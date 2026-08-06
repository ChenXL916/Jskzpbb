@echo off
chcp 65001 >nul
cd /d "%~dp0..\apps\web"
if not exist "..\..\.runtime-logs" mkdir "..\..\.runtime-logs"
pnpm.cmd start >> "..\..\.runtime-logs\web.out.log" 2>&1
