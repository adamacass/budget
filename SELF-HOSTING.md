# Self-hosting the budget app

Run the whole thing on your own desktop with Docker, instead of on Render.

## What you get, and what changes

Two containers: Postgres, and the app itself. The app container serves both the API
and the built React frontend on one port, so there is a single address to remember —
`http://localhost:8080`. Your data lives in a Docker volume on your own machine, which
means no free-tier database expiring after 90 days, no cold starts, and no monthly bill.
What you give up is remote access: the app is only reachable from your own home network
unless you deliberately set something up (see [Reaching it from your phone](#reaching-it-from-your-phone)),
and it is only running while your desktop is on. Nothing about the app's behaviour or
your login details changes.

---

## Prerequisites

Docker Desktop, which bundles everything needed.

| OS | Notes |
| --- | --- |
| Windows 10/11 | Needs WSL2. Docker Desktop installs and enables it for you; you may need one reboot. Run the commands below from PowerShell or from your WSL shell. |
| macOS | Intel and Apple Silicon both fine. |
| Linux | Docker Engine + the Compose plugin is enough; Docker Desktop is optional. |

Give Docker at least **4 GB of RAM** (Docker Desktop → Settings → Resources). The
frontend build is the memory-hungry step and 2 GB can fall over.

---

## Step 1 — Install Docker

Download from <https://www.docker.com/products/docker-desktop/>, install, launch it, and
wait for the whale icon to settle. Check it works:

```bash
docker --version
docker compose version
```

On Linux without Docker Desktop:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"   # then log out and back in
```

## Step 2 — Configure

From the repo root:

```bash
cp .env.docker.example .env
```

Open `.env` and set `JWT_SECRET`. Generate one:

```bash
openssl rand -base64 32
```

Windows PowerShell, if you have no `openssl`:

```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Max 256 }))
```

`JWT_SECRET` signs your login tokens. Any long random string works. Changing it later
just logs everyone out — it does not touch data. Compose refuses to start without it.

**`ANTHROPIC_API_KEY` is optional.** Get one from <https://console.anthropic.com> (billed
per use, separate from a Claude subscription). Leave it blank and the app runs fine, but
exactly four features stop working. They return a "Claude API key not configured" message
rather than erroring:

- **Screenshot import** — dropping a photo of a receipt or banking screen to extract transactions
- **Pay day advice** — the AI suggestion on the PayDay screen
- **Nightly summary** — the AI spending summary
- **Account sweep advice** — the AI suggestion for moving spare cash

Everything else is unaffected: CSV/XLSX statement import, auto-categorisation (plain
pattern matching, no AI), all dashboards, goals, levers, mortgage projections and exports.

The rest of `.env` can stay at its defaults. The one line worth understanding is:

```
DATABASE_URL=postgresql://budget:budget@db:5432/budget?sslmode=disable
```

Leave the `?sslmode=disable` on the end — the Postgres container speaks no TLS, and that
suffix is what reliably stops the client asking for it. See the
[troubleshooting table](#troubleshooting) for the detail.

## Step 3 — Start it

```bash
docker compose up -d --build
```

First run takes a few minutes (downloading base images, installing dependencies, building
the frontend). After that, starts are seconds. Then open:

**<http://localhost:8080>**

Watch it come up with:

```bash
docker compose logs -f app
```

You want to see `Budget server running on port 4000` and `DB pool ready`.

> **On a brand-new empty database the app seeds two demo accounts** — usernames `adam` and
> `aruto`, both with the password `GoPies2023` — along with sample transactions. That is
> fine if you're about to migrate real data over the top (Step 4 replaces all of it). If
> you're starting fresh, change those passwords in the app.

## Step 4 — Bring your data across from Render

This is the step that matters. Two paths; use (a) unless you can't.

### (a) Recommended: full database copy

This brings **everything** — every transaction, income entry, goal, contribution, lever,
balance and budget, plus your existing usernames and passwords.

1. In the [Render dashboard](https://dashboard.render.com), open your **Postgres instance**
   (not the web service). Scroll to **Connections** and copy the **External Database URL**.
   It looks like `postgresql://user:password@dpg-xxxxx.oregon-postgres.render.com/dbname`.

   Use the *external* one — the internal URL only resolves from inside Render's network.

   Note that `render.yaml` in this repo doesn't declare a database, so the Postgres
   instance was added separately in the dashboard; that's where to look for it.

2. Make sure the local stack is up (`docker compose up -d`), then:

   **macOS / Linux:**

   ```bash
   ./scripts/migrate-from-render.sh "postgresql://user:password@dpg-xxxxx.oregon-postgres.render.com/dbname"
   ```

   **Windows (PowerShell)** — the `.sh` script will not run here, use the PowerShell one:

   ```powershell
   .\scripts\migrate-from-render.ps1 "postgresql://user:password@dpg-xxxxx.oregon-postgres.render.com/dbname"
   ```

   If PowerShell refuses with "running scripts is disabled on this system", allow local
   scripts for your user once:

   ```powershell
   Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
   ```

   Wrap the URL in quotes — passwords often contain characters your shell would eat.

