@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Suno API Plus - Stop

set "PORT=3010"
set "PID_FILE=%CD%\.suno-api.pid"
set "NO_PAUSE="
if /I "%~1"=="--no-pause" set "NO_PAUSE=1"

echo.
echo ========================================
echo        Suno API Plus - Stop
echo ========================================
echo.

set "TARGET_PID="
if exist "%PID_FILE%" set /p TARGET_PID=<"%PID_FILE%"

if not defined TARGET_PID goto find_by_port
echo %TARGET_PID%| findstr /r "^[0-9][0-9]*$" >nul
if errorlevel 1 goto clear_stale_pid
powershell.exe -NoProfile -Command "if(Get-Process -Id %TARGET_PID% -ErrorAction SilentlyContinue){exit 0}else{exit 1}" >nul 2>nul
if errorlevel 1 goto clear_stale_pid
goto stop_target

:clear_stale_pid
set "TARGET_PID="
if exist "%PID_FILE%" del /q "%PID_FILE%" >nul 2>nul

:find_by_port
for /f %%P in ('powershell.exe -NoProfile -Command "$c=@(Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue); if($c.Count -gt 0){$c[0].OwningProcess}"') do set "TARGET_PID=%%P"
if not defined TARGET_PID goto not_running

:stop_target
echo [STOP] Stopping the API process tree. PID: %TARGET_PID%
taskkill /PID %TARGET_PID% /T /F >nul 2>nul
if errorlevel 1 goto stop_failed
if exist "%PID_FILE%" del /q "%PID_FILE%" >nul 2>nul

set /a ATTEMPT=0

:wait_for_stop
set "LISTENER_PID="
for /f %%P in ('powershell.exe -NoProfile -Command "$c=@(Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue); if($c.Count -gt 0){$c[0].OwningProcess}"') do set "LISTENER_PID=%%P"
if not defined LISTENER_PID goto stopped
set /a ATTEMPT+=1
if %ATTEMPT% GEQ 15 goto stop_failed
ping 127.0.0.1 -n 2 >nul
goto wait_for_stop

:stopped
echo [OK] API stopped and port %PORT% was released.
goto finish_ok

:not_running
echo [INFO] The API is not running. Nothing to stop.
goto finish_ok

:stop_failed
echo [ERROR] The API could not be stopped. Try running this file as administrator.
goto finish_error

:finish_ok
echo.
if not defined NO_PAUSE pause
exit /b 0

:finish_error
echo.
if not defined NO_PAUSE pause
exit /b 1
