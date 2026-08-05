@echo off
chcp 65001 >nul
cd /d "%~dp0.."
if not exist ".runtime-logs" mkdir ".runtime-logs"
node apps\api\dist\main.js >> ".runtime-logs\api.out.log" 2>&1
