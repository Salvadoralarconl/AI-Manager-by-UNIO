// Anthropic adapter, used by the Claude workers (Developer, Researcher, Marketer).
// Integration: Claude Messages API (POST /v1/messages), API-key auth, streamed,
// billed per token to the Claude Console (API) account. A Claude Pro/Max
// subscription does not pay for these calls.
//
// Streaming is used so long outputs never hit HTTP timeouts and so the runner
// gets real "still receiving" activity instead of a silent wait.
import { costFromBuckets } from './pricing.js';
import { emptyUsage, failed, httpFailure, paidGate, sendJson, slug, summarize } from './http.js';
import { redact } from '../config.js';

const DEFAULT_BASE = 'https://api.anthropic.com/v1';
const API_VERSION = '2026-10-21';

/** @returns {import('./adapter.js').Adapter} */
export function create(cfg, { fetch: fetchImpl = globalThis.fetch, baseUrl = cfg.anthropicBaseUrl || DEFAULT_BASE } = {}) {
  const key = () => cfg.secrets?.anthropic;
  const headers = () => ({ 'x-api-key': key(), 'anthropic-version': API_VERSION });

  return {
    id: 'anthropic',
    kinds: ['worker'],

    // Listing models is free.
    async healthCheck() {
      if (!key()) return { ok: false, detail: 'No Anthropic API key configured' };
      const r = await sendJson(fetchImpl, `${baseUrl}/models?limit=1`, { method: 'GET', headers: headers(), signal: AbortSignal.timeout(10_000) });
      if (r.ok) return { ok: true, detail: 'Claude API reachable, key accepted' };
      if (r.kind === 'http') return { ok: false, detail: r.status === 401 ? 'Anthropic rejected the API key' : `Anthropic returned HTTP ${r.status}` };
      return { ok: false, detail: 'Claude API unreachable' };
    },

    async run(req) {
      if (req.mode === 'review') return failed('Not a reviewer', 'Claude workers do not review; the Manager (OpenAI) does.');
      const gate = paidGate(cfg, 'anthropic', req);
      if (gate) return gate;

      const body = {
        model: req.model,
        max_tokens: req.maxOutputTokens,
        // The system prompt holds agent instructions + this project's stored context.
        // It is the stable prefix, so cache it: repeat runs on the same project read it at a fraction of the price.
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages: req.messages.map(m => ({ role: m.role, content: m.content })),
        output_config: { effort: cfg.anthropicEffort || 'high' },
        stream: true,
      };

      req.onActivity?.('Requesting model');
      req.onProviderState?.('requesting');
      let res;
      try {
        res = await fetchImpl(`${baseUrl}/messages`, {
          method: 'POST', headers: { ...headers(), 'content-type': 'application/json' }, body: JSON.stringify(body), signal: req.signal,
        });
      } catch (err) {
        req.onProviderState?.('error');
        const aborted = req.signal?.aborted || err?.name === 'AbortError';
        return httpFailure(cfg, 'anthropic', aborted ? { kind: 'aborted' } : { kind: 'network', message: err?.message ?? String(err) });
      }
      const requestId = res.headers?.get?.('request-id') ?? undefined;
      if (!res.ok) {
        req.onProviderState?.('error');
        const text = await res.text().catch(() => '');
        let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
        return httpFailure(cfg, 'anthropic', { kind: 'http', status: res.status, json, text, headers: res.headers }, requestId);
      }
      req.onProviderState?.('responded');

      const acc = { id: undefined, model: req.model, text: '', stop: null, usage: {}, error: null };
      try {
        await readStream(res, ev => applyEvent(acc, ev, req));
      } catch (err) {
        const usage = usageFrom(acc, cfg);
        if (req.signal?.aborted || err?.name === 'AbortError') {
          return failed('Cancelled', 'Cancelled while Claude was writing. Tokens generated so far are billed.', { usage, providerRequestId: acc.id ?? requestId });
        }
        return failed('Stream interrupted', redact(`Connection dropped mid-response: ${err?.message ?? err}. Tokens generated so far are billed.`, cfg),
          { retryable: true, usage, providerRequestId: acc.id ?? requestId });
      }

      const usage = usageFrom(acc, cfg);
      const providerRequestId = acc.id ?? requestId;
      if (acc.error) {
        const overloaded = /overloaded|api_error/.test(acc.error.type ?? '');
        return failed('Provider error', redact(`Claude stream error: ${acc.error.type}: ${acc.error.message ?? ''}`, cfg), { retryable: overloaded, usage, providerRequestId });
      }
      if (acc.stop === 'refusal') return failed('Model declined', 'Claude declined this request (stop_reason: refusal).', { retryable: false, usage, providerRequestId });
      if (acc.stop === 'max_tokens' || acc.stop === 'model_context_window_exceeded') {
        return failed('Hit output limit', `Claude stopped at the output limit (${acc.stop}). Partial output was not saved.`, { retryable: false, usage, providerRequestId, partialText: acc.text });
      }
      if (acc.stop !== 'end_turn' && acc.stop !== 'stop_sequence') {
        return failed('Response incomplete', `Unexpected stop reason: ${acc.stop ?? 'none'}.`, { retryable: false, usage, providerRequestId, partialText: acc.text });
      }
      req.onActivity?.('Writing output');
      return {
        status: 'succeeded', summary: summarize(acc.text, 'Deliverable saved'), outputText: acc.text,
        outputName: `${slug(summarize(acc.text, req.taskId))}.md`, usage, providerRequestId,
      };
    },
  };
}

