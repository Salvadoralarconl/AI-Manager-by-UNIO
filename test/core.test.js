import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, settle, events } from './helpers.js';
import { setSetting, now, DEFAULT_SETTINGS } from '../src/db.js';
import { Runner } from '../src/runner.js';

function team(t) {
  const manager = t.mk('Manager');
  const dev = t.mk('Developer');
  const res = t.mk('Researcher');
  return { manager, dev, res };
}

test('full loop: execute → artifact → manager review → completed', async () => {
  const t = setup();
  const { dev } = team(t);
  const p = t.S.createProject(t.db, t.cfg, { name: 'Alpha' });
  t.S.setAssignment(t.db, dev.id, p.id, true);
  const task = t.S.createTask(t.db, p.id, { title: 'Build login', acceptance_criteria: 'Works' });
  await settle(t.runner);
  const done = t.S.getTask(t.db, task.id);
  assert.equal(done.state, 'completed');
  const runs = t.db.prepare('SELECT kind, status FROM runs WHERE task_id = ? ORDER BY started_at').all(task.id);
  assert.deepEqual(runs.map((r) => `${r.kind}:${r.status}`), ['execute:succeeded', 'review:succeeded']);
  const art = t.db.prepare('SELECT * FROM artifacts WHERE task_id = ?').get(task.id);
  assert.ok(fs.existsSync(path.join(t.dir, 'projects', p.id, art.rel_path)), 'artifact saved inside the project directory');
  const usage = t.db.prepare('SELECT cost_kind FROM usage WHERE project_id = ?').all(p.id);
  assert.ok(usage.length >= 2 && usage.every((u) => u.cost_kind === 'simulated'));
});

test('project data separation: context, dependencies, assignments and artifacts stay in their project', async () => {
  const t = setup();
  const { dev } = team(t);
  const a = t.S.createProject(t.db, t.cfg, { name: 'A', brief: 'SECRET-A brief' });
  const b = t.S.createProject(t.db, t.cfg, { name: 'B', brief: 'B brief' });
  t.S.setAssignment(t.db, dev.id, b.id, true);
  const ta = t.S.createTask(t.db, a.id, { title: 'A task' });
  const tb = t.S.createTask(t.db, b.id, { title: 'B task' });
  assert.throws(() => t.S.addDependency(t.db, tb.id, ta.id), /inside one project/);
  assert.throws(() => t.S.createTask(t.db, a.id, { title: 'x', assigned_agent_id: dev.id }), /not assigned/);
  const ctx = t.runner.buildContext(t.S.getTask(t.db, tb.id), dev, 'execute');
  assert.ok(!JSON.stringify(ctx).includes('SECRET-A'), 'other project brief not in context');
  await settle(t.runner);
  // Developer is only assigned to B, so A's task must not run.
  assert.equal(t.S.getTask(t.db, ta.id).state, 'queued');
  assert.equal(t.S.getTask(t.db, tb.id).state, 'completed');
  const arts = t.db.prepare('SELECT project_id FROM artifacts').all();
  assert.ok(arts.every((x) => x.project_id === b.id));
  assert.throws(() => t.S.projectDir(t.cfg, '../etc'), /invalid project id/);
});

test('dependencies run in order; failed dependency blocks dependents', async () => {
  const t = setup();
  const { dev } = team(t);
  const p = t.S.createProject(t.db, t.cfg, { name: 'Deps' });
  t.S.setAssignment(t.db, dev.id, p.id, true);
  const first = t.S.createTask(t.db, p.id, { title: 'First' });
  const second = t.S.createTask(t.db, p.id, { title: 'Second', depends_on: [first.id] });
  assert.throws(() => t.S.addDependency(t.db, first.id, second.id), /cycle/);
  await settle(t.runner);
  const r1 = t.db.prepare("SELECT MIN(started_at) s FROM runs WHERE task_id = ?").get(first.id).s;
  const r2 = t.db.prepare("SELECT MIN(started_at) s FROM runs WHERE task_id = ?").get(second.id).s;
  assert.ok(r2 >= r1);
  assert.equal(t.S.getTask(t.db, second.id).state, 'completed');

  const bad = t.S.createTask(t.db, p.id, { title: 'Broken [fail]', max_attempts: 1 });
  const after = t.S.createTask(t.db, p.id, { title: 'After broken', depends_on: [bad.id] });
  await settle(t.runner);
  assert.equal(t.S.getTask(t.db, bad.id).state, 'failed');
  const blocked = t.S.getTask(t.db, after.id);
  assert.equal(blocked.state, 'blocked');
  assert.match(blocked.blocked_reason, /failed/);
});

