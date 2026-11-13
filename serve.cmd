@echo off
rem ===========================================================================
rem serve.cmd -- MdWeChat LAN preview launcher. Double-click this file.
rem
rem KEEP THIS FILE PURE ASCII AND CRLF. Do not "restore" Chinese comments here.
rem   cmd.exe tracks its position inside a batch file by BYTE OFFSET. With
rem   multi-byte (Chinese) text in the file, running "chcp 65001" makes cmd
rem   re-read that offset under the new code page and jump to the wrong place.
rem   The script then never reaches the final "pause" and the window flashes
rem   open and closes instantly. Chinese console output lives in serve.py
rem   instead -- Python 3.6+ writes Unicode straight to the Windows console,
rem   so no chcp is needed at all.
rem   Full reasoning in Chinese is in the serve.py header.
rem
rem WHY NOT "python -m http.server":
rem   The phone cannot read the PC's localStorage, so both devices need a
rem   shared landing spot. serve.py serves the static files and adds a /sync
rem   route the PC can POST into and the phone can poll.
rem
rem USAGE: put phone and PC on the same WiFi, double-click this file, then
rem        click "phone preview" in index.html and scan the QR code.
rem ===========================================================================
setlocal
cd /d "%~dp0"

set "PORT=8000"
if not "%~1"=="" set "PORT=%~1"

where python >nul 2>nul
if errorlevel 1 goto nopython

rem serve.py prints the phone URL and serves both the static files and /sync.
python "%~dp0serve.py" %PORT%
set "CODE=%errorlevel%"

echo.
echo   Server stopped (exit code %CODE%).
pause
exit /b %CODE%

:nopython
echo [ERROR] "python" was not found on PATH.
echo         Install Python 3 and tick "Add Python to PATH" during setup,
echo         then reopen this window.
echo         Without Python you can run "npx serve ." in this folder instead,
echo         but then the phone will NOT see live edits from the PC.
echo.
pause
exit /b 1
