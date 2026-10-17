# Registers the Windows scheduled task that runs backup-scheduled.ps1.
#
#   .\scripts\register-backup-task.ps1
#   .\scripts\register-backup-task.ps1 -At 18:30 -RunNow
#
# Run it in a normal PowerShell window — no elevation needed, because the task
# is registered in your own user context and runs as you.
#
# Re-run it any time to change the schedule; -Force replaces the existing task
# rather than erroring.
#
# Why it's set up the way it is:
#
#   LogonType Interactive  — the backup dumps out of Docker Compose, and Docker
#     Desktop is a user application. "Run whether user is logged on or not"
#     sounds more robust but in practice means the engine often isn't there, and
#     the task fails silently at 2am. Running as a logged-on user is the setting
#     that actually works.
#
#   StartWhenAvailable     — if the machine was off at the scheduled time, run
#     as soon as it next can, instead of skipping the day entirely.
#
#   Batteries allowed      — the default settings refuse to start on battery and
#     kill a running task when the power is unplugged. Neither is what you want
#     from a backup.

[CmdletBinding()]
param(
  [string]$TaskName = 'Budget database backup',

  # 24-hour local time. Pick a time the machine is normally on and you're logged in.
  [string]$At = '13:00',

  [string]$CopyTo = "$HOME\OneDrive\Budget Backup",

  # Register, then immediately run it once as a test.
  [switch]$RunNow
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Target = Join-Path $PSScriptRoot 'backup-scheduled.ps1'

if (-not (Test-Path $Target)) {
  throw "Could not find $Target — run this from the scripts\ folder of the budget repo."
}

$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Target`" -CopyTo `"$CopyTo`"" `
  -WorkingDirectory $RepoRoot

$trigger = New-ScheduledTaskTrigger -Daily -At $At

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -WakeToRun `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
  -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal `
  -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive `
  -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "Dumps the budget Postgres database to backups\ and copies it to $CopyTo. Keeps 30 days in both. Logs each run to backups\backup-log.jsonl." `
  -Force | Out-Null

Write-Host "`n    Registered '$TaskName' — daily at $At." -ForegroundColor Green
Write-Host "    Offsite copy: $CopyTo"
Write-Host "    Log:          $(Join-Path $RepoRoot 'backups\backup-log.jsonl')"

if ($RunNow) {
  Write-Host "`n==> Running it once now..." -ForegroundColor White
  Start-ScheduledTask -TaskName $TaskName

  # Poll rather than sleeping a fixed amount — a first run that has to start
  # Docker Desktop takes a lot longer than one that doesn't.
  $deadline = (Get-Date).AddMinutes(10)
  do {
    Start-Sleep -Seconds 5
    $info = Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo
  } while ($info.LastTaskResult -eq 267009 -and (Get-Date) -lt $deadline)  # 267009 = currently running

  $result = $info.LastTaskResult
  $meaning = switch ($result) {
    0 { 'success — dump written to both locations' }
    1 { 'FAILED — see backups\backup-log.jsonl' }
    2 { 'local dump OK, but the offsite copy did not land' }
    267009 { 'still running after 10 minutes — check back shortly' }
    267011 { 'the task has not reported a result yet — check back shortly' }
    default { "exit code $result" }
  }
  Write-Host "    Last run result: $meaning"
}

Write-Host @"

    Check on it later with:
      Get-ScheduledTask -TaskName "$TaskName" | Get-ScheduledTaskInfo
      Get-Content "$(Join-Path $RepoRoot 'backups\backup-log.jsonl')" -Tail 5

    Remove it with:
      Unregister-ScheduledTask -TaskName "$TaskName" -Confirm:`$false
"@
