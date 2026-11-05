// Domain logic: projects, agents, tasks, events, usage and derived status.
// Deterministic housekeeping lives here in plain code, never in model calls.
import fs from 'node:fs';
import path from 'node:path';
import { all, one, now, newId, tx, getSettings } from './db.js';

export const TASK_STATES = ['queued', 'assigned', 'running', 'awaiting_review', 'blocked', 'completed', 'failed', 'cancelled'];
export const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
export const PROJECT_ICONS = ['window', 'calendar', 'document', 'cart', 'chart', 'chat', 'box', 'globe'];
export const COLORS = ['green', 'peach', 'lavender', 'yellow', 'blue', 'pink'];
export const PHASES = ['validation', 'research', 'development', 'storefront', 'marketing', 'sales', 'onboarding'];

// Allowed task transitions. Anything else is rejected.
const TRANSITIONS = {
  queued: ['assigned', 'running', 'blocked', 'cancelled'],
  assigned: ['running', 'queued', 'blocked', 'cancelled'],
  running: ['awaiting_review', 'queued', 'failed', 'blocked', 'cancelled'],
  awaiting_review: ['completed', 'queued', 'blocked', 'failed', 'cancelled'],
  blocked: ['queued', 'cancelled'],
  failed: ['queued'],
  cancelled: ['queued'],
  completed: [],
};
export function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);
const notFound = (m = 'Not found') => new HttpError(404, m);

function str(v, max = 2000) {
  if (v === undefined || v === null) return '';
  return String(v).slice(0, max).trim();
}
function initialsFor(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0] ?? '?').slice(0, 1).toUpperCase();
}

// ---------- events ----------
export function addEvent(db, ev) {
  const r = db.prepare(`INSERT INTO events(ts, type, project_id, agent_id, task_id, run_id, artifact_id, message, data)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    ev.ts ?? now(), ev.type, ev.project_id ?? null, ev.agent_id ?? null, ev.task_id ?? null,
    ev.run_id ?? null, ev.artifact_id ?? null, str(ev.message, 300), JSON.stringify(ev.data ?? {}));
  return Number(r.lastInsertRowid);
}

export const EVENT_CATEGORY = {
  'run.started': 'started', 'review.started': 'started',
  'run.completed': 'completed', 'task.completed': 'completed', 'artifact.saved': 'completed',
  'run.failed': 'failed', 'task.failed': 'failed', 'run.interrupted': 'failed',
  'task.reviewed': 'reviewed', 'task.rework': 'reviewed',
  'task.cancelled': 'cancelled', 'run.cancelled': 'cancelled',
  'task.blocked': 'blocked',
};
const WORK_TYPES = ['run.completed', 'task.completed', 'task.reviewed', 'task.rework', 'run.failed', 'task.blocked', 'task.failed', 'task.cancelled'];

export function listEvents(db, f = {}) {
  const where = [];
  const args = [];
  if (f.project_id) { where.push('e.project_id = ?'); args.push(f.project_id); }
  if (f.agent_id) { where.push('e.agent_id = ?'); args.push(f.agent_id); }
  if (f.work) where.push(`e.type IN (${WORK_TYPES.map(() => '?').join(',')})`), args.push(...WORK_TYPES);
  if (f.category) {
    const types = Object.entries(EVENT_CATEGORY).filter(([, c]) => c === f.category).map(([t]) => t);
    if (!types.length) return [];
    where.push(`e.type IN (${types.map(() => '?').join(',')})`); args.push(...types);
  }
  if (f.from) { where.push('e.ts >= ?'); args.push(Number(f.from)); }
  if (f.to) { where.push('e.ts <= ?'); args.push(Number(f.to)); }
  if (f.after_id) { where.push('e.id > ?'); args.push(Number(f.after_id)); }
  if (f.before_id) { where.push('e.id < ?'); args.push(Number(f.before_id)); }
  if (f.q) {
    where.push(`(e.message LIKE ? OR p.name LIKE ? OR a.name LIKE ? OR t.title LIKE ?)`);
    const q = `%${str(f.q, 100)}%`;
    args.push(q, q, q, q);
  }
  const limit = Math.min(Number(f.limit) || 50, 500);
  const rows = all(db, `SELECT e.*, p.name AS project_name, a.name AS agent_name, a.role AS agent_role, t.title AS task_title
    FROM events e LEFT JOIN projects p ON p.id = e.project_id LEFT JOIN agents a ON a.id = e.agent_id
    LEFT JOIN tasks t ON t.id = e.task_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.ts DESC, e.id DESC LIMIT ${limit}`, ...args);
  return rows.map((r) => ({ ...r, data: safeJson(r.data, {}), category: EVENT_CATEGORY[r.type] ?? 'other' }));
}

function safeJson(s, d) { try { return JSON.parse(s); } catch { return d; } }

// ---------- projects ----------
export function projectDir(cfg, projectId) {
  if (!/^prj_[a-f0-9]+$/.test(projectId)) throw bad('invalid project id');
  return path.join(cfg.artifactsDir, projectId);
}

export function createProject(db, cfg, input) {
  const name = str(input.name, 80);
  if (!name) throw bad('Project name is required');
  const id = newId('prj');
  const t = now();
  const icon = PROJECT_ICONS.includes(input.icon) ? input.icon : 'window';
  const pos = (one(db, 'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM projects')?.p) ?? 0;
  // New projects join the fair-share rotation at the current minimum, not at zero.
  const pass = one(db, "SELECT COALESCE(MIN(sched_pass), 0) AS p FROM projects WHERE status = 'active'")?.p ?? 0;
  db.prepare(`INSERT INTO projects(id, name, icon, status, priority, max_concurrency, brief, goals, budget_daily_usd, budget_total_usd, sched_pass, position, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, name, icon, 'active', clampInt(input.priority, 1, 5, 2),
    clampInt(input.max_concurrency, 0, 20, 2), str(input.brief, 8000), str(input.goals, 8000),
    numOrNull(input.budget_daily_usd), numOrNull(input.budget_total_usd), pass, pos, t, t);
  if (cfg) fs.mkdirSync(path.join(projectDir(cfg, id), 'artifacts'), { recursive: true });
  addEvent(db, { type: 'project.created', project_id: id, message: `Project created` });
  return getProject(db, id);
}

function clampInt(v, lo, hi, d) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
}
function numOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw bad('Budget must be a positive number');
  return n;
}

