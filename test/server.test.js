import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, redact } from '../src/config.js';
import { createServer } from '../src/server.js';
import { openDb } from '../src/db.js';
import { seedDemo } from '../src/demo.js';
import { hashPassword } from '../src/auth.js';

const SECRET_O = 'sk-proj-SECRETOPENAI1234567890';
const SECRET_A = 'sk-ant-SECRETANTHROPIC1234567890';

async function boot(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-srv-'));
  const cfg = loadConfig({ DATA_DIR: dir, OWNER_PASSWORD: 'correct horse', OPENAI_API_KEY: SECRET_O, ANTHROPIC_API_KEY: SECRET_A, DEMO_MODE: '0', ...over });
  const server = createServer(cfg);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const req = async (p, { method = 'GET', body, headers = {} } = {}) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'aim', cookie, ...headers }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    return { status: r.status, json, text, headers: r.headers };
  };
  const close = () => new Promise((r) => { server.close(r); server.closeAllConnections(); });
  return { cfg, server, req, close, dir };
}

test('authentication: API and pages require sign-in; healthz is open; login is rate limited', async () => {
  const s = await boot();
  assert.equal((await s.req('/healthz')).status, 200);
  assert.equal((await s.req('/api/overview')).status, 401);
  const page = await s.req('/');
  assert.match(page.text, /Sign in/);
  assert.equal((await s.req('/api/login', { method: 'POST', body: { password: 'nope' } })).status, 401);
  const ok = await s.req('/api/login', { method: 'POST', body: { password: 'correct horse' } });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await s.req('/api/overview')).status, 200);
  // Tampered cookie is rejected.
  const bad = await fetch(new URL('/api/overview', `http://127.0.0.1:${s.server.address().port}`), { headers: { cookie: 'aim_session=eyJzdWIiOiJvd25lciIsImV4cCI6OTk5OTk5OTk5OTk5OX0.forged' } });
  assert.equal(bad.status, 401);
  // Brute force lockout after 5 failures.
  for (let i = 0; i < 5; i++) await s.req('/api/login', { method: 'POST', body: { password: 'x' } });
  assert.equal((await s.req('/api/login', { method: 'POST', body: { password: 'correct horse' } })).status, 429);
  await s.close();
});

test('scrypt password hash works', async () => {
  const s = await boot({ OWNER_PASSWORD: '' });
  await s.close();
  process.env.OWNER_PASSWORD_HASH = hashPassword('pw-123');
  const t = await boot({ OWNER_PASSWORD: '' });
  assert.equal((await t.req('/api/login', { method: 'POST', body: { password: 'wrong' } })).status, 401);
  assert.equal((await t.req('/api/login', { method: 'POST', body: { password: 'pw-123' } })).status, 200);
  delete process.env.OWNER_PASSWORD_HASH;
  await t.close();
});

test('state-changing requests need the same-origin header (CSRF)', async () => {
  const s = await boot();
  await s.req('/api/login', { method: 'POST', body: { password: 'correct horse' } });
  const r = await s.req('/api/projects', { method: 'POST', body: { name: 'X' }, headers: { 'X-Requested-With': '' } });
  assert.equal(r.status, 403);
  await s.close();
});

test('secrets never reach client responses, exports or error messages', async () => {
  const s = await boot();
  await s.req('/api/login', { method: 'POST', body: { password: 'correct horse' } });
  const p = await s.req('/api/projects', { method: 'POST', body: { name: 'Leak test' } });
  await s.req(`/api/projects/${p.json.id}/tasks`, { method: 'POST', body: { title: `Use ${SECRET_O}` } });
  for (const url of ['/api/settings', '/api/agents', '/api/overview', '/api/export']) {
    const r = await s.req(url);
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes(SECRET_A), `${url} leaks anthropic key`);
    assert.ok(!r.text.includes('correct horse'), `${url} leaks password`);
  }
  const settings = (await s.req('/api/settings')).json;
  assert.equal(settings.providers.openai.configured, true);
  const err = await s.req('/api/projects', { method: 'POST', body: { name: '' } });
  assert.equal(err.status, 400);
  assert.equal(redact(`key ${SECRET_A} and Bearer abcdefghijkl`, s.cfg), 'key [redacted] and [redacted]');
  await s.close();
});

test('settings validation and pause control', async () => {
  const s = await boot();
  await s.req('/api/login', { method: 'POST', body: { password: 'correct horse' } });
  assert.equal((await s.req('/api/settings', { method: 'PATCH', body: { global_concurrency: -1 } })).status, 400);
  const ok = await s.req('/api/settings', { method: 'PATCH', body: { daily_cap_usd: 3, paused: true } });
  assert.equal(ok.json.settings.daily_cap_usd, 3);
  assert.equal(ok.json.settings.paused, false, 'pause only via its own endpoint');
  await s.req('/api/system/pause', { method: 'POST', body: { paused: true } });
  assert.equal((await s.req('/api/overview')).json.paused, true);
  await s.close();
});

test('empty state: overview works with no projects', async () => {
  const s = await boot();
  await s.req('/api/login', { method: 'POST', body: { password: 'correct horse' } });
  const o = (await s.req('/api/overview')).json;
  assert.equal(o.projects.length, 0);
  assert.equal(o.selected, null);
  assert.equal(o.team.length, 5, 'default team is seeded');
  assert.deepEqual(o.team.map((a) => a.role), ['Manager', 'Developer', 'Researcher', 'Marketer', 'Intern']);
  await s.close();
});

test('demo data only goes into the separate demo database', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-demo-'));
  const real = loadConfig({ DATA_DIR: dir, DEMO_MODE: '0' });
  const demo = loadConfig({ DATA_DIR: dir, DEMO_MODE: '1' });
  assert.notEqual(real.dbPath, demo.dbPath);
  assert.throws(() => seedDemo(openDb(real.dbPath), real), /outside demo mode/);
  const db = openDb(demo.dbPath);
  assert.equal(seedDemo(db, demo), true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM projects').get().n, 3);
  assert.equal(openDb(real.dbPath).prepare('SELECT COUNT(*) n FROM projects').get().n, 0);
});

test('artifact download is scoped to its project directory', async () => {
  const s = await boot();
  await s.req('/api/login', { method: 'POST', body: { password: 'correct horse' } });
  const db = s.server.db;
  const p = (await s.req('/api/projects', { method: 'POST', body: { name: 'Files' } })).json;
  db.prepare("INSERT INTO artifacts(id, project_id, name, rel_path, bytes, created_at) VALUES ('art_evil', ?, 'x', '../../../etc/passwd', 0, 0)").run(p.id);
  assert.equal((await s.req('/api/artifacts/art_evil')).status, 404);
  await s.close();
});
