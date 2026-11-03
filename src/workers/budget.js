// Spending limits and usage roll-ups. Pure functions over plain records so the
// runner and the dashboard compute them the same way, with no model calls.
//
// Usage record shape (one per provider call, stored by the runner):
//   { at, projectId, taskId, runId, agentId, provider, model, inputTokens, outputTokens,
//     cachedInputTokens, cacheWriteTokens, costUsd, costKind }
// costKind: 'estimated' (tokens reported by the provider x our price table),
//           'unknown'   (call happened, tokens or price unavailable),
//           'local'     (home AI: no provider bill, compute not measured),
//           'simulated' (demo/simulator, never real money),
//           'reported'  (dollars taken from a provider billing report, if imported later).

const isMoney = k => k === 'estimated' || k === 'reported' || k === 'unknown';

/**
 * Decide whether a new call may start.
 * caps: { globalDailyUsd, projectDailyUsd, projectTotalUsd, runUsd } (null = no cap)
 * spent: { globalToday, projectToday, projectTotal } from settled records
 * reserved: { global, project } worst-case amounts held by calls already in flight
 * worstCase: this call's worst-case cost (pricing.worstCaseCostUsd), or null if unpriceable
 * Returns { ok, reason?, reserveUsd }.
 */
export function checkBudget({ caps = {}, spent = {}, reserved = {}, worstCase }) {
  const anyCap = ['globalDailyUsd', 'projectDailyUsd', 'projectTotalUsd', 'runUsd'].some(k => caps[k] != null);
  if (worstCase == null) {
    return anyCap ? { ok: false, reason: 'Cannot bound this call\'s cost (model has no price entry), so spending caps cannot be enforced.' } : { ok: true, reserveUsd: 0 };
  }
  const checks = [
    ['runUsd', 0, 'run limit'],
    ['globalDailyUsd', (spent.globalToday ?? 0) + (reserved.global ?? 0), 'daily limit'],
    ['projectDailyUsd', (spent.projectToday ?? 0) + (reserved.project ?? 0), 'project daily limit'],
    ['projectTotalUsd', (spent.projectTotal ?? 0) + (reserved.project ?? 0), 'project budget'],
  ];
  for (const [k, used, label] of checks) {
    if (caps[k] == null) continue;
    if (used + worstCase > caps[k]) {
      return { ok: false, reason: `Would exceed the ${label}: $${used.toFixed(2)} used or reserved + up to $${worstCase.toFixed(2)} for this call > $${Number(caps[k]).toFixed(2)}.` };
    }
  }
  return { ok: true, reserveUsd: worstCase };
}

/**
 * Totals for the dashboard. Keeps estimated dollars, unknown-cost calls and
 * local calls apart so nothing is shown as more certain (or cheaper) than it is.
 */
export function rollup(records, { groupBy } = {}) {
  const groups = new Map();
  for (const r of records) {
    const key = groupBy ? (typeof groupBy === 'function' ? groupBy(r) : r[groupBy]) : 'all';
    let g = groups.get(key);
    if (!g) groups.set(key, g = emptyGroup(key));
    g.calls++;
    g.inputTokens += r.inputTokens ?? 0;
    g.outputTokens += r.outputTokens ?? 0;
    g.cachedInputTokens += r.cachedInputTokens ?? 0;
    if (r.costKind === 'local') g.localCalls++;
    else if (r.costKind === 'simulated') g.simulatedCalls++;
    else if (isMoney(r.costKind) && r.costUsd != null) g.estimatedUsd += r.costUsd;
    else g.unknownCostCalls++;
  }
  for (const g of groups.values()) g.estimatedUsd = Math.round(g.estimatedUsd * 1e4) / 1e4;
  return groupBy ? [...groups.values()] : (groups.get('all') ?? emptyGroup('all'));
}

function emptyGroup(key) {
  return { key, estimatedUsd: 0, calls: 0, unknownCostCalls: 0, localCalls: 0, simulatedCalls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
}

/** Label for a dollar figure, e.g. "≈ $1.24", "≈ $1.24 + 2 unknown", "Local compute". */
export function costLabel(g) {
  if (!g || g.calls === 0) return '$0.00';
  const parts = [];
  if (g.calls > g.localCalls + g.simulatedCalls) parts.push(`≈ $${g.estimatedUsd.toFixed(2)}`);
  if (g.unknownCostCalls) parts.push(`${g.unknownCostCalls} unknown`);
  if (!parts.length && g.localCalls) return 'Local compute';
  if (!parts.length) return 'Simulated';
  return parts.join(' + ');
}
