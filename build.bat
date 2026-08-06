@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo Building frontend...
call npm.cmd run build
if %errorlevel% neq 0 (
    echo Build failed
    pause
    exit /b 1
)

echo Packaging portable desktop app with the existing Electron runtime...
call pack-portable.bat
if %errorlevel% neq 0 (
    echo Packaging failed
    pause
    exit /b 1
)

echo Installer done! Check releases\ folder.
pause
