@echo off
setlocal
if "%1"=="" goto help
if /I "%1"=="install" goto install
if /I "%1"=="infra" goto infra
if /I "%1"=="migrate" goto migrate
if /I "%1"=="dev" goto dev
if /I "%1"=="check" goto check
if /I "%1"=="up" goto up
if /I "%1"=="down" goto down
goto help

:install
call pnpm.cmd install --frozen-lockfile
exit /b %errorlevel%

:infra
call :compose up -d postgres redis minio
exit /b %errorlevel%

:migrate
call pnpm.cmd run db:migrate
exit /b %errorlevel%

:dev
call pnpm.cmd run dev
exit /b %errorlevel%

:check
call pnpm.cmd run check
exit /b %errorlevel%

:up
call :compose up -d --build
exit /b %errorlevel%

:down
call :compose down
exit /b %errorlevel%

:compose
where docker >nul 2>nul
if %errorlevel% equ 0 (
  docker compose -p jishi-scheduling %*
) else (
  wsl.exe -d Ubuntu-24.04 --cd "%CD%" -- docker compose -p jishi-scheduling %*
)
exit /b %errorlevel%

:help
echo Usage: make.cmd install^|infra^|migrate^|dev^|check^|up^|down
exit /b 1
