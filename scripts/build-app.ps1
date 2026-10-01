# Builds "Claude Kanban.exe": the board's startup screen and its icon by the clock (scripts\app\ClaudeKanban.cs).
# It is built on each computer, with the C# compiler that is part of Windows (.NET Framework 4.8), so there
# is nothing to install and no program is downloaded. create-shortcut.ps1 runs this; Claude Kanban.exe
# runs it itself when an update changed its source.
#   exit 0  built, or already up to date
#   exit 1  could not be built (the lines printed say why): the .cmd launcher still works
param([switch]$Force)

$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $PSScriptRoot 'app\ClaudeKanban.cs'
$exe = Join-Path $root 'Claude Kanban.exe'
$icon = Join-Path $root 'assets\claude-kanban.ico'

if (-not $Force -and (Test-Path $exe) -and (Get-Item $exe).LastWriteTimeUtc -ge (Get-Item $src).LastWriteTimeUtc) { exit 0 }

# Not [RuntimeEnvironment]::GetRuntimeDirectory(): in PowerShell 7 that is .NET's folder, which has no csc.exe.
$csc = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) {
  Write-Output 'No C# compiler on this computer: it comes with .NET Framework 4.8, which is part of Windows 10 and 11.'
  exit 1
}
if (-not (Test-Path $icon)) { & node (Join-Path $root 'scripts\make-icon.mjs') | Out-Null }

$new = Join-Path $root 'Claude Kanban.new.exe'
Remove-Item $new -Force -ErrorAction SilentlyContinue
# /codepage:65001: the source is UTF-8 (its dashes and ellipses), which this compiler does not assume.
$out = & $csc /nologo /target:winexe /optimize+ /codepage:65001 "/out:$new" "/win32icon:$icon" `
  /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll $src 2>&1
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $new)) {
  $out | ForEach-Object { Write-Output "$_" }
  exit 1
}

# A running program cannot be overwritten, but it can be renamed: the copy running now carries on under
# an .old name, and the next start deletes it.
if (Test-Path $exe) {
  $old = Join-Path $root ("Claude Kanban.old-{0}.exe" -f (Get-Date -Format 'yyyyMMddHHmmss'))
  try { Move-Item $exe $old -Force -ErrorAction Stop } catch { Write-Output "Could not replace $exe`: $_"; Remove-Item $new -Force -ErrorAction SilentlyContinue; exit 1 }
}
Move-Item $new $exe -Force
Write-Output "built $exe"
exit 0
