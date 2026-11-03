// Team page + agent drawer: configuration, status, runs, logs, usage, controls.
import { api, html, raw, icon, avatar, status, providerLabel, when, ago, money, toast, openDialog, esc } from './ui.js';
import { route, go } from './main.js';

const ROLES = ['Manager', 'Developer', 'Researcher', 'Marketer', 'Intern'];
const COLORS = ['green', 'peach', 'lavender', 'yellow', 'blue', 'pink'];

export async function renderTeam(r) {
  const agents = await api('/api/agents');
  const id = r.id ?? agents[0]?.id;
  const sel = id ? await api(`/api/agents/${encodeURIComponent(id)}`) : null;
  const runId = r.q.get('run');
  const run = runId ? await api(`/api/runs/${encodeURIComponent(runId)}`).catch(() => null) : null;
  return html`
  <header class="page-head">
    <div><h1>Team</h1><div class="summary">${agents.length} agents · ${agents.filter((a) => ['working', 'reviewing'].includes(a.status)).length} working</div></div>
    <div class="head-right"><button class="textbtn" data-tm="new">Add agent</button></div>
  </header>
  <div class="split">
    <nav aria-label="Agents">${agents.map((a) => html`<a class="list-row" href="#/team/${a.id}" aria-current="${a.id === id}">
      ${avatar(a)}<span class="grow"><span class="name">${a.name}</span><span class="meta">${a.role} · ${providerLabel(a)}${a.model ? ` · ${a.model}` : ''}</span></span>${status(a.status)}</a>`)}
    </nav>
    <div class="vline" aria-hidden="true"></div>
    <section>${sel ? agentDetail(sel, run) : html`<p class="state-msg">No agents yet.</p>`}</section>
  </div>`;
}

function agentDetail(a, run) {
  const busy = ['working', 'reviewing'].includes(a.status);
  return html`
    <div class="h-row">${avatar(a)}<h2>${a.name}</h2>${status(a.status, a.detail ? `${statusWord(a.status)} · ${a.detail}` : undefined)}
      <div class="actions">
        <button class="textbtn sm" data-tm="pause" data-id="${a.id}" data-v="${a.paused ? 0 : 1}">${a.paused ? 'Resume' : 'Pause'}</button>
        <button class="textbtn sm" data-tm="edit" data-id="${a.id}">Configure</button>
      </div>
    </div>
    ${a.paused && busy ? html`<p class="note">Paused: the current run finishes, then no new work is assigned.</p>` : ''}
    <div class="section"><div class="kv">
      <div>Role</div><div>${a.role}${a.is_manager ? ' · coordinates all projects' : ''}</div>
      <div>Provider</div><div>${providerLabel(a)} ${a.model ? html`<span class="muted">· ${a.model}</span>` : ''} ${a.demo ? html`<span class="muted">· simulated in demo</span>` : a.provider_configured ? '' : html`<span class="st st-offline">· not connected</span>`}</div>
      <div>Current</div><div>${a.task_label ? html`<a href="#/projects/${a.project_id}/tasks?task=${a.task_id}">${a.task_label}</a> <span class="muted">· ${a.project_name}</span>` : html`<span class="muted">No current task</span>`}</div>
      <div>Last activity</div><div>${a.last_activity ? html`${a.last_activity} <span class="muted">· ${ago(a.last_activity_at)}</span>` : html`<span class="muted">None recorded</span>`}</div>
      ${a.started_at ? html`<div>Run started</div><div>${when(a.started_at)} <span class="muted">· provider ${a.provider_state}</span></div>` : ''}
      <div>Capacity</div><div>${a.capacity} concurrent run${a.capacity > 1 ? 's' : ''}</div>
      <div>Projects</div><div>${a.all_projects ? 'All projects' : a.projects.length ? a.projects.map((p) => html`<a class="tag" href="#/projects/${p.id}">${p.name}</a>`) : html`<span class="muted">None assigned</span>`}</div>
      <div>Capabilities</div><div>${a.capabilities.length ? a.capabilities.map((c) => html`<span class="tag">${c}</span>`) : html`<span class="muted">—</span>`}</div>
      <div>Permitted tools</div><div>${a.tools.length ? a.tools.map((c) => html`<span class="tag">${c}</span>`) : html`<span class="muted">None</span>`}</div>
    </div></div>
    ${run ? runDetail(run) : ''}
    <div class="section"><h3>Usage</h3>${usageTable(a.usage)}</div>
    <div class="section"><h3>Run history</h3>${runsTable(a)}</div>`;
}
const statusWord = (s) => s[0].toUpperCase() + s.slice(1);

