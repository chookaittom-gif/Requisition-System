@echo off
chcp 65001 > nul
setlocal
set "MSG=%~1"
if "%~1"=="" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-all.ps1"
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-all.ps1" %*
)
exit /b %ERRORLEVEL%
