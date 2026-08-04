@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "COMFYUI_ROOT=%~dp0"
:find_comfyui_root
if exist "%COMFYUI_ROOT%python_embeded\python.exe" if exist "%COMFYUI_ROOT%ComfyUI\main.py" goto comfyui_root_found
for %%I in ("%COMFYUI_ROOT%..") do set "PARENT_DIR=%%~fI\"
if /i "%PARENT_DIR%"=="%COMFYUI_ROOT%" (
    echo ComfyUI portable root not found
    pause
    exit /b 1
)
set "COMFYUI_ROOT=%PARENT_DIR%"
goto find_comfyui_root

:comfyui_root_found
echo Building frontend...
call npm.cmd run build
if %errorlevel% neq 0 (
    echo Frontend build failed
    pause
    exit /b 1
)

echo Compiling launcher...
"%SystemRoot%\Microsoft.NET\Framework\v4.0.30319\csc.exe" /target:winexe /win32icon:"%~dp0electron\icon.ico" /out:"%~dp0ComfyUI-Agent.exe" "%~dp0launcher.cs" -nologo
if %errorlevel% neq 0 (
    echo Launcher compile failed
    pause
    exit /b 1
)

echo Packing portable app...
if "%~1"=="" (
    set "PUBLISH_DIR=%~dp0"
) else (
    for %%I in ("%~f1.") do set "PUBLISH_DIR=%%~fI"
)
set "OUTDIR=%PUBLISH_DIR%\dist-portable"
if "%~1"=="" (
    set "COMFYUI_ROOT_FROM_APP=..\..\..\.."
) else (
    set "COMFYUI_ROOT_FROM_APP=%COMFYUI_ROOT%"
)
set "APPDIR=%OUTDIR%\resources\app"

if exist "%OUTDIR%" (
    rmdir /s /q "%OUTDIR%"
    if exist "%OUTDIR%" (
        echo Portable app is still running. Close it and build again.
        exit /b 1
    )
)

mkdir "%APPDIR%\electron" "%APPDIR%\dist" "%APPDIR%\src" "%APPDIR%\scripts"

xcopy /e /i /q "node_modules\electron\dist" "%OUTDIR%" >nul
if errorlevel 2 (
    echo Electron runtime packaging failed
    exit /b 1
)
copy /y "package.json" "%APPDIR%\" >nul
if errorlevel 1 (
    echo Package manifest packaging failed
    exit /b 1
)
copy /y "comfy-client.mjs" "%APPDIR%\" >nul
if errorlevel 1 (
    echo ComfyUI client packaging failed
    exit /b 1
)
copy /y "electron\main.mjs" "%APPDIR%\electron\" >nul
if errorlevel 1 (
    echo Electron main process packaging failed
    exit /b 1
)
copy /y "electron\preload.cjs" "%APPDIR%\electron\" >nul
if errorlevel 1 (
    echo Electron preload packaging failed
    exit /b 1
)
copy /y "electron\comfyui-manager.mjs" "%APPDIR%\electron\" >nul
if errorlevel 1 (
    echo ComfyUI manager packaging failed
    exit /b 1
)
copy /y "electron\agent-process.mjs" "%APPDIR%\electron\" >nul
if errorlevel 1 (
    echo Agent process packaging failed
    exit /b 1
)
copy /y "electron\agent-worker.mjs" "%APPDIR%\electron\" >nul
if errorlevel 1 (
    echo Agent worker packaging failed
    exit /b 1
)
copy /y "electron\execution-coordinator.mjs" "%APPDIR%\electron\" >nul
if errorlevel 1 (
    echo Execution coordinator packaging failed
    exit /b 1
)
copy /y "electron\request-ledger.mjs" "%APPDIR%\electron\" >nul
if errorlevel 1 (
    echo Request ledger packaging failed
    exit /b 1
)
copy /y "electron\job-object-host.ps1" "%APPDIR%\electron\" >nul
if errorlevel 1 (
    echo Job host packaging failed
    exit /b 1
)
copy /y "electron\icon.ico" "%APPDIR%\electron\" >nul
if errorlevel 1 (
    echo Application icon packaging failed
    exit /b 1
)
xcopy /e /i /q "dist" "%APPDIR%\dist" >nul
if errorlevel 2 (
    echo Frontend packaging failed
    exit /b 1
)
xcopy /e /i /q "src" "%APPDIR%\src" >nul
if errorlevel 2 (
    echo Source packaging failed
    exit /b 1
)
copy /y "scripts\verify-comfyui-recovery.mjs" "%APPDIR%\scripts\" >nul
if errorlevel 1 (
    echo Recovery verification script packaging failed
    exit /b 1
)
>"%APPDIR%\comfyui-root.txt" echo %COMFYUI_ROOT_FROM_APP%
copy /y "ComfyUI-Agent.exe" "%OUTDIR%\" >nul
if errorlevel 1 (
    echo Launcher packaging failed
    exit /b 1
)

