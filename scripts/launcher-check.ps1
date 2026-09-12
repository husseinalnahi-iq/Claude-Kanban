# Called by "Start Claude Kanban.cmd": is the board already running, and is it running the code on disk?
# The shortcut starts the launcher minimised, so an old server is easy to forget about; double-clicking
# again used to just reopen it, even after the code changed.
#   exit 0  nothing on the port: start it
#   exit 1  running the current code (or tasks are busy, or the port is someone else's): just open it
#   exit 2  was running older code with nothing in flight, and has been stopped: start it again
param([int]$Port = 4310)

$root = Split-Path -Parent $PSScriptRoot
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $conn) { exit 0 }

$proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)"
if (-not $proc -or $proc.CommandLine -notlike "*src/index.ts*" -or $proc.CommandLine -notlike "*$root*") {
  Write-Host "Something else is using port $Port; opening it."
  exit 1
}

$newest = Get-ChildItem -Path (Join-Path $root 'server\src'), (Join-Path $root 'web\src') -Recurse -File |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $newest -or $newest.LastWriteTime -le $proc.CreationDate) {
  Write-Host 'Already running.'
  exit 1
}

$busy = 0
try {
  $q = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/queue" -TimeoutSec 5
  $busy = @($q.running).Count
} catch {}
if ($busy -gt 0) {
  Write-Host "Running an older version, but $busy task(s) are working right now, so it was left alone."
  Write-Host 'To update later: close the minimised "Claude Kanban" window in the taskbar, then double-click again.'
  exit 1
}

Write-Host "Running an older version (started $($proc.CreationDate.ToString('t')), code changed $($newest.LastWriteTime.ToString('t'))). Restarting it..."
# Stops the server and the old launcher window around it: walk up to that window's cmd.exe and end the
# whole tree, so no stale window is left behind saying the board stopped.
# Only npm's and tsx's own processes and the launcher window are climbed: a terminal you started the
# board from yourself is left open.
$top = $proc
for ($i = 0; $i -lt 6; $i++) {
  $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($top.ParentProcessId)"
  if (-not $parent) { break }
  $cl = [string]$parent.CommandLine
  $ours = ($parent.Name -eq 'node.exe' -and ($cl -like '*npm-cli.js*' -or $cl -like '*tsx*')) -or
          ($parent.Name -eq 'cmd.exe' -and ($cl -like '*/d /s /c*' -or $cl -like '*Start Claude Kanban.cmd*'))
  if (-not $ours) { break }
  $top = $parent
  if ($cl -like '*Start Claude Kanban.cmd*') { break }
}
taskkill /PID $top.ProcessId /T /F | Out-Null
for ($i = 0; $i -lt 40; $i++) {
  if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { exit 2 }
  Start-Sleep -Milliseconds 250
}
Write-Host "Port $Port did not free up; opening what is there."
exit 1
