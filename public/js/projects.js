// Projects: list, brief/goals, roadmap, tasks, assignments, outputs, spending, controls.
import { api, html, icon, avatar, status, providerLabel, when, dueIn, money, toast, openDialog, confirmDialog, esc } from './ui.js';
import { go, route } from './main.js';
import { newProjectDialog } from './overview.js';
import { costKind } from './team.js';

const SUBS = [['overview', 'Brief'], ['roadmap', 'Roadmap'], ['tasks', 'Tasks'], ['team', 'Agents'], ['outputs', 'Outputs'], ['spending', 'Spending']];
const PHASES = ['validation', 'research', 'development', 'storefront', 'marketing', 'sales', 'onboarding'];

export async function renderProjects(r) {
  const list = await api('/api/projects');
  const id = r.id ?? list.find((p) => p.status !== 'archived')?.id ?? list[0]?.id;
  const p = id ? await api(`/api/projects/${encodeURIComponent(id)}`) : null;
  const sub = SUBS.some(([k]) => k === r.sub) ? r.sub : 'overview';
  const taskId = r.q.get('task');
  const task = taskId ? await api(`/api/tasks/${encodeURIComponent(taskId)}`).catch(() => null) : null;
  return html`
  <header class="page-head">
    <div><h1>Projects</h1><div class="summary">${list.filter((x) => x.status === 'active').length} active · ${list.filter((x) => x.status === 'paused').length} paused</div></div>
    <div class="head-right"><button class="textbtn" data-pj="new">New project</button></div>
  </header>
  <div class="split">
    <nav aria-label="Projects">${list.length ? list.map((x) => html`<a class="list-row" href="#/projects/${x.id}" aria-current="${x.id === id}">
      <span class="ptab-icon">${icon(x.icon)}</span><span class="grow"><span class="name">${x.name}</span><span class="meta">${x.open_tasks} open · ${monthSpend(x.spend_month)}</span></span>${status(x.status)}</a>`) : html`<p class="state-msg">No projects yet.</p>`}
    </nav>
    <div class="vline" aria-hidden="true"></div>
    <section>${p ? detail(p, sub, task) : html`<p class="state-msg">Create a project to get started.</p>`}</section>
  </div>`;
}

function monthSpend(s) {
  if (!s.billable && s.simulated) return `${money(s.simulated)} sim. this month`;
  return `${s.estimated ? '≈' : ''}${money(s.billable)} this month`;
}

function detail(p, sub, task) {
  return html`
    <div class="h-row"><h2>${p.name}</h2>${status(p.status)}
      <div class="actions">
        ${p.status === 'active' ? html`<button class="textbtn sm" data-pj="status" data-v="paused">Pause</button>` : ''}
        ${p.status === 'paused' ? html`<button class="textbtn sm" data-pj="status" data-v="active">Resume</button>` : ''}
        ${p.status !== 'archived' ? html`<button class="textbtn sm muted" data-pj="status" data-v="archived">Archive</button>` : html`<button class="textbtn sm" data-pj="status" data-v="paused">Restore</button>`}
        <button class="textbtn sm" data-pj="edit">Edit</button>
      </div>
    </div>
    <div class="subtabs" role="tablist">${SUBS.map(([k, l]) => html`<button role="tab" aria-selected="${k === sub}" data-pj="sub" data-v="${k}">${l}</button>`)}</div>
    ${{ overview, roadmap, tasks, team, outputs, spending }[sub](p, task)}`;
}

function overview(p) {
  return html`<div class="section"><div class="kv">
    <div>Goal</div><div class="prose">${p.goals || '—'}</div>
    <div>Brief</div><div class="prose">${p.brief || '—'}</div>
    <div>Priority</div><div>${p.priority} of 5</div>
    <div>Max concurrent runs</div><div>${p.max_concurrency}</div>
    <div>Budget</div><div>${p.budget_daily_usd != null ? `${money(p.budget_daily_usd)}/day` : 'No daily cap'} · ${p.budget_total_usd != null ? `${money(p.budget_total_usd)} total` : 'no total cap'}</div>
    <div>Working directory</div><div class="muted">data/projects/${p.id}/</div>
  </div><p class="note">Instructions, files and outputs for this project are only ever given to runs of this project.</p></div>`;
}

