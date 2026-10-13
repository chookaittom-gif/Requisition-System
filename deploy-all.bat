@echo off
chcp 65001 > nul
setlocal
set "MSG=%~1"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-all.ps1" "%MSG%"
exit /b %ERRORLEVEL%
