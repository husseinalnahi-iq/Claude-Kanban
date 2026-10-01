// Claude Kanban's own program on Windows: a startup screen while the board gets ready, then an icon by
// the clock that opens the board, shows its log, restarts it and quits it. It replaces the black console
// window the launcher used to leave open (D265); "Start Claude Kanban.cmd" still starts it the old way.
//
// Built on each computer by scripts\build-app.ps1 with the C# compiler that is part of Windows
// (.NET Framework 4.8), so there is nothing to install. That compiler only knows C# 5: no $"" strings,
// no ?. and no => members.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("Claude Kanban")]
[assembly: AssemblyProduct("Claude Kanban")]
[assembly: AssemblyDescription("A board where Claude plans, codes and reviews your tasks")]
[assembly: AssemblyVersion("1.0.0.0")]

namespace ClaudeKanban
{
    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            var flags = new List<string>(args);
            Native.MakeDpiAware();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);

            var mutex = new Mutex(false, @"Local\ClaudeKanban-" + Paths.Id);
            bool mine;
            try
            {
                // A restart hands over to a fresh copy of this program, which waits here for the old one to go.
                mine = mutex.WaitOne(flags.Contains("--handoff") ? 20000 : 0);
            }
            catch (AbandonedMutexException)
            {
                mine = true;
            }
            if (!mine)
            {
                AskRunningCopyToOpen();
                return;
            }

            Log.Open();
            Log.Line("Claude Kanban " + Paths.Version + " in " + Paths.Root);
            Native.TidyOldBuilds();
            App app = null;
            Application.ThreadException += (s, e) => Log.Line("Unexpected: " + e.Exception);
            AppDomain.CurrentDomain.UnhandledException += (s, e) =>
            {
                Log.Line("Unexpected: " + e.ExceptionObject);
                if (app != null) app.StopServer();
            };
            try
            {
                app = new App(mutex, flags.Contains("--rebuilt"));
                Application.Run(app);
            }
            finally
            {
                // Never leave a board running with no icon to reach it by, nor an icon with no board.
                if (app != null)
                {
                    app.StopServer();
                    app.Dispose();
                }
                Log.Close();
            }
        }

        /// <summary>This program is already running: the icon was clicked again, so that copy opens the board.</summary>
        static void AskRunningCopyToOpen()
        {
            // The copy just started may bring a window to the front; the one by the clock may not unless allowed.
            Native.AllowAnyForeground();
            for (int i = 0; i < 30; i++)
            {
                try
                {
                    using (var signal = EventWaitHandle.OpenExisting(@"Local\ClaudeKanban-open-" + Paths.Id))
                    {
                        signal.Set();
                        return;
                    }
                }
                catch (WaitHandleCannotBeOpenedException)
                {
                    // Still starting up: its signal appears a moment after its lock.
                    Thread.Sleep(100);
                }
            }
        }
    }

    enum State { Starting, Running, Stopped, Failed, Leaving }

    /// <summary>A button on the startup screen when something needs the person.</summary>
    class Choice
    {
        public readonly string Label;
        public readonly Action Run;

        public Choice(string label, Action run)
        {
            Label = label;
            Run = run;
        }
    }

    /// <summary>
    /// The icon by the clock and everything behind it: runs the same steps as the .cmd launcher with no
    /// window, shows them on the startup screen, and keeps the board running until Quit.
    /// </summary>
    class App : ApplicationContext
    {
        const string NodeDownload = "https://nodejs.org/en/download";

        readonly Mutex mutex;
        readonly Control ui = new Control();
        readonly NotifyIcon tray = new NotifyIcon();
        readonly ToolStripMenuItem restartItem;
        readonly EventWaitHandle openSignal;
        Splash splash;
        State state;
        bool rebuilt;
        volatile bool cancelled;
        volatile Process child;
        volatile Process server;
        volatile string reason;
        DateTime codeReadAtUtc;

        public App(Mutex mutex, bool rebuilt)
        {
            this.mutex = mutex;
            this.rebuilt = rebuilt;
            // Work finished on other threads comes back through this control, so it needs its handle now.
            var unused = ui.Handle;

            var menu = new ContextMenuStrip();
            var open = new ToolStripMenuItem("Open Claude Kanban", null, (s, e) => Activate());
            open.Font = new Font(open.Font, FontStyle.Bold);
            menu.Items.Add(open);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem("Show log", null, (s, e) => ShowLog()));
            restartItem = new ToolStripMenuItem("Restart", null, (s, e) => Restart());
            menu.Items.Add(restartItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem("Quit Claude Kanban", null, (s, e) => Quit()));

            tray.Icon = Art.TrayIcon();
            tray.ContextMenuStrip = menu;
            tray.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) Activate(); };
            tray.BalloonTipClicked += (s, e) => Activate();
            tray.Visible = true;

            openSignal = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\ClaudeKanban-open-" + Paths.Id);
            var listener = new Thread(() =>
            {
                while (true)
                {
                    openSignal.WaitOne();
                    Ui(OpenedAgain);
                }
            });
            listener.IsBackground = true;
            listener.Start();

            Start();
        }

        // ---- starting up ----------------------------------------------------------------------------

        void Start()
        {
            cancelled = false;
            reason = null;
            SetState(State.Starting);
            if (splash == null || splash.IsDisposed)
            {
                splash = new Splash();
                splash.CloseClicked += () => { if (state == State.Starting || state == State.Failed) Leave(); };
            }
            splash.Reset();
            splash.ShowAndActivate();
            var worker = new Thread(Steps);
            worker.IsBackground = true;
            worker.Start();
        }

        /// <summary>What "Start Claude Kanban.cmd" does, in the same order, without a window.</summary>
        void Steps()
        {
            try
            {
                if (!rebuilt && UpdatedMyself()) return;
                rebuilt = true;

                Step("Getting started…", 0.1f);
                string node = Native.FindOnPath("node.exe");
                if (node == null)
                {
                    Fail("Claude Kanban needs Node.js 24 or newer",
                        "It is not installed on this computer. Install the LTS version, then open Claude Kanban again.", true);
                    return;
                }
                string version = Capture(node, "-p process.versions.node").Trim();
                int major;
                int.TryParse(version.Split('.')[0], out major);
                if (version.Length == 0)
                {
                    Fail("Node.js did not start",
                        "It is installed but did not answer. Install the LTS version again, then open Claude Kanban again.", true);
                    return;
                }
                if (major < 24)
                {
                    Fail("Claude Kanban needs Node.js 24 or newer",
                        "This computer has Node.js " + version + ". Install the LTS version, then open Claude Kanban again.", true);
                    return;
                }

                // Already running? Open it, unless it runs older code than is on disk: then it is stopped
                // and started again here. Exit codes are explained in scripts\launcher-check.ps1.
                var said = new List<string>();
                int check = Run(Native.PowerShell, "-NoProfile -ExecutionPolicy Bypass -File \"" + Script("launcher-check.ps1") + "\" -Port " + Paths.Port, said.Add);
                if (check == 1)
                {
                    Ui(() => UseRunningBoard(said));
                    return;
                }

                if (NeedsInstall())
                {
                    Step("Installing its parts — a minute or two, the first time only…", 0.5f);
                    if (Npm("install --no-audit --no-fund") != 0)
                    {
                        Fail("Installing its parts did not work", "Check your internet connection, then try again. Show details says exactly what went wrong.", false);
                        return;
                    }
                }

                // Claude's engine: the newest patch, so a new Claude model shows up without a board update.
                // It never stops the board from starting, so its answer is not checked.
                Step("Checking for a newer Claude engine…", 0.58f);
                Run(node, "--disable-warning=ExperimentalWarning \"" + Script("update-engine.mjs") + "\"", null);

                Step("Getting the board ready…", 0.8f);
                if (Npm("run build") != 0)
                {
                    Fail("The board could not be built", "Show details says what went wrong.", false);
                    return;
                }

                Step("Starting the board…", 0.97f);
                // From here on, a change on disk is something this board has not seen (the same moment
                // launcher-check.ps1 compares with: when the server started, not when the install did).
                codeReadAtUtc = DateTime.UtcNow;
                var p = Launch(Native.Cmd, "/d /s /c \"npm run start -w server\"", ServerOutput);
                server = p;
                p.Exited += (s, e) => Ui(() => ServerExited(p));
                if (WaitUntilAnswering(p)) Ui(Ready);
            }
            catch (OperationCanceledException)
            {
                // Quit, or closed from the startup screen: the steps were stopped on purpose.
            }
            catch (Exception e)
            {
                Log.Line("Unexpected: " + e);
                if (!cancelled) Fail("Something went wrong while starting", e.Message, false);
            }
        }

        /// <summary>An update changed this program itself: build the new one and hand over to it.</summary>
        bool UpdatedMyself()
        {
            if (!File.Exists(Paths.Source) || File.GetLastWriteTimeUtc(Paths.Source) <= File.GetLastWriteTimeUtc(Paths.Exe)) return false;
            Step("Updating Claude Kanban…", 0.06f);
            if (Run(Native.PowerShell, "-NoProfile -ExecutionPolicy Bypass -File \"" + Script("build-app.ps1") + "\"", null) != 0)
            {
                Log.Line("The new version of this program could not be built; this one carries on.");
                return false;
            }
            Ui(() => HandOver(true));
            return true;
        }

        bool WaitUntilAnswering(Process p)
        {
            var clock = Stopwatch.StartNew();
            while (clock.Elapsed.TotalSeconds < 120)
            {
                Check();
                if (p.HasExited)
                {
                    Fail("The board stopped while starting", reason ?? "Show details says why.", false);
                    return false;
                }
                if (Http.Get("/api/version", 1500) != null) return true;
                Thread.Sleep(300);
            }
            Fail("The board did not answer", "It was still starting after two minutes. Show details says what it was doing.", false);
            return false;
        }

        void Ready()
        {
            if (state != State.Starting || cancelled) return;
            SetState(State.Running);
            Log.Line("Ready on " + Paths.Url);
            OpenBoard();
            splash.Finish();
            FirstRunHint();
        }

        /// <summary>A board started some other way (the .cmd, a terminal) already answers: open that one.</summary>
        void UseRunningBoard(List<string> said)
        {
            OpenBoard();
            string note = said.Count > 0 ? said[said.Count - 1].Trim() : "";
            // "Already running." needs no words. Anything else is why an older version was left alone.
            if (note.Length == 0 || note == "Already running.")
            {
                Leave();
                return;
            }
            SetState(State.Failed);
            tray.Text = "Claude Kanban — already running";
            splash.Notice("The board is already running", note, new Choice("OK", Leave));
        }

        // ---- while it runs ------------------------------------------------------------------------------

        /// <summary>The icon, its Open item, or a notification was clicked.</summary>
        void Activate()
        {
            switch (state)
            {
                case State.Starting:
                case State.Failed:
                    splash.ShowAndActivate();
                    break;
                case State.Running:
                    OpenBoard();
                    break;
                case State.Stopped:
                    Start();
                    break;
            }
        }

        /// <summary>The Desktop icon was used again while this is running.</summary>
        void OpenedAgain()
        {
            if (state != State.Running)
            {
                Activate();
                return;
            }
            // An update since the board started is picked up now, unless that would interrupt work.
            ThreadPool.QueueUserWorkItem(_ =>
            {
                bool changed = CodeChangedSince(codeReadAtUtc);
                string busy = changed ? Busy.Describe() : "";
                Ui(() =>
                {
                    if (state != State.Running)
                    {
                        Activate();
                        return;
                    }
                    if (changed && busy == "")
                    {
                        Log.Line("The code changed since the board started, and it is idle: restarting it.");
                        HandOver(false);
                        return;
                    }
                    OpenBoard();
                    if (changed)
                    {
                        tray.ShowBalloonTip(10000, "A newer version is ready",
                            "The board is busy, so it was left running. Choose Restart from this icon's menu when your work is done.", ToolTipIcon.Info);
                    }
                });
            });
        }

        void ServerExited(Process p)
        {
            if (p != server || state != State.Running) return;
            Log.Line("The board stopped.");
            SetState(State.Stopped);
            tray.ShowBalloonTip(10000, "Claude Kanban stopped",
                "Click here to start it again. To see why it stopped, right-click its icon and choose Show log.", ToolTipIcon.Warning);
        }

        void Restart()
        {
            if (state == State.Starting || state == State.Leaving) return;
            if (state != State.Running)
            {
                Start();
                return;
            }
            WhenIdleOrConfirmed("Restarting stops it. Restart anyway?", () => HandOver(false));
        }

        void Quit()
        {
            if (state != State.Running)
            {
                Leave();
                return;
            }
            WhenIdleOrConfirmed("Quitting stops it. Quit anyway?", Leave);
        }

        void WhenIdleOrConfirmed(string question, Action then)
        {
            ThreadPool.QueueUserWorkItem(_ =>
            {
                // No answer at all is a board too stuck to be asked, and stopping it is what was asked for.
                string busy = Busy.Describe();
                Ui(() =>
                {
                    if (!string.IsNullOrEmpty(busy) && !Ask("Claude Kanban is in the middle of something: " + busy + ".\n\n" + question)) return;
                    then();
                });
            });
        }

        /// <summary>A fresh copy of this program takes over: it picks up anything an update changed, this program included.</summary>
        void HandOver(bool rebuiltAlready)
        {
            Log.Line("Handing over to a fresh start.");
            Stop();
            try
            {
                mutex.ReleaseMutex();
            }
            catch (ApplicationException)
            {
                // Not held: nothing to hand over.
            }
            try
            {
                Process.Start(new ProcessStartInfo(Paths.Exe, rebuiltAlready ? "--handoff --rebuilt" : "--handoff") { UseShellExecute = false });
            }
            catch (Exception e)
            {
                // The icon on the Desktop starts it again; staying here with nothing running would not help.
                Log.Line("Could not start the fresh copy: " + e.Message);
            }
            ExitThread();
        }

        void Leave()
        {
            Log.Line("Quit.");
            Stop();
            ExitThread();
        }

        void Stop()
        {
            SetState(State.Leaving);
            cancelled = true;
            Native.KillTree(child);
            StopServer();
            tray.Visible = false;
            if (splash != null && !splash.IsDisposed) splash.Dismiss();
        }

        public void StopServer()
        {
            var p = server;
            server = null;
            Native.KillTree(p);
        }

        // ---- the pieces ---------------------------------------------------------------------------------

        void SetState(State next)
        {
            state = next;
            switch (next)
            {
                case State.Starting: tray.Text = "Claude Kanban — starting"; break;
                case State.Running: tray.Text = "Claude Kanban — running"; break;
                case State.Stopped: tray.Text = "Claude Kanban — stopped"; break;
                case State.Failed: tray.Text = "Claude Kanban — did not start"; break;
            }
            bool stopped = next == State.Stopped || next == State.Failed;
            restartItem.Text = stopped ? "Start again" : "Restart";
            restartItem.Enabled = next != State.Starting;
        }

        void Step(string text, float progress)
        {
            Check();
            Log.Line("== " + text);
            Ui(() => { if (state == State.Starting) splash.Step(text, progress); });
        }

        void Fail(string title, string detail, bool nodeMissing)
        {
            Log.Line("Did not start: " + title + (string.IsNullOrEmpty(detail) ? "" : " (" + detail + ")"));
            Ui(() =>
            {
                if (cancelled || state == State.Leaving) return;
                StopServer();
                SetState(State.Failed);
                // The last button is the highlighted one: what the person most likely wants.
                if (nodeMissing)
                    splash.Fail(title, detail, new Choice("Try again", Start), new Choice("Download Node.js", () => Native.Open(NodeDownload)));
                else
                    splash.Fail(title, detail, new Choice("Show details", ShowLog), new Choice("Try again", Start));
            });
        }

        void Check()
        {
            if (cancelled) throw new OperationCanceledException();
        }

        /// <summary>
        /// What best explains a start that failed: the board's own words, not npm's wrapping around them, nor
        /// a stack trace's frames. The first line naming an error wins; until one comes, the first line said.
        /// </summary>
        void ServerOutput(string line)
        {
            Log.Line(line);
            string text = Log.Plain(line).Trim();
            if (text.Length == 0 || text.StartsWith(">") || text.StartsWith("npm ") || text.StartsWith("at ") || text.StartsWith("node:") || text.StartsWith("^")) return;
            if (reason == null || (!NamesError(reason) && NamesError(text))) reason = text;
        }

        static bool NamesError(string text)
        {
            return Regex.IsMatch(text, @"^\w*Error\b|\b[A-Z]\w*Error:|\berror:");
        }

        int Run(string file, string args, Action<string> seen)
        {
            Check();
            Process p;
            try
            {
                p = Launch(file, args, line =>
                {
                    Log.Line(line);
                    if (seen != null) seen(Log.Plain(line));
                });
            }
            catch (Exception e)
            {
                Log.Line("Could not start " + file + ": " + e.Message);
                return -1;
            }
            child = p;
            p.WaitForExit();
            child = null;
            Check();
            return p.ExitCode;
        }

        string Capture(string file, string args)
        {
            var text = new StringBuilder();
            Run(file, args, line => text.AppendLine(line));
            return text.ToString();
        }

        int Npm(string args)
        {
            return Run(Native.Cmd, "/d /s /c \"npm " + args + "\"", null);
        }

        static Process Launch(string file, string args, Action<string> onLine)
        {
            var psi = new ProcessStartInfo(file, args);
            psi.WorkingDirectory = Paths.Root;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardInput = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            // The .cmd has the board open the browser itself; here this program does, and only once it answers.
            psi.EnvironmentVariables.Remove("KANBAN_OPEN_BROWSER");
            var p = new Process();
            p.StartInfo = psi;
            p.EnableRaisingEvents = true;
            DataReceivedEventHandler pass = (s, e) => { if (e.Data != null) onLine(e.Data); };
            p.OutputDataReceived += pass;
            p.ErrorDataReceived += pass;
            p.Start();
            // Nothing ever types into these: an empty input means a question ends the step instead of hanging it.
            p.StandardInput.Close();
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            return p;
        }

        static string Script(string name)
        {
            return Path.Combine(Paths.Root, "scripts", name);
        }

        static bool NeedsInstall()
        {
            string installed = Path.Combine(Paths.Root, "node_modules", ".package-lock.json");
            string wanted = Path.Combine(Paths.Root, "package-lock.json");
            if (!File.Exists(installed)) return true;
            return File.Exists(wanted) && File.GetLastWriteTimeUtc(wanted) > File.GetLastWriteTimeUtc(installed);
        }

        /// <summary>The same files scripts\launcher-check.ps1 looks at: what a restart would pick up.</summary>
        static bool CodeChangedSince(DateTime utc)
        {
            foreach (var dir in new[] { Path.Combine(Paths.Root, "server", "src"), Path.Combine(Paths.Root, "web", "src"), Path.Combine(Paths.Root, "scripts") })
            {
                if (!Directory.Exists(dir)) continue;
                foreach (var f in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories))
                    if (File.GetLastWriteTimeUtc(f) > utc) return true;
            }
            string lockFile = Path.Combine(Paths.Root, "package-lock.json");
            return File.Exists(lockFile) && File.GetLastWriteTimeUtc(lockFile) > utc;
        }

        void OpenBoard()
        {
            Native.Open(Paths.Url);
        }

        void ShowLog()
        {
            try
            {
                Process.Start(new ProcessStartInfo("notepad.exe", "\"" + Paths.LogFile + "\"") { UseShellExecute = true });
            }
            catch (Exception e)
            {
                Log.Line("Could not open the log: " + e.Message);
            }
        }

        /// <summary>Once per computer: where the board went when its window closes.</summary>
        void FirstRunHint()
        {
            string marker = Path.Combine(Paths.StateDir, "tray-hint-shown");
            if (File.Exists(marker)) return;
            try
            {
                File.WriteAllText(marker, DateTime.Now.ToString("o"));
            }
            catch (Exception)
            {
                // The hint shows again next time: harmless.
            }
            tray.ShowBalloonTip(15000, "Claude Kanban keeps running here",
                "Closing the board leaves it working by the clock. Click this icon to open it again, or right-click it to quit. On Windows 11 it may be under the ^ arrow.",
                ToolTipIcon.None);
        }

        static bool Ask(string text)
        {
            // Opened from the icon by the clock, a message box with no owner can land behind other windows.
            using (var owner = new Form())
            {
                owner.TopMost = true;
                return MessageBox.Show(owner, text, "Claude Kanban", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) == DialogResult.Yes;
            }
        }

        void Ui(Action action)
        {
            try
            {
                if (!ui.IsDisposed) ui.BeginInvoke(action);
            }
            catch (InvalidOperationException)
            {
                // Quitting: nothing is left to update.
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                tray.Dispose();
                ui.Dispose();
            }
            base.Dispose(disposing);
        }
    }

    /// <summary>
    /// The startup screen: the Claude Kanban mark with its three columns rising, the step it is on, and a
    /// bar. When something goes wrong it says what, in words, with buttons for what to do next.
    /// </summary>
    class Splash : Form
    {
        // The board's dark palette (web/src/index.css), so the first thing you see already looks like the board.
        static readonly Color Ink900 = Color.FromArgb(0x12, 0x13, 0x10);
        static readonly Color Ink700 = Color.FromArgb(0x29, 0x2a, 0x25);
        static readonly Color Ink600 = Color.FromArgb(0x3a, 0x3b, 0x34);
        static readonly Color Ink500 = Color.FromArgb(0x57, 0x57, 0x4e);
        static readonly Color Ink400 = Color.FromArgb(0x83, 0x82, 0x7a);
        static readonly Color Ink300 = Color.FromArgb(0xae, 0xac, 0xa2);
        static readonly Color Ink100 = Color.FromArgb(0xeb, 0xe8, 0xde);
        static readonly Color Amber = Color.FromArgb(0xf2, 0xa9, 0x3b);
        static readonly Color AmberHover = Color.FromArgb(0xff, 0xbb, 0x55);
        static readonly Color Moss = Color.FromArgb(0x6f, 0xa8, 0x72);
        static readonly Color Rust = Color.FromArgb(0xe0, 0x64, 0x3c);
        // The mark's columns, as in scripts/make-icon.mjs: running, queued, done.
        static readonly Color[] BarColors = { Amber, Ink100, Moss };
        static readonly float[] BarHeights = { 1f, 0.8f, 0.55f };

        const float W = 440, H = 300;

        readonly float k;
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
        readonly Stopwatch clock = Stopwatch.StartNew();
        readonly Font titleFont = new Font("Segoe UI Semibold", 17f);
        readonly Font statusFont = new Font("Segoe UI", 10f);
        readonly Font detailFont = new Font("Segoe UI", 9f);
        readonly Font smallFont = new Font("Segoe UI", 7.5f);
        readonly List<Button> buttons = new List<Button>();
        bool drawBorder = true;
        bool dismissing;

        string status = "Starting…";
        string detail;
        bool failed, finishing;
        double finishAt, stepAt;
        float shown, from, target = 0.05f;
        float calm;
        bool closeHover;

        public event Action CloseClicked;

        public Splash()
        {
            using (var g = Graphics.FromHwnd(IntPtr.Zero)) k = g.DpiX / 96f;
            Text = "Claude Kanban";
            Icon = Art.WindowIcon();
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            ShowInTaskbar = true;
            BackColor = Ink900;
            ClientSize = new Size(Px(W), Px(H));
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
            timer.Interval = 15;
            timer.Tick += (s, e) => Tick();
            timer.Start();
        }

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.ClassStyle |= 0x20000; // CS_DROPSHADOW: a borderless window still lifts off the desktop
                return cp;
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            // Windows 11 rounds the corners and draws the edge; Windows 10 cannot, so the edge is drawn here.
            drawBorder = !Native.RoundCorners(Handle, Ink700);
        }

        // ---- what the app tells it ----------------------------------------------------------------------

        public void Reset()
        {
            failed = false;
            finishing = false;
            detail = null;
            status = "Starting…";
            shown = from = 0;
            target = 0.05f;
            stepAt = Now;
            ClearButtons();
            Invalidate();
        }

        public void Step(string text, float progress)
        {
            status = text;
            from = shown;
            target = progress;
            stepAt = Now;
            Invalidate();
        }

        public void Fail(string title, string text, params Choice[] choices)
        {
            failed = true;
            status = title;
            detail = text;
            SetButtons(choices);
            Invalidate();
            ShowAndActivate();
        }

        /// <summary>Not a failure, just something to read before it closes.</summary>
        public void Notice(string title, string text, params Choice[] choices)
        {
            Fail(title, text, choices);
            failed = false;
            calm = 1;
            Invalidate();
        }

        /// <summary>The board is open: fill the bar, then fade away.</summary>
        public void Finish()
        {
            finishing = true;
            status = "Opening…";
            finishAt = Now + 0.45;
        }

        public void ShowAndActivate()
        {
            if (!Visible) Show();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
        }

        /// <summary>Closed by the app, not by the person: nothing to ask about.</summary>
        public void Dismiss()
        {
            dismissing = true;
            Close();
        }

        // ---- animation and drawing ---------------------------------------------------------------------

        double Now
        {
            get { return clock.Elapsed.TotalSeconds; }
        }

        void Tick()
        {
            double t = Now;
            if (finishing)
            {
                shown += (1 - shown) * 0.25f;
                if (t > finishAt)
                {
                    double fade = (t - finishAt) / 0.3;
                    if (fade >= 1)
                    {
                        Dismiss();
                        return;
                    }
                    Opacity = 1 - fade;
                }
            }
            else if (!failed && buttons.Count == 0)
            {
                // Within a step the bar keeps creeping toward the step's end, so a long step never looks stuck.
                float goal = from + (target - from) * (float)(1 - Math.Exp(-(t - stepAt) / 3.0));
                shown += (goal - shown) * 0.12f;
            }
            float settle = failed || finishing || buttons.Count > 0 ? 1 : 0;
            // A screen waiting on a button has nothing left to animate once it has settled.
            if (settle == 1 && calm > 0.998f && !finishing) return;
            calm += (settle - calm) * 0.08f;
            Invalidate();
        }

        /// <summary>How tall column i stands, 0..1: they rise one after another, then breathe while it works.</summary>
        float Level(int i, double t)
        {
            double rise = Clamp01((t - 0.1 - i * 0.12) / 0.6);
            double c1 = 1.1, c3 = c1 + 1, x = rise - 1;
            double up = 1 + c3 * x * x * x + c1 * x * x; // ease out, with a small overshoot
            double wave = 0.5 + 0.5 * Math.Sin(2 * Math.PI * t / 1.4 - i * 0.9);
            double breathe = 0.3 * (1 - calm) * Clamp01((t - 0.9) / 0.6);
            double level = up * (1 - breathe * wave);
            if (failed) level *= 1 - 0.4 * calm;
            return (float)Math.Max(0, level);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Ink900);
            double t = Now;

            // A faint amber glow from the top, as on the board itself.
            using (var glow = new GraphicsPath())
            {
                glow.AddEllipse(F(W / 2 - 280), F(-250), F(560), F(400));
                using (var b = new PathGradientBrush(glow))
                {
                    b.CenterColor = Color.FromArgb(failed ? 14 : 26, failed ? Rust : Amber);
                    b.SurroundColors = new[] { Color.FromArgb(0, Amber) };
                    g.FillPath(b, glow);
                }
            }

            // The mark: three columns standing on one line.
            const float barW = 18, gap = 10, maxH = 68, baseY = 128;
            float left = W / 2 - (3 * barW + 2 * gap) / 2;
            for (int i = 0; i < 3; i++)
            {
                float h = maxH * BarHeights[i] * Level(i, t);
                if (h < 0.5f) continue;
                var r = new RectangleF(F(left + i * (barW + gap)), F(baseY - h), F(barW), F(h));
                int alpha = failed ? (int)(255 - 150 * calm) : 255;
                using (var path = Rounded(r, F(5)))
                using (var b = new SolidBrush(Color.FromArgb(alpha, BarColors[i])))
                    g.FillPath(b, path);
            }

            const TextFormatFlags centred = TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis;
            TextRenderer.DrawText(g, "Claude Kanban", titleFont, Box(0, 144, W, 34), Ink100, centred);
            TextRenderer.DrawText(g, status, statusFont, Box(28, 182, W - 56, 24), failed ? Rust : Ink300, centred);

            if (detail != null)
            {
                TextRenderer.DrawText(g, detail, detailFont, Box(40, 208, W - 80, 36), Ink400,
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.WordBreak | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPadding);
            }
            else
            {
                DrawBar(g, t);
            }

            TextRenderer.DrawText(g, Paths.Version, smallFont, Box(W - 120, H - 24, 106, 14), Ink500,
                TextFormatFlags.Right | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);

            // Close: stops starting it.
            var x = CloseBox();
            if (closeHover)
            {
                using (var path = Rounded(x, F(6)))
                using (var b = new SolidBrush(Ink700))
                    g.FillPath(b, path);
            }
            using (var pen = new Pen(closeHover ? Ink100 : Ink400, F(1.4f)))
            {
                float inset = F(9);
                g.DrawLine(pen, x.Left + inset, x.Top + inset, x.Right - inset, x.Bottom - inset);
                g.DrawLine(pen, x.Right - inset, x.Top + inset, x.Left + inset, x.Bottom - inset);
            }

            if (drawBorder)
            {
                using (var pen = new Pen(Ink700, 1))
                    g.DrawRectangle(pen, 0, 0, ClientSize.Width - 1, ClientSize.Height - 1);
            }
        }

        void DrawBar(Graphics g, double t)
        {
            var track = new RectangleF(F(92), F(222), F(W - 184), F(3));
            using (var path = Rounded(track, track.Height / 2))
            using (var b = new SolidBrush(Ink700))
                g.FillPath(b, path);
            float w = track.Width * Math.Max(0, Math.Min(1, shown));
            if (w < 1) return;
            var fill = new RectangleF(track.X, track.Y, w, track.Height);
            using (var path = Rounded(fill, track.Height / 2))
            {
                using (var b = new SolidBrush(Amber)) g.FillPath(b, path);
                // A light sweeping along the filled part: it is working, even when a step takes a while.
                float sweep = F(70);
                float at = track.X + (float)((t * 0.7) % 1.6 - 0.3) * track.Width;
                var glint = new RectangleF(at - sweep / 2, track.Y, sweep, track.Height);
                using (var shine = new LinearGradientBrush(new PointF(glint.Left - 1, 0), new PointF(glint.Right + 1, 0), Color.FromArgb(0, 255, 236, 200), Color.FromArgb(0, 255, 236, 200)))
                {
                    var blend = new ColorBlend(3);
                    blend.Colors = new[] { Color.FromArgb(0, 255, 236, 200), Color.FromArgb(200, 255, 236, 200), Color.FromArgb(0, 255, 236, 200) };
                    blend.Positions = new[] { 0f, 0.5f, 1f };
                    shine.InterpolationColors = blend;
                    var before = g.Save();
                    g.SetClip(path);
                    g.FillRectangle(shine, glint);
                    g.Restore(before);
                }
            }
        }

        // ---- buttons and the mouse ---------------------------------------------------------------------

        void SetButtons(Choice[] choices)
        {
            ClearButtons();
            int bw = Px(132), bh = Px(30), gap = Px(10);
            int total = choices.Length * bw + (choices.Length - 1) * gap;
            int x = (ClientSize.Width - total) / 2;
            for (int i = 0; i < choices.Length; i++)
            {
                bool primary = i == choices.Length - 1;
                var run = choices[i].Run;
                var b = new Button();
                b.Text = choices[i].Label;
                b.Font = detailFont;
                b.FlatStyle = FlatStyle.Flat;
                b.UseVisualStyleBackColor = false;
                b.Cursor = Cursors.Hand;
                b.BackColor = primary ? Amber : Ink700;
                b.ForeColor = primary ? Ink900 : Ink100;
                b.FlatAppearance.BorderSize = 1;
                b.FlatAppearance.BorderColor = primary ? Amber : Ink600;
                b.FlatAppearance.MouseOverBackColor = primary ? AmberHover : Ink600;
                b.FlatAppearance.MouseDownBackColor = primary ? Amber : Ink500;
                b.Bounds = new Rectangle(x, Px(254), bw, bh);
                b.Click += (s, e) => run();
                Controls.Add(b);
                buttons.Add(b);
                x += bw + gap;
            }
            if (buttons.Count > 0) AcceptButton = buttons[buttons.Count - 1];
        }

        void ClearButtons()
        {
            foreach (var b in buttons)
            {
                Controls.Remove(b);
                b.Dispose();
            }
            buttons.Clear();
            AcceptButton = null;
        }

        RectangleF CloseBox()
        {
            return new RectangleF(F(W - 38), F(10), F(28), F(28));
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            bool over = CloseBox().Contains(e.Location);
            if (over == closeHover) return;
            closeHover = over;
            Cursor = over ? Cursors.Hand : Cursors.Default;
            Invalidate();
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            closeHover = false;
            Cursor = Cursors.Default;
            Invalidate();
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            // Anywhere but the close button moves the window, as its title bar would.
            if (e.Button == MouseButtons.Left && !CloseBox().Contains(e.Location)) Native.DragWindow(Handle);
        }

        protected override void OnMouseClick(MouseEventArgs e)
        {
            base.OnMouseClick(e);
            if (e.Button == MouseButtons.Left && CloseBox().Contains(e.Location) && CloseClicked != null) CloseClicked();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            // Alt+F4 means the same as the close button: the app decides what closing does now.
            if (!dismissing && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                if (CloseClicked != null) CloseClicked();
                return;
            }
            base.OnFormClosing(e);
        }

        protected override void Dispose(bool disposing)
        {
            base.Dispose(disposing);
            if (disposing)
            {
                // After the base: the buttons it disposes still use these fonts.
                timer.Dispose();
                titleFont.Dispose();
                statusFont.Dispose();
                detailFont.Dispose();
                smallFont.Dispose();
            }
        }

        // ---- sizes -------------------------------------------------------------------------------------
        // Everything is laid out for a 440 x 300 window at 100% and scaled to the screen's setting.

        float F(float v)
        {
            return v * k;
        }

        int Px(float v)
        {
            return (int)Math.Round(v * k);
        }

        Rectangle Box(float x, float y, float w, float h)
        {
            return new Rectangle(Px(x), Px(y), Px(w), Px(h));
        }

        static double Clamp01(double v)
        {
            return v < 0 ? 0 : v > 1 ? 1 : v;
        }

        static GraphicsPath Rounded(RectangleF r, float radius)
        {
            var p = new GraphicsPath();
            float d = Math.Min(radius * 2, Math.Min(r.Width, r.Height));
            if (d <= 0.5f)
            {
                p.AddRectangle(r);
                return p;
            }
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }
    }

    static class Paths
    {
        public static readonly string Exe = Application.ExecutablePath;
        public static readonly string Root = Path.GetDirectoryName(Exe);
        public static readonly string Source = Path.Combine(Root, "scripts", "app", "ClaudeKanban.cs");
        public static readonly string IconFile = Path.Combine(Root, "assets", "claude-kanban.ico");
        // The server's own rules (server/src/config.ts), so both agree on where the board lives.
        public static readonly int Port = ReadPort();
        public static readonly string Url = "http://127.0.0.1:" + Port;
        public static readonly string StateDir = ReadStateDir();
        public static readonly string LogFile = Path.Combine(Path.Combine(StateDir, "logs"), "claude-kanban.log");
        // One running copy per install folder: two installs can each have their own.
        public static readonly string Id = Hash(Root.ToLowerInvariant());
        public static readonly string Version = ReadVersion();

        static int ReadPort()
        {
            int port;
            return int.TryParse(Environment.GetEnvironmentVariable("KANBAN_PORT"), out port) ? port : 4310;
        }

        static string ReadStateDir()
        {
            string dir = Environment.GetEnvironmentVariable("KANBAN_STATE_DIR");
            if (!string.IsNullOrEmpty(dir)) return dir;
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude-kanban");
        }

        static string ReadVersion()
        {
            try
            {
                var m = Regex.Match(File.ReadAllText(Path.Combine(Root, "package.json")), "\"version\"\\s*:\\s*\"([^\"]+)\"");
                return m.Success ? "v" + m.Groups[1].Value : "";
            }
            catch (Exception)
            {
                return "";
            }
        }

        static string Hash(string text)
        {
            using (var sha = SHA1.Create())
            {
                var bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(text));
                return BitConverter.ToString(bytes, 0, 6).Replace("-", "").ToLowerInvariant();
            }
        }
    }

    /// <summary>
    /// Everything the steps and the board print, in one file (Show log), as the black window used to show
    /// it. The run before is kept beside it, since "why did it stop" is usually answered there.
    /// </summary>
    static class Log
    {
        const long MaxBytes = 5 * 1024 * 1024;
        static readonly object Gate = new object();
        static readonly Regex Ansi = new Regex(@"\x1B\[[0-9;?]*[ -/]*[@-~]");
        static StreamWriter writer;

        public static void Open()
        {
            lock (Gate)
            {
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(Paths.LogFile));
                    Rotate();
                }
                catch (Exception)
                {
                    writer = null;
                }
            }
        }

        public static void Line(string text)
        {
            lock (Gate)
            {
                if (writer == null) return;
                try
                {
                    if (writer.BaseStream.Length > MaxBytes) Rotate();
                    writer.WriteLine(DateTime.Now.ToString("HH:mm:ss") + "  " + Plain(text));
                }
                catch (Exception)
                {
                    // A log that cannot be written must never stop the board.
                }
            }
        }

        /// <summary>Colours are for a console; in a text file they are noise.</summary>
        public static string Plain(string text)
        {
            return Ansi.Replace(text, "");
        }

        public static void Close()
        {
            lock (Gate)
            {
                if (writer != null) writer.Dispose();
                writer = null;
            }
        }

        static void Rotate()
        {
            if (writer != null) writer.Dispose();
            writer = null;
            string previous = Path.Combine(Path.GetDirectoryName(Paths.LogFile), "claude-kanban.previous.log");
            try
            {
                if (File.Exists(Paths.LogFile)) File.Copy(Paths.LogFile, previous, true);
            }
            catch (Exception)
            {
                // Keeping the last run is a nicety; this run's log matters more.
            }
            // Shared, so Show log can open it while it is still being written.
            var stream = new FileStream(Paths.LogFile, FileMode.Create, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
            writer = new StreamWriter(stream, new UTF8Encoding(false));
            writer.AutoFlush = true;
        }
    }

    static class Http
    {
        /// <summary>The board's answer, or null when it gives none in time.</summary>
        public static string Get(string path, int timeoutMs)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(Paths.Url + path);
                // The board is on this computer: a proxy set for the internet must not be asked about it.
                req.Proxy = null;
                req.Timeout = timeoutMs;
                req.ReadWriteTimeout = timeoutMs;
                using (var res = (HttpWebResponse)req.GetResponse())
                using (var r = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                    return r.ReadToEnd();
            }
            catch (Exception)
            {
                return null;
            }
        }
    }

    static class Busy
    {
        /// <summary>What the board is in the middle of, in words: "" for nothing, null when it did not answer.</summary>
        public static string Describe()
        {
            string json = Http.Get("/api/busy", 5000);
            if (json == null) return null;
            var parts = new List<string>();
            int tasks = Count(json, "tasks");
            if (tasks == 1) parts.Add("a task is working");
            else if (tasks > 1) parts.Add(tasks + " tasks are working");
            if (Count(json, "chats") > 0) parts.Add("a side chat is writing its reply");
            if (Count(json, "specRewrites") > 0) parts.Add("a spec is being rewritten");
            if (Count(json, "setupFixes") > 0) parts.Add("an install from the Setup page is running");
            int terminals = Count(json, "terminals");
            if (terminals == 1) parts.Add("a terminal is open");
            else if (terminals > 1) parts.Add(terminals + " terminals are open");
            if (parts.Count == 0 && Regex.IsMatch(json, "\"busy\"\\s*:\\s*true")) parts.Add("work in progress");
            return string.Join(", ", parts);
        }

        static int Count(string json, string key)
        {
            var m = Regex.Match(json, "\"" + key + "\"\\s*:\\s*(\\d+)");
            return m.Success ? int.Parse(m.Groups[1].Value) : 0;
        }
    }

    static class Art
    {
        public static Icon TrayIcon()
        {
            // The small size drawn for it, not the big one shrunk: at 16 px that is the difference between crisp and blurry.
            try { return new Icon(Paths.IconFile, SystemInformation.SmallIconSize); }
            catch (Exception) { }
            try { return Icon.ExtractAssociatedIcon(Paths.Exe); }
            catch (Exception) { }
            return SystemIcons.Application;
        }

        public static Icon WindowIcon()
        {
            try { return new Icon(Paths.IconFile); }
            catch (Exception) { }
            try { return Icon.ExtractAssociatedIcon(Paths.Exe); }
            catch (Exception) { }
            return SystemIcons.Application;
        }
    }

    static class Native
    {
        public static readonly string Cmd = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe";
        public static readonly string PowerShell = FindPowerShell();

        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int processId);
        [DllImport("user32.dll")] static extern bool ReleaseCapture();
        [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
        [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

        /// <summary>Drawn at the screen's real size: otherwise Windows stretches it, and at 150% it is blurry.</summary>
        public static void MakeDpiAware()
        {
            try { SetProcessDPIAware(); }
            catch (Exception) { }
        }

        public static void AllowAnyForeground()
        {
            try { AllowSetForegroundWindow(-1); }
            catch (Exception) { }
        }

        public static void DragWindow(IntPtr window)
        {
            try
            {
                ReleaseCapture();
                SendMessage(window, 0xA1 /* WM_NCLBUTTONDOWN */, (IntPtr)2 /* HTCAPTION */, IntPtr.Zero);
            }
            catch (Exception) { }
        }

        /// <summary>Windows 11's rounded corners, with its edge in the given colour. False where there are none (Windows 10).</summary>
        public static bool RoundCorners(IntPtr window, Color edge)
        {
            try
            {
                int round = 2; // DWMWCP_ROUND
                if (DwmSetWindowAttribute(window, 33 /* DWMWA_WINDOW_CORNER_PREFERENCE */, ref round, 4) != 0) return false;
                int colour = edge.R | (edge.G << 8) | (edge.B << 16);
                DwmSetWindowAttribute(window, 34 /* DWMWA_BORDER_COLOR */, ref colour, 4);
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }

        /// <summary>A web page or file, in whatever Windows opens it with.</summary>
        public static void Open(string target)
        {
            try
            {
                Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
            }
            catch (Exception e)
            {
                Log.Line("Could not open " + target + ": " + e.Message);
            }
        }

        /// <summary>Ends a process and everything it started, as closing the black window used to.</summary>
        public static void KillTree(Process p)
        {
            if (p == null) return;
            try
            {
                if (p.HasExited) return;
                var kill = Process.Start(new ProcessStartInfo("taskkill.exe", "/PID " + p.Id + " /T /F") { UseShellExecute = false, CreateNoWindow = true });
                kill.WaitForExit(10000);
                p.WaitForExit(5000);
            }
            catch (Exception e)
            {
                Log.Line("Could not stop a process: " + e.Message);
            }
        }

        /// <summary>
        /// Like the command line's own lookup. The PATH is read afresh first: a Node.js installed after
        /// Windows started is not on the PATH this program was handed.
        /// </summary>
        public static string FindOnPath(string exe)
        {
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var dirs = new List<string>();
            foreach (var source in new[] {
                Environment.GetEnvironmentVariable("Path", EnvironmentVariableTarget.Machine),
                Environment.GetEnvironmentVariable("Path", EnvironmentVariableTarget.User),
                Environment.GetEnvironmentVariable("Path") })
            {
                if (source == null) continue;
                foreach (var d in source.Split(';'))
                {
                    string dir = d.Trim().Trim('"');
                    if (dir.Length > 0 && seen.Add(dir)) dirs.Add(dir);
                }
            }
            // Every step started from here runs with the same, fresh PATH.
            Environment.SetEnvironmentVariable("Path", string.Join(";", dirs));
            foreach (var dir in dirs)
            {
                try
                {
                    string full = Path.Combine(dir, exe);
                    if (File.Exists(full)) return full;
                }
                catch (ArgumentException)
                {
                    // A PATH entry with characters a path cannot have: skip it, as Windows does.
                }
            }
            return null;
        }

        /// <summary>Copies left behind by an update that swapped the program while it ran (scripts\build-app.ps1).</summary>
        public static void TidyOldBuilds()
        {
            try
            {
                foreach (var f in Directory.GetFiles(Paths.Root, "Claude Kanban.old*.exe"))
                {
                    try { File.Delete(f); }
                    catch (Exception) { }
                }
            }
            catch (Exception) { }
        }

        static string FindPowerShell()
        {
            string full = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");
            return File.Exists(full) ? full : "powershell.exe";
        }
    }
}
