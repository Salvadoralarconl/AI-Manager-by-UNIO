// Shared plumbing for provider adapters: one HTTP call, error classification,
// redaction, and the paid-execution / per-run cost gates. No retries here:
// the runner decides whether and when to retry.
import { redact } from '../config.js';
import { worstCaseCostUsd } from './pricing.js';

export const emptyUsage = (costKind = 'unknown', costUsd = null) => ({
  inputTokens: null, outputTokens: null, cachedInputTokens: null, cacheWriteTokens: null, costUsd, costKind,
});

export function failed(summary, error, { retryable = false, usage = emptyUsage('unknown', 0), ...extra } = {}) {
  return { status: 'failed', summary, error, retryable, usage, ...extra };
}

/**
 * Checks that must pass before any paid call. Returns a failed result, or null to proceed.
 * - paid execution must be switched on by the owner
 * - a credential must exist
 * - when the run has a cost limit, the worst-case cost must fit inside it
 */
export function paidGate(cfg, provider, req) {
  if (!cfg.paidExecution) {
    return failed('Paid execution off', 'Paid provider calls are disabled (PAID_EXECUTION_ENABLED is off). No request was sent.');
  }
  if (!cfg.secrets?.[provider]) {
    return failed('Provider not connected', `No ${provider} API key is configured. No request was sent.`);
  }
  if (req.costLimitUsd != null) {
    const worst = worstCaseCostUsd(req.model, req, cfg.pricingOverrides);
    if (worst == null) {
      return failed('Model price unknown', `No price entry for model "${req.model}", so the run's cost limit cannot be enforced. Add it to the pricing table. No request was sent.`);
    }
    if (worst > req.costLimitUsd) {
      return failed('Over run budget', `Worst-case cost $${worst.toFixed(4)} exceeds this run's limit $${Number(req.costLimitUsd).toFixed(4)}. Lower max output tokens, shorten context, or raise the limit. No request was sent.`);
    }
  }
  return null;
}

/**
 * Sends one request. Returns {ok, status, json, headers} or {ok:false, kind, ...}.
 * kind: 'aborted' (cancelled before/while sending), 'network' (no HTTP response;
 * the provider may or may not have processed it), 'http' (provider answered with an error).
 */
export async function sendJson(fetchImpl, url, { method = 'POST', headers = {}, body, signal }) {
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') return { ok: false, kind: 'aborted', message: 'Request cancelled' };
    return { ok: false, kind: 'network', message: err?.message ?? String(err) };
  }
  let json = null;
  const text = await res.text().catch(() => '');
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) return { ok: false, kind: 'http', status: res.status, json, text, headers: res.headers };
  return { ok: true, status: res.status, json, headers: res.headers };
}

/** Turns a non-ok sendJson result into a failed AdapterResult. */
export function httpFailure(cfg, provider, r, providerRequestId) {
  if (r.kind === 'aborted') return failed('Cancelled', 'Request cancelled before a response arrived. The provider may still bill for work it already did.', { retryable: false, usage: emptyUsage('unknown', null), providerRequestId });
  if (r.kind === 'network') {
    // No response: we do not know whether the provider ran (and billed) the request.
    return failed('Provider unreachable', redact(`No response from ${provider}: ${r.message}. Outcome unknown; it may have been processed and billed.`, cfg),
      { retryable: true, outcomeUnknown: true, usage: emptyUsage('unknown', null), providerRequestId });
  }
  const s = r.status;
  const msg = r.json?.error?.message ?? r.text?.slice(0, 300) ?? '';
  const why =
    s === 401 ? 'API key rejected' :
    s === 403 ? 'Access denied for this key or model' :
    s === 404 ? 'Model or endpoint not found' :
    s === 400 || s === 422 ? 'Request rejected' :
    s === 413 ? 'Request too large' :
    s === 429 ? 'Rate limited or out of credit' :
    s >= 500 ? 'Provider error' : `HTTP ${s}`;
  // 429 can also mean "insufficient quota" on OpenAI; a retry won't fix that.
  const quota = /quota|billing|credit balance/i.test(msg);
  const retryable = !quota && (s === 408 || s === 409 || s === 429 || s >= 500);
  return failed(why, redact(`${provider} ${s}: ${why}. ${msg}`.trim(), cfg), {
    retryable, providerRequestId,
    retryAfterSec: Number(r.headers?.get?.('retry-after')) || undefined,
    // Rejected requests are normally not billed; provider-side errors may have partly run.
    usage: emptyUsage(s >= 500 ? 'unknown' : 'estimated', s >= 500 ? null : 0),
  });
}

/** Short phrase for Latest work, taken from the first line of the output. */
export function summarize(text, fallback) {
  const line = String(text ?? '').split('\n').map(l => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean);
  if (!line) return fallback;
  return line.length > 60 ? line.slice(0, 57).trimEnd() + '...' : line;
}

export function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'output';
}

/** Review verdict JSON schema shared by the Manager adapters. */
export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'notes'],
  properties: {
    verdict: { type: 'string', enum: ['approve', 'rework', 'block'] },
    notes: { type: 'string', description: 'Concise reasons and, for rework, what to change.' },
  },
};

export function parseReview(text) {
  try {
    const v = JSON.parse(text);
    if (['approve', 'rework', 'block'].includes(v?.verdict)) return { verdict: v.verdict, notes: String(v.notes ?? '') };
  } catch { /* fall through */ }
  return null;
}
