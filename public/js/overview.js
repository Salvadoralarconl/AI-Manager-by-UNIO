// Overview: header, project switcher, selected project, global Team, Latest work.
import { api, html, raw, icon, avatar, status, providerLabel, clock, dueIn, spendLabel, STATUS_LABEL, openDialog, toast } from './ui.js';
import { connHtml, live, go, route } from './main.js';

const KEY = 'aim.selectedProject';
const FILTER_KEY = 'aim.latestFilter';
let attnOpen = false;

function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } return null; }

export async function renderOverview(r) {
  const wanted = r.q.get('p') || store(KEY) || '';
  const d = await api(`/api/overview?project=${encodeURIComponent(wanted)}`);
  live.staleS = d.stale.dashboard_s;
  const sel = d.selected;
  if (sel) store(KEY, sel.id);
  const filter = store(FILTER_KEY) === 'project' && sel ? 'project' : 'all';
  const latest = filter === 'project' ? d.latest.filter((e) => e.project_id === sel.id) : d.latest;

  const s = d.summary;
  const runnerStale = !d.runner?.fresh;
  return html`
  <header class="page-head">
    <div>
      <h1>Overview</h1>
      <div class="summary tnum">
        <span>${s.working} working</span><span class="sep">·</span>
        <span>${s.available} available</span><span class="sep">·</span>
        <span title="${spendTitle(s.spend_today)}">${spendLabel(s.spend_today)}</span>
        ${d.attention.length ? html`<span class="sep">·</span><button class="attn" data-ov="attn" aria-expanded="${attnOpen}" aria-controls="attn-panel"><span class="dot" aria-hidden="true"></span>${d.attention.length} need${d.attention.length === 1 ? 's' : ''} you</button>` : ''}
        ${d.paused ? html`<span class="sep">·</span><span class="st st-paused">New work paused</span>` : ''}
      </div>
    </div>
    <div class="head-right">
      ${d.demo ? html`<span class="demo-pill" title="Sample data in a separate demo database. Work is simulated.">Demo</span>` : ''}
      ${connHtml()}
      ${runnerStale ? html`<span class="conn warn" title="${d.runner ? `Last runner heartbeat ${clock(d.runner.last_beat_at)}` : 'The runner has never reported'}"><span class="dot hollow"></span>Runner ${d.runner ? 'not reporting' : 'offline'}</span>` : ''}
      <span class="vr" aria-hidden="true"></span>
      <button class="textbtn" data-action="${d.paused ? 'resume-all' : 'pause-all'}">${d.paused ? 'Resume all' : 'Pause all'}</button>
    </div>
  </header>
  ${d.attention.length && attnOpen ? attentionPanel(d.attention) : ''}

  ${switcher(d.projects, sel)}

  ${sel ? html`
  <div class="ov-grid">
    <section aria-labelledby="sel-title">${selectedProject(sel)}</section>
    <div class="vline" aria-hidden="true"></div>
    <section class="team" aria-labelledby="team-title">
      <h2 id="team-title">Team</h2>
      ${d.team.length ? d.team.map(teamRow) : html`<p class="state-msg">No agents yet. <a href="#/team">Add one</a></p>`}
    </section>
  </div>` : html`
  <div class="state-msg">No projects yet. <button class="textbtn" data-ov="add-project">Create your first project</button></div>`}

  <section class="latest" aria-labelledby="lw-title">
    <div class="sec-head">
      <h2 id="lw-title">Latest work</h2>
      ${sel ? html`<div class="seg" role="group" aria-label="Filter latest work">
        <button data-ov="filter" data-v="all" aria-pressed="${filter === 'all'}">All projects</button>
        <button data-ov="filter" data-v="project" aria-pressed="${filter === 'project'}">${sel.name}</button>
      </div>` : ''}
    </div>
    <table class="table lw tnum">
      <colgroup><col class="c-time"><col class="c-proj"><col class="c-agent col-agent"><col></colgroup>
      <thead><tr><th scope="col">Time</th><th scope="col">Project</th><th scope="col" class="col-agent">Agent</th><th scope="col">Update</th></tr></thead>
      <tbody>
        ${latest.length ? latest.slice(0, 8).map(workRow) : html`<tr class="empty-row"><td colspan="4">${filter === 'project' ? 'No work recorded for this project yet.' : 'No work recorded yet.'}</td></tr>`}
      </tbody>
    </table>
    <p class="note"><a href="#/activity">All activity</a></p>
  </section>`;
}

function spendTitle(sp) {
  const parts = [];
  parts.push(`Billable (reported + estimated): $${sp.billable.toFixed(2)}`);
  if (sp.estimated) parts.push(`of which estimated: $${sp.estimated.toFixed(2)}`);
  if (sp.simulated) parts.push(`Simulated (not charged): $${sp.simulated.toFixed(2)}`);
  if (sp.unknown_count) parts.push(`${sp.unknown_count} run(s) with unknown cost`);
  parts.push('Home AI compute is not priced.');
  return parts.join('\n');
}