function roadmap(p) {
  return html`<div class="section"><div class="h-row"><h3 style="margin:0">Milestones</h3><div class="actions"><button class="textbtn sm" data-pj="milestone">Add milestone</button></div></div>
    ${p.milestones.length ? html`<table class="mini-table" style="margin-top:10px"><thead><tr><th>Milestone</th><th>Phase</th><th>Due</th><th>Tasks</th><th>Status</th><th></th></tr></thead><tbody>
    ${p.milestones.map((m) => {
      const ts = p.tasks.filter((t) => t.milestone_id === m.id);
      return html`<tr><td>${m.title}</td><td class="muted">${m.phase}</td><td>${m.due_at ? html`${new Date(m.due_at).toLocaleDateString()} <span class="muted">· ${dueIn(m.due_at)}</span>` : '—'}</td>
        <td class="tnum">${ts.filter((t) => t.state === 'completed').length}/${ts.length}</td><td>${status(m.status === 'done' ? 'completed' : 'queued', m.status === 'done' ? 'Done' : 'Open')}</td>
        <td><button class="textbtn sm" data-pj="ms-toggle" data-id="${m.id}" data-v="${m.status === 'done' ? 'open' : 'done'}">${m.status === 'done' ? 'Reopen' : 'Mark done'}</button></td></tr>`;
    })}</tbody></table>` : html`<p class="state-msg">No milestones. A roadmap can cover validation, development, storefront, marketing, sales and onboarding.</p>`}</div>`;
}

function tasks(p, task) {
  return html`<div class="section"><div class="h-row"><h3 style="margin:0">Tasks</h3><div class="actions"><button class="textbtn sm" data-pj="task-new">Add task</button></div></div>
    ${task && task.project_id === p.id ? taskDetail(task, p) : ''}
    ${p.tasks.length ? html`<table class="mini-table" style="margin-top:10px"><thead><tr><th>Task</th><th>Role</th><th>Agent</th><th>Depends on</th><th>State</th></tr></thead><tbody>
      ${p.tasks.map((t) => html`<tr><td><a href="#/projects/${p.id}/tasks?task=${t.id}">${t.title}</a>${t.kind === 'external' ? html` <span class="tag">external</span>` : ''}</td>
        <td class="muted">${t.role}</td><td>${t.agent_name || html`<span class="muted">—</span>`}</td>
        <td class="muted">${t.depends_on.map((d) => p.tasks.find((x) => x.id === d)?.short_label ?? d).join(', ') || '—'}</td><td>${status(t.state)}</td></tr>`)}
    </tbody></table>` : html`<p class="state-msg">No tasks yet.</p>`}</div>`;
}

