# Unattended wrapper around backup-local.ps1, for the Windows scheduled task.
#
#   .\scripts\backup-scheduled.ps1
#   .\scripts\backup-scheduled.ps1 -CopyTo "D:\some\other\place"
#
# backup-local.ps1 assumes the Docker Compose stack is already up and fails fast
# if it isn't — correct when you run it by hand, useless on a schedule, where
# nobody sees the error. This wrapper makes the run self-sufficient:
#
#   1. starts the Docker engine if it isn't running, and waits for it
#   2. brings up the 'db' service and waits for Postgres to accept connections
#   3. runs backup-local.ps1
#   4. confirms the dump actually landed in BOTH places, then records the run
#      as one JSON line in backups\backup-log.jsonl
#
# Exit codes:  0 = dump written to both places
#              1 = backup failed
#              2 = local dump fine, offsite copy missing or mismatched
#
# The log file is the thing to read when you want to know whether backups have
# been running. One line per run, oldest first.

[CmdletBinding()]
param(
  # Where the offsite copy goes. Must match whatever you registered the
  # scheduled task with; register-backup-task.ps1 keeps the two in step.
  [string]$CopyTo = "$HOME\OneDrive\Budget Backup",

  [int]$KeepDays = 30,

  # How long to wait for the Docker engine, and separately for Postgres.
  [int]$TimeoutSec = 180,

  # Don't try to launch Docker Desktop; fail instead if the engine is down.
  [switch]$NoDockerStart
)

$ErrorActionPreference = 'Continue'

$script:Started = Get-Date
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot
$script:LogFile = Join-Path $RepoRoot 'backups\backup-log.jsonl'

function Info($msg) { Write-Host "    $msg" }

function Add-LogEntry {
  param([string]$Status, [string]$Message, [System.Collections.IDictionary]$Data = @{})

  $entry = [ordered]@{
    ts          = (Get-Date).ToString('o')
    status      = $Status
    message     = $Message
    durationSec = [math]::Round(((Get-Date) - $script:Started).TotalSeconds, 1)
  }
  foreach ($k in $Data.Keys) { $entry[$k] = $Data[$k] }

  try {
    New-Item -ItemType Directory -Force -Path (Split-Path $script:LogFile) | Out-Null
    Add-Content -Path $script:LogFile -Value ($entry | ConvertTo-Json -Compress -Depth 5)
  } catch {
    Write-Host "    WARNING: could not write to the log — $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

function Stop-Run {
  param([string]$Message, [int]$Code = 1, [System.Collections.IDictionary]$Data = @{})
  Add-LogEntry -Status $(if ($Code -eq 2) { 'offsite-missing' } else { 'failed' }) -Message $Message -Data $Data
  Write-Host "`nERROR: $Message" -ForegroundColor Red
  exit $Code
}

Write-Host "`n==> Scheduled backup starting $($script:Started.ToString('yyyy-MM-dd HH:mm:ss'))" -ForegroundColor White

# --- 1. Docker engine ------------------------------------------------------
& docker info --format '{{.ServerVersion}}' 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
  if ($NoDockerStart) { Stop-Run 'The Docker engine is not running.' }

  $exe = @(
    "$env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe",
    "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe",
    "${env:ProgramFiles(x86)}\Docker\Docker\Docker Desktop.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1

  if (-not $exe) { Stop-Run 'The Docker engine is not running, and Docker Desktop was not found to start it.' }

  Info 'Docker engine is down — starting Docker Desktop.'
  Start-Process $exe | Out-Null

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  do {
    Start-Sleep -Seconds 5
    & docker info --format '{{.ServerVersion}}' 2>&1 | Out-Null
  } while ($LASTEXITCODE -ne 0 -and (Get-Date) -lt $deadline)

  if ($LASTEXITCODE -ne 0) { Stop-Run "The Docker engine did not come up within $TimeoutSec seconds." }
  Info 'Docker engine is up.'
}

# --- 2. The db service -----------------------------------------------------
# Same .env parse backup-local.ps1 does, so pg_isready is asked about the right
# database rather than the compose defaults.
$PgUser = 'budget'
$PgDb = 'budget'
if (Test-Path .env) {
  foreach ($line in Get-Content .env) {
    if ($line -match '^\s*#') { continue }
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
      $val = $Matches[2].Trim().Trim('"').Trim("'")
      switch ($Matches[1]) {
        'POSTGRES_USER' { if ($val) { $PgUser = $val } }
        'POSTGRES_DB'   { if ($val) { $PgDb = $val } }
      }
    }
  }
}

$running = & docker compose ps --services --status running 2>&1 | Where-Object { $_ -is [string] }
if ($running -notcontains 'db') {
  Info "The 'db' service is not running — starting it."
  & docker compose up -d db 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Stop-Run 'docker compose up -d db failed. Check: docker compose logs db' }
}

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$ready = $false
while (-not $ready -and (Get-Date) -lt $deadline) {
  & docker compose exec -T db pg_isready -U $PgUser -d $PgDb 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { $ready = $true; break }
  Start-Sleep -Seconds 5
}
if (-not $ready) { Stop-Run "Postgres was not accepting connections within $TimeoutSec seconds." }