function attentionPanel(items) {
  return html`<div class="attn-panel" id="attn-panel"><ul>
    ${items.map((a) => html`<li><span class="muted">${a.project_name}</span><a href="#/projects/${a.project_id}/tasks?task=${a.task_id}">${a.title}</a><span class="why">${a.blocked_reason || STATUS_LABEL[a.state]}</span></li>`)}
  </ul></div>`;
}

function switcher(projects, sel) {
  return html`<div class="switcher">
    <button class="iconbtn" data-ov="scroll" data-dir="-1" aria-label="Scroll projects left" hidden>${icon('left')}</button>
    <div class="tabs-scroll" role="tablist" aria-label="Projects" data-keep-scroll="tabs">
      ${projects.map((p) => {
        const on = sel && p.id === sel.id;
        const sub = p.status === 'paused' ? html`<span class="ptab-sub paused">Paused</span>`
          : p.working ? html`<span class="ptab-sub working">${p.working} working</span>`
          : html`<span class="ptab-sub idle">${p.open_tasks ? `${p.open_tasks} open` : 'Idle'}</span>`;
        return html`<button class="ptab" role="tab" id="tab-${p.id}" data-key="tab-${p.id}" aria-selected="${on}" tabindex="${on ? 0 : -1}" data-ov="select" data-id="${p.id}">
          <span class="ptab-icon">${icon(p.icon)}</span><span><span class="ptab-name">${p.name}</span>${sub}</span></button>`;
      })}
    </div>
    <div class="switcher-end">
      <button class="iconbtn" data-ov="scroll" data-dir="1" aria-label="Scroll projects right" hidden>${icon('right')}</button>
      <span class="vr" aria-hidden="true"></span>
      <button class="iconbtn" data-ov="add-project" aria-label="Add project" title="Add project">${icon('plus')}</button>
    </div>
  </div>`;
}

function selectedProject(p) {
  const m = p.next_milestone;
  return html`
    <div class="proj-title"><h2 id="sel-title"><a href="#/projects/${p.id}">${p.name}</a></h2>${status(p.status)}</div>
    <div class="next-row">
      <span class="lbl">Next:${m ? html`<strong>${m.title}</strong>` : html`<strong class="muted">No open milestone</strong>`}</span>
      <span class="due">${m?.due_at ? dueIn(m.due_at) : ''}</span>
    </div>
    <div class="sub-label">Assigned agents</div>
    ${p.assigned.length ? p.assigned.map((a) => assignedRow(a, p)) : html`<p class="state-msg">No agents assigned. <a href="#/projects/${p.id}/team">Assign agents</a></p>`}`;
}

function assignedRow(a, p) {
  let task = a.current_label;
  let idle = false;
  if (!a.here) {
    idle = true;
    task = a.project_name && ['working', 'reviewing', 'queued', 'blocked'].includes(a.status) ? `On ${a.project_name}` : '—';
  }
  const st = a.here || ['paused', 'offline', 'unknown', 'available', 'failed'].includes(a.status) ? a.status : 'available';
  const stLabel = !a.here && ['working', 'reviewing', 'queued', 'blocked'].includes(a.status) ? 'Elsewhere' : undefined;
  return html`<button class="arow" data-ov="agent" data-id="${a.id}" data-key="arow-${a.id}" aria-label="${a.name}: ${task || 'no current task'}">
    ${avatar(a)}
    <span class="who"><span class="role">${a.name}</span><span class="prov">${providerLabel(a)}</span></span>
    <span class="vr" aria-hidden="true"></span>
    <span class="task${idle || !task ? ' idle' : ''}" title="${a.here ? a.last_activity || '' : ''}">${task || '—'}</span>
    ${stLabel ? status('paused', stLabel) : status(st, a.detail && ['offline', 'unknown'].includes(st) ? a.detail : undefined)}
  </button>`;
}

function teamRow(a) {
  const where = a.is_manager ? 'All projects' : a.project_name && ['working', 'reviewing', 'queued', 'blocked', 'failed', 'unknown'].includes(a.status) ? a.project_name : '';
  return html`<button class="trow" data-ov="agent" data-id="${a.id}" data-key="trow-${a.id}">
    ${avatar(a)}
    <span class="who"><span class="role">${a.name}</span><span class="prov">${providerLabel(a)}</span></span>
    <span class="stcol">${status(a.status)}${where && !(a.is_manager && a.status !== 'reviewing') ? html`<span class="where">${where}</span>` : a.detail ? html`<span class="where">${a.detail}</span>` : ''}</span>
  </button>`;
}

