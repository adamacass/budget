# Copy the live Render Postgres database into the local Docker Compose Postgres.
#
#   .\scripts\migrate-from-render.ps1 "postgresql://user:pass@dpg-xxx.oregon-postgres.render.com/dbname"
#
# Find the URL in the Render dashboard: your Postgres instance -> Connections ->
# "External Database URL" (the internal one only works from inside Render).
#
# Windows equivalent of migrate-from-render.sh. It does the same thing:
#   1. checks the local db service is up
#   2. pg_dump from Render into ./backups/render-<timestamp>.sql
#   3. stops the app container so it cannot write while tables are swapped
#   4. restores the dump into the local database
#   5. starts the app again and prints row counts
#
# The dump uses --clean --if-exists, so it REPLACES the local contents of those
# tables (including the demo data the app seeds on a fresh database).
#
# Note: the dump is written inside the db container and copied out with
# `docker compose cp`, rather than piped through PowerShell. PowerShell's `>`
# writes UTF-16, which would corrupt the SQL file.

[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$RenderUrl
)

# Deliberately NOT 'Stop'. docker compose writes its progress ("Container
# budget-app-1 Stopping") to stderr, and PowerShell turns native-command stderr
# into error records — under 'Stop' that aborts the script on a successful
# command. Failures are detected explicitly via $LASTEXITCODE instead.
$ErrorActionPreference = 'Continue'

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor White }
function Info($msg) { Write-Host "    $msg" }
function Fail($msg) { Write-Host "`nERROR: $msg" -ForegroundColor Red; exit 1 }

# Run docker, swallowing its chatter but preserving the exit code.
function Invoke-Docker {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$DockerArgs)
  & docker @DockerArgs 2>&1 | Out-Null
  return $LASTEXITCODE
}

# Run from the repo root regardless of where the script was invoked from
Set-Location (Join-Path $PSScriptRoot '..')

# --- inputs ----------------------------------------------------------------

if (-not $RenderUrl) { $RenderUrl = $env:RENDER_DATABASE_URL }
if (-not $RenderUrl) {
  Fail @"
No Render connection string.
       Usage: .\scripts\migrate-from-render.ps1 "postgresql://user:pass@dpg-xxxx.oregon-postgres.render.com/dbname"
       or set RENDER_DATABASE_URL in your environment
"@
}

# Pull local database credentials out of .env, falling back to compose defaults
$PgUser = 'budget'
$PgDb = 'budget'
$AppPort = '8080'
if (Test-Path .env) {
  foreach ($line in Get-Content .env) {
    if ($line -match '^\s*#') { continue }
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
      $key = $Matches[1]
      $val = $Matches[2].Trim().Trim('"').Trim("'")
      switch ($key) {
        'POSTGRES_USER' { if ($val) { $PgUser = $val } }
        'POSTGRES_DB'   { if ($val) { $PgDb = $val } }
        'APP_PORT'      { if ($val) { $AppPort = $val } }
      }
    }
  }
}

$Timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
New-Item -ItemType Directory -Force -Path backups | Out-Null
$DumpFile = "backups\render-$Timestamp.sql"
$LogFile = "backups\restore-$Timestamp.log"

# --- 1. preflight ----------------------------------------------------------

Step 'Checking the local database is running'
$dcStatus = Invoke-Docker compose version
if ($dcStatus -ne 0) {
  Fail 'Docker Compose not found. Install Docker Desktop and make sure it is running.'
}

$running = & docker compose ps --services --status running 2>&1 | Where-Object { $_ -is [string] }
if ($running -notcontains 'db') {
  Fail @"
The 'db' service is not running.
       Start the stack first:  docker compose up -d
       Then re-run this script.
"@
}

$readyStatus = Invoke-Docker compose exec -T db pg_isready -U $PgUser -d $PgDb
if ($readyStatus -ne 0) {
  Fail @"
The 'db' container is running but Postgres is not accepting connections yet.
       Wait a few seconds and try again, or check:  docker compose logs db
"@
}
Info "Local Postgres is up (user=$PgUser db=$PgDb)."