export function getProject(db, id) {
  const p = one(db, 'SELECT * FROM projects WHERE id = ?', id);
  if (!p) throw notFound('Project not found');
  return p;
}

export function updateProject(db, id, input) {
  const p = getProject(db, id);
  const fields = {
    name: input.name !== undefined ? str(input.name, 80) || p.name : p.name,
    icon: PROJECT_ICONS.includes(input.icon) ? input.icon : p.icon,
    priority: input.priority !== undefined ? clampInt(input.priority, 1, 5, p.priority) : p.priority,
    max_concurrency: input.max_concurrency !== undefined ? clampInt(input.max_concurrency, 0, 20, p.max_concurrency) : p.max_concurrency,
    brief: input.brief !== undefined ? str(input.brief, 8000) : p.brief,
    goals: input.goals !== undefined ? str(input.goals, 8000) : p.goals,
    budget_daily_usd: input.budget_daily_usd !== undefined ? numOrNull(input.budget_daily_usd) : p.budget_daily_usd,
    budget_total_usd: input.budget_total_usd !== undefined ? numOrNull(input.budget_total_usd) : p.budget_total_usd,
  };
  db.prepare(`UPDATE projects SET name=?, icon=?, priority=?, max_concurrency=?, brief=?, goals=?, budget_daily_usd=?, budget_total_usd=?, updated_at=? WHERE id=?`)
    .run(fields.name, fields.icon, fields.priority, fields.max_concurrency, fields.brief, fields.goals,
      fields.budget_daily_usd, fields.budget_total_usd, now(), id);
  return getProject(db, id);
}

export function setProjectStatus(db, id, status) {
  if (!['active', 'paused', 'archived'].includes(status)) throw bad('invalid status');
  const p = getProject(db, id);
  if (p.status === status) return p;
  db.prepare('UPDATE projects SET status=?, updated_at=? WHERE id=?').run(status, now(), id);
  const verb = { active: 'resumed', paused: 'paused', archived: 'archived' }[status];
  addEvent(db, { type: `project.${verb}`, project_id: id, message: `Project ${verb}` });
  return getProject(db, id);
}

