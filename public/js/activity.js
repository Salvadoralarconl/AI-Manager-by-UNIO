// Activity: searchable, filterable cross-project event log.
import { api, html, when, status } from './ui.js';
import { go, route } from './main.js';

const CATS = [['', 'All types'], ['started', 'Started'], ['completed', 'Completed'], ['reviewed', 'Reviewed'], ['failed', 'Failed'], ['blocked', 'Blocked'], ['cancelled', 'Cancelled']];
const CAT_STATUS = { started: 'running', completed: 'completed', reviewed: 'awaiting_review', failed: 'failed', blocked: 'blocked', cancelled: 'cancelled', other: 'paused' };

export async function renderActivity(r) {
  const q = r.q;
  const params = new URLSearchParams();
  for (const k of ['q', 'project_id', 'agent_id', 'category']) if (q.get(k)) params.set(k, q.get(k));
  if (q.get('from')) params.set('from', new Date(q.get('from') + 'T00:00').getTime());
  if (q.get('to')) params.set('to', new Date(q.get('to') + 'T23:59:59').getTime());
  params.set('limit', q.get('limit') || '100');
  const [events, projects, agents] = await Promise.all([api(`/api/events?${params}`), api('/api/projects'), api('/api/agents')]);
  const sel = (name, opts) => html`<select name="${name}" aria-label="${name}">${opts.map(([v, l]) => html`<option value="${v}" ${q.get(name) === v ? 'selected' : ''}>${l}</option>`)}</select>`;
  return html`
  <header class="page-head"><div><h1>Activity</h1><div class="summary">Events across all projects</div></div></header>
  <form class="filters" id="act-filters" role="search">
    <label class="f q">Search<input type="search" name="q" value="${q.get('q') ?? ''}" placeholder="Task, update, project or agent"></label>
    <label class="f">Project${sel('project_id', [['', 'All projects'], ...projects.map((p) => [p.id, p.name])])}</label>
    <label class="f">Agent${sel('agent_id', [['', 'All agents'], ...agents.map((a) => [a.id, a.name])])}</label>
    <label class="f">Type${sel('category', CATS)}</label>
    <label class="f">From<input type="date" name="from" value="${q.get('from') ?? ''}"></label>
    <label class="f">To<input type="date" name="to" value="${q.get('to') ?? ''}"></label>
    <button class="btn" type="submit">Apply</button>
  </form>
  <table class="table tnum" style="margin-top:22px">
    <colgroup><col style="width:130px"><col style="width:120px"><col style="width:18%"><col style="width:14%"><col></colgroup>
    <thead><tr><th>Time</th><th>Type</th><th>Project</th><th>Agent</th><th>Event</th></tr></thead>
    <tbody>${events.length ? events.map((e) => html`<tr>
      <td>${when(e.ts)}</td>
      <td>${status(CAT_STATUS[e.category] ?? 'paused', e.category === 'other' ? cap(e.type.split('.')[0]) : e.category[0].toUpperCase() + e.category.slice(1))}</td>
      <td>${e.project_id ? html`<a href="#/projects/${e.project_id}">${e.project_name}</a>` : html`<span class="muted">System</span>`}</td>
      <td>${e.agent_id ? html`<a href="#/team/${e.agent_id}">${e.agent_name}</a>` : html`<span class="muted">—</span>`}</td>
      <td>${link(e)}</td></tr>`) : html`<tr class="empty-row"><td colspan="5">No matching events.</td></tr>`}</tbody>
  </table>
  ${events.length >= Number(params.get('limit')) ? html`<p class="note"><button class="textbtn sm" data-act="more">Show more</button></p>` : ''}`;
}

const cap = (s) => s[0].toUpperCase() + s.slice(1);

function link(e) {
  if (e.artifact_id) return html`<a href="/api/artifacts/${e.artifact_id}" target="_blank" rel="noopener">${e.message}</a>`;
  if (e.run_id && e.agent_id) return html`<a href="#/team/${e.agent_id}?run=${e.run_id}">${e.message}</a>`;
  if (e.task_id) return html`<a href="#/projects/${e.project_id}/tasks?task=${e.task_id}">${e.message}</a>`;
  return e.message;
}

const main = document.getElementById('main');
main.addEventListener('submit', (e) => {
  if (e.target.id !== 'act-filters') return;
  e.preventDefault();
  const p = new URLSearchParams();
  for (const el of e.target.elements) if (el.name && el.value) p.set(el.name, el.value);
  go(`#/activity?${p}`);
});
main.addEventListener('click', (e) => {
  if (!e.target.closest('[data-act="more"]')) return;
  const q = route().q;
  q.set('limit', String(Number(q.get('limit') || 100) + 200));
  go(`#/activity?${q}`);
});
