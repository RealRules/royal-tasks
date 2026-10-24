@echo off
rem ---------------------------------------------------------------------------
rem  copyinstall.bat - copy Royal Tasks' runtime files to an installation.
rem
rem    copyinstall.bat <installation folder>
rem
rem  Copies only what the app needs to run: api\, src\, assets\ and the files
rem  in the app root (index.html, manifest.json, sw.js, install.php,
rem  upgrade.php, config.example.php).
rem
rem  Never touched in the installation:
rem    config.php   its database connection (written there by install.php)
rem    uploads\     card attachments, i.e. user data
rem    .htaccess / .user.ini   hardening written by install.php for that host
rem
rem  api\, src\ and assets\ are mirrored, so a file deleted here is deleted
rem  there as well (except the hardening files above). Not copied: tests,
rem  styles (source), scripts, node_modules, deploy, docs and the dev server.
rem
rem  Afterwards, run the database upgrade on the installation:
rem    php upgrade.php          (or open upgrade.php as an administrator)
rem ---------------------------------------------------------------------------
setlocal EnableExtensions

if "%~1"=="" (
  echo Usage: %~nx0 ^<installation folder^>
  echo Copies Royal Tasks' runtime files there; config.php and uploads\ are left alone.
  exit /b 1
)

set "SRC=%~dp0"
set "SRC=%SRC:~0,-1%"
set "DEST=%~f1"

if /i "%DEST%"=="%SRC%" (
  echo Refusing to copy the project onto itself: %DEST%
  exit /b 1
)
if not exist "%SRC%\index.html" (
  echo This script must sit in the Royal Tasks project folder.
  exit /b 1
)
if not exist "%DEST%" mkdir "%DEST%" || exit /b 1

echo Copying Royal Tasks
echo   from %SRC%
echo   to   %DEST%

set "RC=/NFL /NDL /NJH /NJS /NP /R:1 /W:1"
set "KEEP=/XF .htaccess .user.ini"

for %%D in (api src assets) do (
  robocopy "%SRC%\%%D" "%DEST%\%%D" /MIR %KEEP% %RC%
  if errorlevel 8 (
    echo Failed copying %%D\
    exit /b 1
  )
)

robocopy "%SRC%" "%DEST%" index.html manifest.json sw.js install.php upgrade.php config.example.php %RC%
if errorlevel 8 (
  echo Failed copying the root files.
  exit /b 1
)

echo Done.
if exist "%DEST%\config.php" (
  echo Now apply any database updates on the installation: php upgrade.php
) else (
  echo Not installed there yet: open install.php on that server to set it up.
)
exit /b 0
