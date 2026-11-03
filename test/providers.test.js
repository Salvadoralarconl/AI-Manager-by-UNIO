// Provider adapter tests. Every network call goes to an injected fake fetch;
// nothing here can reach a real provider or spend money.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create as createOpenAI } from '../src/workers/openai.js';
import { create as createAnthropic } from '../src/workers/anthropic.js';
import { create as createLocal, normalizeBase } from '../src/workers/local.js';
import { assertAdapter } from '../src/workers/adapter.js';
import { costFromBuckets, worstCaseCostUsd, pricing } from '../src/workers/pricing.js';
import { checkBudget, rollup, costLabel } from '../src/workers/budget.js';
import { evaluateIntern, EVAL_CASES } from '../src/workers/intern-eval.js';

const OPENAI_KEY = 'sk-test-openai-1234567890';
const ANTHROPIC_KEY = 'sk-ant-test-1234567890';
const baseCfg = (o = {}) => ({ paidExecution: true, secrets: { openai: OPENAI_KEY, anthropic: ANTHROPIC_KEY, local: '' }, localAiUrl: 'http://homebox:11434', ...o });

function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    return handler(url, init, calls.length);
  };
  f.calls = calls;
  return f;
}
const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
const sse = (events, headers = {}) => new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } });

const req = (o = {}) => ({
  mode: 'execute', projectId: 'p_shop', taskId: 't_1', runId: 'r_1', idempotencyKey: 't_1:execute:1', model: 'claude-opus-5-5',
  system: 'You are the Developer for project Shop.', messages: [{ role: 'user', content: 'Write checkout notes.' }],
  maxOutputTokens: 2000, costLimitUsd: null, signal: undefined, onActivity: () => {}, onProviderState: () => {}, ...o,
});

// ---------- gates: no request is ever sent ----------

for (const [name, mk, model] of [['openai', createOpenAI, 'gpt-6.1-sol'], ['anthropic', createAnthropic, 'claude-opus-5-5']]) {
  test(`${name}: paid execution off sends nothing`, async () => {
    const f = fakeFetch(() => { throw new Error('must not be called'); });
    const r = await mk(baseCfg({ paidExecution: false }), { fetch: f }).run(req({ model }));
    assert.equal(r.status, 'failed'); assert.equal(r.retryable, false); assert.equal(f.calls.length, 0);
    assert.match(r.error, /No request was sent/);
  });
  test(`${name}: missing key sends nothing`, async () => {
    const f = fakeFetch(() => { throw new Error('must not be called'); });
    const r = await mk(baseCfg({ secrets: {} }), { fetch: f }).run(req({ model }));
    assert.equal(r.summary, 'Provider not connected'); assert.equal(f.calls.length, 0);
  });
  test(`${name}: worst case over run limit sends nothing`, async () => {
    const f = fakeFetch(() => { throw new Error('must not be called'); });
    const r = await mk(baseCfg(), { fetch: f }).run(req({ model, maxOutputTokens: 100_000, costLimitUsd: 0.05 }));
    assert.equal(r.summary, 'Over run budget'); assert.equal(f.calls.length, 0);
  });
  test(`${name}: unpriced model with a cost limit sends nothing`, async () => {
    const f = fakeFetch(() => { throw new Error('must not be called'); });
    const r = await mk(baseCfg(), { fetch: f }).run(req({ model: 'mystery-model', costLimitUsd: 1 }));
    assert.equal(r.summary, 'Model price unknown'); assert.equal(f.calls.length, 0);
  });
  test(`${name}: implements the adapter interface`, () => { assertAdapter(mk(baseCfg())); });
}

// ---------- OpenAI Manager ----------

const openaiResponse = (o = {}) => ({
  id: 'resp_abc', object: 'response', status: 'completed', model: 'gpt-6.1-sol',
  output: [{ type: 'reasoning', id: 'rs_1', summary: [] }, { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '# Plan for checkout\nStep 1...', annotations: [] }] }],
  usage: { input_tokens: 12000, input_tokens_details: { cached_tokens: 7000, cache_write_tokens: 4000 }, output_tokens: 800, output_tokens_details: { reasoning_tokens: 300 }, total_tokens: 12800 },
  ...o,
});

