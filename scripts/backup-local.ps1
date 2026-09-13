# Back up the local Docker Compose Postgres to ./backups/.
#
#   .\scripts\backup-local.ps1
#
# Writes backups\budget-YYYYMMDD-HHMMSS.sql and prunes dumps older than 30 days.
# Safe to run while the app is running — pg_dump takes a consistent snapshot.
#
# Schedule it: see SELF-HOSTING.md (Task Scheduler), or run it by hand before
# anything risky like an upgrade.

[CmdletBinding()]
param(
  [int]$KeepDays = 30,

  # Also copy the dump somewhere off this machine — a synced folder
  # (OneDrive/Dropbox), a USB drive, a NAS share. A backup sitting on the same
  # disk as the database does not protect you from that disk failing.
  #   .\scripts\backup-local.ps1 -CopyTo "$HOME\OneDrive\budget-backups"
  [string]$CopyTo
)

# Not 'Stop': docker writes progress to stderr, which PowerShell would otherwise
# turn into a terminating error. Exit codes are checked explicitly instead.
$ErrorActionPreference = 'Continue'

function Info($msg) { Write-Host "    $msg" }
function Fail($msg) { Write-Host "`nERROR: $msg" -ForegroundColor Red; exit 1 }

Set-Location (Join-Path $PSScriptRoot '..')

# Local database credentials from .env, falling back to compose defaults
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
  Fail "The 'db' service is not running. Start it with:  docker compose up -d"
}

$Timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
New-Item -ItemType Directory -Force -Path backups | Out-Null
$OutFile = "backups\budget-$Timestamp.sql"

Write-Host "`n==> Backing up $PgDb" -ForegroundColor White

# Dump inside the container then copy out — PowerShell's `>` writes UTF-16 and
# would corrupt the SQL.
& docker compose exec -T db pg_dump -U $PgUser -d $PgDb --no-owner --no-privileges --file /tmp/backup.sql 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'pg_dump failed. Check: docker compose logs db' }

& docker compose cp db:/tmp/backup.sql $OutFile 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'Could not copy the dump out of the container.' }

if (-not (Test-Path $OutFile) -or (Get-Item $OutFile).Length -eq 0) {
  Remove-Item $OutFile -ErrorAction SilentlyContinue
  Fail 'The backup came out empty.'
}

$sizeKb = [math]::Round((Get-Item $OutFile).Length / 1KB, 1)
Info "Saved $OutFile ($sizeKb KB)."

# Copy offsite if asked
if ($CopyTo) {
  try {
    if (-not (Test-Path $CopyTo)) { New-Item -ItemType Directory -Force -Path $CopyTo | Out-Null }
    Copy-Item $OutFile -Destination $CopyTo -Force
    Info "Copied to $CopyTo"

    # Prune the offsite copies on the same schedule
    $offsiteCutoff = (Get-Date).AddDays(-$KeepDays)
    $oldOffsite = Get-ChildItem (Join-Path $CopyTo 'budget-*.sql') -ErrorAction SilentlyContinue |
                  Where-Object { $_.LastWriteTime -lt $offsiteCutoff }
    if ($oldOffsite) { $oldOffsite | Remove-Item -Force }
  } catch {
    # A failed offsite copy must not look like a failed backup — the local dump is fine
    Write-Host "    WARNING: could not copy to $CopyTo — $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

# Tidy up old dumps
$cutoff = (Get-Date).AddDays(-$KeepDays)
$old = Get-ChildItem backups\budget-*.sql -ErrorAction SilentlyContinue |
       Where-Object { $_.LastWriteTime -lt $cutoff }
if ($old) {
  $old | Remove-Item -Force
  Info "Pruned $($old.Count) backup(s) older than $KeepDays days."
}

Write-Host @"

    Restore this backup with:
      docker compose cp "$OutFile" db:/tmp/restore.sql
      docker compose stop app
      docker compose exec -T db psql -U $PgUser -d $PgDb -f /tmp/restore.sql
      docker compose start app

    Copy backups\ to another drive or cloud folder periodically.
    A backup on the same disk as the database is not a backup.
"@