// ---------- milestones ----------
export function addMilestone(db, projectId, input) {
  getProject(db, projectId);
  const title = str(input.title, 120);
  if (!title) throw bad('Milestone title is required');
  const id = newId('ms');
  const pos = one(db, 'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM milestones WHERE project_id = ?', projectId).p;
  db.prepare('INSERT INTO milestones(id, project_id, title, phase, due_at, status, position, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, projectId, title, PHASES.includes(input.phase) ? input.phase : 'development',
      input.due_at ? Number(new Date(input.due_at)) || null : null, 'open', pos, now());
  return one(db, 'SELECT * FROM milestones WHERE id = ?', id);
}
export function updateMilestone(db, id, input) {
  const m = one(db, 'SELECT * FROM milestones WHERE id = ?', id);
  if (!m) throw notFound();
  db.prepare('UPDATE milestones SET title=?, phase=?, due_at=?, status=? WHERE id=?').run(
    input.title !== undefined ? str(input.title, 120) || m.title : m.title,
    PHASES.includes(input.phase) ? input.phase : m.phase,
    input.due_at !== undefined ? (input.due_at ? Number(new Date(input.due_at)) || null : null) : m.due_at,
    ['open', 'done'].includes(input.status) ? input.status : m.status, id);
  return one(db, 'SELECT * FROM milestones WHERE id = ?', id);
}

