// Settings: providers, models, scheduling, caps, permissions, freshness, auth, backup, Intern evaluation.
import { api, html, raw, status, when, money, toast, openDialog, esc } from './ui.js';
import { go, route } from './main.js';

export async function renderSettings(r, { soft } = {}) {
  // Avoid clobbering an edit in progress on live refresh.
  if (soft && document.querySelector('#settings-form')?.dataset.dirty) return undefined;
  const [s, evals] = await Promise.all([api('/api/settings'), api('/api/intern-evals')]);
  const st = s.settings;
  const prov = (k) => s.providers[k];
  return html`
  <header class="page-head"><div><h1>Settings</h1><div class="summary">${s.demo ? 'Demo database · ' : ''}Changes apply on the runner's next pass</div></div></header>
  <form id="settings-form" class="split split-even">
    <div>
      <div class="section"><h3>Provider connections</h3>
        <div class="kv">
          ${['openai', 'anthropic', 'local'].map((k) => html`<div>${prov(k).label}</div><div>${prov(k).configured ? status('active', k === 'local' ? 'Endpoint set' : 'Key set on server') : status('offline', 'Not configured')}</div>`)}
          <div>Paid execution</div><div>${s.paid_execution ? status('working', 'Enabled') : status('paused', 'Off')} <span class="muted">· PAID_EXECUTION_ENABLED</span></div>
          <div>Runner</div><div>${s.runner ? html`Last heartbeat ${when(s.runner.last_beat_at)}` : html`<span class="muted">Never reported</span>`}</div>
        </div>
        <p class="note">Keys and the home AI endpoint are read from the server's environment only. They are never shown here, logged, exported or sent to the browser. See docs/PROVIDERS.md for billing before enabling paid execution.</p>
      </div>
      <div class="section"><h3>Default models</h3><div class="form">
        <div class="row3">
          <label class="f">Manager (OpenAI)<input type="text" name="default_models.openai" value="${st.default_models.openai}"></label>
          <label class="f">Workers (Claude)<input type="text" name="default_models.anthropic" value="${st.default_models.anthropic}"></label>
          <label class="f">Intern (Home AI)<input type="text" name="default_models.local" value="${st.default_models.local}"></label>
        </div><p class="note">Used for new agents. Each agent can override its model in Team.</p></div></div>
      <div class="section"><h3>Scheduling and spending</h3><div class="form">
        <div class="row2">
          <label class="f">Global concurrent runs<input type="number" min="0" max="50" name="global_concurrency" value="${st.global_concurrency}"></label>
          <label class="f">Default per-run cap (USD)<input type="number" step="0.01" min="0" name="default_run_cap_usd" value="${st.default_run_cap_usd ?? ''}"></label>
        </div>
        <div class="row2">
          <label class="f">Daily cap, all projects (USD)<input type="number" step="0.01" min="0" name="daily_cap_usd" value="${st.daily_cap_usd ?? ''}"></label>
          <label class="f">Monthly cap, all projects (USD)<input type="number" step="0.01" min="0" name="monthly_cap_usd" value="${st.monthly_cap_usd ?? ''}"></label>
        </div>
        <p class="note">Each paid run reserves its cap before starting, so concurrent runs can't jointly exceed a limit. A request already in flight can still finish slightly above its estimate. Projects get capacity by fair share weighted by priority.</p>
      </div></div>
      <div class="section"><h3>Connection freshness</h3><div class="form"><div class="row3">
        <label class="f">Runner heartbeat stale after (s)<input type="number" min="5" name="heartbeat_stale_s" value="${st.heartbeat_stale_s}"></label>
        <label class="f">Run activity stale after (s)<input type="number" min="5" name="activity_stale_s" value="${st.activity_stale_s}"></label>
        <label class="f">Dashboard stream stale after (s)<input type="number" min="5" name="dashboard_stale_s" value="${st.dashboard_stale_s}"></label>
      </div><p class="note">Past these limits an agent shows Unknown with its last known activity instead of Working.</p></div></div>
    </div>
    <div class="vline" aria-hidden="true"></div>
    <div>
      <div class="section"><h3>Permissions</h3><div class="form">
        <label class="chk"><input type="checkbox" name="permissions.auto_assign_internal" ${st.permissions.auto_assign_internal ? 'checked' : ''}> Assign and run internal tasks without asking</label>
        <label class="chk"><input type="checkbox" name="permissions.allow_external_actions" ${st.permissions.allow_external_actions ? 'checked' : ''}> Allow external actions (outreach, publishing)</label>
        <label class="chk"><input type="checkbox" name="permissions.intern_reassign" ${st.permissions.intern_reassign ? 'checked' : ''}> Reassign Intern work to a Claude worker when the Intern is unavailable or fails</label>
        <div class="row3">
          <label class="f">Intern fallback role<input type="text" name="permissions.intern_fallback_role" value="${st.permissions.intern_fallback_role ?? 'Researcher'}"></label>
          <label class="f">Marketing<select name="permissions.marketing_mode">${modeOpts(st.permissions.marketing_mode)}</select></label>
          <label class="f">Sales<select name="permissions.sales_mode">${modeOpts(st.permissions.sales_mode)}</select></label>
        </div>
        <p class="note">Marketing and sales output stays as drafts until specific repeatable operations are authorized. External actions are not executed in this version.</p>
      </div></div>
      <div class="section"><h3>Authentication</h3><div class="kv">
        <div>Sign-in</div><div>${s.auth_enabled ? status('active', 'Password required') : status('blocked', 'Disabled (loopback only)')}</div>
        <div>Change password</div><div class="muted">Set OWNER_PASSWORD_HASH on the server (npm run hash-password) and restart.</div>
      </div>${s.auth_enabled ? html`<p class="note"><button type="button" class="textbtn sm" data-st="logout">Sign out</button></p>` : ''}</div>
      <div class="section"><h3>Backup and export</h3><div class="kv">
        <div>Database</div><div>${s.storage.database}</div>
        <div>Export</div><div><a href="/api/export" download="ai-manager-export.json">Download JSON export</a> <span class="muted">· records only, no secrets</span></div>
        <div>Full backup</div><div class="muted">deploy/backup.sh (database + project files). See docs/BACKUP.md.</div>
      </div></div>
      <div class="section"><h3>Intern evaluation</h3>
        <p class="note" style="margin:0 0 10px">The Intern only gets a task type after it passes an evaluation here (at least 5 samples).</p>
        ${evals.length ? html`<table class="mini-table tnum"><thead><tr><th>Task type</th><th class="num">Passed</th><th class="num">Avg s</th><th class="num">Review min</th><th>Decision</th><th></th></tr></thead><tbody>
          ${evals.map((e) => html`<tr><td>${e.task_type}</td><td class="num">${e.passed}/${e.samples}</td><td class="num">${e.avg_seconds ?? '—'}</td><td class="num">${e.review_minutes ?? '—'}</td>
          <td>${status(e.decision === 'approved' ? 'completed' : e.decision === 'rejected' ? 'failed' : 'queued', { approved: 'Approved', rejected: 'Rejected', not_evaluated: 'Not evaluated' }[e.decision])}</td>
          <td><button type="button" class="textbtn sm" data-st="eval" data-id="${e.id}">Record</button></td></tr>`)}</tbody></table>` : html`<p class="state-msg" style="padding:6px 0">No task types under evaluation.</p>`}
        <p class="note"><button type="button" class="textbtn sm" data-st="eval-new">Add task type</button></p>
      </div>
    </div>
  </form>
  <div style="position:sticky;bottom:calc(var(--dock-h) + var(--dock-bottom) + 12px);display:flex;justify-content:flex-end;margin-top:12px">
    <button class="btn primary" form="settings-form" type="submit">Save settings</button>
  </div>`;
}

