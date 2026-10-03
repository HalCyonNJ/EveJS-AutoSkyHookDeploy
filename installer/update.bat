@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

echo ============================================================
echo   Auto Skyhook Deploy - Update
echo ============================================================
echo.
echo   Usage:
echo     update.bat                                   (EveJS found automatically)
echo     update.bat --server "C:\path\to\EveJS"
echo     update.bat --server "C:\path\to\EveJS" --dry-run
echo.
echo   With no arguments this assumes EveJS is installed on this computer
echo   and looks for it: beside this folder, above it, and failing that
echo   deeper in the tree. Pass --server only to override that.
echo.
echo   Replaces mods\autoSkyHookDeploy with the version in this package
echo   and re-applies the preload for every deployment it finds. Your
echo   config and a local .env are never overwritten, and the folder being
echo   replaced is archived under ^<EveJS root^>\_autoskyhookdeploy-backup
echo   first.
echo.
echo   After it finishes: rebuild Docker, or restart the native server.
echo.
echo ------------------------------------------------------------
echo.

node "update.js" %*
set RC=%ERRORLEVEL%
echo.
echo ------------------------------------------------------------
echo   Exit code: %RC%
if not "%RC%"=="0" echo   (non-zero = failed, see messages above)
echo.
pause
exit /b %RC%

:nonode
echo.
echo [ERROR] Node.js was not found in PATH.
echo         This package needs Node.js 18 or newer.
echo         Download: https://nodejs.org/
echo.
pause
exit /b 1
