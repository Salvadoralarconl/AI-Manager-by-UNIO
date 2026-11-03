// Scheduler + worker slots. Runs as its own process (`npm run runner`).
// All decisions here are ordinary code: eligibility, fairness, budgets, leases,
// retries and review loops. Models are only called inside adapters.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadConfig, redact } from './config.js';
import { openDb, getSettings, all, one, now, newId, tx } from './db.js';
import {
  addEvent, transition, budgetCheck, recordUsage, projectDir, providerReady, TERMINAL,
} from './store.js';
import { create as createSimulated } from './workers/simulated.js';
import { unavailableAdapter, assertAdapter } from './workers/adapter.js';

const LEASE_MS = 60_000;
const BEAT_MS = 5_000;

export async function loadAdapters(cfg) {
  const adapters = { simulated: createSimulated(cfg) };
  for (const id of ['openai', 'anthropic', 'local']) {
    try {
      const mod = await import(`./workers/${id}.js`);
      adapters[id] = assertAdapter(mod.create(cfg));
    } catch (e) {
      adapters[id] = unavailableAdapter(id, e.code === 'ERR_MODULE_NOT_FOUND' ? 'Adapter not installed yet' : 'Adapter failed to load');
    }
  }
  return adapters;
}

export class Runner {
  constructor({ db, cfg, adapters, id }) {
    this.db = db;
    this.cfg = cfg;
    this.adapters = adapters;
    this.id = id ?? `runner_${os.hostname()}_${process.pid}_${Date.now().toString(36)}`;
    this.active = new Map(); // runId -> { controller, promise, taskId, kind }
    this.lastBudgetNote = new Map();
    this.startedAt = now();
    this.stopped = false;
    // Demo mode runs every agent through the simulator, whatever provider it displays.
    if (cfg.demo) this.adapters = new Proxy(adapters, { get: (t) => t.simulated });
  }

  bump() {
    this.db.prepare("INSERT INTO meta(key, value) VALUES ('rev', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1").run();
  }

  heartbeat() {
    this.db.prepare(`INSERT INTO heartbeats(id, kind, pid, started_at, last_beat_at, info) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET last_beat_at = excluded.last_beat_at, info = excluded.info`)
      .run(this.id, 'runner', process.pid, this.startedAt, now(), JSON.stringify({ active: this.active.size }));
    this.lastBeat = now();
  }

  // ---- recovery ----
  // A run is orphaned when its lease expired or its owner stopped heartbeating.
  recover() {
    const settings = getSettings(this.db);
    const staleBefore = now() - settings.heartbeat_stale_s * 1000;
    const orphans = all(this.db, `SELECT r.*, t.kind AS task_kind, t.state AS task_state, t.short_label FROM runs r JOIN tasks t ON t.id = r.task_id
      WHERE r.status = 'running' AND r.lease_owner != ? AND (r.lease_expires_at < ? OR NOT EXISTS (
        SELECT 1 FROM heartbeats h WHERE h.id = r.lease_owner AND h.last_beat_at >= ?))`, this.id, now(), staleBefore);
    for (const r of orphans) {
      tx(this.db, () => {
        // If an external action may have happened, we cannot know its outcome: do not repeat it.
        const uncertain = r.external_effect === 'pending' || (r.task_kind === 'external' && r.provider_state === 'requesting');
        this.db.prepare("UPDATE runs SET status = ?, ended_at = ?, reserved_usd = 0, error = ? WHERE id = ? AND status = 'running'")
          .run(uncertain ? 'unknown' : 'interrupted', now(), 'Runner stopped during this run', r.id);
        addEvent(this.db, { type: 'run.interrupted', project_id: r.project_id, agent_id: r.agent_id, task_id: r.task_id, run_id: r.id,
          message: `${r.short_label} interrupted` });
        if (r.kind === 'execute' && r.task_state === 'running') {
          if (uncertain) {
            transition(this.db, r.task_id, 'running', 'blocked', { needs_owner: 1,
              blocked_reason: 'Interrupted while an external action was in progress. Check the outcome before retrying.' });
            addEvent(this.db, { type: 'task.blocked', project_id: r.project_id, task_id: r.task_id, agent_id: r.agent_id, run_id: r.id, message: `${r.short_label}: outcome unknown` });
          } else {
            this.requeueOrFail(r.task_id, 'running', 'Interrupted');
          }
        }
        // Review runs: task stays awaiting_review and a fresh review is started next tick.
      });
    }
    if (orphans.length) this.bump();
    return orphans.length;
  }

