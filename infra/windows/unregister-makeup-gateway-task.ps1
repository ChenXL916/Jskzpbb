[CmdletBinding()]
param(
    [string]$TaskName = 'MakeupOps-Gateway'
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$serviceScript = Join-Path $root 'scripts\makeup-gateway-service.mjs'

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

Get-CimInstance Win32_Process |
    Where-Object {
        ($_.Name -eq 'node.exe' -and $_.CommandLine -like "*$serviceScript*") -or
        ($_.Name -eq 'cloudflared.exe' -and $_.CommandLine -like '*--url http://127.0.0.1:8088*')
    } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
