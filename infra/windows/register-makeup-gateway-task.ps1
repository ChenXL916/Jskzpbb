[CmdletBinding()]
param(
    [string]$TaskName = 'MakeupOps-Gateway'
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$serviceScript = Join-Path $root 'scripts\makeup-gateway-service.mjs'
$cloudflared = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
$node = (Get-Command node -ErrorAction Stop).Source
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

foreach ($requiredPath in @($serviceScript, $cloudflared, (Join-Path $root 'apps\api\dist\main.js'))) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Missing makeup gateway runtime file: $requiredPath"
    }
}
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw 'GitHub CLI is required to publish the isolated Quick Tunnel origin.'
}

$action = New-ScheduledTaskAction `
    -Execute $node `
    -Argument "`"$serviceScript`"" `
    -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$principal = New-ScheduledTaskPrincipal `
    -UserId $currentUser `
    -LogonType Interactive `
    -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -RestartCount 99 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description 'Makeup scheduling web gateway and isolated Cloudflare runtime-origin publication.' `
    -Force | Out-Null

Get-ScheduledTask -TaskName $TaskName |
    Select-Object TaskName, State, Author, Description
