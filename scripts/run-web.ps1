$ErrorActionPreference = 'Stop'
$env:PORT = '8088'
$env:HOSTNAME = '0.0.0.0'
$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$webDirectory = Join-Path $workspaceRoot 'apps\web'
$logDirectory = Join-Path $workspaceRoot '.runtime-logs'
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$webProcess = Start-Process `
  -FilePath 'pnpm.cmd' `
  -ArgumentList 'start' `
  -WorkingDirectory $webDirectory `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logDirectory 'web.out.log') `
  -RedirectStandardError (Join-Path $logDirectory 'web.err.log') `
  -PassThru `
  -Wait
exit $webProcess.ExitCode
