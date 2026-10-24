@echo off
rem Royal Tasks - starts the PHP web server and opens the app in your browser.
rem The app is a single directory: this folder is the document root.
setlocal
cd /d "%~dp0"

where php >nul 2>nul
if errorlevel 1 (
    echo [ERROR] PHP was not found on PATH.
    echo Install PHP 8.4+ and try again: https://www.php.net/downloads
    pause
    exit /b 1
)

set PORT=8080

rem Start the built-in PHP web server (minimized). Close its window to stop it.
rem "%~dp0." and not "%~dp0": %~dp0 ends in a backslash, and a trailing \ before
rem the closing quote escapes it, so php would get a mangled -t path.
start "Royal Tasks Server" /min php -d upload_max_filesize=32M -d post_max_size=130M -S 127.0.0.1:%PORT% -t "%~dp0." "%~dp0router.php"

rem Give the server a moment to come up, then launch the browser.
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:%PORT%/"

echo.
echo  Royal Tasks is running at http://127.0.0.1:%PORT%/
echo.
if exist "%~dp0config.php" (
    echo  Sign in with your administrator account.
) else (
    echo  FIRST RUN: open http://127.0.0.1:%PORT%/install.php to set up
    echo  the database and create the master account.
)
echo.
echo  To stop the server, close the "Royal Tasks Server" window.
echo.
pause