function taskDetail(t, p) {
  const canCancel = !['completed', 'failed', 'cancelled'].includes(t.state);
  const canRetry = ['failed', 'cancelled', 'blocked'].includes(t.state);
  return html`<div class="section" id="task-detail" style="border:1px solid var(--line);border-radius:10px;padding:16px 18px">
    <div class="h-row"><h3 style="margin:0">${t.title}</h3>${status(t.state)}
      <div class="actions">
        ${canRetry ? html`<button class="textbtn sm" data-pj="retry" data-id="${t.id}">Retry</button>` : ''}
        ${canCancel ? html`<button class="textbtn sm" data-pj="cancel" data-id="${t.id}">${t.cancel_requested ? 'Cancelling…' : 'Cancel'}</button>` : ''}
        ${!['completed'].includes(t.state) ? html`<button class="textbtn sm" data-pj="task-edit" data-id="${t.id}">Edit</button>` : ''}
        <a class="textbtn sm muted" href="#/projects/${p.id}/tasks">Close</a>
      </div></div>
    ${t.blocked_reason ? html`<p class="note" style="color:var(--orange)">${t.blocked_reason}</p>` : ''}
    <div class="kv" style="margin-top:12px">
      <div>Short label</div><div>${t.short_label}</div>
      <div>Description</div><div class="prose">${t.description || '—'}</div>
      <div>Acceptance criteria</div><div class="prose">${t.acceptance_criteria || '—'}</div>
      <div>Depends on</div><div>${t.depends_on.length ? t.depends_on.map((d) => html`<span class="tag">${d.title} · ${d.state}</span>`) : '—'}</div>
      <div>Limits</div><div>${t.attempts}/${t.max_attempts} attempts · ${t.review_rounds}/${t.max_review_rounds} rework rounds · ${t.run_cost_limit_usd != null ? `${money(t.run_cost_limit_usd)}/run` : 'default run cap'} · ${Math.round(t.timeout_s / 60)} min timeout</div>
      <div>Type</div><div>${t.kind === 'external' ? 'External action (never repeated automatically if the outcome is unknown)' : 'Internal'}</div>
      ${t.review_notes ? html`<div>Review notes</div><div class="prose">${t.review_notes}</div>` : ''}
      ${t.result_summary ? html`<div>Result</div><div>${t.result_summary}</div>` : ''}
      <div>Outputs</div><div>${t.artifacts.length ? t.artifacts.map((a) => html`<a class="tag" href="/api/artifacts/${a.id}" target="_blank" rel="noopener">${a.name}</a>`) : html`<span class="muted">None</span>`}</div>
    </div>
    ${t.runs.length ? html`<table class="mini-table" style="margin-top:12px"><thead><tr><th>Started</th><th>Agent</th><th>Kind</th><th>Status</th><th>Result</th></tr></thead><tbody>
      ${t.runs.map((r) => html`<tr><td class="tnum">${when(r.started_at)}</td><td>${r.agent_name}</td><td>${r.kind === 'review' ? `Review ${r.attempt}` : `Attempt ${r.attempt}`}</td><td>${status(r.status)}</td><td>${r.summary || r.error || '—'}${r.verdict ? html` <span class="muted">· ${r.verdict}</span>` : ''}</td></tr>`)}
    </tbody></table>` : ''}
  </div>`;
}

function team(p) {
  const rows = p.agents.filter((a) => !a.is_manager);
  return html`<div class="section"><p class="note" style="margin-bottom:10px">The Manager coordinates every project. Assign workers below.</p>
    ${rows.map((a) => html`<label class="list-row" style="cursor:pointer">${avatar(a)}<span class="grow"><span class="name">${a.name}</span><span class="meta">${providerLabel(a)}${a.project_name && a.project_id !== p.id ? ` · on ${a.project_name}` : ''}</span></span>
      ${status(a.status)}<input type="checkbox" data-pj="assign" data-id="${a.id}" ${a.assigned ? 'checked' : ''} aria-label="Assign ${esc(a.name)} to ${esc(p.name)}"></label>`)}</div>`;
}

function outputs(p) {
  return html`<div class="section">${p.artifacts.length ? html`<table class="mini-table"><thead><tr><th>Saved</th><th>File</th><th>Task</th><th class="num">Size</th></tr></thead><tbody>
    ${p.artifacts.map((a) => html`<tr><td class="tnum">${when(a.created_at)}</td><td><a href="/api/artifacts/${a.id}" target="_blank" rel="noopener">${a.name}</a></td><td class="muted">${a.task_title || '—'}</td><td class="num">${(a.bytes / 1024).toFixed(1)} KB</td></tr>`)}
  </tbody></table>` : html`<p class="state-msg">No deliverables yet.</p>`}</div>`;
}