test('review rework is bounded and escalates to the owner', async () => {
  const t = setup();
  const { dev } = team(t);
  const p = t.S.createProject(t.db, t.cfg, { name: 'Review' });
  t.S.setAssignment(t.db, dev.id, p.id, true);
  const once = t.S.createTask(t.db, p.id, { title: 'Copy [rework]' });
  const never = t.S.createTask(t.db, p.id, { title: 'Copy [reject]', max_review_rounds: 2 });
  const block = t.S.createTask(t.db, p.id, { title: 'Pricing [block]' });
  await settle(t.runner, 80);
  const o = t.S.getTask(t.db, once.id);
  assert.equal(o.state, 'completed');
  assert.equal(o.review_rounds, 1);
  const n = t.S.getTask(t.db, never.id);
  assert.equal(n.state, 'blocked');
  assert.equal(n.needs_owner, 1);
  assert.equal(t.db.prepare("SELECT COUNT(*) c FROM runs WHERE task_id = ? AND kind = 'execute'").get(never.id).c, 3, 'initial + 2 rework rounds, then stop');
  assert.equal(t.S.getTask(t.db, block.id).state, 'blocked');
  assert.ok(t.S.attentionItems(t.db).length >= 2);
});

test('retries are bounded; flaky work recovers; owner retry resets', async () => {
  const t = setup();
  const { dev } = team(t);
  const p = t.S.createProject(t.db, t.cfg, { name: 'Retry' });
  t.S.setAssignment(t.db, dev.id, p.id, true);
  const flaky = t.S.createTask(t.db, p.id, { title: 'Deploy [flaky]', max_attempts: 2 });
  const broken = t.S.createTask(t.db, p.id, { title: 'Parse [fail]', max_attempts: 2 });
  await settle(t.runner, 60);
  assert.equal(t.S.getTask(t.db, flaky.id).state, 'completed');
  const b = t.S.getTask(t.db, broken.id);
  assert.equal(b.state, 'failed');
  assert.equal(b.attempts, 2);
  assert.equal(t.db.prepare("SELECT COUNT(*) c FROM runs WHERE task_id = ? AND kind='execute'").get(broken.id).c, 2);
  t.S.retryTask(t.db, broken.id);
  assert.equal(t.S.getTask(t.db, broken.id).state, 'queued');
  assert.equal(t.S.getTask(t.db, broken.id).attempts, 0);
});

test('agent capacity, project concurrency and global concurrency are enforced', async () => {
  const t = setup();
  team(t);
  const dev2 = t.mk('Developer');
  assert.equal(dev2.name, 'Developer 2', 'same-role agents get distinct identities');
  const devs = t.S.listAgents(t.db).filter((a) => a.role === 'Developer');
  const p = t.S.createProject(t.db, t.cfg, { name: 'Busy', max_concurrency: 5 });
  for (const d of devs) t.S.setAssignment(t.db, d.id, p.id, true);
  for (let i = 0; i < 5; i++) t.S.createTask(t.db, p.id, { title: `Job ${i} [slow]` });
  await t.runner.tick();
  // Two developers, capacity 1 each → exactly two concurrent runs, never two on one agent.
  const running = t.db.prepare("SELECT agent_id FROM runs WHERE status='running'").all();
  assert.equal(running.length, 2);
  assert.equal(new Set(running.map((r) => r.agent_id)).size, 2);
  for (const r of t.runner.active.values()) r.controller.abort();
  await t.runner.drain();

  const t2 = setup();
  const { dev } = team(t2);
  t2.S.updateAgent(t2.db, dev.id, { capacity: 4 });
  const q = t2.S.createProject(t2.db, t2.cfg, { name: 'Q', max_concurrency: 1 });
  t2.S.setAssignment(t2.db, dev.id, q.id, true);
  for (let i = 0; i < 3; i++) t2.S.createTask(t2.db, q.id, { title: `Job ${i} [slow]` });
  await t2.runner.tick();
  assert.equal(t2.db.prepare("SELECT COUNT(*) c FROM runs WHERE status='running'").get().c, 1, 'project concurrency 1');
  for (const r of t2.runner.active.values()) r.controller.abort();
  await t2.runner.drain();
});