# --- 3. The actual backup --------------------------------------------------
# Launched as its own process: backup-local.ps1 signals failure with `exit 1`,
# and a separate process is the only way to read that back reliably.
$backupScript = Join-Path $PSScriptRoot 'backup-local.ps1'
if (-not (Test-Path $backupScript)) { Stop-Run "Could not find $backupScript" }

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $backupScript -KeepDays $KeepDays -CopyTo $CopyTo 2>&1 |
  ForEach-Object { Write-Host $_ }
$backupExit = $LASTEXITCODE

# --- 4. Verify and record --------------------------------------------------
$localFiles = @(Get-ChildItem 'backups\budget-*.sql' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime)
$newest = $localFiles | Select-Object -Last 1

# Tolerate a little clock slack rather than demanding a strictly-after timestamp
$freshlyWritten = $newest -and $newest.LastWriteTime -gt $script:Started.AddSeconds(-10)

$localNewestName = $null
$localNewestBytes = 0
if ($newest) {
  $localNewestName = $newest.Name
  $localNewestBytes = $newest.Length
}

$localOldest = $null
if ($localFiles.Count) { $localOldest = $localFiles[0].LastWriteTime.ToString('o') }

$localTotal = 0
if ($localFiles.Count) { $localTotal = [int64](($localFiles | Measure-Object -Property Length -Sum).Sum) }

$stats = [ordered]@{
  localDir         = (Join-Path $RepoRoot 'backups')
  localNewest      = $localNewestName
  localNewestBytes = $localNewestBytes
  localCount       = $localFiles.Count
  localTotalBytes  = $localTotal
  localOldest      = $localOldest
  offsiteDir       = $CopyTo
  offsiteOk        = $false
  offsiteCount     = 0
  offsiteTotalBytes = 0
  backupExitCode   = $backupExit
}

if ($backupExit -ne 0 -or -not $freshlyWritten) {
  Stop-Run 'backup-local.ps1 did not produce a new dump.' 1 $stats
}

$offsite = @()
if (Test-Path -LiteralPath $CopyTo) {
  $offsite = @(Get-ChildItem -LiteralPath $CopyTo -Filter 'budget-*.sql' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime)
}
$offsiteNewest = $offsite | Select-Object -Last 1

$offsiteTotal = 0
if ($offsite.Count) { $offsiteTotal = [int64](($offsite | Measure-Object -Property Length -Sum).Sum) }

$stats.offsiteCount = $offsite.Count
$stats.offsiteTotalBytes = $offsiteTotal
$stats.offsiteOk = [bool]($offsiteNewest -and
                          $offsiteNewest.Name -eq $newest.Name -and
                          $offsiteNewest.Length -eq $newest.Length)

$sizeKb = [math]::Round($newest.Length / 1KB, 1)

if (-not $stats.offsiteOk) {
  Stop-Run "Local dump $($newest.Name) ($sizeKb KB) is fine, but it did not reach $CopyTo." 2 $stats
}

Add-LogEntry -Status 'ok' -Message "$($newest.Name) ($sizeKb KB) written to both locations." -Data $stats

Write-Host "`n    OK — $($newest.Name) ($sizeKb KB)" -ForegroundColor Green
Info "$($stats.localCount) local dump(s), $($stats.offsiteCount) offsite."
Info "Log: $script:LogFile"
exit 0
