// Intern evaluation: measure the home AI on small, checkable tasks before
// routing real work to it. Each task type has fixed cases with deterministic
// graders (no model judges, no paid calls). The result says, per task type,
// whether quality and speed justify local assignment. The owner decides.
//
// Usage:
//   const report = await evaluateIntern(createLocal(cfg), { model: 'llama3.1:8b' });
//   report.byType.classification.eligible  -> true/false, with reasons

export const EVAL_CASES = {
  extraction: [
    { prompt: 'Extract the email address. Reply with only the address.\n\nHi, reach Dana at dana.lee@example.org or call 555-0100.', check: out => /^dana\.lee@example\.org$/i.test(out.trim()) },
    { prompt: 'Extract the invoice total as a number with two decimals. Reply with only the number.\n\nItems: $12.00, $8.50. Tax $1.65. Total due: $22.15.', check: out => out.trim().replace(/^\$/, '') === '22.15' },
    { prompt: 'Extract the due date in YYYY-MM-DD. Reply with only the date.\n\nPlease pay by March 9, 2027.', check: out => out.trim() === '2027-03-09' },
  ],
  classification: [
    { prompt: 'Classify the support message as one of: billing, bug, feature. Reply with only the label.\n\n"I was charged twice this month."', check: out => /^billing\.?$/i.test(out.trim()) },
    { prompt: 'Classify the support message as one of: billing, bug, feature. Reply with only the label.\n\n"The export button crashes the app."', check: out => /^bug\.?$/i.test(out.trim()) },
    { prompt: 'Classify the support message as one of: billing, bug, feature. Reply with only the label.\n\n"Could you add dark mode?"', check: out => /^feature\.?$/i.test(out.trim()) },
  ],
  formatting: [
    { prompt: 'Convert to a JSON array of objects with keys "name" and "qty". Reply with only JSON.\n\napples: 3\npears: 5', check: out => jsonEq(out, [{ name: 'apples', qty: 3 }, { name: 'pears', qty: 5 }]) },
    { prompt: 'Rewrite as a Markdown bullet list, one item per line, nothing else.\n\nred, green, blue', check: out => { const l = out.trim().split('\n').map(x => x.trim()); return l.length === 3 && l.every(x => /^[-*] /.test(x)) && l.map(x => x.slice(2).trim()).join('|') === 'red|green|blue'; } },
  ],
  summarization: [
    { prompt: 'Summarize in one sentence under 25 words. It must mention the launch date.\n\nThe team finished the storefront. Payments were tested with three cards. Launch is set for June 2. Marketing copy still needs a review.',
      check: out => words(out) <= 25 && /june\s*2|2\s*june|06[-/]02/i.test(out) },
    { prompt: 'Summarize in one sentence under 20 words. It must mention that the bug is fixed.\n\nA customer reported checkout failing on Safari. The developer found a date-parsing issue, fixed it, and added a test.',
      check: out => words(out) <= 20 && /fix/i.test(out) },
  ],
};

export const DEFAULT_THRESHOLDS = { minPassRate: 0.9, maxMedianLatencyMs: 20_000, runsPerCase: 2 };

/**
 * @param {import('./adapter.js').Adapter} adapter  normally the local adapter
 * @param {{model:string, thresholds?:object, cases?:object, signal?:AbortSignal, now?:()=>number}} opts
 */
export async function evaluateIntern(adapter, { model, thresholds = {}, cases = EVAL_CASES, signal, now = Date.now } = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const byType = {};
  for (const [type, list] of Object.entries(cases)) {
    let passed = 0, attempts = 0, errors = 0;
    const latencies = [];
    const failures = [];
    for (const [i, c] of list.entries()) {
      for (let k = 0; k < t.runsPerCase; k++) {
        if (signal?.aborted) break;
        attempts++;
        const t0 = now();
        const res = await adapter.run({
          mode: 'execute', projectId: 'eval', taskId: `eval-${type}-${i}`, runId: `eval-${type}-${i}-${k}`, idempotencyKey: `eval-${type}-${i}-${k}`,
          model, system: 'You are a precise assistant. Follow the output format exactly.', messages: [{ role: 'user', content: c.prompt }],
          maxOutputTokens: 200, costLimitUsd: null, signal,
        });
        latencies.push(res.usage?.latencyMs ?? now() - t0);
        if (res.status !== 'succeeded') { errors++; failures.push({ case: i, error: res.error }); continue; }
        if (safeCheck(c.check, res.outputText)) passed++;
        else failures.push({ case: i, output: String(res.outputText).slice(0, 120) });
      }
    }
    const passRate = attempts ? passed / attempts : 0;
    const medianLatencyMs = median(latencies);
    const reasons = [];
    if (passRate < t.minPassRate) reasons.push(`pass rate ${(passRate * 100).toFixed(0)}% < ${(t.minPassRate * 100).toFixed(0)}%`);
    if (medianLatencyMs > t.maxMedianLatencyMs) reasons.push(`median ${Math.round(medianLatencyMs)}ms > ${t.maxMedianLatencyMs}ms`);
    if (errors) reasons.push(`${errors} failed call(s)`);
    byType[type] = {
      attempts, passed, passRate, errors, medianLatencyMs,
      // Share of outputs a reviewer would have to fix or redo: a proxy for review effort.
      reworkShare: attempts ? 1 - passRate : 1,
      eligible: attempts > 0 && reasons.length === 0, reasons, failures: failures.slice(0, 5),
    };
  }
  return { model, provider: adapter.id, at: new Date(now()).toISOString(), thresholds: t, byType };
}

function safeCheck(fn, out) { try { return Boolean(fn(String(out ?? ''))); } catch { return false; } }
function words(s) { return String(s).trim().split(/\s+/).filter(Boolean).length; }
function median(a) { if (!a.length) return Infinity; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function jsonEq(out, expected) {
  const m = String(out).match(/\[[\s\S]*\]/);
  try { return JSON.stringify(JSON.parse(m ? m[0] : out)) === JSON.stringify(expected); } catch { return false; }
}
