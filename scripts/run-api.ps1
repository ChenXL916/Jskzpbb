$ErrorActionPreference = 'Stop'
$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logDirectory = Join-Path $workspaceRoot '.runtime-logs'
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null

$apiProcess = Start-Process `
  -FilePath 'node' `
  -ArgumentList 'apps/api/dist/main.js' `
  -WorkingDirectory $workspaceRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logDirectory 'api.out.log') `
  -RedirectStandardError (Join-Path $logDirectory 'api.err.log') `
  -PassThru `
  -Wait
exit $apiProcess.ExitCode