// ---------- agents ----------
export function createAgent(db, input) {
  const role = str(input.role, 40);
  if (!role) throw bad('Role is required');
  if (!['openai', 'anthropic', 'local', 'simulated'].includes(input.provider)) throw bad('Unknown provider');
  const isManager = role.toLowerCase() === 'manager';
  if (isManager && input.provider !== 'openai' && input.provider !== 'simulated') throw bad('The Manager runs on OpenAI');
  if (isManager && one(db, 'SELECT id FROM agents WHERE is_manager = 1')) throw bad('There is already a Manager');
  // Give same-role agents distinct identities ("Developer 2").
  const sameRole = one(db, 'SELECT COUNT(*) AS n FROM agents WHERE role = ?', role).n;
  const name = str(input.name, 60) || (sameRole ? `${role} ${sameRole + 1}` : role);
  const id = newId('agt');
  const t = now();
  const pos = one(db, 'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM agents').p;
  db.prepare(`INSERT INTO agents(id, name, role, initials, color, provider, model, is_manager, capabilities, tools, instructions, capacity, enabled, paused, all_projects, position, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, name, role, str(input.initials, 2).toUpperCase() || initialsFor(name),
    COLORS.includes(input.color) ? input.color : 'green', input.provider, str(input.model, 80), isManager ? 1 : 0,
    JSON.stringify(arr(input.capabilities)), JSON.stringify(arr(input.tools)), str(input.instructions, 8000),
    clampInt(input.capacity, 1, 8, 1), 1, 0, isManager ? 1 : 0, pos, t, t);
  addEvent(db, { type: 'agent.created', agent_id: id, message: `${name} added` });
  return getAgent(db, id);
}
function arr(v) {
  if (Array.isArray(v)) return v.map((x) => str(x, 60)).filter(Boolean).slice(0, 30);
  if (typeof v === 'string') return v.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 30);
  return [];
}

export function getAgent(db, id) {
  const a = one(db, 'SELECT * FROM agents WHERE id = ?', id);
  if (!a) throw notFound('Agent not found');
  a.capabilities = safeJson(a.capabilities, []);
  a.tools = safeJson(a.tools, []);
  a.project_ids = all(db, 'SELECT project_id FROM agent_projects WHERE agent_id = ?', id).map((r) => r.project_id);
  return a;
}
export function listAgents(db) {
  return all(db, 'SELECT id FROM agents ORDER BY is_manager DESC, position').map((r) => getAgent(db, r.id));
}

export function updateAgent(db, id, input) {
  const a = getAgent(db, id);
  if (input.provider && !['openai', 'anthropic', 'local', 'simulated'].includes(input.provider)) throw bad('Unknown provider');
  if (a.is_manager && input.provider && !['openai', 'simulated'].includes(input.provider)) throw bad('The Manager runs on OpenAI');
  db.prepare(`UPDATE agents SET name=?, initials=?, color=?, provider=?, model=?, capabilities=?, tools=?, instructions=?, capacity=?, enabled=?, updated_at=? WHERE id=?`).run(
    input.name !== undefined ? str(input.name, 60) || a.name : a.name,
    input.initials !== undefined ? str(input.initials, 2).toUpperCase() || a.initials : a.initials,
    COLORS.includes(input.color) ? input.color : a.color,
    input.provider ?? a.provider,
    input.model !== undefined ? str(input.model, 80) : a.model,
    JSON.stringify(input.capabilities !== undefined ? arr(input.capabilities) : a.capabilities),
    JSON.stringify(input.tools !== undefined ? arr(input.tools) : a.tools),
    input.instructions !== undefined ? str(input.instructions, 8000) : a.instructions,
    input.capacity !== undefined ? clampInt(input.capacity, 1, 8, a.capacity) : a.capacity,
    input.enabled !== undefined ? (input.enabled ? 1 : 0) : a.enabled,
    now(), id);
  return getAgent(db, id);
}

export function setAgentPaused(db, id, paused) {
  const a = getAgent(db, id);
  db.prepare('UPDATE agents SET paused=?, updated_at=? WHERE id=?').run(paused ? 1 : 0, now(), id);
  addEvent(db, { type: paused ? 'agent.paused' : 'agent.resumed', agent_id: id, message: `${a.name} ${paused ? 'paused' : 'resumed'}` });
  return getAgent(db, id);
}

export function setAssignment(db, agentId, projectId, assigned) {
  getAgent(db, agentId); getProject(db, projectId);
  if (assigned) db.prepare('INSERT OR IGNORE INTO agent_projects(agent_id, project_id) VALUES (?,?)').run(agentId, projectId);
  else db.prepare('DELETE FROM agent_projects WHERE agent_id=? AND project_id=?').run(agentId, projectId);
}

// ---------- tasks ----------
export function createTask(db, projectId, input) {
  const p = getProject(db, projectId);
  if (p.status === 'archived') throw bad('Project is archived');
  const title = str(input.title, 200);
  if (!title) throw bad('Task title is required');
  const id = newId('tsk');
  const t = now();
  if (input.milestone_id) {
    const m = one(db, 'SELECT project_id FROM milestones WHERE id = ?', input.milestone_id);
    if (!m || m.project_id !== projectId) throw bad('Milestone belongs to another project');
  }
  if (input.assigned_agent_id) {
    const a = getAgent(db, input.assigned_agent_id);
    if (!a.all_projects && !a.project_ids.includes(projectId)) throw bad('Agent is not assigned to this project');
  }
  const kind = input.kind === 'external' ? 'external' : 'internal';
  tx(db, () => {
    db.prepare(`INSERT INTO tasks(id, project_id, milestone_id, title, short_label, description, acceptance_criteria, role, kind, state, assigned_agent_id, priority, max_attempts, max_review_rounds, run_cost_limit_usd, timeout_s, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, projectId, input.milestone_id || null, title,
      str(input.short_label, 40) || shortLabel(title), str(input.description, 8000), str(input.acceptance_criteria, 4000),
      str(input.role, 40) || 'Developer', kind, 'queued', input.assigned_agent_id || null,
      clampInt(input.priority, 1, 5, 3), clampInt(input.max_attempts, 1, 5, 2), clampInt(input.max_review_rounds, 0, 5, 2),
      numOrNull(input.run_cost_limit_usd), clampInt(input.timeout_s, 30, 7200, 900), t, t);
    for (const dep of input.depends_on ?? []) addDependency(db, id, dep);
    addEvent(db, { type: 'task.created', project_id: projectId, task_id: id, message: `Task added: ${shortLabel(title)}` });
  });
  return getTask(db, id);
}

export function shortLabel(title) {
  const words = String(title).replace(/[.:].*$/, '').split(/\s+/).slice(0, 4).join(' ');
  return words.length > 32 ? words.slice(0, 31) + '…' : words;
}

