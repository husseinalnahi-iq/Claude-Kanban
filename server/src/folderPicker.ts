import { execFile } from "node:child_process";

/**
 * The Windows folder picker, the modern Explorer one — address bar you can paste into, Quick access,
 * recent folders — via the shell's IFileOpenDialog with FOS_PICKFOLDERS.
 *
 * Two things the previous version got wrong, which is what "clicked Browse and it didn't work" was:
 *
 * - Its owner window was created but never shown, so the dialog opened *behind* the browser and the
 *   button just sat there busy. Here the owner is shown (off-screen, invisible, topmost) before the
 *   dialog, and an owned window of a topmost window is itself on top.
 * - It used the old FolderBrowserDialog tree, which on Windows PowerShell's .NET cannot be upgraded
 *   and cannot take a pasted path.
 *
 * The starting folder is passed in an environment variable, never spliced into the script, so a
 * folder name containing `$`, quotes or backticks cannot change what PowerShell runs.
 */
const PICKER_CS = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class KanbanFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogRCW {}

  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
  }

  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string pszPath, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem ppv);

  const uint FOS_PICKFOLDERS = 0x20, FOS_FORCEFILESYSTEM = 0x40, FOS_PATHMUSTEXIST = 0x800;
  const uint SIGDN_FILESYSPATH = 0x80058000;

  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string title);
  static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_SHOWWINDOW = 0x40;

  /**
   * Windows will not let a background process take the foreground ("foreground lock") — which is what
   * the board's server is, so its dialog opened behind the browser. Two things get round it:
   *  - HWND_TOPMOST puts the window above every normal window, and needs no foreground permission;
   *  - joining the foreground thread's input queue lets SetForegroundWindow give it keyboard focus.
   * No keystrokes are simulated: that would leak into whatever window you were using.
   */
  static void BringToFront(IntPtr hwnd) {
    SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW);
    uint pid;
    uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    uint me = GetCurrentThreadId();
    bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
    try {
      BringWindowToTop(hwnd);
      SetForegroundWindow(hwnd);
    } finally {
      if (attached) AttachThreadInput(me, fgThread, false);
    }
  }

  public static string Pick(string title, string start) {
    // The owner sits in the middle of the screen so the dialog opens centred on it; it is invisible.
    var screen = Screen.PrimaryScreen.WorkingArea;
    var owner = new Form {
      TopMost = true, ShowInTaskbar = false, FormBorderStyle = FormBorderStyle.None, Opacity = 0,
      StartPosition = FormStartPosition.Manual, Width = 1, Height = 1,
      Left = screen.Left + screen.Width / 2, Top = screen.Top + screen.Height / 3,
    };
    owner.Show();
    BringToFront(owner.Handle);
    // The dialog only exists once Show() is running, and Show() blocks until it closes. A timer on this
    // thread still fires inside the dialog's own message loop, so it finds the window by its title and
    // lifts it to the top. It re-asserts a few times, in case the dialog repaints itself underneath.
    int lifts = 0;
    var timer = new Timer { Interval = 60 };
    timer.Tick += (s, e) => {
      IntPtr hwnd = FindWindow("#32770", title);
      if (hwnd == IntPtr.Zero) return;
      BringToFront(hwnd);
      if (++lifts >= 4) timer.Stop();
    };
    timer.Start();
    try {
      var dlg = (IFileDialog)new FileOpenDialogRCW();
      uint opts;
      dlg.GetOptions(out opts);
      dlg.SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
      dlg.SetTitle(title);
      dlg.SetOkButtonLabel("Use this folder");
      if (!String.IsNullOrEmpty(start)) {
        try { IShellItem folder; SHCreateItemFromParsingName(start, IntPtr.Zero, typeof(IShellItem).GUID, out folder); dlg.SetFolder(folder); }
        catch { /* a start folder that no longer exists just opens the default location */ }
      }
      if (dlg.Show(owner.Handle) != 0) return null; // cancelled
      IShellItem result;
      dlg.GetResult(out result);
      string path;
      result.GetDisplayName(SIGDN_FILESYSPATH, out path);
      return path;
    } finally {
      timer.Stop();
      timer.Dispose();
      owner.Close();
      owner.Dispose();
    }
  }
}
`;

const PS_SCRIPT = [
  "$ErrorActionPreference = 'Stop';",
  "Add-Type -AssemblyName System.Windows.Forms;",
  `Add-Type -TypeDefinition @'\n${PICKER_CS}\n'@ -ReferencedAssemblies System.Windows.Forms, System.Drawing;`,
  "if ($env:KANBAN_PICK_DRYRUN -eq '1') { Write-Output '::compiled'; exit 0 }",
  "$p = [KanbanFolderPicker]::Pick('Choose a project folder for Claude Kanban', $env:KANBAN_PICK_START);",
  "if ($p) { Write-Output $p }",
].join("\n");

export interface PickResult {
  path: string | null;
  cancelled: boolean;
  /** Set when the picker itself failed — so the UI can say so instead of pretending you cancelled. */
  error: string | null;
}

export function pickFolder(start?: string, opts: { dryRun?: boolean; timeoutMs?: number } = {}): Promise<PickResult> {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command", PS_SCRIPT],
        {
          windowsHide: true,
          timeout: opts.timeoutMs ?? 600_000,
          env: { ...process.env, KANBAN_PICK_START: start ?? "", KANBAN_PICK_DRYRUN: opts.dryRun ? "1" : "" },
        },
        (err, stdout, stderr) => {
          const out = (stdout ?? "").trim();
          if (out) return resolve({ path: out, cancelled: false, error: null });
          if (err && !(err as { killed?: boolean }).killed) {
            const detail = (stderr || err.message).split(/\r?\n/).find((l) => l.trim()) ?? "unknown error";
            return resolve({ path: null, cancelled: false, error: `The folder picker could not open: ${detail.trim().slice(0, 240)}` });
          }
          resolve({ path: null, cancelled: true, error: null });
        },
      );
      return;
    }
    const cmd =
      process.platform === "darwin"
        ? { file: "osascript", args: ["-e", 'POSIX path of (choose folder with prompt "Choose a project folder for Claude Kanban")'] }
        : { file: "zenity", args: ["--file-selection", "--directory", "--title=Choose a project folder"] };
    execFile(cmd.file, cmd.args, { timeout: opts.timeoutMs ?? 600_000 }, (err, stdout) => {
      const out = (stdout ?? "").trim();
      if (out) return resolve({ path: out, cancelled: false, error: null });
      // Both tools exit non-zero on Cancel, so a non-zero exit with no output is a cancel, not a failure.
      resolve({ path: null, cancelled: true, error: err && (err as { code?: unknown }).code === "ENOENT" ? `${cmd.file} is not installed.` : null });
    });
  });
}