  requeueOrFail(taskId, from, reason) {
    const t = one(this.db, 'SELECT * FROM tasks WHERE id = ?', taskId);
    if (t.attempts < t.max_attempts) {
      transition(this.db, taskId, from, 'queued');
      addEvent(this.db, { type: 'task.retry_scheduled', project_id: t.project_id, task_id: taskId, agent_id: t.assigned_agent_id,
        message: `${t.short_label}: retry ${t.attempts + 1} of ${t.max_attempts}` });
      return 'queued';
    }
    const settings = getSettings(this.db);
    const agent = t.assigned_agent_id ? one(this.db, 'SELECT * FROM agents WHERE id = ?', t.assigned_agent_id) : null;
    // Intern fallback: preserve the task and hand it to a Claude worker once, if permitted.
    if (agent?.provider === 'local' && settings.permissions?.intern_reassign && !t.fallback_used) {
      transition(this.db, taskId, from, 'queued', { attempts: 0, assigned_agent_id: null, fallback_used: 1,
        role: settings.permissions.intern_fallback_role || 'Researcher' });
      addEvent(this.db, { type: 'task.reassigned', project_id: t.project_id, task_id: taskId, message: `${t.short_label}: Intern couldn't finish, reassigned` });
      return 'reassigned';
    }
    transition(this.db, taskId, from, 'failed', { needs_owner: 1, blocked_reason: `${reason} after ${t.attempts} attempt(s)` });
    addEvent(this.db, { type: 'task.failed', project_id: t.project_id, task_id: taskId, agent_id: t.assigned_agent_id,
      message: `${t.short_label} failed`, data: { reason, attempts: t.attempts } });
    return 'failed';
  }

  // ---- scheduling ----
  candidates(task, project, settings, busy) {
    const agents = all(this.db, `SELECT a.* FROM agents a WHERE a.enabled = 1 AND a.paused = 0 AND a.is_manager = 0
      AND (a.all_projects = 1 OR EXISTS (SELECT 1 FROM agent_projects ap WHERE ap.agent_id = a.id AND ap.project_id = ?))
      ORDER BY a.position`, project.id);
    const free = (a) => (busy.get(a.id) ?? 0) < a.capacity && providerReady(this.cfg, a.provider);
    if (task.assigned_agent_id) {
      const a = agents.find((x) => x.id === task.assigned_agent_id);
      return a && free(a) ? [a] : [];
    }
    const role = task.role.toLowerCase();
    let pool = agents.filter((a) => a.role.toLowerCase() === role);
    // No ready Intern: hand the task to a worker instead of waiting forever, if permitted.
    if (role === 'intern' && !pool.some((a) => providerReady(this.cfg, a.provider)) && settings.permissions?.intern_reassign) {
      const fb = (settings.permissions.intern_fallback_role || 'Researcher').toLowerCase();
      pool = agents.filter((a) => a.role.toLowerCase() === fb);
    }
    return pool.filter(free).sort((a, b) => (busy.get(a.id) ?? 0) - (busy.get(b.id) ?? 0));
  }

  busyMap() {
    const m = new Map();
    for (const r of all(this.db, "SELECT agent_id, COUNT(*) AS n FROM runs WHERE status = 'running' GROUP BY agent_id")) m.set(r.agent_id, r.n);
    return m;
  }

  blockOnFailedDeps() {
    const rows = all(this.db, `SELECT DISTINCT t.id, t.project_id, t.short_label, d.state AS dep_state, d.short_label AS dep_label FROM tasks t
      JOIN task_deps td ON td.task_id = t.id JOIN tasks d ON d.id = td.depends_on_id
      WHERE t.state = 'queued' AND d.state IN ('failed','cancelled')`);
    for (const r of rows) {
      if (transition(this.db, r.id, 'queued', 'blocked', { needs_owner: 1, blocked_reason: `Depends on "${r.dep_label}" which ${r.dep_state === 'failed' ? 'failed' : 'was cancelled'}` }))
        addEvent(this.db, { type: 'task.blocked', project_id: r.project_id, task_id: r.id, message: `${r.short_label} blocked by dependency` });
    }
  }

