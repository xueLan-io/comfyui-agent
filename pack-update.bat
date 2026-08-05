@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo Building frontend...
call npm.cmd run build
if %errorlevel% neq 0 (
    echo Frontend build failed
    exit /b 1
)

echo Creating application-only update package...
node.exe "scripts\create-update-package.mjs"
if %errorlevel% neq 0 (
    echo Update package failed
    exit /b 1
)

echo Done. Electron runtime is not included in the update package.