test('fair scheduling: a busy project cannot starve another', async () => {
  const t = setup();
  const { dev } = team(t);
  setSetting(t.db, 'global_concurrency', 1);
  const big = t.S.createProject(t.db, t.cfg, { name: 'Big', priority: 1 });
  const small = t.S.createProject(t.db, t.cfg, { name: 'Small', priority: 1 });
  for (const p of [big, small]) t.S.setAssignment(t.db, dev.id, p.id, true);
  for (let i = 0; i < 6; i++) t.S.createTask(t.db, big.id, { title: `Big ${i}` });
  t.S.createTask(t.db, small.id, { title: 'Small 0' });
  t.S.createTask(t.db, small.id, { title: 'Small 1' });
  await settle(t.runner, 80);
  const order = t.db.prepare("SELECT project_id FROM runs WHERE kind='execute' ORDER BY started_at, rowid").all().map((r) => (r.project_id === big.id ? 'B' : 'S'));
  // Both Small tasks must start within the first four executions (round-robin), not after all six Big ones.
  assert.ok(order.slice(0, 4).filter((x) => x === 'S').length === 2, order.join(''));
});

test('pause all, project pause and agent pause stop new work; cancel stops running work', async () => {
  const t = setup();
  const { dev } = team(t);
  const p = t.S.createProject(t.db, t.cfg, { name: 'Pause' });
  t.S.setAssignment(t.db, dev.id, p.id, true);
  const task = t.S.createTask(t.db, p.id, { title: 'Work' });

  setSetting(t.db, 'paused', true);
  await t.runner.tick();
  assert.equal(t.runner.active.size, 0);
  setSetting(t.db, 'paused', false);

  t.S.setProjectStatus(t.db, p.id, 'paused');
  await t.runner.tick();
  assert.equal(t.runner.active.size, 0);
  t.S.setProjectStatus(t.db, p.id, 'active');

  t.S.setAgentPaused(t.db, dev.id, true);
  await t.runner.tick();
  assert.equal(t.runner.active.size, 0);
  assert.equal(t.S.agentStatus(t.db, t.cfg, t.S.getAgent(t.db, dev.id)).status, 'paused');
  t.S.setAgentPaused(t.db, dev.id, false);

  const slow = t.S.createTask(t.db, p.id, { title: 'Long [slow]', priority: 1 });
  await t.runner.tick();
  assert.equal(t.S.getTask(t.db, slow.id).state, 'running');
  t.S.cancelTask(t.db, slow.id);
  await t.runner.tick();
  await t.runner.drain();
  assert.equal(t.S.getTask(t.db, slow.id).state, 'cancelled');
  assert.equal(t.db.prepare('SELECT status FROM runs WHERE task_id = ?').get(slow.id).status, 'cancelled');
  await settle(t.runner);
  assert.equal(t.S.getTask(t.db, task.id).state, 'completed');
});

