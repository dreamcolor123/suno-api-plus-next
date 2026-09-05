@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Suno Playwright Cookie Login

echo.
echo ========================================
echo    Suno Isolated Playwright Login
echo ========================================
echo.
echo Each run uses a fresh browser context.
echo Do not sign out previously captured accounts.
echo.

where node.exe >nul 2>nul
if errorlevel 1 goto missing_node
where npm.cmd >nul 2>nul
if errorlevel 1 goto missing_node

set "SUNO_LOGIN_PROXY="
for /f "delims=" %%P in ('powershell.exe -NoProfile -Command "$m=@(Select-String -LiteralPath '.env' -Pattern '^SUNO_PROXY_URL=(.*)$'); if($m.Count -gt 0){$m[0].Matches[0].Groups[1].Value.Trim()}"') do set "SUNO_LOGIN_PROXY=%%P"
if defined SUNO_LOGIN_PROXY (
    set "HTTP_PROXY=%SUNO_LOGIN_PROXY%"
    set "HTTPS_PROXY=%SUNO_LOGIN_PROXY%"
    echo [INFO] Proxy: %SUNO_LOGIN_PROXY%
)

if not exist "suno-cookie-extractor\node_modules\playwright\package.json" (
    echo [SETUP] Installing the Playwright extractor...
    pushd "suno-cookie-extractor"
    call npm install --no-audit --no-fund
    set "INSTALL_EXIT=%ERRORLEVEL%"
    popd
    if not "%INSTALL_EXIT%"=="0" goto install_failed
)

set "ACCOUNT_NAME=%~1"
if not defined ACCOUNT_NAME set /p "ACCOUNT_NAME=Account name (for example account-01): "
if not defined ACCOUNT_NAME set "ACCOUNT_NAME=Playwright account"

set "ACCOUNT_TIER="
set /p "ACCOUNT_TIER=Tier [basic/super/heavy] (default basic): "
if not defined ACCOUNT_TIER set "ACCOUNT_TIER=basic"
if /I not "%ACCOUNT_TIER%"=="basic" if /I not "%ACCOUNT_TIER%"=="super" if /I not "%ACCOUNT_TIER%"=="heavy" set "ACCOUNT_TIER=basic"

echo [START] A new isolated browser will open.
echo [ACTION] Complete the Suno login in that browser.
echo.
call npm run get-cookie -- --manual --import-admin --admin-url "http://127.0.0.1:3000" --account-name "%ACCOUNT_NAME%" --tier "%ACCOUNT_TIER%" --timeout 900000
if errorlevel 1 goto extract_failed

echo.
echo [OK] Cookie captured and imported into the admin account pool.
echo [DATA] The encrypted account is stored in data\accounts.json.
start "" "http://127.0.0.1:3000/admin#accounts"
goto finish_ok

:missing_node
echo [ERROR] Node.js or npm was not found.
goto finish_error

:install_failed
echo [ERROR] Playwright installation failed. Check the proxy and npm output.
goto finish_error

:extract_failed
echo [ERROR] Cookie capture failed or timed out.
goto finish_error

:finish_ok
echo.
pause
exit /b 0

:finish_error
echo.
pause
exit /b 1
