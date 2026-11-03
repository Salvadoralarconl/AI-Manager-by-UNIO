// Deterministic simulated worker. Used only by agents whose provider is set to
// "simulated" (or in demo mode). It never makes network calls. Outcomes depend
// only on task text and attempt number, so tests and demos are reproducible.
//
// Markers in a task title steer outcomes for testing:
//   [fail]    execution fails on every attempt
//   [flaky]   execution fails on attempt 1, succeeds afterwards
//   [rework]  Manager asks for rework on the first review, approves after
//   [reject]  Manager always asks for rework (exercises the bounded loop)
//   [block]   Manager blocks the task (needs owner decision)
//   [slow]    takes 10x longer (exercises cancel and stale detection)
import crypto from 'node:crypto';

function hash(s) {
  return crypto.createHash('sha256').update(s).digest().readUInt32BE(0);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortErr());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(abortErr()); }, { once: true });
  });
}
function abortErr() { const e = new Error('Aborted'); e.name = 'AbortError'; return e; }

export function create(cfg = {}) {
  const speed = cfg.simSpeed > 0 ? cfg.simSpeed : 1;
  return {
    id: 'simulated',
    kinds: ['manager', 'worker'],
    async healthCheck() { return { ok: true, detail: 'Simulator (no provider calls)' }; },
    async run(req) {
      const title = req.task?.title ?? '';
      const label = req.task?.short_label || title;
      const seed = hash(`${req.taskId}:${req.mode}:${req.attempt ?? 1}`);
      const base = req.mode === 'review' ? 1200 : 2500 + (seed % 3000);
      const total = (title.includes('[slow]') ? base * 10 : base) / speed;
      const steps = req.mode === 'review'
        ? ['Reading output', 'Checking acceptance criteria']
        : ['Reading context', 'Working', 'Writing output'];
      req.onProviderState?.('requesting');
      for (const s of steps) {
        req.onActivity?.(s);
        await sleep(total / steps.length, req.signal);
      }
      req.onProviderState?.('responded');
      const inTok = 800 + (seed % 2400);
      const outTok = 300 + (seed % 1200);
      const usage = { inputTokens: inTok, outputTokens: outTok, cachedInputTokens: 0, cacheWriteTokens: 0,
        costUsd: +(inTok * 3e-6 + outTok * 15e-6).toFixed(4), costKind: 'simulated' };

      if (req.mode === 'review') {
        const round = req.reviewRound ?? 0;
        let verdict = 'approve';
        let notes = 'Meets the acceptance criteria.';
        if (title.includes('[block]')) { verdict = 'block'; notes = 'Needs an owner decision before continuing.'; }
        else if (title.includes('[reject]') || (title.includes('[rework]') && round === 0)) {
          verdict = 'rework'; notes = 'Acceptance criteria not fully met; tighten the output.';
        }
        const summary = { approve: `${label} approved`, rework: `${label} sent back`, block: `${label} needs you` }[verdict];
        return { status: 'succeeded', summary, review: { verdict, notes }, usage };
      }

      if (title.includes('[fail]') || (title.includes('[flaky]') && (req.attempt ?? 1) === 1)) {
        return { status: 'failed', summary: `${label} failed`, error: 'Simulated failure', retryable: true, usage };
      }
      const outputText = [
        `# ${title}`, '',
        '_Simulated output. No model was called._', '',
        '## Acceptance criteria', req.task?.acceptance_criteria || '(none given)', '',
        '## Result', `Deterministic placeholder for attempt ${req.attempt ?? 1}.`,
        req.reviewNotes ? `\n## Addressed review notes\n${req.reviewNotes}` : '',
      ].join('\n');
      return { status: 'succeeded', summary: doneSummary(label), outputText,
        outputName: `${slug(label)}.md`, usage };
    },
  };
}

function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'output'; }

// "Building checkout" -> "Checkout updated" style phrases for Latest work.
export function doneSummary(label) {
  const words = String(label).trim().split(/\s+/);
  if (words.length >= 2 && /ing$/i.test(words[0])) {
    const obj = words.slice(1).join(' ');
    const verb = words[0].toLowerCase();
    const past = { building: 'built', writing: 'drafted', comparing: 'compared', sorting: 'sorted', drafting: 'drafted',
      researching: 'researched', testing: 'tested', fixing: 'fixed', updating: 'updated', summarizing: 'summarized' }[verb]
      ?? verb.replace(/ing$/, 'ed');
    return `${obj[0].toUpperCase()}${obj.slice(1)} ${past}`;
  }
  return `${label} done`;
}
