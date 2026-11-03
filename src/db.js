// SQLite persistence using Node's built-in driver (no native dependencies).
// WAL mode lets the web process and the runner process share one file safely.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const now = () => Date.now();
export const newId = (prefix) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'window',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  priority INTEGER NOT NULL DEFAULT 1 CHECK (priority BETWEEN 1 AND 5),
  max_concurrency INTEGER NOT NULL DEFAULT 2 CHECK (max_concurrency BETWEEN 0 AND 20),
  brief TEXT NOT NULL DEFAULT '',
  goals TEXT NOT NULL DEFAULT '',
  budget_daily_usd REAL,
  budget_total_usd REAL,
  sched_pass REAL NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS milestones (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'development',
  due_at INTEGER,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  initials TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'green',
  provider TEXT NOT NULL CHECK (provider IN ('openai','anthropic','local','simulated')),
  model TEXT NOT NULL DEFAULT '',
  is_manager INTEGER NOT NULL DEFAULT 0,
  capabilities TEXT NOT NULL DEFAULT '[]',
  tools TEXT NOT NULL DEFAULT '[]',
  instructions TEXT NOT NULL DEFAULT '',
  capacity INTEGER NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 8),
  enabled INTEGER NOT NULL DEFAULT 1,
  paused INTEGER NOT NULL DEFAULT 0,
  all_projects INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_projects (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, project_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  short_label TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  acceptance_criteria TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'Developer',
  kind TEXT NOT NULL DEFAULT 'internal' CHECK (kind IN ('internal','external')),
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','assigned','running','awaiting_review','blocked','completed','failed','cancelled')),
  assigned_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  priority INTEGER NOT NULL DEFAULT 3,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 2,
  review_rounds INTEGER NOT NULL DEFAULT 0,
  max_review_rounds INTEGER NOT NULL DEFAULT 2,
  run_cost_limit_usd REAL,
  timeout_s INTEGER NOT NULL DEFAULT 900,
  review_notes TEXT NOT NULL DEFAULT '',
  blocked_reason TEXT NOT NULL DEFAULT '',
  needs_owner INTEGER NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  fallback_used INTEGER NOT NULL DEFAULT 0,
  result_summary TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS tasks_project_state ON tasks(project_id, state);

CREATE TABLE IF NOT EXISTS task_deps (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_id)
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  kind TEXT NOT NULL CHECK (kind IN ('execute','review')),
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','cancelled','interrupted','unknown')),
  attempt INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  provider_state TEXT NOT NULL DEFAULT 'idle' CHECK (provider_state IN ('idle','requesting','responded','error')),
  external_effect TEXT NOT NULL DEFAULT 'none' CHECK (external_effect IN ('none','pending','committed')),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  reserved_usd REAL NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  last_activity TEXT NOT NULL DEFAULT '',
  ended_at INTEGER,
  summary TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  verdict TEXT,
  log TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS runs_agent ON runs(agent_id, started_at);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'text/markdown',
  bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  cost_kind TEXT NOT NULL CHECK (cost_kind IN ('reported','estimated','unknown','simulated','local')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_project_time ON usage(project_id, created_at);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  project_id TEXT,
  agent_id TEXT,
  task_id TEXT,
  run_id TEXT,
  artifact_id TEXT,
  message TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS events_project ON events(project_id, id);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS heartbeats (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  pid INTEGER,
  started_at INTEGER NOT NULL,
  last_beat_at INTEGER NOT NULL,
  info TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS intern_evals (
  id TEXT PRIMARY KEY,
  task_type TEXT NOT NULL,
  samples INTEGER NOT NULL DEFAULT 0,
  passed INTEGER NOT NULL DEFAULT 0,
  avg_seconds REAL,
  review_minutes REAL,
  decision TEXT NOT NULL DEFAULT 'not_evaluated' CHECK (decision IN ('not_evaluated','approved','rejected')),
  notes TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
`;

export const DEFAULT_SETTINGS = {
  paused: false,
  global_concurrency: 3,
  daily_cap_usd: 10,
  monthly_cap_usd: 150,
  default_run_cap_usd: 0.5,
  heartbeat_stale_s: 30,
  activity_stale_s: 120,
  dashboard_stale_s: 15,
  default_models: { openai: 'gpt-6.1-sol', anthropic: 'claude-opus-5-5', local: '' },
  permissions: {
    auto_assign_internal: true,
    allow_external_actions: false,
    marketing_mode: 'draft_only',
    sales_mode: 'draft_only',
    intern_reassign: true,
    intern_fallback_role: 'Researcher',
  },
  backup: { include_artifacts: true },
};

export function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  const get = db.prepare('SELECT value FROM settings WHERE key = ?');
  const put = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) if (!get.get(k)) put.run(k, JSON.stringify(v));
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function getSettings(db) {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    try { out[row.key] = JSON.parse(row.value); } catch { /* ignore malformed */ }
  }
  return out;
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

export function plain(row) {
  return row ? { ...row } : row;
}
export function all(db, sql, ...args) {
  return db.prepare(sql).all(...args).map(plain);
}
export function one(db, sql, ...args) {
  return plain(db.prepare(sql).get(...args));
}