function modeOpts(cur) {
  return raw([['draft_only', 'Drafts only'], ['authorized_operations', 'Authorized operations']]
    .map(([v, l]) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`).join(''));
}

const main = document.getElementById('main');
main.addEventListener('input', (e) => { const f = e.target.closest('#settings-form'); if (f) f.dataset.dirty = '1'; });
main.addEventListener('submit', async (e) => {
  if (e.target.id !== 'settings-form') return;
  e.preventDefault();
  const body = {};
  for (const el of e.target.elements) {
    if (!el.name) continue;
    const v = el.type === 'checkbox' ? el.checked : el.value;
    const [k, sub] = el.name.split('.');
    if (sub) (body[k] ??= {})[sub] = v;
    else body[k] = v === '' ? null : v;
  }
  try { await api('/api/settings', { method: 'PATCH', body }); delete e.target.dataset.dirty; toast('Settings saved'); go(location.hash); }
  catch (err) { toast(err.message, true); }
});
main.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-st]');
  if (!b || route().view !== 'settings') return;
  if (b.dataset.st === 'logout') { await api('/api/logout', { method: 'POST' }); location.href = '/'; }
  if (b.dataset.st === 'eval-new') openDialog('Add Intern task type', `<label class="f">Task type<input type="text" name="task_type" required placeholder="e.g. Classify feedback"></label>`,
    async (d) => { await api('/api/intern-evals', { method: 'POST', body: d }); go(location.hash); }, 'Add');
  if (b.dataset.st === 'eval') {
    const list = await api('/api/intern-evals');
    const ev = list.find((x) => x.id === b.dataset.id);
    openDialog(`Evaluate: ${ev.task_type}`, `<div class="row2">
      <label class="f">Samples run<input type="number" name="samples" min="0" value="${ev.samples}"></label>
      <label class="f">Samples passing review<input type="number" name="passed" min="0" value="${ev.passed}"></label></div>
      <div class="row2"><label class="f">Average seconds per item<input type="number" step="0.1" name="avg_seconds" value="${ev.avg_seconds ?? ''}"></label>
      <label class="f">Review minutes per item<input type="number" step="0.1" name="review_minutes" value="${ev.review_minutes ?? ''}"></label></div>
      <label class="f">Decision<select name="decision">${[['not_evaluated', 'Not evaluated'], ['approved', 'Approve for Intern'], ['rejected', 'Keep with Claude']].map(([v, l]) => `<option value="${v}" ${ev.decision === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="f">Notes<textarea name="notes">${esc(ev.notes)}</textarea></label>`,
    async (d) => {
      for (const k of ['avg_seconds', 'review_minutes']) d[k] = d[k] === '' ? null : Number(d[k]);
      await api(`/api/intern-evals/${ev.id}`, { method: 'PATCH', body: d }); go(location.hash);
    });
  }
});

export { money };