function spending(p) {
  const row = (label, s) => html`<tr><td>${label}</td><td class="num">${money(s.reported)}</td><td class="num">${money(s.estimated)}</td><td class="num">${money(s.simulated)}</td><td class="num">${s.unknown_count}</td></tr>`;
  return html`<div class="section"><table class="mini-table tnum"><thead><tr><th>Period</th><th class="num">Provider-reported</th><th class="num">Estimated</th><th class="num">Simulated</th><th class="num">Unknown-cost runs</th></tr></thead>
    <tbody>${row('Today', p.spend.today)}${row('This month', p.spend.month)}${row('All time', p.spend.total)}</tbody></table>
    <p class="note">Reserved for in-flight runs: ${money(p.reserved_usd)}. In-flight requests can finish slightly above a reservation; caps are checked before each run starts. Simulated amounts are not charged. Home AI compute is not priced.</p></div>`;
}

// ---------- actions ----------
function pid() { return route().id ?? document.querySelector('.split nav [aria-current="true"]')?.getAttribute('href')?.split('/')[2]; }

document.getElementById('main').addEventListener('change', async (e) => {
  const b = e.target.closest('[data-pj="assign"]');
  if (!b) return;
  try { await api(`/api/projects/${pid()}/assignments`, { method: 'POST', body: { agent_id: b.dataset.id, assigned: b.checked } }); toast(b.checked ? 'Assigned' : 'Unassigned'); }
  catch (err) { toast(err.message, true); b.checked = !b.checked; }
});

document.getElementById('main').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-pj]');
  if (!b || route().view !== 'projects' || b.dataset.pj === 'assign') return;
  const id = pid();
  const act = b.dataset.pj;
  try {
    if (act === 'new') newProjectDialog((p) => go(`#/projects/${p.id}`));
    else if (act === 'sub') go(`#/projects/${id}/${b.dataset.v}`);
    else if (act === 'status') {
      const v = b.dataset.v;
      if (v === 'archived' && !(await confirmDialog('Archive project?', 'Archived projects stop scheduling and leave the Overview. Records and files are kept.', 'Archive'))) return;
      await api(`/api/projects/${id}/status`, { method: 'POST', body: { status: v } });
      toast(v === 'paused' ? 'Paused. Running work finishes; nothing new starts.' : v === 'active' ? 'Resumed' : 'Updated');
      go(location.hash);
    } else if (act === 'edit') editProject(await api(`/api/projects/${id}`));
    else if (act === 'milestone') milestoneDialog(id);
    else if (act === 'ms-toggle') { await api(`/api/milestones/${b.dataset.id}`, { method: 'PATCH', body: { status: b.dataset.v } }); go(location.hash); }
    else if (act === 'task-new') taskDialog(await api(`/api/projects/${id}`));
    else if (act === 'task-edit') taskDialog(await api(`/api/projects/${id}`), await api(`/api/tasks/${b.dataset.id}`));
    else if (act === 'cancel') {
      if (!(await confirmDialog('Cancel task?', 'A running task is stopped at the next safe point. Saved outputs are kept.', 'Cancel task'))) return;
      await api(`/api/tasks/${b.dataset.id}/cancel`, { method: 'POST' }); toast('Cancel requested'); go(location.hash);
    } else if (act === 'retry') { await api(`/api/tasks/${b.dataset.id}/retry`, { method: 'POST' }); toast('Queued again'); go(location.hash); }
  } catch (err) { toast(err.message, true); }
});

function editProject(p) {
  openDialog(`Edit ${p.name}`, `
    <label class="f">Name<input type="text" name="name" value="${esc(p.name)}" required></label>
    <div class="row3">
      <label class="f">Icon<select name="icon">${['window', 'calendar', 'document', 'cart', 'chart', 'chat', 'box', 'globe'].map((i) => `<option ${i === p.icon ? 'selected' : ''}>${i}</option>`).join('')}</select></label>
      <label class="f">Priority (1–5)<input type="number" name="priority" min="1" max="5" value="${p.priority}"></label>
      <label class="f">Max concurrent runs<input type="number" name="max_concurrency" min="0" max="20" value="${p.max_concurrency}"></label>
    </div>
    <label class="f">Goal<textarea name="goals">${esc(p.goals)}</textarea></label>
    <label class="f">Brief<textarea name="brief">${esc(p.brief)}</textarea></label>
    <div class="row2">
      <label class="f">Daily budget (USD)<input type="number" step="0.01" min="0" name="budget_daily_usd" value="${p.budget_daily_usd ?? ''}"></label>
      <label class="f">Total budget (USD)<input type="number" step="0.01" min="0" name="budget_total_usd" value="${p.budget_total_usd ?? ''}"></label>
    </div>`, async (d) => { await api(`/api/projects/${p.id}`, { method: 'PATCH', body: d }); toast('Saved'); go(location.hash); });
}

