@echo off
REM Double-click to start Claude Kanban and open it in the browser.
REM Builds the UI if needed, serves everything from http://127.0.0.1:4310, keeps this window as the log.
title Claude Kanban
cd /d "%~dp0"

echo Claude Kanban
echo ----------------------------------------

REM Node.js 24 or newer runs the board. Say so plainly, and open the download page, when it is missing.
where node >nul 2>&1
if errorlevel 1 goto :nonode
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"
if errorlevel 1 goto :oldnode

REM Already running? Open it - unless it is running older code than what is on disk, then restart it.
REM Exit codes: 0 not running, 1 open the running one, 2 old one stopped (see scripts\launcher-check.ps1).
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\launcher-check.ps1"
if errorlevel 2 goto :start
if errorlevel 1 goto :open

:start
REM Install the parts on the first run, and again whenever an update changed them.
if not exist "node_modules\.package-lock.json" goto :install
powershell -NoProfile -Command "exit [int]((Get-Item 'package-lock.json').LastWriteTime -gt (Get-Item 'node_modules\.package-lock.json').LastWriteTime)"
if errorlevel 1 goto :install
goto :build

:install
echo Installing its parts - a minute or two, first run only...
call npm install --no-audit --no-fund || goto :fail

:build
echo Building the UI...
call npm run build || goto :fail

REM First run from a download: put the Claude Kanban icon on the Desktop and in the Start menu.
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\create-shortcut.ps1" -IfMissing >nul 2>&1

echo Starting the server on http://127.0.0.1:4310
start "" "http://127.0.0.1:4310"
call npm run start -w server

REM The server only ends on its own when something went wrong: keep the message on screen.
echo.
echo ----------------------------------------
echo The board stopped. The lines above say why.
echo Press any key to start it again, or close this window.
pause >nul
goto :start

:open
start "" "http://127.0.0.1:4310"
timeout /t 5 >nul
exit /b 0

:nonode
echo.
echo Claude Kanban needs Node.js 24 or newer, and it is not installed.
echo Opening the download page: install the LTS version, then double-click this file again.
start "" "https://nodejs.org/en/download"
pause
exit /b 1

:oldnode
echo.
echo Claude Kanban needs Node.js 24 or newer. This computer has an older one:
node -v
echo Opening the download page: install the LTS version, then double-click this file again.
start "" "https://nodejs.org/en/download"
pause
exit /b 1

:fail
echo.
echo Something failed above. Fix it, then run this file again.
echo Help: https://github.com/husseinalnahi-iq/Claude-Kanban#if-something-goes-wrong
pause
exit /b 1
