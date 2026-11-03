// Demo data. Only ever written to the separate demo database (DEMO_MODE=1).
// Everything here is sample content; no real project or customer data.
import { one, now, newId, getSettings } from './db.js';
import * as S from './store.js';

export function seedDemo(db, cfg) {
  if (!cfg.demo) throw new Error('Refusing to seed demo data outside demo mode');
  if (one(db, 'SELECT COUNT(*) AS n FROM projects').n) return false;
  S.seedTeam(db, getSettings(db));
  const agents = Object.fromEntries(S.listAgents(db).map((a) => [a.role, a]));
  const t0 = now();
  const min = 60_000;
  const day = 24 * 60 * min;

  const cp = S.createProject(db, cfg, { name: 'Client Portal', icon: 'window', priority: 3, max_concurrency: 2,
    brief: 'Self-serve portal where clients view invoices, pay, and download deliverables.',
    goals: 'Ship checkout and a product page; onboard the first five pilot clients.', budget_daily_usd: 5, budget_total_usd: 120 });
  const ba = S.createProject(db, cfg, { name: 'Booking App', icon: 'calendar', priority: 2, max_concurrency: 2,
    brief: 'Appointment booking for small studios.', goals: 'Validate pricing and collect beta feedback.', budget_daily_usd: 4 });
  const it = S.createProject(db, cfg, { name: 'Invoice Tool', icon: 'document', priority: 1, max_concurrency: 1,
    brief: 'Extract line items from supplier invoices.', goals: 'Prototype PDF parsing.' });
  S.setProjectStatus(db, it.id, 'paused');

  const assign = (role, ...projects) => projects.forEach((p) => S.setAssignment(db, agents[role].id, p.id, true));
  assign('Developer', cp, it);
  assign('Marketer', cp, ba);
  assign('Researcher', ba);
  assign('Intern', ba);

  const cpM1 = S.addMilestone(db, cp.id, { title: 'Complete checkout', phase: 'development', due_at: new Date(t0 + 2 * day + 3600_000).toISOString() });
  S.addMilestone(db, cp.id, { title: 'Publish product page', phase: 'storefront', due_at: new Date(t0 + 9 * day).toISOString() });
  S.addMilestone(db, cp.id, { title: 'Onboard pilot clients', phase: 'onboarding' });
  const baM1 = S.addMilestone(db, ba.id, { title: 'Validate pricing', phase: 'validation', due_at: new Date(t0 + 5 * day).toISOString() });
  S.addMilestone(db, ba.id, { title: 'Beta launch', phase: 'development' });
  S.addMilestone(db, it.id, { title: 'Parsing prototype', phase: 'development' });

  // Finished history so Latest work has content from the start.
  const history = [
    [cp, 'Developer', 'Update checkout form', 'Checkout updated', 6],
    [cp, 'Marketer', 'Draft launch copy outline', 'Launch copy drafted', 10],
    [ba, 'Researcher', 'Save pricing comparison sources', 'Pricing comparison saved', 13],
    [ba, 'Intern', 'Sort beta feedback by theme', 'Feedback sorted', 16],
    [cp, 'Developer', 'Set up payments sandbox', 'Payments sandbox ready', 48],
    [ba, 'Marketer', 'Draft waitlist email', 'Waitlist email drafted', 95],
  ];
  const costs = [1.15, 0.92, 1.38, 0, 0.71, 0.64];
  history.forEach(([p, role, title, summary, ago], i) => {
    const a = agents[role];
    const ts = t0 - ago * min;
    const tk = S.createTask(db, p.id, { title, role, assigned_agent_id: a.id, milestone_id: p === cp ? cpM1.id : baM1.id });
    db.prepare("UPDATE tasks SET state='completed', attempts=1, result_summary=?, completed_at=?, created_at=?, updated_at=? WHERE id=?")
      .run(summary, ts, ts - 20 * min, ts, tk.id);
    const runId = newId('run');
    db.prepare(`INSERT INTO runs(id, task_id, project_id, agent_id, kind, status, attempt, idempotency_key, provider_state, started_at, last_activity_at, last_activity, ended_at, summary)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(runId, tk.id, p.id, a.id, 'execute', 'succeeded', 1, `${tk.id}:execute:1`, 'responded', ts - 12 * min, ts, 'Writing output', ts, summary);
    S.recordUsage(db, { project_id: p.id, run_id: runId, agent_id: a.id, provider: a.provider, model: a.model,
      input_tokens: 4000 + i * 900, output_tokens: 1200 + i * 300, cost_usd: role === 'Intern' ? null : costs[i], cost_kind: role === 'Intern' ? 'local' : 'simulated', created_at: ts });
    S.addEvent(db, { ts, type: 'run.completed', project_id: p.id, agent_id: a.id, task_id: tk.id, run_id: runId, message: summary });
  });
  db.prepare("DELETE FROM events WHERE type = 'task.created'").run();

  // Live work the simulated runner will pick up.
  const checkout = S.createTask(db, cp.id, { title: 'Build checkout flow', short_label: 'Building checkout', role: 'Developer', priority: 1,
    milestone_id: cpM1.id, acceptance_criteria: 'Card payment succeeds in sandbox; failed payments show a clear error; tests pass.' });
  S.createTask(db, cp.id, { title: 'Write launch copy for the product page', short_label: 'Writing launch copy', role: 'Marketer', priority: 1,
    acceptance_criteria: 'Headline, three benefit blocks, FAQ. Draft only; not published.' });
  S.createTask(db, cp.id, { title: 'Add payment confirmation emails', short_label: 'Adding receipts', role: 'Developer', priority: 2,
    milestone_id: cpM1.id, depends_on: [checkout.id], acceptance_criteria: 'Receipt email renders and is sent in sandbox.' });
  const pricing = S.createTask(db, ba.id, { title: 'Compare competitor pricing', short_label: 'Comparing pricing', role: 'Researcher', priority: 1,
    milestone_id: baM1.id, acceptance_criteria: 'At least six competitors, sources cited, summary table.' });
  S.createTask(db, ba.id, { title: 'Draft pricing page', short_label: 'Drafting pricing page', role: 'Marketer', priority: 2, depends_on: [pricing.id] });
  S.createTask(db, it.id, { title: 'Parse invoice PDFs', short_label: 'Parsing invoices', role: 'Developer' });

  // One item already waiting for the Manager's review.
  const review = S.createTask(db, ba.id, { title: 'Summarize beta interviews', short_label: 'Summarizing interviews', role: 'Researcher', assigned_agent_id: agents.Researcher.id });
  db.prepare("UPDATE tasks SET state='awaiting_review', attempts=1, result_summary='Interview summary ready' WHERE id=?").run(review.id);
  // One blocked item so the attention indicator has something to show.
  const blocked = S.createTask(db, cp.id, { title: 'Choose a payment provider', short_label: 'Choosing payments', role: 'Researcher' });
  db.prepare("UPDATE tasks SET state='blocked', needs_owner=1, blocked_reason='Needs your decision: Stripe or Paddle for EU VAT handling.' WHERE id=?").run(blocked.id);
  db.prepare("DELETE FROM events WHERE type = 'task.created'").run();
  return true;
}
