// Dashboard + JSON API + server-sent events. No framework, no dependencies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, redact, providerConfigured } from './config.js';
import { openDb, getSettings, setSetting, all, one, now, newId, DEFAULT_SETTINGS } from './db.js';
import * as S from './store.js';
import { createAuth } from './auth.js';
import { seedDemo } from './demo.js';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json' };

export function createServer(cfg, db = openDb(cfg.dbPath)) {
  const auth = createAuth(cfg);
  if (cfg.demo) seedDemo(db, cfg);
  else S.seedTeam(db, getSettings(db));
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler });
  };

  // ---------- API ----------
  route('GET', '/api/overview', (req, q) => S.overview(db, cfg, q.get('project')));

  route('GET', '/api/projects', () => all(db, 'SELECT * FROM projects ORDER BY status = \'archived\', position, created_at').map((p) => ({
    ...p,
    open_tasks: one(db, "SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND state NOT IN ('completed','failed','cancelled')", p.id).n,
    spend_month: S.spend(db, { project_id: p.id, since: S.startOfMonth() }),
  })));
  route('POST', '/api/projects', (req, q, body) => S.createProject(db, cfg, body));
  route('GET', '/api/projects/:id', (req, q, body, { id }) => projectDetail(id));
  route('PATCH', '/api/projects/:id', (req, q, body, { id }) => S.updateProject(db, id, body));
  route('POST', '/api/projects/:id/status', (req, q, body, { id }) => S.setProjectStatus(db, id, body.status));
  route('POST', '/api/projects/:id/milestones', (req, q, body, { id }) => S.addMilestone(db, id, body));
  route('PATCH', '/api/milestones/:id', (req, q, body, { id }) => S.updateMilestone(db, id, body));
  route('POST', '/api/projects/:id/tasks', (req, q, body, { id }) => S.createTask(db, id, body));
  route('POST', '/api/projects/:id/assignments', (req, q, body, { id }) => { S.setAssignment(db, body.agent_id, id, Boolean(body.assigned)); return { ok: true }; });

  route('GET', '/api/tasks/:id', (req, q, body, { id }) => ({
    ...S.getTask(db, id),
    runs: all(db, `SELECT r.id, r.kind, r.status, r.attempt, r.started_at, r.ended_at, r.summary, r.error, r.verdict, a.name AS agent_name
      FROM runs r JOIN agents a ON a.id = r.agent_id WHERE r.task_id = ? ORDER BY r.started_at DESC`, id),
    artifacts: all(db, 'SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at DESC', id),
    events: S.listEvents(db, { limit: 30 }).filter((e) => e.task_id === id),
  }));
  route('PATCH', '/api/tasks/:id', (req, q, body, { id }) => S.updateTask(db, id, body));
  route('POST', '/api/tasks/:id/cancel', (req, q, body, { id }) => S.cancelTask(db, id));
  route('POST', '/api/tasks/:id/retry', (req, q, body, { id }) => S.retryTask(db, id));

  route('GET', '/api/agents', () => {
    const ctx = { settings: getSettings(db), heartbeat: S.runnerHeartbeat(db) };
    return S.listAgents(db).map((a) => ({ ...S.publicAgent(a), ...S.agentStatus(db, cfg, a, ctx), provider_configured: providerConfigured(cfg, a.provider) }));
  });
  route('POST', '/api/agents', (req, q, body) => S.publicAgent(S.createAgent(db, body)));
  route('GET', '/api/agents/:id', (req, q, body, { id }) => agentDetail(id));
  route('PATCH', '/api/agents/:id', (req, q, body, { id }) => S.publicAgent(S.updateAgent(db, id, body)));
  route('POST', '/api/agents/:id/pause', (req, q, body, { id }) => S.publicAgent(S.setAgentPaused(db, id, Boolean(body.paused))));

  route('GET', '/api/runs/:id', (req, q, body, { id }) => {
    const r = one(db, `SELECT r.*, a.name AS agent_name, a.role AS agent_role, t.title AS task_title, p.name AS project_name FROM runs r
      JOIN agents a ON a.id = r.agent_id JOIN tasks t ON t.id = r.task_id JOIN projects p ON p.id = r.project_id WHERE r.id = ?`, id);
    if (!r) throw new S.HttpError(404, 'Run not found');
    const { lease_owner, ...rest } = r;
    return { ...rest, log: JSON.parse(r.log || '[]'), artifacts: all(db, 'SELECT * FROM artifacts WHERE run_id = ?', id),
      usage: all(db, 'SELECT * FROM usage WHERE run_id = ?', id) };
  });

  route('GET', '/api/events', (req, q) => S.listEvents(db, Object.fromEntries(q)));

  route('GET', '/api/settings', () => settingsView());
  route('PATCH', '/api/settings', (req, q, body) => {
    for (const [k, v] of Object.entries(body ?? {})) {
      if (!(k in DEFAULT_SETTINGS) || k === 'paused') continue;
      setSetting(db, k, validateSetting(k, v));
    }
    return settingsView();
  });
  route('POST', '/api/system/pause', (req, q, body) => {
    const paused = Boolean(body.paused);
    setSetting(db, 'paused', paused);
    S.addEvent(db, { type: paused ? 'system.paused' : 'system.resumed', message: paused ? 'All work paused' : 'Work resumed' });
    return { paused };
  });

  route('GET', '/api/intern-evals', () => all(db, 'SELECT * FROM intern_evals ORDER BY task_type'));
  route('POST', '/api/intern-evals', (req, q, body) => {
    const type = String(body.task_type ?? '').trim().slice(0, 60);
    if (!type) throw new S.HttpError(400, 'Task type is required');
    const id = newId('iev');
    db.prepare('INSERT INTO intern_evals(id, task_type, updated_at) VALUES (?,?,?)').run(id, type, now());
    return one(db, 'SELECT * FROM intern_evals WHERE id = ?', id);
  });
  route('PATCH', '/api/intern-evals/:id', (req, q, body, { id }) => {
    const e = one(db, 'SELECT * FROM intern_evals WHERE id = ?', id);
    if (!e) throw new S.HttpError(404, 'Not found');
    const samples = Math.max(0, Number(body.samples ?? e.samples) | 0);
    const passed = Math.min(samples, Math.max(0, Number(body.passed ?? e.passed) | 0));
    const decision = ['not_evaluated', 'approved', 'rejected'].includes(body.decision) ? body.decision : e.decision;
    if (decision === 'approved' && samples < 5) throw new S.HttpError(400, 'Evaluate at least 5 samples before approving');
    db.prepare('UPDATE intern_evals SET samples=?, passed=?, avg_seconds=?, review_minutes=?, decision=?, notes=?, updated_at=? WHERE id=?')
      .run(samples, passed, body.avg_seconds ?? e.avg_seconds, body.review_minutes ?? e.review_minutes, decision, String(body.notes ?? e.notes).slice(0, 1000), now(), id);
    return one(db, 'SELECT * FROM intern_evals WHERE id = ?', id);
  });

  // Export: records only. Secrets are never in the DB, and session/lease internals are stripped.
  route('GET', '/api/export', () => ({
    exported_at: new Date().toISOString(), demo: cfg.demo, schema: 1,
    settings: getSettings(db),
    projects: all(db, 'SELECT * FROM projects'), milestones: all(db, 'SELECT * FROM milestones'),
    agents: all(db, 'SELECT * FROM agents'), agent_projects: all(db, 'SELECT * FROM agent_projects'),
    tasks: all(db, 'SELECT * FROM tasks'), task_deps: all(db, 'SELECT * FROM task_deps'),
    runs: all(db, 'SELECT id, task_id, project_id, agent_id, kind, status, attempt, started_at, ended_at, summary, error, verdict FROM runs'),
    artifacts: all(db, 'SELECT * FROM artifacts'), usage: all(db, 'SELECT * FROM usage'),
    events: all(db, 'SELECT * FROM events ORDER BY id DESC LIMIT 5000'),
    intern_evals: all(db, 'SELECT * FROM intern_evals'),
  }));

  function settingsView() {
    const s = getSettings(db);
    return {
      settings: s,
      demo: cfg.demo,
      auth_enabled: auth.enabled,
      paid_execution: cfg.paidExecution,
      providers: {
        openai: { configured: Boolean(cfg.secrets.openai), label: 'OpenAI · Manager' },
        anthropic: { configured: Boolean(cfg.secrets.anthropic), label: 'Anthropic · Workers' },
        local: { configured: Boolean(cfg.localAiUrl), label: 'Home AI · Intern', endpoint_set: Boolean(cfg.localAiUrl) },
      },
      runner: S.runnerHeartbeat(db) ? { last_beat_at: S.runnerHeartbeat(db).last_beat_at } : null,
      storage: { database: cfg.demo ? 'demo.db' : 'app.db' },
    };
  }

  function validateSetting(k, v) {
    const n = (x, lo, hi) => { const y = Number(x); if (!Number.isFinite(y) || y < lo || y > hi) throw new S.HttpError(400, `${k} out of range`); return y; };
    switch (k) {
      case 'global_concurrency': return n(v, 0, 50) | 0;
      case 'daily_cap_usd': case 'monthly_cap_usd': case 'default_run_cap_usd': return v === null || v === '' ? null : n(v, 0, 100000);
      case 'heartbeat_stale_s': case 'activity_stale_s': case 'dashboard_stale_s': return n(v, 5, 86400) | 0;
      case 'default_models': return { ...DEFAULT_SETTINGS.default_models, ...pick(v, ['openai', 'anthropic', 'local'], 80) };
      case 'permissions': {
        const cur = getSettings(db).permissions;
        const out = { ...cur };
        for (const b of ['auto_assign_internal', 'allow_external_actions', 'intern_reassign']) if (b in v) out[b] = Boolean(v[b]);
        for (const m of ['marketing_mode', 'sales_mode']) if (v[m]) out[m] = ['draft_only', 'authorized_operations'].includes(v[m]) ? v[m] : cur[m];
        if (v.intern_fallback_role) out.intern_fallback_role = String(v.intern_fallback_role).slice(0, 40);
        return out;
      }
      case 'backup': return { include_artifacts: Boolean(v?.include_artifacts) };
      default: throw new S.HttpError(400, 'Unknown setting');
    }
  }
  function pick(o, keys, max) { const r = {}; for (const k of keys) if (o && k in o) r[k] = String(o[k]).slice(0, max); return r; }

  function projectDetail(id) {
    const p = S.getProject(db, id);
    const ctx = { settings: getSettings(db), heartbeat: S.runnerHeartbeat(db) };
    const assigned = new Set(all(db, 'SELECT agent_id FROM agent_projects WHERE project_id = ?', id).map((r) => r.agent_id));
    return {
      ...p,
      milestones: all(db, 'SELECT * FROM milestones WHERE project_id = ? ORDER BY position, created_at', id),
      tasks: S.listTasks(db, id),
      agents: S.listAgents(db).map((a) => ({ ...S.publicAgent(a), ...S.agentStatus(db, cfg, a, ctx), assigned: a.all_projects ? true : assigned.has(a.id) })),
      artifacts: all(db, `SELECT ar.*, t.title AS task_title FROM artifacts ar LEFT JOIN tasks t ON t.id = ar.task_id WHERE ar.project_id = ? ORDER BY ar.created_at DESC LIMIT 100`, id),
      spend: { today: S.spend(db, { project_id: id, since: S.startOfDay() }), month: S.spend(db, { project_id: id, since: S.startOfMonth() }), total: S.spend(db, { project_id: id }) },
      reserved_usd: S.reservedUsd(db, id),
    };
  }

  function agentDetail(id) {
    const a = S.getAgent(db, id);
    return {
      ...S.publicAgent(a),
      instructions: a.instructions,
      ...S.agentStatus(db, cfg, a),
      provider_configured: providerConfigured(cfg, a.provider),
      demo: cfg.demo,
      runs: all(db, `SELECT r.id, r.kind, r.status, r.attempt, r.started_at, r.ended_at, r.summary, r.error, r.last_activity, r.task_id,
        t.title AS task_title, p.name AS project_name, r.project_id FROM runs r JOIN tasks t ON t.id = r.task_id JOIN projects p ON p.id = r.project_id
        WHERE r.agent_id = ? ORDER BY r.started_at DESC LIMIT 50`, id),
      usage: {
        today: aggUsage(id, S.startOfDay()), month: aggUsage(id, S.startOfMonth()),
      },
      projects: all(db, 'SELECT p.id, p.name FROM agent_projects ap JOIN projects p ON p.id = ap.project_id WHERE ap.agent_id = ?', id),
      events: S.listEvents(db, { agent_id: id, limit: 20 }),
    };
  }
  function aggUsage(agentId, since) {
    return all(db, `SELECT cost_kind, COUNT(*) AS runs, COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens,
      COALESCE(SUM(cost_usd),0) AS cost_usd FROM usage WHERE agent_id = ? AND created_at >= ? GROUP BY cost_kind`, agentId, since);
  }

  // ---------- SSE ----------
  const clients = new Set();
  let lastEventId = one(db, 'SELECT COALESCE(MAX(id),0) AS m FROM events').m;
  let lastRev = one(db, "SELECT value FROM meta WHERE key = 'rev'")?.value ?? '0';
  const poll = setInterval(() => {
    if (!clients.size) {
      lastEventId = one(db, 'SELECT COALESCE(MAX(id),0) AS m FROM events').m;
      return;
    }
    const evs = all(db, 'SELECT id, ts, type, project_id, agent_id, task_id, message FROM events WHERE id > ? ORDER BY id LIMIT 200', lastEventId);
    const rev = one(db, "SELECT value FROM meta WHERE key = 'rev'")?.value ?? '0';
    for (const e of evs) { lastEventId = e.id; broadcast('event', e, e.id); }
    if (rev !== lastRev && !evs.length) broadcast('change', { rev });
    lastRev = rev;
  }, 1000);
  const ping = setInterval(() => {
    const hb = S.runnerHeartbeat(db);
    broadcast('ping', { now: now(), runner_beat_at: hb?.last_beat_at ?? null });
  }, 5000);
  function broadcast(type, data, id) {
    const msg = `${id ? `id: ${id}\n` : ''}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  }

  // ---------- HTTP ----------
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    try {
      if (p === '/healthz') return json(res, 200, { ok: true, demo: cfg.demo });
      if (p === '/api/login' && req.method === 'POST') {
        const body = await readBody(req);
        const r = auth.login(req.socket.remoteAddress, body.password);
        if (!r.ok) return json(res, r.status, { error: r.error });
        res.setHeader('Set-Cookie', r.cookie);
        return json(res, 200, { ok: true });
      }
      if (p === '/api/logout' && req.method === 'POST') {
        res.setHeader('Set-Cookie', auth.logoutCookie());
        return json(res, 200, { ok: true });
      }
      if (p === '/api/session') return json(res, 200, { authed: auth.isAuthed(req), auth_enabled: auth.enabled, demo: cfg.demo });
      if (p.startsWith('/fonts/') || p === '/app.css' || p === '/login.js' || p === '/icon.svg') return serveStatic(res, p);
      if (!auth.isAuthed(req)) {
        if (p.startsWith('/api/')) return json(res, 401, { error: 'Sign in required' });
        return serveStatic(res, '/login.html');
      }
      if (p.startsWith('/api/')) {
        // CSRF: state-changing requests must be same-origin JSON (cookies are SameSite=Strict as well).
        if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'aim') return json(res, 403, { error: 'Bad request origin' });
        if (p === '/api/stream') return stream(req, res);
        const m = p.match(/^\/api\/artifacts\/([^/]+)$/);
        if (m && req.method === 'GET') return serveArtifact(res, m[1], url.searchParams.get('download'));
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const mm = p.match(r.re);
          if (!mm) continue;
          const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(mm[i + 1])]));
          const body = req.method === 'GET' ? {} : await readBody(req);
          return json(res, 200, await r.handler(req, url.searchParams, body, params));
        }
        return json(res, 404, { error: 'Not found' });
      }
      return serveStatic(res, p === '/' ? '/index.html' : p, true);
    } catch (e) {
      const status = e.status ?? (e instanceof SyntaxError ? 400 : 500);
      if (status >= 500) console.error('[web]', redact(e.stack ?? String(e), cfg));
      return json(res, status, { error: status >= 500 ? 'Server error' : redact(e.message, cfg) });
    }
  });

  function stream(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ now: now() })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  }

  function serveArtifact(res, id, download) {
    const a = one(db, 'SELECT * FROM artifacts WHERE id = ?', id);
    if (!a) return json(res, 404, { error: 'Not found' });
    const dir = S.projectDir(cfg, a.project_id);
    const abs = path.resolve(dir, a.rel_path);
    if (!abs.startsWith(dir + path.sep) || !fs.existsSync(abs)) return json(res, 404, { error: 'File missing' });
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${a.name.replace(/"/g, '')}"`,
      'Content-Security-Policy': "default-src 'none'" });
    fs.createReadStream(abs).pipe(res);
  }

  function serveStatic(res, p, spa = false) {
    const file = path.resolve(PUBLIC, '.' + p);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      if (spa && !path.extname(p)) return serveStatic(res, '/index.html');
      return json(res, 404, { error: 'Not found' });
    }
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': ext === '.woff2' ? 'public, max-age=31536000' : 'no-cache',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'" });
    fs.createReadStream(file).pipe(res);
  }

  server.on('close', () => { clearInterval(poll); clearInterval(ping); for (const c of clients) c.end(); });
  server.db = db;
  return server;
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 1e6) { reject(new S.HttpError(413, 'Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(new S.HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function isLoopback(host) { return ['127.0.0.1', 'localhost', '::1'].includes(host); }

async function main() {
  const cfg = loadConfig();
  if (!cfg.ownerPassword && !process.env.OWNER_PASSWORD_HASH && !isLoopback(cfg.host)) {
    console.error('[web] Refusing to listen on a non-loopback address without OWNER_PASSWORD or OWNER_PASSWORD_HASH.');
    process.exit(1);
  }
  const server = createServer(cfg);
  server.listen(cfg.port, cfg.host, () => {
    console.log(`[web] http://${cfg.host}:${cfg.port}${cfg.demo ? ' (DEMO MODE: sample data in demo.db)' : ''}`);
    if (!cfg.ownerPassword && !process.env.OWNER_PASSWORD_HASH) console.warn('[web] No owner password set: sign-in disabled (loopback only).');
  });
  const shutdown = () => { server.close(() => process.exit(0)); server.closeAllConnections(); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