  nextTaskFor(project) {
    return all(this.db, `SELECT t.* FROM tasks t WHERE t.project_id = ? AND t.state = 'queued' AND t.cancel_requested = 0
      AND NOT EXISTS (SELECT 1 FROM task_deps d JOIN tasks x ON x.id = d.depends_on_id WHERE d.task_id = t.id AND x.state != 'completed')
      ORDER BY t.priority, t.created_at`, project.id);
  }

  async tick() {
    if (this.stopped) return;
    this.heartbeat();
    const leaseUntil = now() + LEASE_MS;
    for (const runId of this.active.keys()) this.db.prepare('UPDATE runs SET lease_expires_at = ? WHERE id = ? AND lease_owner = ?').run(leaseUntil, runId, this.id);
    this.handleCancels();
    this.recover();
    this.blockOnFailedDeps();
    const settings = getSettings(this.db);
    this.startReviews(settings);
    if (settings.paused) return;
    this.scheduleExecutions(settings);
  }

  handleCancels() {
    for (const [runId, a] of this.active) {
      const t = one(this.db, 'SELECT cancel_requested FROM tasks WHERE id = ?', a.taskId);
      if (t?.cancel_requested && !a.controller.signal.aborted) a.controller.abort(new Error('cancelled'));
    }
    // Cancel requested on a task with no live run (e.g. awaiting review between runs).
    for (const t of all(this.db, `SELECT * FROM tasks WHERE cancel_requested = 1 AND state IN ('awaiting_review','running')
      AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.task_id = tasks.id AND r.status = 'running')`)) {
      if (transition(this.db, t.id, t.state, 'cancelled', { cancel_requested: 0 }))
        addEvent(this.db, { type: 'task.cancelled', project_id: t.project_id, task_id: t.id, agent_id: t.assigned_agent_id, message: `Cancelled: ${t.short_label}` });
    }
  }

  scheduleExecutions(settings) {
    const busy = this.busyMap();
    let running = one(this.db, "SELECT COUNT(*) AS n FROM runs WHERE status = 'running' AND kind = 'execute'").n;
    const projects = all(this.db, "SELECT * FROM projects WHERE status = 'active' ORDER BY sched_pass, position");
    const blockedProjects = new Set();
    // Stride scheduling: each start advances the project's pass by 1/priority, so
    // higher-priority projects get proportionally more starts but none starves.
    while (running < settings.global_concurrency) {
      const pick = projects
        .filter((p) => !blockedProjects.has(p.id))
        .sort((a, b) => a.sched_pass - b.sched_pass || a.position - b.position)[0];
      if (!pick) break;
      const projRunning = one(this.db, "SELECT COUNT(*) AS n FROM runs WHERE status = 'running' AND kind = 'execute' AND project_id = ?", pick.id).n;
      if (projRunning >= pick.max_concurrency) { blockedProjects.add(pick.id); continue; }
      let started = false;
      for (const task of this.nextTaskFor(pick)) {
        const agents = this.candidates(task, pick, settings, busy);
        if (!agents.length) continue;
        const agent = agents[0];
        const reserve = ['simulated', 'local'].includes(agent.provider) ? 0 : (task.run_cost_limit_usd ?? settings.default_run_cap_usd);
        const reason = budgetCheck(this.db, settings, pick, reserve);
        if (reason) { this.noteBudget(pick, reason); break; }
        if (this.startExecute(task, agent, reserve)) {
          busy.set(agent.id, (busy.get(agent.id) ?? 0) + 1);
          running++;
          started = true;
          pick.sched_pass += 1 / Math.max(1, pick.priority);
          this.db.prepare('UPDATE projects SET sched_pass = ? WHERE id = ?').run(pick.sched_pass, pick.id);
          break;
        }
      }
      if (!started) blockedProjects.add(pick.id);
    }
  }

  noteBudget(project, reason) {
    const last = this.lastBudgetNote.get(project.id) ?? 0;
    if (now() - last < 3600_000) return;
    this.lastBudgetNote.set(project.id, now());
    addEvent(this.db, { type: 'budget.limited', project_id: project.id, message: `${reason}; new work waits` });
    this.bump();
  }

