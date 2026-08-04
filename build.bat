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

echo Packaging with electron-builder...
call npx electron-builder --win --config electron-builder.yml
if %errorlevel% neq 0 (
    echo Packaging failed
    pause
    exit /b 1
)

echo Done! Check releases\ folder.
pause