function usageTable(u) {
  const rows = [];
  for (const [period, list] of [['Today', u.today], ['This month', u.month]]) {
    if (!list.length) rows.push(html`<tr><td>${period}</td><td colspan="4" class="muted">No usage</td></tr>`);
    for (const x of list) rows.push(html`<tr><td>${period}</td><td>${costKind(x.cost_kind)}</td><td class="num">${x.runs}</td>
      <td class="num">${(x.input_tokens + x.output_tokens).toLocaleString()}</td><td class="num">${x.cost_kind === 'local' ? 'not priced' : x.cost_kind === 'unknown' ? 'unknown' : money(x.cost_usd)}</td></tr>`);
  }
  return html`<table class="mini-table tnum"><thead><tr><th>Period</th><th>Cost basis</th><th class="num">Runs</th><th class="num">Tokens</th><th class="num">Cost</th></tr></thead><tbody>${rows}</tbody></table>`;
}
export const costKind = (k) => ({ reported: 'Provider-reported', estimated: 'Estimated', unknown: 'Unknown', simulated: 'Simulated (not charged)', local: 'Local compute' }[k] ?? k);

function runsTable(a) {
  if (!a.runs.length) return html`<p class="state-msg">No runs yet.</p>`;
  return html`<table class="mini-table"><thead><tr><th>Started</th><th>Project</th><th>Task</th><th>Kind</th><th>Status</th><th>Result</th></tr></thead><tbody>
    ${a.runs.map((r) => html`<tr><td class="tnum">${when(r.started_at)}</td><td>${r.project_name}</td>
      <td><a href="#/projects/${r.project_id}/tasks?task=${r.task_id}">${r.task_title}</a></td><td>${r.kind === 'review' ? 'Review' : `Attempt ${r.attempt}`}</td>
      <td>${status(r.status)}</td><td><a href="#/team/${a.id}?run=${r.id}">${r.summary || r.error || r.last_activity || 'Details'}</a></td></tr>`)}
  </tbody></table>`;
}

export function runDetail(r) {
  return html`<div class="section" id="run-detail"><h3>Run · ${r.task_title}</h3>
    <div class="kv">
      <div>Project</div><div>${r.project_name}</div>
      <div>Kind</div><div>${r.kind === 'review' ? `Manager review (round ${r.attempt})` : `Execution attempt ${r.attempt}`}</div>
      <div>Status</div><div>${status(r.status)}${r.verdict ? html` <span class="muted">· verdict ${r.verdict}</span>` : ''}</div>
      <div>Started</div><div>${when(r.started_at)}${r.ended_at ? html` <span class="muted">→ ${when(r.ended_at)}</span>` : ''}</div>
      <div>Provider state</div><div>${r.provider_state}</div>
      <div>Summary</div><div>${r.summary || '—'}</div>
      ${r.error ? html`<div>Error</div><div class="err">${r.error}</div>` : ''}
      <div>Outputs</div><div>${r.artifacts.length ? r.artifacts.map((x) => html`<a class="tag" href="/api/artifacts/${x.id}" target="_blank" rel="noopener">${x.name}</a>`) : html`<span class="muted">None</span>`}</div>
      <div>Usage</div><div>${r.usage.length ? r.usage.map((u) => html`${(u.input_tokens ?? 0) + (u.output_tokens ?? 0)} tokens · ${u.cost_kind === 'unknown' ? 'cost unknown' : u.cost_kind === 'local' ? 'local compute' : `${money(u.cost_usd)} ${costKind(u.cost_kind).toLowerCase()}`}`) : html`<span class="muted">None recorded</span>`}</div>
    </div>
    <p class="note">Observable actions only.</p>
    <div class="log">${r.log.length ? r.log.map((l) => `${new Date(l.ts).toLocaleTimeString([], { hour12: false })}  ${l.text}\n`).join('') : 'No activity log.'}</div>
  </div>`;
}