# --- 2. dump from Render ---------------------------------------------------

Step 'Dumping the Render database'
Info 'This reads from Render and writes nothing to it.'

# Dump to a file inside the container, then copy it out — avoids PowerShell
# mangling the encoding of a redirected stream.
$dumpStatus = Invoke-Docker compose exec -T db pg_dump $RenderUrl --no-owner --no-privileges --clean --if-exists --file /tmp/render-dump.sql
if ($dumpStatus -ne 0) {
  Fail @"
pg_dump failed. Check the connection string, and that the Render database
       still exists (free-tier databases expire and the URL rotates).
"@
}

$cpStatus = Invoke-Docker compose cp db:/tmp/render-dump.sql $DumpFile
if ($cpStatus -ne 0) { Fail 'Could not copy the dump out of the container.' }

if (-not (Test-Path $DumpFile) -or (Get-Item $DumpFile).Length -eq 0) {
  Remove-Item $DumpFile -ErrorAction SilentlyContinue
  Fail 'The dump came out empty. Check the connection string and that the Render database still has data.'
}
$sizeKb = [math]::Round((Get-Item $DumpFile).Length / 1KB, 1)
Info "Saved $DumpFile ($sizeKb KB)."

# --- 3. stop the app -------------------------------------------------------

Step 'Stopping the app container while the tables are replaced'
Invoke-Docker compose stop app | Out-Null
Info 'Stopped.'

# --- 4. restore ------------------------------------------------------------

Step 'Restoring into the local database'
Info 'DROPs and recreates the tables in the dump, then loads the rows.'

# Restore from a file inside the container for the same encoding reason
& docker compose exec -T db psql -v ON_ERROR_STOP=1 --quiet -U $PgUser -d $PgDb -f /tmp/render-dump.sql 2>&1 |
  Out-File -FilePath $LogFile -Encoding utf8
$restoreStatus = $LASTEXITCODE

if ($restoreStatus -ne 0) {
  Write-Host "`nRestore reported errors. Last 20 lines:" -ForegroundColor Red
  if (Test-Path $LogFile) { Get-Content $LogFile -Tail 20 | ForEach-Object { Write-Host "    $_" } }
  Fail @"
Restore failed. Full log: $LogFile
       The dump is still there ($DumpFile) - nothing was lost on the Render side.
       Start the app again with:  docker compose start app
"@
}
Info "Restore completed. Log: $LogFile"

# --- 5. restart and verify -------------------------------------------------

Step 'Starting the app again'
Invoke-Docker compose start app | Out-Null
Info 'Started. It re-applies its own idempotent schema migrations on boot;'
Info 'it will NOT re-seed demo data because the tables now have rows.'

Step 'Row counts in the local database'
$tables = @('users', 'expenses', 'income_entries', 'account_balances', 'savings_goals',
            'goal_contributions', 'fund_allocations', 'levers', 'category_budgets')
foreach ($t in $tables) {
  $sql = "SELECT CASE WHEN to_regclass('public.$t') IS NULL THEN 'MISSING' ELSE (SELECT count(*)::text FROM $t) END"
  $count = & docker compose exec -T db psql -At -U $PgUser -d $PgDb -c $sql 2>&1 | Where-Object { $_ -is [string] }
  if ($null -eq $count -or $count -eq '') { $count = '?' }
  Write-Host ("    {0,-22} {1}" -f $t, ($count -join ''))
}

Step 'Done'
Write-Host @"
    Compare those counts against Render before you switch over. If they look
    right, open the app and log in with your existing username and password
    (password hashes come across in the dump, so nothing is reset).

      App:   http://localhost:$AppPort
      Logs:  docker compose logs -f app

    Keep $DumpFile until you are satisfied - it is your rollback.
"@
