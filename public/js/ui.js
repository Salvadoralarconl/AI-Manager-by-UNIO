// Shared UI helpers: API access, escaping, icons, formatting.

export async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'aim' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  if (r.status === 401) { location.href = '/'; throw new Error('Sign in required'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

// Tagged template that escapes interpolations unless they are raw() fragments.
export class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(s);
export function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => {
    if (Array.isArray(v)) out += v.map((x) => (x instanceof Raw ? x.s : esc(x))).join('');
    else if (v instanceof Raw) out += v.s;
    else if (v === null || v === undefined) out += '';
    else out += esc(v);
    out += strings[i + 1];
  });
  return raw(out);
}

const P = 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
export const ICONS = {
  window: `<svg viewBox="0 0 24 24" ${P}><rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3 9h18"/></svg>`,
  calendar: `<svg viewBox="0 0 24 24" ${P}><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>`,
  document: `<svg viewBox="0 0 24 24" ${P}><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 15.5h6M9 9h2"/></svg>`,
  cart: `<svg viewBox="0 0 24 24" ${P}><path d="M3 4h2.5l2 11h10l2-8H7"/><circle cx="9.5" cy="19" r="1.2"/><circle cx="16.5" cy="19" r="1.2"/></svg>`,
  chart: `<svg viewBox="0 0 24 24" ${P}><path d="M4 20V4M4 20h16M8 16v-4M12 16V8M16 16v-6"/></svg>`,
  chat: `<svg viewBox="0 0 24 24" ${P}><path d="M4 5h16v11H9l-5 4z"/></svg>`,
  box: `<svg viewBox="0 0 24 24" ${P}><path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9"/></svg>`,
  globe: `<svg viewBox="0 0 24 24" ${P}><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.5 2.5 14.5 0 17M12 3.5c-2.5 2.5-2.5 14.5 0 17"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" ${P}><path d="M12 5v14M5 12h14"/></svg>`,
  left: `<svg viewBox="0 0 24 24" ${P}><path d="m14.5 6-6 6 6 6"/></svg>`,
  right: `<svg viewBox="0 0 24 24" ${P}><path d="m9.5 6 6 6-6 6"/></svg>`,
  close: `<svg viewBox="0 0 24 24" ${P}><path d="M6 6l12 12M18 6 6 18"/></svg>`,
  home: `<svg viewBox="0 0 24 24" ${P}><path d="M4 10.5 12 4l8 6.5V20h-5.5v-5.5h-5V20H4z"/></svg>`,
  layers: `<svg viewBox="0 0 24 24" ${P}><path d="m12 4 8.5 4.5L12 13 3.5 8.5z"/><path d="m3.5 12.5 8.5 4.5 8.5-4.5M3.5 16.5 12 21l8.5-4.5"/></svg>`,
  team: `<svg viewBox="0 0 24 24" ${P}><circle cx="9" cy="8.5" r="3.5"/><path d="M3 19.5c.7-3.3 3-5 6-5s5.3 1.7 6 5"/><circle cx="17" cy="9.5" r="2.6"/><path d="M16.5 14.6c2.3.2 4 1.7 4.5 4.4"/></svg>`,
  pulse: `<svg viewBox="0 0 24 24" ${P}><path d="M3 12h4l2.5-6 4 13 2.5-7H21"/></svg>`,
  gear: `<svg viewBox="0 0 24 24" ${P}><circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M2.8 12h2.4M18.8 12h2.4M4.9 19.1l1.7-1.7M17.4 6.6l1.7-1.7"/><circle cx="12" cy="12" r="6.6"/></svg>`,
};
export const icon = (name) => raw(ICONS[name] ?? ICONS.window);

export const PROVIDER_LABEL = { openai: 'ChatGPT', anthropic: 'Claude', local: 'Home AI', simulated: 'Simulator' };
export const providerLabel = (a) => PROVIDER_LABEL[a.provider] ?? a.provider;