function applyEvent(acc, ev, req) {
  switch (ev.type) {
    case 'message_start':
      acc.id = ev.message?.id; acc.model = ev.message?.model ?? acc.model;
      Object.assign(acc.usage, ev.message?.usage ?? {});
      acc.lastActivity = Date.now();
      req.onActivity?.('Receiving output');
      break;
    case 'content_block_delta':
      // Only visible text is kept. Thinking blocks are never stored or shown.
      if (ev.delta?.type === 'text_delta') acc.text += ev.delta.text;
      // Long generations: report real liveness every ~15s so the dashboard does not go stale.
      if (Date.now() - (acc.lastActivity ?? 0) > 15_000) { acc.lastActivity = Date.now(); req.onActivity?.('Receiving output'); }
      break;
    case 'message_delta':
      if (ev.delta?.stop_reason) acc.stop = ev.delta.stop_reason;
      // message_delta usage counts are cumulative; overwrite what we have.
      for (const [k, v] of Object.entries(ev.usage ?? {})) if (v != null) acc.usage[k] = v;
      break;
    case 'error':
      acc.error = ev.error ?? { type: 'error' };
      break;
  }
}

// Minimal server-sent-events reader over a fetch Response body.
async function readStream(res, onEvent) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (!data) continue;
      let ev; try { ev = JSON.parse(data); } catch { continue; }
      onEvent(ev);
    }
  }
}

// Anthropic: input_tokens is only the uncached remainder; cache reads and writes are reported separately.
export function usageFrom(acc, cfg) {
  const u = acc.usage ?? {};
  if (u.input_tokens == null && u.output_tokens == null) return emptyUsage('unknown', null);
  const uncached = u.input_tokens ?? 0;
  const read = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const cost = costFromBuckets(acc.model, {
    uncachedInputTokens: uncached, cachedInputTokens: read, cacheWriteTokens: write - write1h, cacheWrite1hTokens: write1h, outputTokens: output,
  }, cfg.pricingOverrides);
  return {
    inputTokens: uncached + read + write, outputTokens: output, cachedInputTokens: read, cacheWriteTokens: write,
    costUsd: cost, costKind: cost == null ? 'unknown' : 'estimated', billedModel: acc.model,
  };
}
