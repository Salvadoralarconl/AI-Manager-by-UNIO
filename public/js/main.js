// App shell: router, dock, live connection, shared drawer.
import { api, html, icon, esc, toast } from './ui.js';
import { renderOverview, newProjectDialog } from './overview.js';
import { renderProjects } from './projects.js';
import { renderTeam, openAgentDrawer } from './team.js';
import { renderActivity } from './activity.js';
import { renderSettings } from './settings.js';

const NAV = [
  ['overview', 'Overview', 'home'],
  ['projects', 'Projects', 'layers'],
  ['team', 'Team', 'team'],
  ['activity', 'Activity', 'pulse'],
  ['settings', 'Settings', 'gear'],
];
const VIEWS = { overview: renderOverview, projects: renderProjects, team: renderTeam, activity: renderActivity, settings: renderSettings };

// Live connection state is tracked separately from runner heartbeat and agent status.
export const live = { state: 'connecting', lastMsgAt: 0, runnerBeatAt: null, staleS: 15, listeners: new Set() };

export function route() {
  const [p, qs] = location.hash.replace(/^#\/?/, '').split('?');
  const parts = p.split('/').filter(Boolean);
  return { view: VIEWS[parts[0]] ? parts[0] : 'overview', id: parts[1] ? decodeURIComponent(parts[1]) : null, sub: parts[2] ?? null, q: new URLSearchParams(qs ?? '') };
}
export function go(hash) { if (location.hash !== hash) location.hash = hash; else render(); }

function renderDock(view) {
  const nav = document.getElementById('dock');
  const links = NAV.map(([id, label, ic]) =>
    html`<a href="#/${id}" ${id === view ? html`aria-current="page"` : ''}>${icon(ic)}<span>${label}</span></a>`.s).join('');
  if (!nav.firstElementChild) {
    nav.innerHTML = html`<div class="brand"><span class="brand-mark" aria-hidden="true">${icon('mark')}</span><span>AI Manager<small>by UNIO</small></span></div>
      <div class="side-nav"></div>
      <div class="side-foot"><button class="btn primary block" data-action="new-project">${icon('plus')}New project</button></div>`.s;
  }
  nav.querySelector('.side-nav').innerHTML = links;
}

let renderSeq = 0;
let current = null;
export async function render({ soft = false } = {}) {
  const r = route();
  renderDock(r.view);
  const main = document.getElementById('main');
  const seq = ++renderSeq;
  if (!soft || current !== r.view) {
    if (current !== r.view) main.innerHTML = '<p class="state-msg">Loading…</p>';
  }
  current = r.view;
  try {
    const out = await VIEWS[r.view](r, { soft });
    if (seq !== renderSeq || out === undefined) return;
    preserveFocus(main, () => { main.innerHTML = out.s ?? out; });
    main.dispatchEvent(new CustomEvent('rendered'));
  } catch (e) {
    if (seq !== renderSeq) return;
    main.innerHTML = html`<div class="state-msg" role="alert">Couldn't load this page: ${e.message}<button class="textbtn" data-action="reload">Try again</button></div>`.s;
  }
  const drawer = r.q.get('agent');
  if (drawer) openAgentDrawer(drawer); else closeDrawer();
}

// Re-rendering on live updates must not steal keyboard focus or scroll.
function preserveFocus(root, fn) {
  const a = document.activeElement;
  const key = a && root.contains(a) ? (a.id || a.dataset.key || a.name) : null;
  const sel = a && 'selectionStart' in a ? [a.selectionStart, a.selectionEnd] : null;
  const scrollers = [...root.querySelectorAll('[data-keep-scroll]')].map((el) => [el.dataset.keepScroll, el.scrollLeft]);
  fn();
  for (const [k, x] of scrollers) { const el = root.querySelector(`[data-keep-scroll="${k}"]`); if (el) el.scrollLeft = x; }
  if (!key) return;
  const el = root.querySelector(`#${CSS.escape(key)}`) || root.querySelector(`[data-key="${CSS.escape(key)}"]`) || root.querySelector(`[name="${CSS.escape(key)}"]`);
  if (el) { el.focus({ preventScroll: true }); if (sel && 'setSelectionRange' in el) try { el.setSelectionRange(...sel); } catch { /* n/a */ } }
}

export function closeDrawer() {
  const d = document.getElementById('drawer-root');
  if (d) d.remove();
}

// ---------- live updates (SSE) ----------
let es;
let softTimer;
function scheduleSoft() {
  clearTimeout(softTimer);
  softTimer = setTimeout(() => {
    // Don't re-render under an open dialog or while typing in a form.
    if (document.querySelector('dialog[open]')) return scheduleSoft();
    const a = document.activeElement;
    if (a && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName) && a.closest('form')) return;
    render({ soft: true });
    for (const l of live.listeners) l();
  }, 350);
}
function connect() {
  es?.close();
  es = new EventSource('/api/stream');
  const seen = () => { live.lastMsgAt = Date.now(); if (live.state !== 'online') { live.state = 'online'; paintConn(); } };
  es.addEventListener('hello', () => { seen(); scheduleSoft(); });
  es.addEventListener('ping', (e) => { seen(); try { live.runnerBeatAt = JSON.parse(e.data).runner_beat_at; } catch { /* ignore */ } paintConn(); });
  es.addEventListener('event', () => { seen(); scheduleSoft(); });
  es.addEventListener('change', () => { seen(); scheduleSoft(); });
  es.onerror = () => { live.state = 'reconnecting'; paintConn(); };
}
export function connState() {
  if (live.state === 'online' && Date.now() - live.lastMsgAt > live.staleS * 1000) return 'stale';
  return live.state;
}
export function paintConn() {
  const el = document.getElementById('conn');
  if (el) el.outerHTML = connHtml().s;
}
export function connHtml() {
  const s = connState();
  const map = {
    online: ['', 'Server online'], connecting: ['warn', 'Connecting…'], reconnecting: ['warn', 'Reconnecting…'], stale: ['warn', 'Connection stale'],
  };
  const [cls, label] = map[s] ?? ['off', 'Offline'];
  return html`<span id="conn" class="conn ${cls}" role="status" title="Live updates from the server"><span class="dot${cls ? ' hollow' : ''}" aria-hidden="true"></span>${label}</span>`;
}

// ---------- global actions ----------
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-action]');
  if (!b) return;
  const act = b.dataset.action;
  if (act === 'reload') return render();
  if (act === 'new-project') return newProjectDialog((p) => go(`#/overview?p=${p.id}`));
  if (act === 'pause-all' || act === 'resume-all') {
    b.disabled = true;
    try { await api('/api/system/pause', { method: 'POST', body: { paused: act === 'pause-all' } }); toast(act === 'pause-all' ? 'New work paused. Running work finishes.' : 'Work resumed'); render({ soft: true }); }
    catch (err) { toast(err.message, true); b.disabled = false; }
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('drawer-root')) {
    const q = route().q; q.delete('agent');
    const base = location.hash.split('?')[0];
    location.hash = q.toString() ? `${base}?${q}` : base;
  }
});

window.addEventListener('hashchange', () => render());
setInterval(() => { paintConn(); }, 3000);
// Status is time-based (stale telemetry), so refresh the view periodically even without events.
setInterval(() => { if (document.visibilityState === 'visible') scheduleSoft(); }, 15000);

(async function boot() {
  try {
    const s = await (await fetch('/api/session')).json();
    if (s.demo) document.title = 'AI Manager · Demo';
  } catch { /* offline: render will show the error state */ }
  connect();
  render();
})();

export { esc };