function milestoneDialog(projectId) {
  openDialog('Add milestone', `
    <label class="f">Title<input type="text" name="title" required></label>
    <div class="row2">
      <label class="f">Phase<select name="phase">${PHASES.map((x) => `<option>${x}</option>`).join('')}</select></label>
      <label class="f">Due date<input type="date" name="due_at"></label>
    </div>`, async (d) => { await api(`/api/projects/${projectId}/milestones`, { method: 'POST', body: d }); go(location.hash); });
}

function taskDialog(p, t) {
  const others = p.tasks.filter((x) => x.id !== t?.id);
  const deps = new Set((t?.depends_on ?? []).map((d) => d.id));
  const agents = p.agents.filter((a) => !a.is_manager && a.assigned);
  openDialog(t ? 'Edit task' : 'Add task', `
    <label class="f">Title<input type="text" name="title" required value="${esc(t?.title ?? '')}"></label>
    <div class="row2">
      <label class="f">Short label (shown on Overview)<input type="text" name="short_label" maxlength="40" value="${esc(t?.short_label ?? '')}" placeholder="e.g. Building checkout"></label>
      <label class="f">Milestone<select name="milestone_id"><option value="">—</option>${p.milestones.map((m) => `<option value="${m.id}" ${m.id === t?.milestone_id ? 'selected' : ''}>${esc(m.title)}</option>`).join('')}</select></label>
    </div>
    <div class="row3">
      <label class="f">Role<input type="text" name="role" list="roles2" value="${esc(t?.role ?? 'Developer')}"><datalist id="roles2"><option>Developer</option><option>Researcher</option><option>Marketer</option><option>Intern</option></datalist></label>
      <label class="f">Agent (optional)<select name="assigned_agent_id"><option value="">Any with this role</option>${agents.map((a) => `<option value="${a.id}" ${a.id === t?.assigned_agent_id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
      <label class="f">Priority (1 = first)<input type="number" name="priority" min="1" max="5" value="${t?.priority ?? 3}"></label>
    </div>
    <label class="f">Description<textarea name="description">${esc(t?.description ?? '')}</textarea></label>
    <label class="f">Acceptance criteria<textarea name="acceptance_criteria">${esc(t?.acceptance_criteria ?? '')}</textarea></label>
    <label class="f">Depends on<select name="depends_on" multiple size="${Math.min(5, Math.max(2, others.length))}">${others.map((x) => `<option value="${x.id}" ${deps.has(x.id) ? 'selected' : ''}>${esc(x.title)}</option>`).join('')}</select></label>
    <div class="row3">
      <label class="f">Max attempts<input type="number" name="max_attempts" min="1" max="5" value="${t?.max_attempts ?? 2}"></label>
      <label class="f">Max rework rounds<input type="number" name="max_review_rounds" min="0" max="5" value="${t?.max_review_rounds ?? 2}"></label>
      <label class="f">Run cost cap (USD)<input type="number" step="0.01" min="0" name="run_cost_limit_usd" value="${t?.run_cost_limit_usd ?? ''}"></label>
    </div>
    ${t ? '' : `<label class="chk"><input type="checkbox" name="external"> External action (contacts people or publishes). Never repeated automatically.</label>`}`,
  async (d) => {
    if (!t) d.kind = d.external ? 'external' : 'internal';
    delete d.external;
    if (t) await api(`/api/tasks/${t.id}`, { method: 'PATCH', body: d });
    else await api(`/api/projects/${p.id}/tasks`, { method: 'POST', body: d });
    toast('Saved');
    go(location.hash);
  }, t ? 'Save' : 'Add task');
}

export { icon };
