// OpenAI adapter, used by the Manager.
// Integration: OpenAI Responses API (POST /v1/responses), API-key auth, billed
// per token to the OpenAI API Platform account. A ChatGPT subscription does not
// pay for these calls, and this server does not share memory with ChatGPT
// conversations: the Manager only knows what `system` and `messages` contain.
import { costFromBuckets } from './pricing.js';
import { REVIEW_SCHEMA, emptyUsage, failed, httpFailure, paidGate, parseReview, sendJson, slug, summarize } from './http.js';

const DEFAULT_BASE = 'https://api.openai.com/v1';

/** @returns {import('./adapter.js').Adapter} */
export function create(cfg, { fetch: fetchImpl = globalThis.fetch, baseUrl = cfg.openaiBaseUrl || DEFAULT_BASE } = {}) {
  const key = () => cfg.secrets?.openai;
  const auth = () => ({ authorization: `Bearer ${key()}` });

  return {
    id: 'openai',
    kinds: ['manager', 'worker'],

    // Listing models is free; it proves the key works without generating tokens.
    async healthCheck() {
      if (!key()) return { ok: false, detail: 'No OpenAI API key configured' };
      const r = await sendJson(fetchImpl, `${baseUrl}/models`, { method: 'GET', headers: auth(), signal: AbortSignal.timeout(10_000) });
      if (r.ok) return { ok: true, detail: 'OpenAI API reachable, key accepted' };
      if (r.kind === 'http') return { ok: false, detail: r.status === 401 ? 'OpenAI rejected the API key' : `OpenAI returned HTTP ${r.status}` };
      return { ok: false, detail: 'OpenAI API unreachable' };
    },

    async run(req) {
      const gate = paidGate(cfg, 'openai', req);
      if (gate) return gate;

      const body = {
        model: req.model,
        instructions: req.system,
        input: req.messages.map(m => ({ role: m.role, content: m.content })),
        max_output_tokens: req.maxOutputTokens,
        // Do not keep project content on OpenAI beyond the request; context comes from our DB each time.
        store: false,
        // Keeps cache routing and accounting per project so prompts from different projects never share a key.
        prompt_cache_key: `project:${req.projectId}`,
        metadata: { project_id: req.projectId, task_id: req.taskId, run_id: req.runId },
      };
      if (cfg.openaiReasoningEffort) body.reasoning = { effort: cfg.openaiReasoningEffort };
      if (req.mode === 'review') {
        body.text = { format: { type: 'json_schema', name: 'review_verdict', schema: REVIEW_SCHEMA, strict: true } };
      }

      req.onActivity?.(req.mode === 'review' ? 'Requesting review' : 'Requesting model');
      req.onProviderState?.('requesting');
      const r = await sendJson(fetchImpl, `${baseUrl}/responses`, {
        headers: auth(),
        body, signal: req.signal,
      });
      if (!r.ok) { req.onProviderState?.('error'); return httpFailure(cfg, 'openai', r, r.headers?.get?.('x-request-id') ?? undefined); }
      req.onProviderState?.('responded');

      const resp = r.json ?? {};
      const usage = usageFrom(resp, cfg);
      const providerRequestId = resp.id ?? r.headers?.get?.('x-request-id') ?? undefined;
      const { text, refusal } = outputText(resp);

      if (resp.status === 'failed') return failed('Model failed', `OpenAI: ${resp.error?.message ?? 'response failed'}`, { retryable: true, usage, providerRequestId });
      if (refusal) return failed('Model declined', `OpenAI declined: ${refusal.slice(0, 300)}`, { retryable: false, usage, providerRequestId });
      if (resp.status === 'incomplete') {
        const why = resp.incomplete_details?.reason ?? 'unknown';
        return failed(why === 'max_output_tokens' ? 'Hit output limit' : 'Response incomplete',
          `OpenAI stopped early (${why}). Partial output was not saved.`, { retryable: false, usage, providerRequestId, partialText: text });
      }

      if (req.mode === 'review') {
        const review = parseReview(text);
        if (!review) return failed('Unreadable review', 'Manager review was not valid verdict JSON.', { retryable: true, usage, providerRequestId });
        const label = { approve: 'Approved', rework: 'Sent back for rework', block: 'Blocked' }[review.verdict];
        return { status: 'succeeded', summary: label, review, usage, providerRequestId };
      }
      return { status: 'succeeded', summary: summarize(text, 'Response saved'), outputText: text, outputName: `${slug(summarize(text, req.taskId))}.md`, usage, providerRequestId };
    },
  };
}

function outputText(resp) {
  let text = '', refusal = '';
  for (const item of resp.output ?? []) {
    if (item.type !== 'message') continue;
    for (const c of item.content ?? []) {
      if (c.type === 'output_text') text += c.text;
      else if (c.type === 'refusal') refusal += c.refusal;
    }
  }
  return { text, refusal };
}

// OpenAI: input_tokens is the whole prompt; cached_tokens and cache_write_tokens are parts of it.
export function usageFrom(resp, cfg) {
  const u = resp.usage;
  if (!u) return emptyUsage('unknown', null);
  const input = u.input_tokens ?? 0;
  const cached = u.input_tokens_details?.cached_tokens ?? 0;
  const writes = u.input_tokens_details?.cache_write_tokens ?? 0;
  const output = u.output_tokens ?? 0; // includes reasoning tokens, which are billed as output
  const model = resp.model ?? '';
  const cost = costFromBuckets(priceKey(model, cfg), {
    uncachedInputTokens: Math.max(0, input - cached - writes), cachedInputTokens: cached, cacheWriteTokens: writes, outputTokens: output,
  }, cfg.pricingOverrides);
  return {
    inputTokens: input, outputTokens: output, cachedInputTokens: cached, cacheWriteTokens: writes,
    reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? null,
    costUsd: cost, costKind: cost == null ? 'unknown' : 'estimated', billedModel: model,
  };
}

// Responses may name a dated snapshot (e.g. "gpt-6.1-sol-2026-09-01"); price it as its base model.
function priceKey(model, cfg) {
  const table = { ...(cfg.pricingOverrides ?? {}) };
  if (table[model]) return model;
  return model.replace(/-\d{4}-\d{2}-\d{2}$/, '');
}