The script dumps from Render into `./backups/render-<timestamp>.sql`, stops the app
container, restores over the local database, restarts the app, and prints row counts. It
reads from Render and writes nothing to it, so your live site is untouched.

If `pg_dump` isn't installed on your desktop, the script runs it inside the Postgres
container instead — you don't need to install anything.

> **Free-tier databases on Render expire after 90 days** and the connection details rotate
> when they're replaced. If the URL is rejected, check in the dashboard that the database
> still exists and re-copy it. Do this migration sooner rather than later.

### (b) Fallback: the in-app JSON backup

Use this if you can't get a working `pg_dump` connection — for example the Render free
tier has already expired and you can only reach the app through the browser.

1. In the app on Render, go to **Settings → Data Backup & Restore → Download Backup**
   (or `GET /api/backup?include_credentials=1` while logged in). You get a JSON file.
2. On your local copy, **Settings → Restore from Backup**, pick that file, and choose
   **Replace** mode (it wipes the seeded demo data first, rather than merging into it).

The backup covers every table the app uses — users, expenses, income entries, fund
allocations, savings goals and their contributions, levers, account balances, category
budgets, learned category rules, retention profiles, upcoming expenses, deleted-expense
memory, offset withdrawals and planned withdrawals. Row ids and id sequences are
preserved, so the links between records survive.

Two things to know:

- **Passwords.** `include_credentials=1` includes the password hashes so you can log in
  with your existing passwords. Without it, users are restored with the placeholder
  password `ChangeMe123` — change it immediately under Settings. The file contains
  password hashes, so treat it like a credential: don't email it or put it in cloud
  storage unencrypted.
- **It's a logical copy, not a byte-for-byte one.** Rows that violate a constraint are
  skipped rather than failing the whole restore, and the response tells you how many rows
  landed in each table. Check those counts against the source.

Path (a) is still the better option when it's available — it reproduces the database
exactly.

## Step 5 — Verify the migration

The migration script prints this automatically, but to check any time:

```bash
docker compose exec db psql -U budget -d budget -c "
  SELECT 'users' t, count(*) FROM users
  UNION ALL SELECT 'expenses', count(*) FROM expenses
  UNION ALL SELECT 'income_entries', count(*) FROM income_entries
  UNION ALL SELECT 'account_balances', count(*) FROM account_balances
  UNION ALL SELECT 'savings_goals', count(*) FROM savings_goals
  UNION ALL SELECT 'goal_contributions', count(*) FROM goal_contributions
  UNION ALL SELECT 'fund_allocations', count(*) FROM fund_allocations
  UNION ALL SELECT 'levers', count(*) FROM levers
  UNION ALL SELECT 'category_budgets', count(*) FROM category_budgets;"
```

Then, by eye:

- **Log in with your normal username and password.** Password hashes come across in the
  dump, so nothing is reset. If you're still on the demo `adam`/`aruto` accounts, the
  migration didn't take.
- **Dashboard totals** should match what Render shows — offset balance, spend this month.
- **Scroll the expense list back to your oldest transaction.** Check the first entry and
  the date range look right.
- **Check the goals page** — targets, current amounts and the contributions chart.

Keep the Render service running until you've used the local copy for a week or so. Keep
`backups/render-<timestamp>.sql` indefinitely; it's your safety net.

---

## Backups

The database lives in a Docker volume. Volumes survive `docker compose down`, image
rebuilds and reboots — but not `docker compose down -v`, and not a disk failure. Take real
backups.

```bash
./scripts/backup-local.sh
```

Writes `./backups/budget-YYYYMMDD-HHMMSS.sql.gz`, prunes dumps older than 30 days, and
prints the path. Safe to run while the app is up.

Restore one:

```bash
docker compose stop app
gunzip -c backups/budget-20260312-020000.sql.gz | docker compose exec -T db psql -U budget -d budget
docker compose start app
```

### Scheduling it

macOS / Linux — `crontab -e`, then (2am daily):

```cron
0 2 * * * cd /home/you/budget && ./scripts/backup-local.sh >> backups/cron.log 2>&1
```

