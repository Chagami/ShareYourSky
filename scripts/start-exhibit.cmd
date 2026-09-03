@echo off
setlocal

rem  Share Your Sky - the exhibit server.
rem
rem  Started by the scheduled task at boot (see install-startup-task.ps1), and safe to
rem  double-click for a test run. Everything it prints goes to logs\exhibit.log.
rem
rem  It serves the built site in dist\, which is committed, so a fresh clone needs no build
rem  step. After changing anything under js\ or css\, run "npm run build" or the exhibit will
rem  go on serving the old version.

cd /d "%~dp0.."
if errorlevel 1 exit /b 1

rem  Port and certificate differ per machine, and the certificate paths are local, so they
rem  live in a file that is not in git. Without one the defaults are port 4173 and a
rem  self-signed certificate: fine for a bench test, not for the floor.
if exist "scripts\exhibit.env.cmd" call "scripts\exhibit.env.cmd"

if not exist "logs" mkdir "logs"
set "LOG=logs\exhibit.log"

rem  The log is a file, not a terminal. Without this Vite writes colour escapes
rem  into it and the whole thing is unreadable in Notepad at eight in the morning.
set "NO_COLOR=1"
set "FORCE_COLOR=0"

rem  Resolve node explicitly. The SYSTEM account's PATH is not the one you see in your own
rem  terminal, and npm is a batch shim that swallows the real exit code.
set "NODE="
for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined NODE set "NODE=%%N"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE (
  echo [%date% %time%] node.exe not found - install Node or add it to the system PATH>>"%LOG%"
  exit /b 9009
)

:run

rem  Keep the log from growing without bound across months of daily restarts. One previous
rem  file is kept, which is one more than is usually wanted.
if exist "%LOG%" for %%A in ("%LOG%") do if %%~zA GTR 5000000 (
  if exist "logs\exhibit.prev.log" del "logs\exhibit.prev.log"
  move /y "%LOG%" "logs\exhibit.prev.log" >nul
)

echo.>>"%LOG%"
echo [%date% %time%] starting - port=%SKY_PORT% cert=%SKY_CERT%>>"%LOG%"
"%NODE%" "node_modules\vite\bin\vite.js" preview >>"%LOG%" 2>&1
echo [%date% %time%] server exited with %errorlevel% - restarting in 5s>>"%LOG%"

rem  Restart it here rather than leaning on the task's restart-on-failure, which only fires
rem  when a task *fails* - a server that exits cleanly would otherwise stay down until
rem  somebody noticed. ping, not timeout: timeout wants a console and there is none as SYSTEM.
ping -n 6 127.0.0.1 >nul
goto run