if not "%~1"=="" copy /y "ComfyUI-Agent.exe" "%PUBLISH_DIR%\" >nul
if errorlevel 1 if not "%~1"=="" (
    echo Desktop launcher update failed
    exit /b 1
)

node.exe "scripts\verify-packaged-runtime.mjs" "%APPDIR%"
if errorlevel 1 (
    echo Packaged runtime validation failed
    exit /b 1
)

if not exist "%APPDIR%\src\agent\index.mjs" (
    echo Agent runtime packaging failed
    exit /b 1
)
if not exist "%APPDIR%\src\runtime\direct\direct-service.mjs" (
    echo Direct runtime packaging failed
    exit /b 1
)
if not exist "%APPDIR%\src\config\modelProfiles.json" (
    echo Model profile packaging failed
    exit /b 1
)
if not exist "%APPDIR%\src\ui-preferences.mjs" (
    echo UI preferences packaging failed
    exit /b 1
)
if not exist "%APPDIR%\electron\main.mjs" (
    echo Electron main process packaging failed
    exit /b 1
)
if not exist "%APPDIR%\electron\execution-coordinator.mjs" (
    echo Execution coordinator packaging failed
    exit /b 1
)
if not exist "%APPDIR%\electron\request-ledger.mjs" (
    echo Request ledger packaging failed
    exit /b 1
)
if not exist "%APPDIR%\scripts\verify-comfyui-recovery.mjs" (
    echo Recovery verification script packaging failed
    exit /b 1
)
if not exist "%APPDIR%\dist\index.html" (
    echo Frontend packaging failed
    exit /b 1
)
if not exist "%OUTDIR%\electron.exe" (
    echo Electron runtime packaging failed
    exit /b 1
)
if not exist "%OUTDIR%\ComfyUI-Agent.exe" (
    echo Portable launcher packaging failed
    exit /b 1
)

echo Writing usage guide...
copy /y "%~dp0dist-readme.txt" "%OUTDIR%\使用说明.txt" >nul
if errorlevel 1 (
    echo Usage guide packaging failed
    exit /b 1
)

echo Creating distribution zip...
for /f "usebackq delims=" %%V in (`node -p "JSON.parse(require('fs').readFileSync('package.json','utf8')).version"`) do set "APP_VERSION=%%V"
set "ZIP_NAME=ComfyUI-Agent-portable-v%APP_VERSION%.zip"
if exist "%ZIP_NAME%" del /q "%ZIP_NAME%"
powershell -NoProfile -Command "Compress-Archive -Path '%OUTDIR%\*' -DestinationPath '%ZIP_NAME%' -Force"
if errorlevel 1 (
    echo Distribution zip failed
    exit /b 1
)

echo Done!
echo.
if "%~1"=="" (
    echo Launch: %OUTDIR%\ComfyUI-Agent.exe
) else (
    echo Launch: %PUBLISH_DIR%\ComfyUI-Agent.exe
)
echo Package: %~dp0%ZIP_NAME%
echo.
pause