Use the real absolute path, and make sure Docker is running at that hour (on macOS, set
Docker Desktop to start at login; your desktop must be awake, so pick a time it's on).

Windows — Task Scheduler → Create Task → Trigger: daily → Action: Start a program:

```
Program:   wsl
Arguments: -d Ubuntu -- bash -lc "cd /home/you/budget && ./scripts/backup-local.sh"
```

(WSL's own cron doesn't start automatically, so drive it from Task Scheduler.) Tick "Run
whether user is logged on or not" and make sure Docker Desktop is set to start at login.

Copy `./backups/` to another drive or a cloud folder periodically. A backup on the same
disk as the database isn't a backup.

### Where the data actually lives

The volume is named `budget_budget-db-data` (Compose prefixes it with the project
directory name).

```bash
docker volume inspect budget_budget-db-data
```

On Linux that resolves to a real path, typically
`/var/lib/docker/volumes/budget_budget-db-data/_data`. On macOS and Windows it's inside
the Docker Desktop virtual machine and not directly browsable from Finder or Explorer —
which is exactly why you take dumps rather than copying files. Never copy those files
while Postgres is running; the copy will be inconsistent.

---

## Keeping it running

Both services are set to `restart: unless-stopped`, so they come back automatically when
Docker starts — set Docker Desktop to launch at login and the app is simply always there.

```bash
docker compose logs -f app          # follow the app log
docker compose logs -f db           # follow Postgres
docker compose ps                   # what's running, and health
docker compose restart app          # restart just the app
docker compose down                 # stop everything (data is kept)
docker compose down -v              # stop AND DELETE THE DATABASE VOLUME — careful
```

After pulling new code:

```bash
git pull
docker compose up -d --build
```

Only the app image rebuilds; the database volume is untouched. The app applies its own
schema migrations on boot, so there's no separate migration step. Take a backup first if
the change looks significant.

---

## Reaching it from your phone

On the same wifi, find your desktop's LAN address:

```bash
# macOS
ipconfig getifaddr en0
# Linux
hostname -I | awk '{print $1}'
# Windows PowerShell
(Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias 'Wi-Fi').IPAddress
```

Then browse to `http://192.168.x.x:8080` from your phone.

If it doesn't load, the desktop firewall is blocking port 8080 — on Windows, allow it for
**Private** networks only; on macOS, approve the prompt when it appears; on Linux, e.g.
`sudo ufw allow from 192.168.0.0/16 to any port 8080`.

**This is LAN only.** It is not reachable from the internet, which is the correct default —
the app is plain HTTP with no rate limiting, so anything you type, including your password,
crosses the network unencrypted.

## Reaching it from anywhere

Three options, cheapest first. None of them opens a port on your router.

### Option 0 — Quick tunnel (free, no account, no domain)

```bash
docker compose --profile quicktunnel up -d
docker compose logs quicktunnel | grep trycloudflare        # PowerShell: | Select-String trycloudflare
```

That prints a `https://<random-words>.trycloudflare.com` address that works in any browser
straight away. Nothing to sign up for.

Two catches:

- **The URL changes every time the container restarts**, including on reboot. Fine for
  occasional use, no good as a bookmark.
- **It cannot be protected by Cloudflare Access** (that needs an account), so your app's own
  login is the only thing guarding it. The URL is long and unguessable, but treat it as a
  secret, and stop the tunnel when you don't need it:

  ```bash
  docker compose stop quicktunnel
  ```

Upgrade to Option B below when you want a permanent address.

### Option A — Tailscale (private, needs the app on each device)

Install [Tailscale](https://tailscale.com) on the desktop and on your phone, sign in to
both with the same account, and the app is at `http://<tailscale-hostname>:8080` from
anywhere. Nothing is exposed publicly — only your own devices can see it.

The catch: every device you want to use needs the Tailscale app and to be signed in. No
good for a borrowed laptop or sharing a link.

### Option B — Cloudflare Tunnel (a real https:// URL, any browser)

Gives you something like `https://budget.yourdomain.com` that works in any browser with
nothing installed. Needs a domain on Cloudflare (~$10/year).

1. Add your domain to Cloudflare (free plan is fine).
2. Zero Trust dashboard → **Networks → Tunnels → Create a tunnel** → name it → copy the
   **token**.
3. Put it in `.env` as `TUNNEL_TOKEN=...`
4. In the tunnel's **Public Hostname** tab, add your hostname (e.g. `budget.yourdomain.com`)
   pointing at service `http://app:4000`. That's the compose service name — cloudflared
   reaches it over the private compose network, so port 8080 need not be published at all.
5. Start it:

   ```bash
   docker compose --profile tunnel up -d
   ```

Without `--profile tunnel` the tunnel container never starts, so this stays off until you
ask for it.

**Then lock it down — this step is not optional.** A tunnel publishes the app to the whole
internet, where its only defence is its own login form: no rate limiting, no lockout, no
second factor. Put Cloudflare Access in front of it:

Zero Trust → **Access → Applications → Add an application** → Self-hosted → your hostname →
add a policy allowing only your and your partner's email addresses, action **Allow**, with
**One-time PIN** as the identity method.

Visitors then get a Cloudflare login page and a code emailed to them before the app is
reachable at all. Free for up to 50 users. Without it, anyone who guesses the hostname can
sit and grind passwords against your financial history.

### Either way, do not port-forward 8080 on your router

That publishes an unencrypted login form for your entire financial history to the open
internet, with your password crossing the network in the clear. Both options above are
easier and dramatically safer.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `bind: address already in use` on startup | Something else owns port 8080 | Set `APP_PORT=8090` in `.env`, then `docker compose up -d`. Find the culprit with `lsof -i :8080` (macOS/Linux) or `netstat -ano \| findstr :8080` (Windows). |
| App log: `The server does not support SSL connections` | The client is asking for TLS that the plain Postgres container doesn't offer — almost always `?sslmode=disable` dropped from `DATABASE_URL` | Put it back. `server/db.js` decides on TLS from the URL and the hostname (it treats `localhost`, `127.0.0.1` and the compose service name `db` as local, and honours `sslmode=disable` in the URL, `PGSSLMODE=disable`, or `DATABASE_SSL=false`). Independently of that, node-postgres parses the connection string *after* the options passed in code, so `sslmode=disable` in the URL wins regardless. That's why the URL suffix is the setting to rely on rather than the env vars. |
| App log: `ECONNREFUSED` or `getaddrinfo ENOTFOUND db` | Postgres isn't up yet, or the db container died | `docker compose ps` then `docker compose logs db`. Compose waits for the db healthcheck, so this usually means Postgres itself failed — most often a corrupt volume after an unclean shutdown. |
| Build fails in `npm ci` with `node-gyp` / `prebuild-install` errors | The legacy `better-sqlite3` dependency compiling from source | The builder stage already installs `build-essential` and `python3` for this. If it still fails it's usually a network hiccup mid-download: `docker compose build --no-cache app`. Note nothing in `server/` actually requires `better-sqlite3` — it's a leftover from before the Postgres move, kept so `package-lock.json` stays valid. |
| Build fails with `JavaScript heap out of memory` during `vite build` | Docker has too little RAM | Docker Desktop → Settings → Resources → raise memory to 4 GB+, then rebuild. As a last resort add `ENV NODE_OPTIONS=--max-old-space-size=4096` above the build step in the `Dockerfile`. |
| `Error: Cannot find module '...'` at startup | Stale image, or a needed file excluded by `.dockerignore` | `docker compose build --no-cache app && docker compose up -d`. The runtime image intentionally ships only `server/`, `client/dist`, `node_modules` and the root `package.json` — the last is required because `server/index.js` reads the version out of it. |
| Compose exits with `required variable JWT_SECRET is missing a value` | No `.env`, or the value is blank | `cp .env.docker.example .env` and fill in `JWT_SECRET`. |
| Migration script: `The 'db' service is not running` | Stack isn't started | `docker compose up -d`, wait for `docker compose ps` to show db as `healthy`, retry. |
| Migration script: `aborting because of server version mismatch` | The `pg_dump` doing the work is older than the source server. `pg_dump` will not read a server newer than itself. Render provisions Postgres 18; if your `db` service is on 16, its `pg_dump` is 16 and refuses. | Set `POSTGRES_IMAGE` in `.env` to match or exceed the source major version (default is `postgres:18-alpine`), then recreate the volume: `docker compose down -v` then `docker compose up -d --build`. That deletes local data — fine before a migration, since the real data is still on Render. If you have a *locally installed* `pg_dump` that's older, the bash script prefers it: rename it so the script falls back to the container. |
| Page loads but every API call 500s | Database reachable but schema init failed | `docker compose logs app` and read the first error after `DB pool ready`. |
| Login rejects your normal password | You're on a fresh database with only the seeded demo users | The migration hasn't run, or didn't take. Re-run Step 4 and check the row counts. |

Inspect the database directly at any time:

```bash
docker compose exec db psql -U budget -d budget
```

---

## Rolling back to Render

Nothing here touches your Render setup. `render.yaml` is unchanged, and the migration only
*reads* from the Render database — so as long as you haven't deleted the service, rolling
back is just using the Render URL again.

Keep the Render service alive until you're confident. When you are, delete the Render
Postgres instance and the web service from the dashboard to stop any charges.

If you've been running locally for a while and want to push that data back up to Render:

```bash
./scripts/backup-local.sh
gunzip -c backups/budget-<timestamp>.sql.gz \
  | psql "postgresql://user:password@dpg-xxxxx.oregon-postgres.render.com/dbname"
```

That overwrites the Render database with your local copy (the dump uses
`--clean --if-exists`), so take a dump of Render first if there's anything there you want.