test('budget caps block paid work and reservations count in-flight runs', async () => {
  const t = setup({ ANTHROPIC_API_KEY: 'sk-ant-test-1234567890', PAID_EXECUTION_ENABLED: '1' });
  const { dev } = team(t);
  t.S.updateAgent(t.db, dev.id, { provider: 'anthropic' });
  let calls = 0;
  t.runner.adapters.anthropic = { id: 'anthropic', kinds: ['worker'], healthCheck: async () => ({ ok: true }),
    run: async () => { calls++; await new Promise((r) => setTimeout(r, 30)); return { status: 'succeeded', summary: 'ok', outputText: 'x', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.4, costKind: 'reported' } }; } };
  setSetting(t.db, 'daily_cap_usd', 1);
  setSetting(t.db, 'default_run_cap_usd', 0.5);
  const p = t.S.createProject(t.db, t.cfg, { name: 'Budget' });
  t.S.setAssignment(t.db, dev.id, p.id, true);
  t.S.updateAgent(t.db, dev.id, { capacity: 4 });
  for (let i = 0; i < 4; i++) t.S.createTask(t.db, p.id, { title: `Paid ${i}` });
  await t.runner.tick();
  // $1 cap with $0.50 reservations → at most 2 can be in flight at once.
  assert.equal(t.runner.active.size, 2);
  await t.runner.drain();
  await t.runner.tick();
  // Spent $0.80; another $0.50 reservation would exceed $1. (Simulated Manager reviews may run; they cost nothing.)
  assert.equal(t.db.prepare("SELECT COUNT(*) c FROM runs WHERE status='running' AND kind='execute'").get().c, 0);
  await t.runner.drain();
  assert.equal(calls, 2);
  assert.ok(events(t.db, 'budget.limited').length === 1);
  const s = t.S.spend(t.db, { since: t.S.startOfDay() });
  assert.equal(+s.reported.toFixed(2), 0.8);
  // Project budget applies too.
  const t2 = setup();
  const p2 = t2.S.createProject(t2.db, t2.cfg, { name: 'P2', budget_daily_usd: 0.1 });
  assert.equal(t2.S.budgetCheck(t2.db, DEFAULT_SETTINGS, p2, 0.5), 'Project daily budget reached');
});

test('paid providers are not used without credentials and explicit enablement', async () => {
  const t = setup({ ANTHROPIC_API_KEY: 'sk-ant-test-1234567890' }); // key but paid execution off
  const { dev } = team(t);
  t.S.updateAgent(t.db, dev.id, { provider: 'anthropic' });
  const p = t.S.createProject(t.db, t.cfg, { name: 'Off' });
  t.S.setAssignment(t.db, dev.id, p.id, true);
  const task = t.S.createTask(t.db, p.id, { title: 'Should wait' });
  await t.runner.tick();
  assert.equal(t.runner.active.size, 0);
  assert.equal(t.S.getTask(t.db, task.id).state, 'queued');
  const st = t.S.agentStatus(t.db, t.cfg, t.S.getAgent(t.db, dev.id));
  assert.equal(st.status, 'offline');
  assert.equal(st.detail, 'Not connected');
});

test('stale telemetry shows unknown, never an indefinite Working', async () => {
  const t = setup();
  const { dev } = team(t);
  const p = t.S.createProject(t.db, t.cfg, { name: 'Stale' });
  t.S.setAssignment(t.db, dev.id, p.id, true);
  t.S.createTask(t.db, p.id, { title: 'Long [slow]' });
  await t.runner.tick();
  const agent = t.S.getAgent(t.db, dev.id);
  assert.equal(t.S.agentStatus(t.db, t.cfg, agent).status, 'working');
  const later = now() + 10 * 60 * 1000;
  const st = t.S.agentStatus(t.db, t.cfg, agent, { now: later });
  assert.equal(st.status, 'unknown');
  assert.ok(st.last_activity, 'last known activity is kept');
  // No runner at all → offline, not available.
  const t2 = setup();
  const a2 = t2.mk('Developer');
  assert.equal(t2.S.agentStatus(t2.db, t2.cfg, a2).status, 'offline');
  for (const r of t.runner.active.values()) r.controller.abort();
  await t.runner.drain();
});