  startExecute(task, agent, reserve) {
    const attempt = task.attempts + 1;
    const runId = newId('run');
    try {
      tx(this.db, () => {
        if (!transition(this.db, task.id, 'queued', 'running', { assigned_agent_id: agent.id, attempts: attempt, cancel_requested: 0 }))
          throw new Error('lost race');
        this.db.prepare(`INSERT INTO runs(id, task_id, project_id, agent_id, kind, status, attempt, idempotency_key, lease_owner, lease_expires_at, reserved_usd, started_at, last_activity_at, last_activity)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(runId, task.id, task.project_id, agent.id, 'execute', 'running', attempt,
          // Keyed on the task version the claim was based on: two runners racing on the same
          // snapshot produce the same key, so the UNIQUE constraint lets only one through.
          `${task.id}:execute:v${task.version}`, this.id, now() + LEASE_MS, reserve, now(), now(), 'Starting');
        addEvent(this.db, { type: 'run.started', project_id: task.project_id, agent_id: agent.id, task_id: task.id, run_id: runId,
          message: `${agent.name} started ${task.short_label}` });
      });
    } catch (e) {
      if (/lost race|UNIQUE/.test(e.message)) return false; // another runner took it
      throw e;
    }
    this.bump();
    this.launch(runId, task.id, 'execute', agent);
    return true;
  }

  startReviews(settings) {
    const manager = one(this.db, 'SELECT * FROM agents WHERE is_manager = 1 AND enabled = 1 AND paused = 0');
    if (!manager || !providerReady(this.cfg, manager.provider)) return;
    let busy = one(this.db, "SELECT COUNT(*) AS n FROM runs WHERE agent_id = ? AND status = 'running'", manager.id).n;
    const waiting = all(this.db, `SELECT t.* FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.state = 'awaiting_review' AND t.cancel_requested = 0 AND p.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.task_id = t.id AND r.status = 'running') ORDER BY t.updated_at`);
    for (const task of waiting) {
      if (settings.paused || busy >= manager.capacity) break;
      const n = one(this.db, "SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND kind = 'review' AND attempt = ?", task.id, task.review_rounds + 1).n;
      if (n >= 3) { // review itself keeps failing: escalate instead of looping
        if (transition(this.db, task.id, 'awaiting_review', 'blocked', { needs_owner: 1, blocked_reason: 'Manager review could not be completed' }))
          addEvent(this.db, { type: 'task.blocked', project_id: task.project_id, task_id: task.id, message: `${task.short_label}: review unavailable` });
        continue;
      }
      const runId = newId('run');
      try {
        this.db.prepare(`INSERT INTO runs(id, task_id, project_id, agent_id, kind, status, attempt, idempotency_key, lease_owner, lease_expires_at, reserved_usd, started_at, last_activity_at, last_activity)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(runId, task.id, task.project_id, manager.id, 'review', 'running', task.review_rounds + 1,
          `${task.id}:review:${task.review_rounds + 1}:${n + 1}`, this.id, now() + LEASE_MS, 0, now(), now(), 'Starting review');
      } catch (e) {
        if (/UNIQUE/.test(e.message)) continue;
        throw e;
      }
      addEvent(this.db, { type: 'review.started', project_id: task.project_id, agent_id: manager.id, task_id: task.id, run_id: runId, message: `Reviewing ${task.short_label}` });
      busy++;
      this.bump();
      this.launch(runId, task.id, 'review', manager);
    }
  }

  // ---- execution ----
  buildContext(task, agent, kind) {
    // Only this project's brief, goals and outputs are included: no cross-project mixing.
    const project = one(this.db, 'SELECT * FROM projects WHERE id = ?', task.project_id);
    const deps = all(this.db, `SELECT t.title, t.result_summary FROM task_deps d JOIN tasks t ON t.id = d.depends_on_id
      WHERE d.task_id = ? AND t.project_id = ?`, task.id, task.project_id);
    const system = [agent.instructions, `Project: ${project.name}`, project.brief && `Brief: ${project.brief}`, project.goals && `Goals: ${project.goals}`]
      .filter(Boolean).join('\n\n');
    let content = [`Task: ${task.title}`, task.description, task.acceptance_criteria && `Acceptance criteria:\n${task.acceptance_criteria}`,
      deps.length && `Completed dependencies:\n${deps.map((d) => `- ${d.title}: ${d.result_summary}`).join('\n')}`,
      task.review_notes && `Manager review notes to address:\n${task.review_notes}`].filter(Boolean).join('\n\n');
    if (kind === 'review') {
      const art = one(this.db, 'SELECT * FROM artifacts WHERE task_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 1', task.id, task.project_id);
      let body = '';
      if (art) try { body = fs.readFileSync(path.join(projectDir(this.cfg, task.project_id), art.rel_path), 'utf8').slice(0, 20000); } catch { /* missing */ }
      content += `\n\nOutput to review:\n${body || task.result_summary}\n\nReply with a verdict: approve, rework or block.`;
    }
    return { system, messages: [{ role: 'user', content }] };
  }

  launch(runId, taskId, kind, agent) {
    const controller = new AbortController();
    const entry = { controller, taskId, kind };
    entry.promise = this.execute(runId, taskId, kind, agent, controller).catch((e) => {
      console.error(`[runner] run ${runId} crashed:`, redact(e.stack ?? String(e), this.cfg));
    }).finally(() => { this.active.delete(runId); this.bump(); });
    this.active.set(runId, entry);
  }

  async execute(runId, taskId, kind, agent, controller) {
    const db = this.db;
    const task = one(db, 'SELECT * FROM tasks WHERE id = ?', taskId);
    const run = one(db, 'SELECT * FROM runs WHERE id = ?', runId);
    const adapter = this.adapters[agent.provider];
    const { system, messages } = this.buildContext(task, agent, kind);
    const timeout = AbortSignal.timeout(task.timeout_s * 1000);
    const signal = AbortSignal.any([controller.signal, timeout]);
    const log = [];
    const activity = (text) => {
      log.push({ ts: now(), text: String(text).slice(0, 200) });
      if (log.length > 50) log.shift();
      db.prepare("UPDATE runs SET last_activity = ?, last_activity_at = ?, log = ? WHERE id = ? AND status = 'running'")
        .run(String(text).slice(0, 120), now(), JSON.stringify(log), runId);
      this.bump();
    };
    let result;
    try {
      result = await adapter.run({
        mode: kind, projectId: task.project_id, taskId, runId, idempotencyKey: run.idempotency_key,
        attempt: run.attempt, reviewRound: task.review_rounds, reviewNotes: task.review_notes,
        task: { title: task.title, short_label: task.short_label, acceptance_criteria: task.acceptance_criteria, kind: task.kind },
        model: agent.model, system, messages, maxOutputTokens: 4000,
        costLimitUsd: run.reserved_usd || null, signal,
        onActivity: activity,
        onProviderState: (s) => { db.prepare('UPDATE runs SET provider_state = ? WHERE id = ?').run(s, runId); },
      });
    } catch (e) {
      if (signal.aborted) {
        const cancelled = controller.signal.aborted;
        return this.finishAborted(runId, task, agent, kind, cancelled ? 'cancelled' : 'timeout');
      }
      result = { status: 'failed', summary: `${task.short_label} failed`, error: redact(e.message, this.cfg), retryable: true, usage: null };
    }
    if (controller.signal.aborted) return this.finishAborted(runId, task, agent, kind, 'cancelled');
    this.finish(runId, task, agent, kind, result, log);
  }

  finishAborted(runId, task, agent, kind, why) {
    const db = this.db;
    tx(db, () => {
      db.prepare("UPDATE runs SET status = ?, ended_at = ?, reserved_usd = 0, error = ? WHERE id = ?")
        .run(why === 'cancelled' ? 'cancelled' : 'failed', now(), why === 'cancelled' ? 'Cancelled by owner' : 'Timed out', runId);
      const cur = one(db, 'SELECT state FROM tasks WHERE id = ?', task.id).state;
      if (why === 'cancelled') {
        if (!TERMINAL.has(cur) && transition(db, task.id, cur, 'cancelled', { cancel_requested: 0 }))
          addEvent(db, { type: 'task.cancelled', project_id: task.project_id, task_id: task.id, agent_id: agent.id, run_id: runId, message: `Cancelled: ${task.short_label}` });
      } else {
        addEvent(db, { type: 'run.failed', project_id: task.project_id, task_id: task.id, agent_id: agent.id, run_id: runId, message: `${task.short_label} timed out` });
        if (kind === 'execute' && cur === 'running') this.requeueOrFail(task.id, 'running', 'Timed out');
      }
    });
  }

  finish(runId, task, agent, kind, result, log) {
    const db = this.db;
    tx(db, () => {
      if (result.usage) {
        recordUsage(db, { project_id: task.project_id, run_id: runId, agent_id: agent.id, provider: agent.provider, model: agent.model,
          input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens,
          cost_usd: result.usage.costUsd, cost_kind: result.usage.costKind ?? 'unknown' });
      }
      const ok = result.status === 'succeeded';
      // The provider may have done (and billed) work we never saw: record it as unknown, not failed.
      const unknown = !ok && result.outcomeUnknown;
      db.prepare(`UPDATE runs SET status = ?, ended_at = ?, reserved_usd = 0, summary = ?, error = ?, verdict = ?, provider_state = ?, last_activity_at = ? WHERE id = ?`)
        .run(ok ? 'succeeded' : unknown ? 'unknown' : 'failed', now(), String(result.summary ?? '').slice(0, 120), redact(result.error ?? '', this.cfg).slice(0, 500),
          result.review?.verdict ?? null, ok ? 'responded' : 'error', now(), runId);

      if (kind === 'execute') {
        const cur = one(db, 'SELECT state FROM tasks WHERE id = ?', task.id).state;
        if (cur !== 'running') return; // cancelled or recovered meanwhile
        if (!ok) {
          addEvent(db, { type: 'run.failed', project_id: task.project_id, task_id: task.id, agent_id: agent.id, run_id: runId,
            message: result.summary || `${task.short_label} failed`, data: { error: redact(result.error ?? '', this.cfg) } });
          if (unknown && task.kind === 'external') {
            transition(db, task.id, 'running', 'blocked', { needs_owner: 1,
              blocked_reason: 'Connection dropped during an external action; its outcome is unknown. Check before retrying.' });
            addEvent(db, { type: 'task.blocked', project_id: task.project_id, task_id: task.id, agent_id: agent.id, run_id: runId, message: `${task.short_label}: outcome unknown` });
            return;
          }
          if (result.retryable === false) {
            db.prepare('UPDATE tasks SET attempts = max_attempts WHERE id = ?').run(task.id);
          }
          this.requeueOrFail(task.id, 'running', result.error || 'Run failed');
          return;
        }
        let artifactId = null;
        if (result.outputText) artifactId = this.saveArtifact(task, runId, result.outputName, result.outputText);
        transition(db, task.id, 'running', 'awaiting_review', { result_summary: String(result.summary ?? '').slice(0, 200) });
        addEvent(db, { type: 'run.completed', project_id: task.project_id, task_id: task.id, agent_id: agent.id, run_id: runId,
          artifact_id: artifactId, message: result.summary || `${task.short_label} done` });
        return;
      }

      // review
      const cur = one(db, 'SELECT * FROM tasks WHERE id = ?', task.id);
      if (cur.state !== 'awaiting_review') return;
      if (!ok || !result.review) {
        addEvent(db, { type: 'run.failed', project_id: task.project_id, task_id: task.id, agent_id: agent.id, run_id: runId, message: `Review of ${task.short_label} failed` });
        return; // a fresh review is attempted next tick (bounded in startReviews)
      }
      const { verdict, notes } = result.review;
      const base = { project_id: task.project_id, task_id: task.id, agent_id: agent.id, run_id: runId };
      if (verdict === 'approve') {
        transition(db, task.id, 'awaiting_review', 'completed', { review_notes: String(notes ?? '').slice(0, 2000), needs_owner: 0 });
        addEvent(db, { ...base, type: 'task.reviewed', message: `${task.short_label} approved`, data: { verdict, notes } });
        this.completeMilestoneIfDone(task);
      } else if (verdict === 'rework') {
        if (cur.review_rounds + 1 > cur.max_review_rounds) {
          transition(db, task.id, 'awaiting_review', 'blocked', { needs_owner: 1, review_notes: String(notes ?? '').slice(0, 2000),
            blocked_reason: `Still not accepted after ${cur.review_rounds + 1} review(s): ${String(notes ?? '').slice(0, 200)}` });
          addEvent(db, { ...base, type: 'task.blocked', message: `${task.short_label}: review limit reached`, data: { verdict, notes } });
        } else {
          transition(db, task.id, 'awaiting_review', 'queued', { review_rounds: cur.review_rounds + 1, attempts: 0, review_notes: String(notes ?? '').slice(0, 2000) });
          addEvent(db, { ...base, type: 'task.rework', message: `${task.short_label} sent back`, data: { verdict, notes } });
        }
      } else {
        transition(db, task.id, 'awaiting_review', 'blocked', { needs_owner: 1, blocked_reason: String(notes || 'Manager needs a decision').slice(0, 500) });
        addEvent(db, { ...base, type: 'task.blocked', message: `${task.short_label} needs you`, data: { verdict, notes } });
      }
    });
  }

  completeMilestoneIfDone(task) {
    if (!task.milestone_id) return;
    const open = one(this.db, "SELECT COUNT(*) AS n FROM tasks WHERE milestone_id = ? AND state NOT IN ('completed','cancelled')", task.milestone_id).n;
    if (open === 0) {
      this.db.prepare("UPDATE milestones SET status = 'done' WHERE id = ?").run(task.milestone_id);
      const m = one(this.db, 'SELECT title FROM milestones WHERE id = ?', task.milestone_id);
      addEvent(this.db, { type: 'milestone.done', project_id: task.project_id, message: `Milestone reached: ${m.title}` });
    }
  }

  saveArtifact(task, runId, name, text) {
    const safe = String(name || 'output.md').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '').slice(0, 80) || 'output.md';
    const rel = path.join('artifacts', `${runId}-${safe}`);
    const dir = projectDir(this.cfg, task.project_id);
    const abs = path.join(dir, rel);
    if (!abs.startsWith(dir + path.sep)) throw new Error('artifact path escapes project');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
    const id = newId('art');
    this.db.prepare('INSERT INTO artifacts(id, project_id, task_id, run_id, name, rel_path, mime, bytes, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, task.project_id, task.id, runId, safe, rel, safe.endsWith('.md') ? 'text/markdown' : 'text/plain', Buffer.byteLength(text), now());
    return id;
  }

  async drain() {
    await Promise.all([...this.active.values()].map((a) => a.promise));
  }

  start() {
    this.heartbeat();
    this.recover();
    const loop = async () => {
      if (this.stopped) return;
      try { await this.tick(); } catch (e) { console.error('[runner] tick failed:', redact(e.stack ?? String(e), this.cfg)); }
      this.timer = setTimeout(loop, this.cfg.runnerTickMs);
    };
    loop();
    this.beatTimer = setInterval(() => { try { this.heartbeat(); } catch { /* db busy */ } }, BEAT_MS);
  }

  // Graceful stop: stop scheduling, abort nothing; leases expire if we die anyway.
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  close() { clearInterval(this.beatTimer); }
}

async function main() {
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  if (process.argv.includes('--healthcheck')) {
    const s = getSettings(db);
    const hb = one(db, "SELECT last_beat_at FROM heartbeats WHERE kind = 'runner' ORDER BY last_beat_at DESC LIMIT 1");
    process.exit(hb && now() - hb.last_beat_at < s.heartbeat_stale_s * 1000 ? 0 : 1);
  }
  const adapters = await loadAdapters(cfg);
  const runner = new Runner({ db, cfg, adapters });
  console.log(`[runner] ${runner.id} started (db ${cfg.dbPath}${cfg.demo ? ', demo mode' : ''}; paid execution ${cfg.paidExecution ? 'ENABLED' : 'off'})`);
  runner.start();
  const shutdown = async (sig) => {
    console.log(`[runner] ${sig}: finishing in-flight runs (up to 30s)`);
    await runner.stop();
    await Promise.race([runner.drain(), new Promise((r) => setTimeout(r, 30_000))]);
    runner.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