export function addDependency(db, taskId, dependsOnId) {
  if (taskId === dependsOnId) throw bad('A task cannot depend on itself');
  const a = one(db, 'SELECT project_id FROM tasks WHERE id = ?', taskId);
  const b = one(db, 'SELECT project_id FROM tasks WHERE id = ?', dependsOnId);
  if (!a || !b) throw notFound('Task not found');
  if (a.project_id !== b.project_id) throw bad('Dependencies must stay inside one project');
  // Reject cycles: walk from dependsOn back through its deps.
  const seen = new Set();
  const stack = [dependsOnId];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === taskId) throw bad('That dependency would create a cycle');
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const r of all(db, 'SELECT depends_on_id FROM task_deps WHERE task_id = ?', cur)) stack.push(r.depends_on_id);
  }
  db.prepare('INSERT OR IGNORE INTO task_deps(task_id, depends_on_id) VALUES (?,?)').run(taskId, dependsOnId);
}

export function getTask(db, id) {
  const t = one(db, 'SELECT * FROM tasks WHERE id = ?', id);
  if (!t) throw notFound('Task not found');
  t.depends_on = all(db, 'SELECT d.depends_on_id AS id, t.title, t.state FROM task_deps d JOIN tasks t ON t.id = d.depends_on_id WHERE d.task_id = ?', id);
  return t;
}

export function listTasks(db, projectId) {
  return all(db, `SELECT t.*, a.name AS agent_name FROM tasks t LEFT JOIN agents a ON a.id = t.assigned_agent_id
    WHERE t.project_id = ? ORDER BY CASE t.state WHEN 'running' THEN 0 WHEN 'awaiting_review' THEN 1 WHEN 'blocked' THEN 2 WHEN 'assigned' THEN 3 WHEN 'queued' THEN 4 ELSE 5 END, t.priority, t.created_at`, projectId)
    .map((t) => ({ ...t, depends_on: all(db, 'SELECT depends_on_id AS id FROM task_deps WHERE task_id = ?', t.id).map((r) => r.id) }));
}

// Optimistic state change: succeeds only if the task is still in the expected state/version.
export function transition(db, taskId, from, to, patch = {}) {
  if (!canTransition(from, to)) throw new HttpError(409, `Cannot move task from ${from} to ${to}`);
  const sets = ['state = ?', 'version = version + 1', 'updated_at = ?'];
  const args = [to, now()];
  for (const [k, v] of Object.entries(patch)) { sets.push(`${k} = ?`); args.push(v); }
  if (to === 'completed') { sets.push('completed_at = ?'); args.push(now()); }
  const r = db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ? AND state = ?`).run(...args, taskId, from);
  return r.changes === 1;
}

export function updateTask(db, id, input) {
  const t = getTask(db, id);
  if (TERMINAL.has(t.state) && t.state !== 'failed' && t.state !== 'cancelled') throw bad('Completed tasks cannot be edited');
  if (input.assigned_agent_id) {
    const a = getAgent(db, input.assigned_agent_id);
    if (!a.all_projects && !a.project_ids.includes(t.project_id)) throw bad('Agent is not assigned to this project');
  }
  db.prepare(`UPDATE tasks SET title=?, short_label=?, description=?, acceptance_criteria=?, role=?, priority=?, assigned_agent_id=?, max_attempts=?, max_review_rounds=?, run_cost_limit_usd=?, updated_at=? WHERE id=?`).run(
    input.title !== undefined ? str(input.title, 200) || t.title : t.title,
    input.short_label !== undefined ? str(input.short_label, 40) : t.short_label,
    input.description !== undefined ? str(input.description, 8000) : t.description,
    input.acceptance_criteria !== undefined ? str(input.acceptance_criteria, 4000) : t.acceptance_criteria,
    input.role !== undefined ? str(input.role, 40) || t.role : t.role,
    input.priority !== undefined ? clampInt(input.priority, 1, 5, t.priority) : t.priority,
    input.assigned_agent_id !== undefined ? input.assigned_agent_id || null : t.assigned_agent_id,
    input.max_attempts !== undefined ? clampInt(input.max_attempts, 1, 5, t.max_attempts) : t.max_attempts,
    input.max_review_rounds !== undefined ? clampInt(input.max_review_rounds, 0, 5, t.max_review_rounds) : t.max_review_rounds,
    input.run_cost_limit_usd !== undefined ? numOrNull(input.run_cost_limit_usd) : t.run_cost_limit_usd,
    now(), id);
  if (Array.isArray(input.depends_on)) {
    db.prepare('DELETE FROM task_deps WHERE task_id = ?').run(id);
    for (const d of input.depends_on) addDependency(db, id, d);
  }
  return getTask(db, id);
}

// Owner-initiated cancel. Running work is signalled; the runner aborts it.
export function cancelTask(db, id) {
  const t = getTask(db, id);
  if (TERMINAL.has(t.state)) throw new HttpError(409, 'Task already finished');
  if (t.state === 'running' || t.state === 'awaiting_review') {
    db.prepare('UPDATE tasks SET cancel_requested = 1, updated_at = ? WHERE id = ?').run(now(), id);
    addEvent(db, { type: 'task.cancel_requested', project_id: t.project_id, task_id: id, agent_id: t.assigned_agent_id, message: `Cancel requested: ${t.short_label}` });
    return getTask(db, id);
  }
  transition(db, id, t.state, 'cancelled', { needs_owner: 0 });
  addEvent(db, { type: 'task.cancelled', project_id: t.project_id, task_id: id, agent_id: t.assigned_agent_id, message: `Cancelled: ${t.short_label}` });
  return getTask(db, id);
}

// Owner-initiated retry: resets attempts so the task is eligible again.
export function retryTask(db, id) {
  const t = getTask(db, id);
  if (!['failed', 'cancelled', 'blocked'].includes(t.state)) throw new HttpError(409, 'Only failed, blocked or cancelled tasks can be retried');
  transition(db, id, t.state, 'queued', { attempts: 0, review_rounds: 0, needs_owner: 0, blocked_reason: '', cancel_requested: 0 });
  addEvent(db, { type: 'task.retried', project_id: t.project_id, task_id: id, agent_id: t.assigned_agent_id, message: `Retry: ${t.short_label}` });
  return getTask(db, id);
}

// ---------- usage & budget ----------
export function startOfDay(ts = now()) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
export function startOfMonth(ts = now()) { const d = new Date(ts); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime(); }

export function recordUsage(db, u) {
  const id = newId('use');
  db.prepare(`INSERT INTO usage(id, project_id, run_id, agent_id, provider, model, input_tokens, output_tokens, cost_usd, cost_kind, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, u.project_id, u.run_id ?? null, u.agent_id ?? null, u.provider, u.model ?? '',
    u.input_tokens ?? null, u.output_tokens ?? null, u.cost_usd ?? null, u.cost_kind, u.created_at ?? now());
  return id;
}

