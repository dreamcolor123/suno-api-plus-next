@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Suno API Plus - Start

set "HOST=127.0.0.1"
set "PORT=3010"
set "PID_FILE=%CD%\.suno-api.pid"
set "NO_PAUSE="
if /I "%~1"=="--no-pause" set "NO_PAUSE=1"

echo.
echo ========================================
echo        Suno API Plus - Start
echo ========================================
echo.

where node.exe >nul 2>nul
if errorlevel 1 goto missing_node

where npm.cmd >nul 2>nul
if errorlevel 1 goto missing_node

if not exist ".env" goto missing_env

set "RUNNING_PID="
for /f %%P in ('powershell.exe -NoProfile -Command "$c=@(Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue); if($c.Count -gt 0){$c[0].OwningProcess}"') do set "RUNNING_PID=%%P"
if defined RUNNING_PID goto already_running

if exist "%PID_FILE%" del /q "%PID_FILE%" >nul 2>nul

if not exist "node_modules\" (
    echo [SETUP] Installing dependencies. This may take a while...
    call npm ci --no-audit --no-fund
    if errorlevel 1 goto install_failed
)

if not exist ".next\BUILD_ID" (
    echo [SETUP] Production build not found. Building the project...
    call npm run build
    if errorlevel 1 goto build_failed
)

echo [START] Starting the API in the background...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$root=(Get-Location).Path; $node=(Get-Command node.exe).Source; $p=Start-Process -FilePath $node -ArgumentList @('node_modules/next/dist/bin/next','start','-H','%HOST%','-p','%PORT%') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $root 'suno-api.out.log') -RedirectStandardError (Join-Path $root 'suno-api.err.log') -PassThru; [IO.File]::WriteAllText((Join-Path $root '.suno-api.pid'), [string]$p.Id)"
if errorlevel 1 goto start_failed

set /a ATTEMPT=0

:wait_for_start
set "LISTENER_PID="
for /f %%P in ('powershell.exe -NoProfile -Command "$c=@(Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue); if($c.Count -gt 0){$c[0].OwningProcess}"') do set "LISTENER_PID=%%P"
if defined LISTENER_PID goto started
set /a ATTEMPT+=1
if %ATTEMPT% GEQ 30 goto start_failed
ping 127.0.0.1 -n 2 >nul
goto wait_for_start

:started
echo.
echo [OK] API started successfully in the background.
echo [URL] Admin: http://%HOST%:%PORT%/admin
echo [URL] API docs: http://%HOST%:%PORT%/docs
echo [LOG] %CD%\suno-api.out.log
goto finish_ok

:already_running
echo [INFO] Port %PORT% is already listening. Nothing to start. PID: %RUNNING_PID%
echo [URL] Admin: http://%HOST%:%PORT%/admin
goto finish_ok

:missing_node
echo [ERROR] Node.js or npm was not found. Install Node.js first.
goto finish_error

:missing_env
echo [ERROR] The .env configuration file was not found.
echo         Copy .env.example to .env and configure it first.
goto finish_error

:install_failed
echo [ERROR] npm dependency installation failed. Check the network and npm logs.
goto finish_error

:build_failed
echo [ERROR] The production build failed. Review the output above.
goto finish_error

:start_failed
echo [ERROR] The API did not start within 30 seconds.
echo         Check suno-api.err.log and suno-api.out.log.
if exist "suno-api.err.log" powershell.exe -NoProfile -Command "Get-Content -LiteralPath 'suno-api.err.log' -Tail 20"
goto finish_error

:finish_ok
echo.
if not defined NO_PAUSE pause
exit /b 0

:finish_error
echo.
if not defined NO_PAUSE pause
exit /b 1
