// Home AI adapter, used by the Intern.
// Integration: any OpenAI-compatible chat endpoint on your network
// (POST {LOCAL_AI_URL}/v1/chat/completions). Ollama, LM Studio, llama.cpp
// server and vLLM all expose one. No provider bill, but not free: it uses your
// machine's electricity and hardware, which this app does not measure.
// Cost is therefore recorded as costKind 'local' with costUsd null.
//
// Nothing here assumes what the home model can do. Use intern-eval.js to
// measure it on candidate task types before routing real work to it.
import { emptyUsage, failed, httpFailure, sendJson, slug, summarize } from './http.js';

/** @returns {import('./adapter.js').Adapter} */
export function create(cfg, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const base = () => normalizeBase(cfg.localAiUrl);
  const headers = () => (cfg.secrets?.local ? { authorization: `Bearer ${cfg.secrets.local}` } : {});
  const timeoutMs = cfg.localTimeoutMs ?? 10 * 60_000;

  return {
    id: 'local',
    kinds: ['worker'],

    async healthCheck() {
      if (!cfg.localAiUrl) return { ok: false, detail: 'No local AI endpoint configured' };
      const r = await sendJson(fetchImpl, `${base()}/models`, { method: 'GET', headers: headers(), signal: AbortSignal.timeout(5_000) });
      if (!r.ok) return { ok: false, detail: r.kind === 'http' ? `Local AI returned HTTP ${r.status}` : 'Local AI unreachable' };
      const ids = (r.json?.data ?? []).map(m => m.id).filter(Boolean);
      return { ok: true, detail: ids.length ? `Local AI reachable; models: ${ids.slice(0, 5).join(', ')}` : 'Local AI reachable', models: ids };
    },

    async run(req) {
      if (req.mode === 'review') return failed('Not a reviewer', 'The Intern does not review; the Manager (OpenAI) does.');
      if (!cfg.localAiUrl) return failed('Home AI not connected', 'No local AI endpoint configured. No request was sent.', { usage: emptyUsage('local', null) });

      const signal = req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      req.onActivity?.('Requesting home AI');
      req.onProviderState?.('requesting');
      const t0 = Date.now();
      const r = await sendJson(fetchImpl, `${base()}/chat/completions`, {
        headers: headers(), signal,
        body: {
          model: req.model,
          messages: [{ role: 'system', content: req.system }, ...req.messages.map(m => ({ role: m.role, content: m.content }))],
          max_tokens: req.maxOutputTokens,
          stream: false,
        },
      });
      if (!r.ok) {
        req.onProviderState?.('error');
        if (r.kind === 'aborted' && !req.signal?.aborted) {
          return failed('Home AI timed out', `No answer within ${Math.round(timeoutMs / 1000)}s.`, { retryable: true, usage: emptyUsage('local', null) });
        }
        const f = httpFailure(cfg, 'local AI', r);
        return { ...f, usage: emptyUsage('local', null) };
      }
      req.onProviderState?.('responded');

      const choice = r.json?.choices?.[0];
      const text = choice?.message?.content ?? '';
      const u = r.json?.usage;
      const usage = {
        inputTokens: u?.prompt_tokens ?? null, outputTokens: u?.completion_tokens ?? null,
        cachedInputTokens: null, cacheWriteTokens: null, costUsd: null, costKind: 'local',
        billedModel: r.json?.model ?? req.model, latencyMs: Date.now() - t0,
      };
      if (choice?.finish_reason === 'length') return failed('Hit output limit', 'Home AI stopped at the output limit.', { retryable: false, usage, partialText: text });
      if (!text.trim()) return failed('Empty answer', 'Home AI returned no text.', { retryable: true, usage });
      return { status: 'succeeded', summary: summarize(text, 'Output saved'), outputText: text, outputName: `${slug(summarize(text, req.taskId))}.md`, usage, providerRequestId: r.json?.id };
    },
  };
}

export function normalizeBase(url) {
  const u = String(url ?? '').replace(/\/+$/, '');
  return /\/v1$/.test(u) ? u : `${u}/v1`;
}
