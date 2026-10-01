# Creates a "Claude Kanban" shortcut (with the app icon) on the Desktop and in the Start menu.
# Run:  powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1
# Add -Startup to also launch the board when Windows starts.
# -IfMissing: do nothing when the Desktop icon is already there (the launcher's first run uses this),
# except move icons made before Claude Kanban.exe over to it.
param([switch]$Startup, [switch]$IfMissing)

$root = Split-Path -Parent $PSScriptRoot
$cmd = Join-Path $root 'Start Claude Kanban.cmd'
$app = Join-Path $root 'Claude Kanban.exe'
$icon = Join-Path $root 'assets\claude-kanban.ico'
if (-not (Test-Path $cmd)) { throw "Missing $cmd" }
if (-not (Test-Path $icon)) { & node (Join-Path $root 'scripts\make-icon.mjs') }

# The icons open Claude Kanban.exe: a startup screen, then an icon by the clock, and no black window (D265).
# Where it cannot be built, they open the .cmd launcher as before.
& (Join-Path $PSScriptRoot 'build-app.ps1') | ForEach-Object { Write-Output $_ }
$useApp = ($LASTEXITCODE -eq 0) -and (Test-Path $app)
$target = if ($useApp) { $app } else { $cmd }

$shell = New-Object -ComObject WScript.Shell
$desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Claude Kanban.lnk'
$startupLink = Join-Path ([Environment]::GetFolderPath('Startup')) 'Claude Kanban.lnk'
$targets = @(
  $desktop,
  (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\Claude Kanban.lnk')
)
if ($Startup) { $targets += $startupLink }

if ($IfMissing -and (Test-Path $desktop)) {
  # Only icons that open this folder's .cmd are moved over: one pointed somewhere else on purpose is left be.
  $current = $shell.CreateShortcut($desktop).TargetPath
  if ($current -ieq $target -or $current -ine $cmd) { exit 0 }
  $targets = @($targets + $startupLink) | Select-Object -Unique |
    Where-Object { (Test-Path $_) -and ($shell.CreateShortcut($_).TargetPath -ieq $cmd) }
}

foreach ($path in $targets) {
  New-Item -ItemType Directory -Force -Path (Split-Path $path) | Out-Null
  $sc = $shell.CreateShortcut($path)
  $sc.TargetPath = $target
  $sc.WorkingDirectory = $root
  $sc.IconLocation = "$icon,0"
  $sc.Description = 'Claude Kanban - run Claude sessions from a board'
  # The .cmd's window is the server log, so it starts minimised; the app starts normally, or its first
  # window - the startup screen - would open minimised too.
  $sc.WindowStyle = if ($useApp) { 1 } else { 7 }
  $sc.Save()
  Write-Output "created $path"
}
