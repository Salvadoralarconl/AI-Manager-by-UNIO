# Stack contract (for parallel threads)

- Runtime: Node.js 22 LTS (>=22.13), plain ESM JavaScript, **zero npm runtime dependencies**.
- DB: SQLite via built-in `node:sqlite`, WAL mode. File: `$DATA_DIR/app.db` (demo mode: `$DATA_DIR/demo.db`). No Postgres.
- Project files/artifacts: `$DATA_DIR/projects/<project_id>/artifacts/` (demo: `$DATA_DIR/demo-projects/`).
- Processes (same image, two commands, share the `/data` volume):
  - `web`:    `node src/server.js`  → HTTP on `$HOST:$PORT` (default 127.0.0.1:8080). Dashboard, JSON API, SSE (`/api/stream`).
  - `runner`: `node src/runner.js`  → scheduler + worker slots. Heartbeat written to the DB every few seconds.
- Health:
  - web: `GET /healthz` → 200 `{ok:true}` (no auth). 
  - runner: `node src/runner.js --healthcheck` exits 0 if its heartbeat in the DB is fresh.
- Auth: the **app owns login** (single owner). Password from `OWNER_PASSWORD` (or `OWNER_PASSWORD_HASH`, scrypt), cookie signing key `SESSION_SECRET`. Set `COOKIE_SECURE=1` behind HTTPS. A reverse proxy (Caddy) for TLS / private network is welcome but not required for auth.
- Env vars: `DATA_DIR`, `HOST`, `PORT`, `OWNER_PASSWORD`, `OWNER_PASSWORD_HASH`, `SESSION_SECRET`, `COOKIE_SECURE`, `DEMO_MODE`,
  `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `LOCAL_AI_URL`, `LOCAL_AI_API_KEY`, `PAID_EXECUTION_ENABLED` (default off), `RUNNER_TICK_MS`, `SIM_SPEED`.
- Worker adapter interface: `src/workers/adapter.js` (JSDoc). Adapters live in `src/workers/<provider>.js` and export a factory `create(cfg) → Adapter`.
- Backups: SQLite online backup (`sqlite3 app.db ".backup ..."` or the app's `/api/export`) + tar of `$DATA_DIR/projects`.
