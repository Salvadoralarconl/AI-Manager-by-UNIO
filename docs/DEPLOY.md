# Deploying AI Manager on Ubuntu

This runs the dashboard and its runner around the clock on one Ubuntu server
(22.04 or 24.04) with Docker Compose. "Around the clock" means it is ready to
process work when there is work; it does not call models continuously.

## What runs

| Service | What it does | Reachable from |
|---|---|---|
| `web` | Dashboard, JSON API, live updates (SSE), owner login | `127.0.0.1:8080` on the server only |
| `runner` | Scheduler and worker slots, one instance | nothing (outbound API calls only) |
| `proxy` | Optional Caddy HTTPS front, off unless you enable it | ports 80/443 |

All state lives in the Docker volume `ai-manager_data`: the SQLite database
(`app.db`), project artifacts (`projects/<id>/artifacts/`), and demo data in
separate files (`demo.db`, `demo-projects/`). Secrets live only in `.env`.

Every service has a health check, restarts automatically if it crashes
(`restart: unless-stopped`), and comes back after a reboot because Docker
starts on boot. Logs rotate at 20 MB × 5 files per service.

## 1. Install Docker (once)

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"   # log out and back in afterwards
```

## 2. Put the app on the server

```bash
sudo mkdir -p /opt/ai-manager && sudo chown "$USER" /opt/ai-manager
# copy or clone the project into /opt/ai-manager, then:
cd /opt/ai-manager
cp .env.example .env && chmod 600 .env
```

Fill in `.env`:

1. `SESSION_SECRET`: run `openssl rand -hex 32` and paste the result.
2. Owner password. Build the image first, then create a hash:
   ```bash
   docker compose build
   docker compose run --rm --no-deps web node src/hash-password.js
   ```
   Put the output in `OWNER_PASSWORD_HASH` (wrap it in single quotes if it contains `$`) and leave `OWNER_PASSWORD` empty.
3. Leave `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` empty until you have decided on billing. The app works for planning and simulation without them, and `PAID_EXECUTION_ENABLED=0` keeps paid calls off even after keys are added.

## 3. Start it

```bash
docker compose up -d --build
docker compose ps            # web and runner should say "(healthy)" within a minute
```

The dashboard now answers only on the server itself at `http://127.0.0.1:8080`.
Choose one way to reach it from your devices (step 4).

## 4. Private access (pick one)

Docker-published ports bypass `ufw`, which is why `web` binds to `127.0.0.1`
by default. Don't change `WEB_BIND` to `0.0.0.0`.

### A. Tailscale (recommended)

Only devices signed in to your tailnet can reach the dashboard, with a real
HTTPS certificate and nothing exposed to the internet.

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
# In the Tailscale admin console, enable MagicDNS and HTTPS certificates (DNS page).
sudo tailscale serve --bg 8080
tailscale serve status       # shows https://<server>.<tailnet>.ts.net
```

Keep `COOKIE_SECURE=1`. The `proxy` service is not needed.

### B. Home network only, with Caddy

In `.env` set `SITE_ADDRESS` to the server's LAN IP (for example `192.168.1.20`)
and `PROXY_BIND` to that same IP. In `deploy/Caddyfile`, uncomment `tls internal`.
Then:

```bash
docker compose --profile proxy up -d
```

Browsers will warn once because Caddy uses its own local certificate authority.
You can trust it on your devices with the root certificate from
`docker compose exec proxy cat /data/caddy/pki/authorities/local/root.crt`.

### C. Public hostname, with Caddy

Only if you need access without a VPN. Point a DNS record at the server,
open ports 80 and 443, set `SITE_ADDRESS=dash.example.com` and keep
`PROXY_BIND=0.0.0.0`, then `docker compose --profile proxy up -d`. Caddy gets a
Let's Encrypt certificate automatically. The app's own login is then the only
barrier, so use a long password. Tailscale is safer.

Future public product storefronts should be separate apps with their own
hostnames and deployments, never routes on this internal dashboard.

## 5. Nightly backups

```bash
sudo cp deploy/systemd/ai-manager-backup.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ai-manager-backup.timer
systemctl list-timers ai-manager-backup.timer
```

If you installed somewhere other than `/opt/ai-manager`, edit the paths in
`ai-manager-backup.service` first. Backup and restore details are in
[BACKUP.md](BACKUP.md).

## Day-to-day commands

| Task | Command |
|---|---|
| Health of each service | `docker compose ps` |
| Follow logs | `docker compose logs -f --tail 100 web runner` |
| Restart | `docker compose restart` |
| Stop everything | `docker compose down` (data is kept) |
| Update to new code | `bash deploy/backup.sh --label pre-update && git pull && docker compose up -d --build` |
| Back up now | `bash deploy/backup.sh` |

`docker compose down -v` deletes the data volume. Don't run it unless you mean to wipe everything.

## Home AI on the same network

Set `LOCAL_AI_URL` in `.env`. For another machine use its LAN IP, for example
`http://192.168.1.50:11434`. For a model server on this same Ubuntu machine use
`http://host.docker.internal:11434`, and make sure that server listens on an
address Docker can reach (not only `127.0.0.1`).

## Shutdown, crashes and interrupted runs

On `docker compose stop` or a reboot, the runner gets up to 60 seconds to
record the state of in-flight runs. After a crash or a power cut there is no
such chance. Once the old runner's heartbeat goes stale (30 seconds by default),
the new runner marks each orphaned run as interrupted:

- Internal work (writing, research, code in the project folder) goes back in the
  queue and counts as one used attempt, so it can't loop forever.
- External work (anything marked as an external action) whose outcome can't be
  known is marked "unknown" and never repeated automatically. The task becomes
  blocked and shows up as an attention item for you to check.

Only one `runner` should ever run. Don't scale it with `--scale runner=2`;
parallelism comes from worker slots inside the runner, set in the dashboard.

## Health checks

- `web`: `GET /healthz` must return 200. It needs no login and reveals nothing.
- `runner`: `node src/runner.js --healthcheck` passes while the runner's
  heartbeat in the database is fresh. A heartbeat only proves the process is
  alive; task progress is shown separately in the dashboard.
- `proxy`: Caddy's admin endpoint answers.

A service that stays unhealthy is visible in `docker compose ps`. Docker only
restarts a container automatically when its process exits, so if `runner` is
stuck "unhealthy", run `docker compose restart runner` and check its logs.
