# Called by "Start Claude Kanban.cmd": is the board already running, and is it running the code on disk?
# The board keeps running out of sight (by the clock, or in a minimised window), so an old server is easy
# to forget about; double-clicking again used to just reopen it, even after the code changed.
#   exit 0  nothing on the port: start it
#   exit 1  running the current code (or it is busy, or did not say, or the port is someone else's): just open it
#   exit 2  was running older code with nothing in flight, and has been stopped: start it again
param([int]$Port = 4310)

$root = Split-Path -Parent $PSScriptRoot
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $conn) { exit 0 }

$proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)"
# A plain "does it contain" test. -like reads [ and ] in a folder name as a pattern, so a board installed
# under such a folder was never recognised as ours and never restarted.
$cmdLine = [string]$proc.CommandLine
$ignoreCase = [System.StringComparison]::OrdinalIgnoreCase
if (-not $proc -or $cmdLine.IndexOf('src/index.ts', $ignoreCase) -lt 0 -or $cmdLine.IndexOf($root, $ignoreCase) -lt 0) {
  Write-Host "Something else is using port $Port; opening it."
  exit 1
}

# Everything a restart would pick up: the server and the page, the scripts that start them, and the
# list of parts to install (an update that only changes a part touches nothing else).
$files = @(Get-ChildItem -Path (Join-Path $root 'server\src'), (Join-Path $root 'web\src'), (Join-Path $root 'scripts') -Recurse -File -ErrorAction SilentlyContinue)
$lock = Join-Path $root 'package-lock.json'
if (Test-Path $lock) { $files += Get-Item $lock }
$newest = $files | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $newest -or $newest.LastWriteTime -le $proc.CreationDate) {
  Write-Host 'Already running.'
  exit 1
}

# Is it in the middle of anything? Only a clear "no" lets it be stopped. No answer at all (a server too
# busy to reply in time) used to count as "no", and the restart then ended the work it was busy with.
$busy = $null
$what = ''
try {
  $b = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/busy" -TimeoutSec 5
  $busy = [bool]$b.busy
  $parts = @()
  if ($b.tasks -gt 0) { $parts += "$($b.tasks) task(s) working" }
  if ($b.chats -gt 0) { $parts += 'a side chat writing its reply' }
  if ($b.specRewrites -gt 0) { $parts += 'a spec being rewritten' }
  if ($b.setupFixes -gt 0) { $parts += 'an install started from the Setup page' }
  if ($b.terminals -gt 0) { $parts += "$($b.terminals) terminal(s) open" }
  $what = $parts -join ', '
} catch {
  $status = 0
  try { $status = [int]$_.Exception.Response.StatusCode } catch {}
  if ($status -eq 404) {
    # A server from before /api/busy existed: its queue is all it can be asked about.
    try {
      $q = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/queue" -TimeoutSec 5
      $n = @($q.running).Count
      $busy = ($n -gt 0)
      $what = "$n task(s) working"
    } catch {}
  }
}
if ($null -eq $busy) {
  Write-Host 'Running an older version, but it did not answer when asked whether it is busy, so it was left alone.'
  Write-Host 'To update: quit Claude Kanban (right-click its icon by the clock, or close its window in the taskbar), then open it again.'
  exit 1
}
if ($busy) {
  Write-Host "Running an older version, but it is in the middle of something ($what), so it was left alone."
  Write-Host 'To update later: quit Claude Kanban (right-click its icon by the clock, or close its window in the taskbar), then open it again.'
  exit 1
}

Write-Host "Running an older version (started $($proc.CreationDate.ToString('t')), code changed $($newest.LastWriteTime.ToString('t'))). Restarting it..."
# Stops the server and the old launcher around it: walk up to that window's cmd.exe, or to Claude Kanban.exe,
# and end the whole tree, so no stale window or icon is left behind saying the board stopped.
# Only npm's and tsx's own processes and the launchers are climbed: a terminal you started the board from
# yourself is left open.
$top = $proc
for ($i = 0; $i -lt 6; $i++) {
  $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($top.ParentProcessId)"
  if (-not $parent) { break }
  $cl = [string]$parent.CommandLine
  $ours = ($parent.Name -eq 'node.exe' -and ($cl -like '*npm-cli.js*' -or $cl -like '*tsx*')) -or
          ($parent.Name -eq 'cmd.exe' -and ($cl -like '*/d /s /c*' -or $cl -like '*Start Claude Kanban.cmd*')) -or
          ($parent.Name -eq 'Claude Kanban.exe')
  if (-not $ours) { break }
  $top = $parent
  if ($cl -like '*Start Claude Kanban.cmd*' -or $parent.Name -eq 'Claude Kanban.exe') { break }
}
taskkill /PID $top.ProcessId /T /F | Out-Null
for ($i = 0; $i -lt 40; $i++) {
  if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { exit 2 }
  Start-Sleep -Milliseconds 250
}
Write-Host "Port $Port did not free up; opening what is there."
exit 1