export const STATUS_LABEL = {
  working: 'Working', reviewing: 'Reviewing', available: 'Available', queued: 'Queued', blocked: 'Blocked', failed: 'Failed',
  paused: 'Paused', offline: 'Offline', unknown: 'Unknown',
  // task states
  assigned: 'Assigned', running: 'Running', awaiting_review: 'Awaiting review', completed: 'Completed', cancelled: 'Cancelled',
  // run states
  succeeded: 'Succeeded', interrupted: 'Interrupted',
  active: 'Active', archived: 'Archived',
};
export function status(s, label) {
  const hollow = ['offline', 'unknown', 'paused', 'cancelled', 'archived', 'interrupted', 'queued'].includes(s);
  return html`<span class="st st-${s}"><span class="dot${hollow ? ' hollow' : ''}" aria-hidden="true"></span>${label ?? STATUS_LABEL[s] ?? s}</span>`;
}

export function avatar(a, cls = '') {
  return html`<span class="av av-${a.color || 'green'} ${cls}" aria-hidden="true">${a.initials}</span>`;
}

export function clock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}
export function when(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return clock(ts);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + clock(ts);
}
export function ago(ts, now = Date.now()) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
export function dueIn(ts, now = Date.now()) {
  if (!ts) return '';
  const a = new Date(now); a.setHours(0, 0, 0, 0);
  const b = new Date(ts); b.setHours(0, 0, 0, 0);
  const days = Math.round((b - a) / 86400000);
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  if (days > 1) return `Due in ${days} days`;
  return `Overdue by ${-days} day${days === -1 ? '' : 's'}`;
}
export function money(n) {
  if (n === null || n === undefined) return '—';
  return `$${Number(n).toFixed(2)}`;
}
// Spend that is honest about where numbers come from.
export function spendLabel(sp) {
  if (!sp) return '';
  if (sp.billable > 0 || (!sp.simulated && !sp.local)) {
    const est = sp.estimated > 0 ? '≈' : '';
    return `${est}${money(sp.billable)} today${sp.unknown_count ? ' + unknown' : ''}`;
  }
  return `${money(sp.simulated)} simulated today`;
}

let toastTimer;
export function toast(msg, isErr = false) {
  const el = document.getElementById('toast');
  el.innerHTML = `<div class="toast${isErr ? ' err' : ''}">${esc(msg)}</div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.innerHTML = ''; }, 3200);
}

export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.multiple) out[el.name] = [...el.selectedOptions].map((o) => o.value);
    else out[el.name] = el.value;
  }
  return out;
}

// Modal dialog built on <dialog>. onSubmit returns a promise; errors stay in the dialog.
export function openDialog(title, bodyHtml, onSubmit, submitLabel = 'Save') {
  const overlay = document.getElementById('overlay');
  overlay.innerHTML = `<dialog aria-labelledby="dlg-title"><form method="dialog" class="form" novalidate>
    <h2 id="dlg-title">${esc(title)}</h2>${bodyHtml}<p class="err" role="alert"></p>
    <div class="foot"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary" type="submit">${esc(submitLabel)}</button></div>
  </form></dialog>`;
  const dlg = overlay.querySelector('dialog');
  const form = dlg.querySelector('form');
  const restore = document.activeElement;
  dlg.addEventListener('close', () => { overlay.innerHTML = ''; restore?.focus?.(); });
  dlg.querySelector('[data-x]').onclick = () => dlg.close();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await onSubmit(formData(form), form); dlg.close(); } catch (err) { form.querySelector('.err').textContent = err.message; }
  });
  dlg.showModal();
  return dlg;
}

export function confirmDialog(title, text, label = 'Confirm') {
  return new Promise((resolve) => {
    let ok = false;
    const dlg = openDialog(title, `<p class="prose">${esc(text)}</p>`, async () => { ok = true; }, label);
    dlg.addEventListener('close', () => resolve(ok));
  });
}