test('openai: builds a Responses API request scoped to the project', async () => {
  const f = fakeFetch(() => json(openaiResponse()));
  const r = await createOpenAI(baseCfg(), { fetch: f }).run(req({ model: 'gpt-6.1-sol', system: 'Manager instructions' }));
  const c = f.calls[0];
  assert.equal(c.url, 'https://api.openai.com/v1/responses');
  assert.equal(c.init.headers.authorization, `Bearer ${OPENAI_KEY}`);
  assert.equal(c.body.instructions, 'Manager instructions');
  assert.equal(c.body.store, false);
  assert.equal(c.body.prompt_cache_key, 'project:p_shop');
  assert.deepEqual(c.body.metadata, { project_id: 'p_shop', task_id: 't_1', run_id: 'r_1' });
  assert.equal(r.status, 'succeeded');
  assert.equal(r.outputText, '# Plan for checkout\nStep 1...');
  assert.equal(r.summary, 'Plan for checkout');
  assert.equal(r.providerRequestId, 'resp_abc');
});

test('openai: usage treats cached and cache-write tokens as parts of input', async () => {
  const f = fakeFetch(() => json(openaiResponse()));
  const r = await createOpenAI(baseCfg(), { fetch: f }).run(req({ model: 'gpt-6.1-sol' }));
  assert.equal(r.usage.inputTokens, 12000);
  assert.equal(r.usage.cachedInputTokens, 7000);
  assert.equal(r.usage.cacheWriteTokens, 4000);
  assert.equal(r.usage.reasoningTokens, 300);
  assert.equal(r.usage.costKind, 'estimated');
  // 1000 uncached x $2 + 7000 cached x $0.10 + 4000 writes x $2.50 + 800 out x $10, per million
  assert.equal(r.usage.costUsd, (1000 * 2 + 7000 * 0.10 + 4000 * 2.5 + 800 * 10) / 1e6);
});

test('openai: dated snapshot priced as base model; unknown model is "unknown" cost', async () => {
  let r = await createOpenAI(baseCfg(), { fetch: fakeFetch(() => json(openaiResponse({ model: 'gpt-6.1-sol-2026-09-01' }))) }).run(req({ model: 'gpt-6.1-sol' }));
  assert.equal(r.usage.costKind, 'estimated');
  r = await createOpenAI(baseCfg(), { fetch: fakeFetch(() => json(openaiResponse({ model: 'gpt-future' }))) }).run(req({ model: 'gpt-future' }));
  assert.equal(r.usage.costKind, 'unknown'); assert.equal(r.usage.costUsd, null); assert.equal(r.usage.outputTokens, 800);
});

test('openai: review mode uses strict JSON schema and returns a verdict', async () => {
  const f = fakeFetch(() => json(openaiResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: '{"verdict":"rework","notes":"Add error states."}' }] }] })));
  const r = await createOpenAI(baseCfg(), { fetch: f }).run(req({ mode: 'review', model: 'gpt-6.1-sol' }));
  assert.equal(f.calls[0].body.text.format.type, 'json_schema');
  assert.equal(f.calls[0].body.text.format.strict, true);
  assert.deepEqual(r.review, { verdict: 'rework', notes: 'Add error states.' });
  assert.equal(r.summary, 'Sent back for rework');
});

test('openai: unreadable review fails and is retryable', async () => {
  const f = fakeFetch(() => json(openaiResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'looks fine' }] }] })));
  const r = await createOpenAI(baseCfg(), { fetch: f }).run(req({ mode: 'review', model: 'gpt-6.1-sol' }));
  assert.equal(r.status, 'failed'); assert.equal(r.retryable, true);
});