test('restart recovery: internal work is requeued once, external work with unknown outcome is not repeated', async () => {
  const t = setup();
  const { dev } = team(t);
  const p = t.S.createProject(t.db, t.cfg, { name: 'Crash' });
  t.S.setAssignment(t.db, dev.id, p.id, true);
  t.S.updateAgent(t.db, dev.id, { capacity: 2 });
  const internal = t.S.createTask(t.db, p.id, { title: 'Internal [slow]' });
  const external = t.S.createTask(t.db, p.id, { title: 'Send email [slow]', kind: 'external' });
  await t.runner.tick();
  assert.equal(t.runner.active.size, 2);
  // Simulate a crash: the old runner stops heartbeating and its leases lapse.
  t.runner.stopped = true;
  for (const r of t.runner.active.values()) r.controller.abort();
  const stash = t.runner.active; t.runner.active = new Map();
  t.db.prepare("UPDATE runs SET provider_state = 'requesting', lease_expires_at = 0").run();
  t.db.prepare("UPDATE heartbeats SET last_beat_at = 0").run();
  // finish() of the aborted old runs must not interfere: wait for them first.
  await Promise.all([...stash.values()].map((a) => a.promise));
  // The aborted runs were marked cancelled by the old process; reset them to "running" to model a hard crash.
  t.db.prepare("UPDATE runs SET status = 'running', ended_at = NULL").run();
  t.db.prepare("UPDATE tasks SET state = 'running' WHERE id IN (?, ?)").run(internal.id, external.id);

  const fresh = new Runner({ db: t.db, cfg: t.cfg, adapters: t.adapters, id: 'runner_new' });
  const n = fresh.recover();
  assert.equal(n, 2);
  assert.equal(t.S.getTask(t.db, internal.id).state, 'queued');
  const ext = t.S.getTask(t.db, external.id);
  assert.equal(ext.state, 'blocked');
  assert.match(ext.blocked_reason, /outcome/);
  assert.equal(t.db.prepare("SELECT status FROM runs WHERE task_id = ?").get(external.id).status, 'unknown');
  assert.equal(fresh.recover(), 0, 'recovery is idempotent');
});

test('duplicate execution is prevented across two runners', async () => {
  const t = setup();
  const { dev } = team(t);
  t.S.updateAgent(t.db, dev.id, { capacity: 4 });
  const p = t.S.createProject(t.db, t.cfg, { name: 'Dup' });
  t.S.setAssignment(t.db, dev.id, p.id, true);
  const task = t.S.createTask(t.db, p.id, { title: 'Once [slow]' });
  const other = new Runner({ db: t.db, cfg: t.cfg, adapters: t.adapters, id: 'runner_other' });
  // Both runners see the same queued task; only one may claim it.
  const taskRow = t.db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id);
  const a = t.runner.startExecute(taskRow, dev, 0);
  const b = other.startExecute(taskRow, dev, 0);
  assert.equal([a, b].filter(Boolean).length, 1);
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM runs WHERE task_id = ?').get(task.id).c, 1);
  for (const r of [...t.runner.active.values(), ...other.active.values()]) r.controller.abort();
  await t.runner.drain(); await other.drain();
});

test('intern fallback: unavailable Intern work is reassigned once when permitted', async () => {
  const t = setup();
  team(t);
  const intern = t.S.createAgent(t.db, { role: 'Intern', provider: 'local' }); // no LOCAL_AI_URL → not ready
  const p = t.S.createProject(t.db, t.cfg, { name: 'Intern' });
  const res = t.S.listAgents(t.db).find((a) => a.role === 'Researcher');
  t.S.setAssignment(t.db, intern.id, p.id, true);
  t.S.setAssignment(t.db, res.id, p.id, true);
  const task = t.S.createTask(t.db, p.id, { title: 'Classify feedback', role: 'Intern' });
  await settle(t.runner);
  const run = t.db.prepare("SELECT agent_id FROM runs WHERE task_id = ? AND kind='execute'").get(task.id);
  assert.equal(run.agent_id, res.id);
  assert.equal(t.S.getTask(t.db, task.id).state, 'completed');
  setSetting(t.db, 'permissions', { ...DEFAULT_SETTINGS.permissions, intern_reassign: false });
  const t2 = t.S.createTask(t.db, p.id, { title: 'Classify more', role: 'Intern' });
  await settle(t.runner);
  assert.equal(t.S.getTask(t.db, t2.id).state, 'queued', 'waits when reassignment is not permitted');
});

test('invalid task transitions are rejected', () => {
  const t = setup();
  const p = t.S.createProject(t.db, t.cfg, { name: 'SM' });
  const task = t.S.createTask(t.db, p.id, { title: 'x' });
  assert.throws(() => t.S.transition(t.db, task.id, 'queued', 'completed'), /Cannot move/);
  assert.equal(t.S.transition(t.db, task.id, 'running', 'awaiting_review'), false, 'stale expected state does nothing');
  t.S.cancelTask(t.db, task.id);
  assert.throws(() => t.S.cancelTask(t.db, task.id), /already finished/);
});
