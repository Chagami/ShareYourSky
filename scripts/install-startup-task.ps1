#Requires -RunAsAdministrator
<#
    Registers "Share Your Sky" to start at boot.

    A scheduled task rather than a Windows service: nothing extra has to be installed for it,
    it starts before anyone logs in, and whoever is on shift can see and restart it from Task
    Scheduler without a console.

    From an elevated PowerShell, in the repo folder:

        powershell -ExecutionPolicy Bypass -File scripts\install-startup-task.ps1

    ...and to undo it:

        powershell -ExecutionPolicy Bypass -File scripts\install-startup-task.ps1 -Remove
#>
param(
    [switch]$Remove,
    [string]$TaskName = 'Share Your Sky'
)

$ErrorActionPreference = 'Stop'

$repo     = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'start-exhibit.cmd'

if ($Remove) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed '$TaskName'. The exhibit will no longer start at boot." -ForegroundColor Yellow
    } else {
        Write-Host "No '$TaskName' task to remove." -ForegroundColor Yellow
    }
    return
}

if (-not (Test-Path $launcher)) { throw "Cannot find $launcher" }

# SYSTEM rather than a named user: it starts at boot with nobody logged in, it is allowed to
# bind port 443, and it has no password to expire in the middle of a school holiday.
$action    = New-ScheduledTaskAction -Execute $launcher -WorkingDirectory $repo
$trigger   = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

# ExecutionTimeLimit zero is the single most important line here. The default is three days,
# after which Windows kills the task and the exhibit goes dark with nothing in any log to say
# why. The battery and idle switches matter on a laptop or an all-in-one that sleeps.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -DontStopOnIdleEnd `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings `
    -Description 'Serves the Share Your Sky exhibit (tablet interactive and gallery wall).' | Out-Null

Write-Host ""
Write-Host "Registered '$TaskName'." -ForegroundColor Green
Write-Host "  runs       : $launcher"
Write-Host "  working in : $repo"
Write-Host "  as         : SYSTEM, at startup, restarted if it stops"
Write-Host ""

if (-not (Test-Path (Join-Path $PSScriptRoot 'exhibit.env.cmd'))) {
    Write-Host "There is no scripts\exhibit.env.cmd, so the server will use port 4173 and a" -ForegroundColor Yellow
    Write-Host "self-signed certificate. Copy exhibit.env.example.cmd to exhibit.env.cmd and" -ForegroundColor Yellow
    Write-Host "set the real port and certificate before opening." -ForegroundColor Yellow
    Write-Host ""
}

Write-Host "Starting it now, so you can check it without rebooting..."
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 6

$task = Get-ScheduledTask -TaskName $TaskName
$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host "  state      : $($task.State)"
Write-Host "  last result: $($info.LastTaskResult)  (267009 means 'still running', which is what you want)"
Write-Host "  log        : $(Join-Path $repo 'logs\exhibit.log')"
Write-Host ""