function workRow(e) {
  const href = e.run_id ? `#/team/${e.agent_id}?run=${e.run_id}` : e.task_id ? `#/projects/${e.project_id}/tasks?task=${e.task_id}` : '#/activity';
  const kind = { failed: 'Failed', blocked: 'Needs you', cancelled: 'Cancelled' }[e.category];
  return html`<tr>
    <td>${clock(e.ts)}</td>
    <td>${e.project_id ? html`<a href="#/projects/${e.project_id}">${e.project_name}</a>` : '—'}</td>
    <td class="col-agent">${e.agent_name || '—'}</td>
    <td><a href="${href}">${e.message}</a>${kind ? html`<span class="kind st-${e.category === 'blocked' ? 'blocked' : e.category}">${kind}</span>` : ''}</td>
  </tr>`;
}

export function newProjectDialog(onDone) {
  openDialog('New project', `
    <label class="f">Name<input type="text" name="name" required maxlength="80" autofocus></label>
    <div class="row2">
      <label class="f">Icon<select name="icon">${['window', 'calendar', 'document', 'cart', 'chart', 'chat', 'box', 'globe'].map((i) => `<option>${i}</option>`).join('')}</select></label>
      <label class="f">Priority (1–5, higher gets more capacity)<input type="number" name="priority" min="1" max="5" value="2"></label>
    </div>
    <label class="f">Goal<textarea name="goals" placeholder="What does success look like?"></textarea></label>
    <label class="f">Brief<textarea name="brief"></textarea></label>
    <div class="row2">
      <label class="f">Daily budget (USD, optional)<input type="number" step="0.01" min="0" name="budget_daily_usd"></label>
      <label class="f">Total budget (USD, optional)<input type="number" step="0.01" min="0" name="budget_total_usd"></label>
    </div>`, async (data) => {
    const p = await api('/api/projects', { method: 'POST', body: data });
    toast(`${p.name} created`);
    onDone?.(p);
  }, 'Create project');
}

// ---------- interactions ----------
const main = document.getElementById('main');
main.addEventListener('click', (e) => {
  const b = e.target.closest('[data-ov]');
  if (!b || route().view !== 'overview') return;
  const act = b.dataset.ov;
  if (act === 'select') { store(KEY, b.dataset.id); go(`#/overview?p=${b.dataset.id}`); }
  else if (act === 'agent') { const q = route().q; q.set('agent', b.dataset.id); location.hash = `#/overview?${q}`; }
  else if (act === 'filter') { store(FILTER_KEY, b.dataset.v); go(location.hash); }
  else if (act === 'attn') { attnOpen = !attnOpen; go(location.hash); }
  else if (act === 'add-project') newProjectDialog((p) => { store(KEY, p.id); go(`#/overview?p=${p.id}`); });
  else if (act === 'scroll') {
    const s = main.querySelector('.tabs-scroll');
    s.scrollBy({ left: Number(b.dataset.dir) * s.clientWidth * 0.8 });
  }
});
// Roving tabindex for the project tabs (arrow keys, Home/End).
main.addEventListener('keydown', (e) => {
  const tab = e.target.closest('.ptab');
  if (!tab) return;
  const tabs = [...main.querySelectorAll('.ptab')];
  const i = tabs.indexOf(tab);
  let j = null;
  if (e.key === 'ArrowRight') j = Math.min(tabs.length - 1, i + 1);
  if (e.key === 'ArrowLeft') j = Math.max(0, i - 1);
  if (e.key === 'Home') j = 0;
  if (e.key === 'End') j = tabs.length - 1;
  if (j === null) return;
  e.preventDefault();
  tabs[j].focus();
  tabs[j].scrollIntoView({ block: 'nearest', inline: 'nearest' });
});
// Show overflow arrows only when the tabs don't fit.
function syncOverflow() {
  const s = main.querySelector('.tabs-scroll');
  if (!s) return;
  const [l, r] = main.querySelectorAll('[data-ov="scroll"]');
  const over = s.scrollWidth > s.clientWidth + 2;
  l.hidden = !over || s.scrollLeft <= 2;
  r.hidden = !over || s.scrollLeft + s.clientWidth >= s.scrollWidth - 2;
}
main.addEventListener('rendered', () => {
  const s = main.querySelector('.tabs-scroll');
  if (!s) return;
  s.addEventListener('scroll', syncOverflow, { passive: true });
  syncOverflow();
  const sel = s.querySelector('[aria-selected="true"]');
  if (sel && (sel.offsetLeft < s.scrollLeft || sel.offsetLeft + sel.offsetWidth > s.scrollLeft + s.clientWidth)) s.scrollLeft = sel.offsetLeft - 20;
});
window.addEventListener('resize', syncOverflow);

export { raw };
