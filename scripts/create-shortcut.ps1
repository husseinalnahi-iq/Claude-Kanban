# Creates a "Claude Kanban" shortcut (with the app icon) on the Desktop and in the Start menu.
# Run:  powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1
# Add -Startup to also launch the board when Windows starts.
# -IfMissing: do nothing when the Desktop icon is already there (the launcher's first run uses this).
param([switch]$Startup, [switch]$IfMissing)

$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root 'Start Claude Kanban.cmd'
$icon = Join-Path $root 'assets\claude-kanban.ico'
if (-not (Test-Path $target)) { throw "Missing $target" }
if (-not (Test-Path $icon)) { & node (Join-Path $root 'scripts\make-icon.mjs') }

if ($IfMissing -and (Test-Path (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Claude Kanban.lnk'))) { exit 0 }

$shell = New-Object -ComObject WScript.Shell
$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Claude Kanban.lnk'),
  (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\Claude Kanban.lnk')
)
if ($Startup) { $targets += (Join-Path ([Environment]::GetFolderPath('Startup')) 'Claude Kanban.lnk') }

foreach ($path in $targets) {
  New-Item -ItemType Directory -Force -Path (Split-Path $path) | Out-Null
  $sc = $shell.CreateShortcut($path)
  $sc.TargetPath = $target
  $sc.WorkingDirectory = $root
  $sc.IconLocation = "$icon,0"
  $sc.Description = 'Claude Kanban - run Claude sessions from a board'
  $sc.WindowStyle = 7   # start minimised; the window is the server log
  $sc.Save()
  Write-Output "created $path"
}