// Spend that counts toward caps: provider-reported + our estimates. Simulated and
// local compute are tracked separately and never presented as API charges.
export function spend(db, { project_id, since } = {}) {
  const where = ['created_at >= ?'];
  const args = [since ?? 0];
  if (project_id) { where.push('project_id = ?'); args.push(project_id); }
  const rows = all(db, `SELECT cost_kind, COALESCE(SUM(cost_usd),0) AS usd, COUNT(*) AS n FROM usage WHERE ${where.join(' AND ')} GROUP BY cost_kind`, ...args);
  const out = { reported: 0, estimated: 0, simulated: 0, local: 0, unknown_count: 0 };
  for (const r of rows) {
    if (r.cost_kind === 'unknown') out.unknown_count += r.n;
    else out[r.cost_kind] += r.usd;
  }
  out.billable = out.reported + out.estimated;
  return out;
}

export function reservedUsd(db, projectId) {
  const r = one(db, `SELECT COALESCE(SUM(reserved_usd),0) AS r FROM runs WHERE status = 'running' ${projectId ? 'AND project_id = ?' : ''}`, ...(projectId ? [projectId] : []));
  return r.r;
}

// Can a new run reserving `amount` start? Returns null if OK, else a reason.
export function budgetCheck(db, settings, project, amount) {
  const day = startOfDay();
  const g = spend(db, { since: day }).billable + reservedUsd(db);
  if (settings.daily_cap_usd != null && g + amount > settings.daily_cap_usd) return 'Global daily cap reached';
  const m = spend(db, { since: startOfMonth() }).billable + reservedUsd(db);
  if (settings.monthly_cap_usd != null && m + amount > settings.monthly_cap_usd) return 'Global monthly cap reached';
  const pr = reservedUsd(db, project.id);
  if (project.budget_daily_usd != null && spend(db, { project_id: project.id, since: day }).billable + pr + amount > project.budget_daily_usd) return 'Project daily budget reached';
  if (project.budget_total_usd != null && spend(db, { project_id: project.id }).billable + pr + amount > project.budget_total_usd) return 'Project budget reached';
  return null;
}

