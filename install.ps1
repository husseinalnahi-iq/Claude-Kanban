# Claude Kanban installer for Windows 10 / 11.
#
# Paste this into PowerShell (Start menu -> type "PowerShell" -> Enter):
#
#   irm https://raw.githubusercontent.com/husseinalnahi-iq/Claude-Kanban/main/install.ps1 | iex
#
# It installs what is missing (Node.js 24 or newer, Git) with Windows' own installer (winget),
# downloads Claude Kanban into your user folder, puts a "Claude Kanban" icon on your Desktop and in
# the Start menu, and opens the board. Run the same line again to update to the newest version.
#
# Options, set before the line above (all optional):
#   $env:KANBAN_DIR = "D:\Apps\Claude Kanban"   # where to put it (default: your user folder)
#   $env:KANBAN_NO_LAUNCH = "1"                  # do not open it at the end
#   $env:KANBAN_NO_SHORTCUT = "1"                # do not create the icons

# Everything is inside a function so a problem ends the installer, not your PowerShell window.
function Install-ClaudeKanban {
  # Not 'Stop': git and npm print progress on stderr, which Windows PowerShell 5.1 would turn into a
  # failure. Every program's exit code is checked instead.
  $ErrorActionPreference = 'Continue'
  $repo = if ($env:KANBAN_REPO) { $env:KANBAN_REPO } else { 'https://github.com/husseinalnahi-iq/Claude-Kanban.git' }
  $dir = if ($env:KANBAN_DIR) { $env:KANBAN_DIR } else { Join-Path $env:USERPROFILE 'Claude Kanban' }

  function Say([string]$m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
  function Fail([string]$m) {
    Write-Host "`nX $m" -ForegroundColor Red
    Write-Host "  Help: https://github.com/husseinalnahi-iq/Claude-Kanban#if-something-goes-wrong" -ForegroundColor DarkGray
  }
  function Has([string]$cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
  # A program winget just installed is not on this window's PATH until it is re-read.
  function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  }
  function Node-Major {
    if (-not (Has 'node')) { return 0 }
    try { return [int]((& node -v) -replace '^v(\d+).*', '$1') } catch { return 0 }
  }
  function Winget-Install([string]$id, [string]$name) {
    if (-not (Has 'winget')) {
      Fail "$name is needed, and this Windows has no 'winget' to install it. Install $name yourself, then run this line again."
      return $false
    }
    Say "Installing $name (Windows may ask for permission)..."
    & winget install --id $id -e --accept-package-agreements --accept-source-agreements --silent
    Refresh-Path
    return $true
  }

  Write-Host 'Claude Kanban installer' -ForegroundColor White
  Write-Host "Folder: $dir" -ForegroundColor DarkGray

  # 1. Node.js 24 or newer: the board runs on it (it uses Node's built-in SQLite).
  if ((Node-Major) -lt 24) {
    $had = Node-Major
    if (-not (Winget-Install 'OpenJS.NodeJS.LTS' 'Node.js')) { start 'https://nodejs.org/en/download'; return }
    if ((Node-Major) -lt 24) {
      if ($had -gt 0) {
        Fail "Node.js $had is installed, but the board needs 24 or newer. Update Node.js from https://nodejs.org (the LTS version), close this window, and run the line again in a new one."
      } else {
        Fail 'Node.js was installed, but this window cannot see it yet. Close PowerShell, open a new one, and run the same line again.'
      }
      return
    }
  }
  Write-Host "Node.js $(& node -v)  OK" -ForegroundColor Green

  # 2. Git: to download and update the board, and because the board works in git repositories.
  if (-not (Has 'git')) {
    if (-not (Winget-Install 'Git.Git' 'Git')) { start 'https://git-scm.com/download/win'; return }
    if (-not (Has 'git')) { Fail 'Git was installed, but this window cannot see it yet. Close PowerShell, open a new one, and run the same line again.'; return }
  }
  Write-Host "$(& git --version)  OK" -ForegroundColor Green

  # 3. Download, or update an earlier download.
  if (Test-Path (Join-Path $dir '.git')) {
    Say 'Updating Claude Kanban to the newest version...'
    & git -C $dir pull --ff-only
    if ($LASTEXITCODE -ne 0) { Fail "Could not update $dir. If you changed files in it, move them out, delete the folder, and run the line again."; return }
  } elseif ((Test-Path $dir) -and (Get-ChildItem $dir -Force | Select-Object -First 1)) {
    Fail "$dir already exists and is not a Claude Kanban download. Move or rename it, or choose another folder with `$env:KANBAN_DIR."
    return
  } else {
    Say 'Downloading Claude Kanban...'
    & git clone --depth 1 $repo $dir
    if ($LASTEXITCODE -ne 0) { Fail 'Could not download from GitHub. Check your internet connection and run the line again.'; return }
  }

  # 4. Its parts, and the web page it shows. npm.cmd, not npm: npm.ps1 may be blocked by script policy.
  Push-Location $dir
  try {
    Say 'Installing its parts (a minute or two the first time)...'
    & npm.cmd install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { Fail 'npm install failed; the lines above say why.'; return }
    Say 'Building the board...'
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { Fail 'The build failed; the lines above say why.'; return }
  } finally {
    Pop-Location
  }

  # 5. The icon on the Desktop and in the Start menu.
  if (-not $env:KANBAN_NO_SHORTCUT) {
    Say 'Adding the Claude Kanban icon to your Desktop and Start menu...'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir 'scripts\create-shortcut.ps1') | Out-Null
  }

  Write-Host "`nDone. Claude Kanban is installed in $dir" -ForegroundColor Green
  Write-Host '  - Open it any time with the "Claude Kanban" icon on your Desktop (or in the Start menu).'
  Write-Host '  - It opens in your browser. The first time, the Setup page walks you through logging in to Claude.'
  Write-Host '  - To update later, run the same install line again.'

  # 6. Open it. The launcher restarts an older copy that is already running.
  if (-not $env:KANBAN_NO_LAUNCH) {
    Start-Process (Join-Path $dir 'Start Claude Kanban.cmd') -WorkingDirectory $dir -WindowStyle Minimized
  }
}

Install-ClaudeKanban