// ---------- drawer (opened from Overview) ----------
export async function openAgentDrawer(id) {
  let root = document.getElementById('drawer-root');
  const fresh = !root;
  if (!root) {
    root = document.createElement('div');
    root.id = 'drawer-root';
    document.body.appendChild(root);
  }
  let a;
  try { a = await api(`/api/agents/${encodeURIComponent(id)}`); } catch (e) { root.innerHTML = ''; toast(e.message, true); return; }
  if (!document.getElementById('drawer-root')) return;
  const recent = a.runs.slice(0, 6);
  root.innerHTML = html`<div class="drawer-back" data-dr="close"></div>
  <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="dr-title">
    <div class="drawer-head">${avatar(a)}<span class="who"><span class="role" id="dr-title">${a.name}</span><span class="prov">${a.role} · ${providerLabel(a)}${a.model ? ` · ${a.model}` : ''}</span></span>
      <button class="iconbtn close" data-dr="close" aria-label="Close">${icon('close')}</button></div>
    <div class="section"><div class="kv">
      <div>Status</div><div>${status(a.status)}${a.detail ? html` <span class="muted">· ${a.detail}</span>` : ''}</div>
      <div>Project</div><div>${a.is_manager ? 'All projects' : a.project_name || html`<span class="muted">—</span>`}</div>
      <div>Task</div><div>${a.task_label ? html`<a href="#/projects/${a.project_id}/tasks?task=${a.task_id}">${a.task_label}</a>` : html`<span class="muted">None</span>`}</div>
      <div>Last activity</div><div>${a.last_activity ? html`${a.last_activity} <span class="muted">· ${ago(a.last_activity_at)}</span>` : html`<span class="muted">None recorded</span>`}</div>
    </div></div>
    <div class="section"><h3>Recent runs</h3>${recent.length ? html`<table class="mini-table"><tbody>${recent.map((r) => html`<tr><td class="tnum">${when(r.started_at)}</td><td><a href="#/team/${a.id}?run=${r.id}">${r.summary || r.task_title}</a><div class="note">${r.project_name}</div></td><td>${status(r.status)}</td></tr>`)}</tbody></table>` : html`<p class="state-msg">No runs yet.</p>`}</div>
    <div class="section h-row"><a class="btn" href="#/team/${a.id}">Open in Team</a>
      <button class="btn" data-tm="pause" data-id="${a.id}" data-v="${a.paused ? 0 : 1}">${a.paused ? 'Resume agent' : 'Pause agent'}</button></div>
  </aside>`.s;
  if (fresh) root.querySelector('.close').focus();
  root.onclick = (e) => {
    if (e.target.closest('[data-dr="close"]')) {
      const q = route().q; q.delete('agent');
      const base = location.hash.split('?')[0];
      location.hash = q.toString() ? `${base}?${q}` : base;
    }
  };
}

// ---------- actions ----------
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-tm]');
  if (!b) return;
  const act = b.dataset.tm;
  try {
    if (act === 'pause') {
      await api(`/api/agents/${b.dataset.id}/pause`, { method: 'POST', body: { paused: b.dataset.v === '1' } });
      toast(b.dataset.v === '1' ? 'Agent paused' : 'Agent resumed');
      go(location.hash);
    } else if (act === 'new') agentDialog();
    else if (act === 'edit') agentDialog(await api(`/api/agents/${b.dataset.id}`));
  } catch (err) { toast(err.message, true); }
});

function agentDialog(a) {
  const opt = (v, cur, label = v) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
  openDialog(a ? `Configure ${a.name}` : 'Add agent', `
    <div class="row2">
      ${a ? `<label class="f">Role<input type="text" value="${esc(a.role)}" disabled></label>` : `<label class="f">Role<input type="text" name="role" list="roles" required placeholder="Developer"><datalist id="roles">${ROLES.map((r) => `<option>${r}</option>`).join('')}</datalist></label>`}
      <label class="f">Name<input type="text" name="name" value="${esc(a?.name ?? '')}" placeholder="Defaults to the role"></label>
    </div>
    <div class="row3">
      <label class="f">Provider<select name="provider">${[['openai', 'OpenAI (ChatGPT)'], ['anthropic', 'Anthropic (Claude)'], ['local', 'Home AI'], ['simulated', 'Simulator']].map(([v, l]) => opt(v, a?.provider ?? 'anthropic', l)).join('')}</select></label>
      <label class="f">Model identifier<input type="text" name="model" value="${esc(a?.model ?? '')}"></label>
      <label class="f">Capacity<input type="number" name="capacity" min="1" max="8" value="${a?.capacity ?? 1}"></label>
    </div>
    <div class="row3">
      <label class="f">Initials<input type="text" name="initials" maxlength="2" value="${esc(a?.initials ?? '')}"></label>
      <label class="f">Colour<select name="color">${COLORS.map((c) => opt(c, a?.color ?? 'green')).join('')}</select></label>
      <label class="f">Enabled<select name="enabled">${opt('1', a ? String(a.enabled) : '1', 'Yes')}${opt('0', a ? String(a.enabled) : '1', 'No')}</select></label>
    </div>
    <label class="f">Capabilities (comma separated)<input type="text" name="capabilities" value="${esc(a?.capabilities.join(', ') ?? '')}"></label>
    <label class="f">Permitted tools (comma separated)<input type="text" name="tools" value="${esc(a?.tools.join(', ') ?? '')}"></label>
    <label class="f">Instructions<textarea name="instructions">${esc(a?.instructions ?? '')}</textarea></label>
    <p class="note">The Manager must use OpenAI. Simulator agents never call a provider.</p>`, async (d) => {
    d.enabled = d.enabled === '1';
    if (a) await api(`/api/agents/${a.id}`, { method: 'PATCH', body: d });
    else { const n = await api('/api/agents', { method: 'POST', body: d }); go(`#/team/${n.id}`); }
    toast('Saved');
    go(location.hash);
  }, a ? 'Save' : 'Add agent');
}

export { raw };