// ---------- status ----------
export function runnerHeartbeat(db) {
  return one(db, "SELECT * FROM heartbeats WHERE kind = 'runner' ORDER BY last_beat_at DESC LIMIT 1");
}

export function agentStatus(db, cfg, agent, ctx = {}) {
  const settings = ctx.settings ?? getSettings(db);
  const t = ctx.now ?? now();
  const hb = ctx.heartbeat !== undefined ? ctx.heartbeat : runnerHeartbeat(db);
  const runnerFresh = hb && t - hb.last_beat_at <= settings.heartbeat_stale_s * 1000;
  const run = one(db, `SELECT r.*, tk.short_label, tk.title AS task_title, p.name AS project_name FROM runs r
    JOIN tasks tk ON tk.id = r.task_id JOIN projects p ON p.id = r.project_id
    WHERE r.agent_id = ? AND r.status = 'running' ORDER BY r.started_at DESC LIMIT 1`, agent.id);
  const base = { last_activity_at: null, last_activity: '', project_id: null, project_name: null, task_id: null, task_label: '', run_id: null };
  const lastRun = one(db, `SELECT r.*, tk.short_label, p.name AS project_name FROM runs r JOIN tasks tk ON tk.id = r.task_id JOIN projects p ON p.id = r.project_id
    WHERE r.agent_id = ? ORDER BY r.started_at DESC LIMIT 1`, agent.id);
  if (lastRun) Object.assign(base, { last_activity_at: lastRun.last_activity_at, last_activity: lastRun.last_activity || lastRun.summary });

  if (!agent.enabled) return { ...base, status: 'offline', detail: 'Disabled' };
  if (run) {
    const info = { ...base, project_id: run.project_id, project_name: run.project_name, task_id: run.task_id, task_label: run.short_label,
      run_id: run.id, last_activity_at: run.last_activity_at, last_activity: run.last_activity, started_at: run.started_at, provider_state: run.provider_state };
    if (!runnerFresh) return { ...info, status: 'unknown', detail: 'Runner not reporting' };
    if (t - run.last_activity_at > settings.activity_stale_s * 1000) return { ...info, status: 'unknown', detail: 'No recent activity' };
    return { ...info, status: run.kind === 'review' ? 'reviewing' : 'working' };
  }
  if (agent.paused) return { ...base, status: 'paused' };
  if (cfg && !providerReady(cfg, agent.provider)) return { ...base, status: 'offline', detail: 'Not connected' };
  if (!runnerFresh) return { ...base, status: 'offline', detail: 'Runner offline' };
  const blocked = one(db, `SELECT tk.id, tk.short_label, tk.project_id, p.name AS project_name FROM tasks tk JOIN projects p ON p.id = tk.project_id
    WHERE tk.assigned_agent_id = ? AND tk.state = 'blocked' AND p.status != 'archived' ORDER BY tk.updated_at DESC LIMIT 1`, agent.id);
  const queued = one(db, `SELECT tk.id, tk.short_label, tk.project_id, p.name AS project_name FROM tasks tk JOIN projects p ON p.id = tk.project_id
    WHERE tk.assigned_agent_id = ? AND tk.state IN ('queued','assigned') AND p.status = 'active' ORDER BY tk.priority, tk.created_at LIMIT 1`, agent.id);
  if (lastRun && lastRun.status === 'failed' && t - (lastRun.ended_at ?? 0) < 30 * 60 * 1000 && !queued)
    return { ...base, status: 'failed', project_id: lastRun.project_id, project_name: lastRun.project_name, task_id: lastRun.task_id, task_label: lastRun.short_label };
  if (queued) return { ...base, status: 'queued', project_id: queued.project_id, project_name: queued.project_name, task_id: queued.id, task_label: queued.short_label };
  if (blocked) return { ...base, status: 'blocked', project_id: blocked.project_id, project_name: blocked.project_name, task_id: blocked.id, task_label: blocked.short_label };
  return { ...base, status: 'available' };
}

export function providerReady(cfg, provider) {
  if (provider === 'simulated' || cfg.demo) return true;
  if (provider === 'local') return Boolean(cfg.localAiUrl);
  return Boolean(cfg.secrets?.[provider]) && cfg.paidExecution;
}