test('openai: incomplete and refusal are failures that keep usage', async () => {
  let r = await createOpenAI(baseCfg(), { fetch: fakeFetch(() => json(openaiResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }))) }).run(req({ model: 'gpt-6.1-sol' }));
  assert.equal(r.summary, 'Hit output limit'); assert.equal(r.retryable, false); assert.ok(r.usage.costUsd > 0);
  r = await createOpenAI(baseCfg(), { fetch: fakeFetch(() => json(openaiResponse({ output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Cannot help.' }] }] }))) }).run(req({ model: 'gpt-6.1-sol' }));
  assert.equal(r.summary, 'Model declined');
});

test('openai: HTTP errors are classified and redacted', async () => {
  const cases = [
    [401, { error: { message: `Incorrect API key provided: ${OPENAI_KEY}` } }, false, 'API key rejected'],
    [429, { error: { message: 'Rate limit reached' } }, true, 'Rate limited or out of credit'],
    [429, { error: { message: 'You exceeded your current quota, please check your plan and billing details.' } }, false, 'Rate limited or out of credit'],
    [500, { error: { message: 'boom' } }, true, 'Provider error'],
    [400, { error: { message: 'bad param' } }, false, 'Request rejected'],
  ];
  for (const [status, body, retryable, summary] of cases) {
    const r = await createOpenAI(baseCfg(), { fetch: fakeFetch(() => json(body, status, { 'x-request-id': 'req_9' })) }).run(req({ model: 'gpt-6.1-sol' }));
    assert.equal(r.status, 'failed'); assert.equal(r.retryable, retryable, `${status}`); assert.equal(r.summary, summary);
    assert.ok(!r.error.includes(OPENAI_KEY), 'key must be redacted');
  }
});

test('openai: network failure is retryable with outcome unknown', async () => {
  const r = await createOpenAI(baseCfg(), { fetch: fakeFetch(() => { throw new TypeError('fetch failed'); }) }).run(req({ model: 'gpt-6.1-sol' }));
  assert.equal(r.retryable, true); assert.equal(r.outcomeUnknown, true); assert.equal(r.usage.costKind, 'unknown');
});

test('openai: makes exactly one call (never retries itself)', async () => {
  const f = fakeFetch(() => json({ error: { message: 'boom' } }, 503));
  await createOpenAI(baseCfg(), { fetch: f }).run(req({ model: 'gpt-6.1-sol' }));
  assert.equal(f.calls.length, 1);
});

test('openai: healthCheck lists models (free) and reports bad keys', async () => {
  let f = fakeFetch(() => json({ data: [] }));
  assert.equal((await createOpenAI(baseCfg(), { fetch: f }).healthCheck()).ok, true);
  assert.equal(f.calls[0].url, 'https://api.openai.com/v1/models'); assert.equal(f.calls[0].init.method, 'GET');
  f = fakeFetch(() => json({}, 401));
  assert.match((await createOpenAI(baseCfg(), { fetch: f }).healthCheck()).detail, /rejected/);
  assert.equal((await createOpenAI(baseCfg({ secrets: {} })).healthCheck()).ok, false);
});

// ---------- Anthropic workers ----------

const claudeEvents = ({ stop = 'end_turn', text = ['## Checkout notes\n', 'Done.'], model = 'claude-opus-5-5', usageStart, usageEnd } = {}) => [
  { type: 'message_start', message: { id: 'msg_01', model, usage: usageStart ?? { input_tokens: 300, cache_creation_input_tokens: 5000, cache_read_input_tokens: 20000, cache_creation: { ephemeral_5m_input_tokens: 5000, ephemeral_1h_input_tokens: 0 }, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'private reasoning' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  ...text.map(t => ({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: t } })),
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: stop }, usage: usageEnd ?? { output_tokens: 1500 } },
  { type: 'message_stop' },
];

test('anthropic: builds a streamed Messages API request with cached system prompt', async () => {
  const f = fakeFetch(() => sse(claudeEvents(), { 'request-id': 'req_011' }));
  const acts = [];
  const r = await createAnthropic(baseCfg(), { fetch: f }).run(req({ onActivity: a => acts.push(a) }));
  const c = f.calls[0];
  assert.equal(c.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(c.init.headers['x-api-key'], ANTHROPIC_KEY);
  assert.equal(c.init.headers['anthropic-version'], '2026-10-21');
  assert.equal(c.body.stream, true);
  assert.equal(c.body.max_tokens, 2000);
  assert.deepEqual(c.body.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(c.body.temperature, undefined);
  assert.equal(c.body.output_config.effort, 'high');
  assert.equal(r.status, 'succeeded');
  assert.equal(r.outputText, '## Checkout notes\nDone.');
  assert.ok(!r.outputText.includes('private reasoning'), 'thinking must never be saved');
  assert.equal(r.summary, 'Checkout notes');
  assert.equal(r.providerRequestId, 'msg_01');
  assert.ok(acts.includes('Receiving output'));
});

test('anthropic: usage sums uncached, cache reads and writes; cost from billed model', async () => {
  const r = await createAnthropic(baseCfg(), { fetch: fakeFetch(() => sse(claudeEvents())) }).run(req());
  assert.equal(r.usage.inputTokens, 300 + 20000 + 5000);
  assert.equal(r.usage.cachedInputTokens, 20000);
  assert.equal(r.usage.cacheWriteTokens, 5000);
  assert.equal(r.usage.outputTokens, 1500);
  assert.equal(r.usage.costUsd, (300 * 4 + 20000 * 0.20 + 5000 * 5 + 1500 * 20) / 1e6);
  assert.equal(r.usage.costKind, 'estimated');
  const r2 = await createAnthropic(baseCfg(), { fetch: fakeFetch(() => sse(claudeEvents({ model: 'claude-sonnet-5-5' }))) }).run(req());
  assert.equal(r2.usage.billedModel, 'claude-sonnet-5-5');
  assert.equal(r2.usage.costUsd, (300 * 2 + 20000 * 0.10 + 5000 * 2.5 + 1500 * 10) / 1e6);
});

test('anthropic: refusal, max_tokens and stream error are failures', async () => {
  let r = await createAnthropic(baseCfg(), { fetch: fakeFetch(() => sse(claudeEvents({ stop: 'refusal' }))) }).run(req());
  assert.equal(r.summary, 'Model declined'); assert.equal(r.retryable, false);
  r = await createAnthropic(baseCfg(), { fetch: fakeFetch(() => sse(claudeEvents({ stop: 'max_tokens' }))) }).run(req());
  assert.equal(r.summary, 'Hit output limit'); assert.ok(r.usage.costUsd > 0);
  r = await createAnthropic(baseCfg(), { fetch: fakeFetch(() => sse([claudeEvents()[0], { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }])) }).run(req());
  assert.equal(r.summary, 'Provider error'); assert.equal(r.retryable, true);
});

test('anthropic: HTTP 401 is not retryable and key is redacted', async () => {
  const r = await createAnthropic(baseCfg(), { fetch: fakeFetch(() => json({ type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${ANTHROPIC_KEY}` } }, 401)) }).run(req());
  assert.equal(r.retryable, false); assert.ok(!r.error.includes(ANTHROPIC_KEY));
});

test('anthropic: cancel mid-stream reports cancelled with partial usage', async () => {
  const ac = new AbortController();
  const enc = new TextEncoder();
  const first = claudeEvents()[0];
  const body = new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(enc.encode(`event: message_start\ndata: ${JSON.stringify(first)}\n\n`));
      ac.signal.addEventListener('abort', () => ctrl.error(new DOMException('aborted', 'AbortError')));
    },
  });
  const p = createAnthropic(baseCfg(), { fetch: fakeFetch(() => new Response(body, { status: 200 })) }).run(req({ signal: ac.signal }));
  setTimeout(() => ac.abort(), 20);
  const r = await p;
  assert.equal(r.summary, 'Cancelled'); assert.equal(r.usage.inputTokens, 25300);
});

test('anthropic: workers do not review', async () => {
  const f = fakeFetch(() => { throw new Error('must not be called'); });
  const r = await createAnthropic(baseCfg(), { fetch: f }).run(req({ mode: 'review' }));
  assert.equal(r.status, 'failed'); assert.equal(f.calls.length, 0);
});

test('anthropic: healthCheck uses the free models endpoint', async () => {
  const f = fakeFetch(() => json({ data: [] }));
  assert.equal((await createAnthropic(baseCfg(), { fetch: f }).healthCheck()).ok, true);
  assert.match(f.calls[0].url, /\/v1\/models/); assert.equal(f.calls[0].init.method, 'GET');
});

// ---------- Local Intern ----------

const chat = (text, o = {}) => ({ id: 'chatcmpl-1', model: 'llama3.1:8b', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 8 }, ...o });

test('local: runs without paid execution and records local cost', async () => {
  const f = fakeFetch(() => json(chat('billing')));
  const r = await createLocal(baseCfg({ paidExecution: false }), { fetch: f }).run(req({ model: 'llama3.1:8b' }));
  assert.equal(f.calls[0].url, 'http://homebox:11434/v1/chat/completions');
  assert.equal(f.calls[0].body.messages[0].role, 'system');
  assert.equal(r.status, 'succeeded');
  assert.equal(r.usage.costKind, 'local'); assert.equal(r.usage.costUsd, null);
  assert.equal(r.usage.inputTokens, 40);
});

test('local: base URL normalisation', () => {
  assert.equal(normalizeBase('http://h:1234/v1/'), 'http://h:1234/v1');
  assert.equal(normalizeBase('http://h:11434'), 'http://h:11434/v1');
});

test('local: not configured, unreachable, length-limited', async () => {
  let r = await createLocal(baseCfg({ localAiUrl: '' })).run(req());
  assert.equal(r.summary, 'Home AI not connected');
  r = await createLocal(baseCfg(), { fetch: fakeFetch(() => { throw new TypeError('ECONNREFUSED'); }) }).run(req());
  assert.equal(r.status, 'failed'); assert.equal(r.retryable, true); assert.equal(r.usage.costKind, 'local');
  r = await createLocal(baseCfg(), { fetch: fakeFetch(() => json(chat('partial', { choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] }))) }).run(req());
  assert.equal(r.summary, 'Hit output limit');
});

test('local: healthCheck lists models', async () => {
  const h = await createLocal(baseCfg(), { fetch: fakeFetch(() => json({ data: [{ id: 'llama3.1:8b' }] })) }).healthCheck();
  assert.equal(h.ok, true); assert.deepEqual(h.models, ['llama3.1:8b']);
});

// ---------- Intern evaluation ----------

test('intern eval: perfect model is eligible everywhere; bad one is not', async () => {
  const answers = new Map([
    ['dana', 'dana.lee@example.org'], ['invoice', '22.15'], ['due date', '2027-03-09'],
    ['charged twice', 'billing'], ['crashes', 'bug'], ['dark mode', 'feature'],
    ['JSON array', '[{"name":"apples","qty":3},{"name":"pears","qty":5}]'], ['bullet', '- red\n- green\n- blue'],
    ['launch date', 'The storefront is done and launches June 2.'], ['bug is fixed', 'The Safari checkout bug is fixed and tested.'],
  ]);
  const good = { id: 'local', async run(r) {
    const p = r.messages[0].content;
    const hit = [...answers.entries()].find(([k]) => p.toLowerCase().includes(k.toLowerCase()));
    return { status: 'succeeded', outputText: hit ? hit[1] : '?', usage: { costKind: 'local', latencyMs: 500 } };
  } };
  const rep = await evaluateIntern(good, { model: 'm' });
  for (const t of Object.keys(EVAL_CASES)) assert.equal(rep.byType[t].eligible, true, `${t}: ${rep.byType[t].reasons}`);

  const bad = { id: 'local', async run() { return { status: 'succeeded', outputText: 'I think it might be billing, maybe.', usage: { costKind: 'local', latencyMs: 30_000 } }; } };
  const rep2 = await evaluateIntern(bad, { model: 'm' });
  assert.equal(rep2.byType.classification.eligible, false);
  assert.ok(rep2.byType.classification.reasons.some(x => /median/.test(x)));
});

// ---------- pricing and budgets ----------

test('pricing: Haiku long-prompt tier applies over 100k prompt tokens', () => {
  const short = costFromBuckets('claude-haiku-5-5', { uncachedInputTokens: 100_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
  const long = costFromBuckets('claude-haiku-5-5', { uncachedInputTokens: 100_001, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
  assert.equal(short, 0.01); assert.ok(long > 0.05);
});

test('pricing: worst case always >= actual for the same request', () => {
  const r = req({ system: 'x'.repeat(30_000), maxOutputTokens: 4000 });
  const worst = worstCaseCostUsd('claude-opus-5-5', r);
  const actual = costFromBuckets('claude-opus-5-5', { uncachedInputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 30_000 / 3.5, outputTokens: 4000 });
  assert.ok(worst >= actual);
  for (const m of Object.keys(pricing)) assert.ok(worstCaseCostUsd(m, r) > 0);
  assert.equal(worstCaseCostUsd('nope', r), null);
});

test('budget: reservations for in-flight calls count against caps', () => {
  const caps = { globalDailyUsd: 5, projectDailyUsd: 2 };
  assert.equal(checkBudget({ caps, spent: { globalToday: 1, projectToday: 1 }, reserved: { global: 0, project: 0 }, worstCase: 0.5 }).ok, true);
  const no = checkBudget({ caps, spent: { globalToday: 1, projectToday: 1 }, reserved: { global: 0, project: 0.8 }, worstCase: 0.5 });
  assert.equal(no.ok, false); assert.match(no.reason, /project daily limit/);
  assert.equal(checkBudget({ caps, worstCase: null }).ok, false);
  assert.equal(checkBudget({ caps: {}, worstCase: null }).ok, true);
});

test('budget: rollup keeps estimated, unknown, local and simulated apart', () => {
  const recs = [
    { projectId: 'a', costKind: 'estimated', costUsd: 0.5, inputTokens: 10, outputTokens: 5 },
    { projectId: 'a', costKind: 'unknown', costUsd: null },
    { projectId: 'b', costKind: 'local', costUsd: null, inputTokens: 40 },
    { projectId: 'b', costKind: 'simulated', costUsd: 0 },
  ];
  const all = rollup(recs);
  assert.equal(all.estimatedUsd, 0.5); assert.equal(all.unknownCostCalls, 1); assert.equal(all.localCalls, 1); assert.equal(all.simulatedCalls, 1);
  assert.equal(costLabel(all), '≈ $0.50 + 1 unknown');
  const byP = rollup(recs, { groupBy: 'projectId' });
  assert.equal(costLabel(byP.find(g => g.key === 'b')), 'Local compute');
  assert.equal(costLabel(rollup([])), '$0.00');
});