export function attentionItems(db) {
  return all(db, `SELECT t.id AS task_id, t.title, t.short_label, t.state, t.blocked_reason, t.project_id, p.name AS project_name, t.updated_at
    FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE p.status != 'archived' AND (t.state = 'blocked' OR (t.state = 'failed' AND t.needs_owner = 1) OR t.needs_owner = 1)
    ORDER BY t.updated_at DESC LIMIT 20`);
}

export function overview(db, cfg, selectedId) {
  const settings = getSettings(db);
  const hb = runnerHeartbeat(db);
  const ctx = { settings, heartbeat: hb, now: now() };
  const projects = all(db, "SELECT * FROM projects WHERE status != 'archived' ORDER BY position, created_at");
  const agents = listAgents(db).map((a) => ({ ...publicAgent(a), ...agentStatus(db, cfg, a, ctx) }));
  for (const p of projects) {
    p.working = agents.filter((a) => a.project_id === p.id && ['working', 'reviewing'].includes(a.status)).length;
    p.open_tasks = one(db, "SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND state NOT IN ('completed','failed','cancelled')", p.id).n;
    // Share of tasks completed (cancelled tasks don't count). A fact, not an ETA.
    const t = one(db, "SELECT SUM(state = 'completed') AS done, SUM(state != 'cancelled') AS total FROM tasks WHERE project_id = ?", p.id);
    p.tasks_done = t.done ?? 0;
    p.tasks_total = t.total ?? 0;
  }
  const selected = projects.find((p) => p.id === selectedId) ?? projects[0] ?? null;
  let detail = null;
  if (selected) {
    const next = one(db, "SELECT * FROM milestones WHERE project_id = ? AND status = 'open' ORDER BY position, created_at LIMIT 1", selected.id);
    const assignedIds = new Set(all(db, 'SELECT agent_id FROM agent_projects WHERE project_id = ?', selected.id).map((r) => r.agent_id));
    const assigned = agents.filter((a) => !a.is_manager && assignedIds.has(a.id)).map((a) => {
      const here = a.project_id === selected.id;
      return { ...a, here, current_label: here ? a.task_label : '' };
    });
    detail = { ...selected, next_milestone: next, assigned };
  }
  const today = spend(db, { since: startOfDay() });
  return {
    demo: cfg.demo,
    now: ctx.now,
    paused: Boolean(settings.paused),
    runner: hb ? { last_beat_at: hb.last_beat_at, fresh: ctx.now - hb.last_beat_at <= settings.heartbeat_stale_s * 1000 } : null,
    summary: {
      working: agents.filter((a) => ['working', 'reviewing'].includes(a.status)).length,
      available: agents.filter((a) => a.status === 'available').length,
      spend_today: today,
    },
    projects,
    selected: detail,
    team: agents,
    latest: listEvents(db, { work: true, limit: 12 }),
    attention: attentionItems(db),
    stale: { heartbeat_s: settings.heartbeat_stale_s, activity_s: settings.activity_stale_s, dashboard_s: settings.dashboard_stale_s },
  };
}

export function publicAgent(a) {
  const { instructions, ...rest } = a;
  return { ...rest, has_instructions: Boolean(instructions) };
}

// ---------- seeding ----------
export function seedTeam(db, settings) {
  if (one(db, 'SELECT COUNT(*) AS n FROM agents').n) return;
  const m = settings?.default_models ?? {};
  createAgent(db, { role: 'Manager', provider: 'openai', model: m.openai, color: 'green', capabilities: ['planning', 'review'], tools: [] });
  createAgent(db, { role: 'Developer', provider: 'anthropic', model: m.anthropic, color: 'green', capabilities: ['code', 'tests', 'docs'], tools: ['workspace_files'] });
  createAgent(db, { role: 'Researcher', provider: 'anthropic', model: m.anthropic, color: 'peach', capabilities: ['research'], tools: [] });
  createAgent(db, { role: 'Marketer', provider: 'anthropic', model: m.anthropic, initials: 'MK', color: 'lavender', capabilities: ['copy', 'campaigns'], tools: [] });
  createAgent(db, { role: 'Intern', provider: 'local', model: '', color: 'yellow', capabilities: ['extraction', 'classification', 'formatting', 'summarization'], tools: [] });
}
