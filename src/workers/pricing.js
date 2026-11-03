// Price table for cost ESTIMATES. Providers report token counts on every
// response, but not dollars, so every per-run dollar figure in this app is an
// estimate: provider-reported tokens x the rates below. Reconcile against the
// provider's billing page; the bill is the source of truth.
//
// Rates are USD per million tokens, standard (non-batch) tier.
// Model ids are configurable; add or override entries with cfg.pricingOverrides
// (same shape) instead of editing this file when a provider changes prices.

export const PRICING_SOURCES = {
  anthropic: { url: 'https://platform.claude.com/docs/en/about-claude/pricing', checked: '2026-11-03' },
  openai: { url: 'https://developers.openai.com/api/docs/pricing', checked: '2026-11-03' },
  openaiCaching: { url: 'https://developers.openai.com/api/docs/guides/prompt-caching', checked: '2026-11-03' },
};

// inputPerMTok          uncached input
// cachedInputPerMTok    cache read / hit
// cacheWritePerMTok     cache write (Anthropic 5-minute cache; OpenAI default 30-minute cache)
// cacheWrite1hPerMTok   Anthropic 1-hour cache write
// outputPerMTok         output, including reasoning/thinking tokens
export const pricing = {
  // Anthropic (Claude workers)
  'claude-opus-5-5':   { provider: 'anthropic', inputPerMTok: 4,    cachedInputPerMTok: 0.20, cacheWritePerMTok: 5,     cacheWrite1hPerMTok: 8,    outputPerMTok: 20 },
  'claude-sonnet-5-5': { provider: 'anthropic', inputPerMTok: 2,    cachedInputPerMTok: 0.10, cacheWritePerMTok: 2.50,  cacheWrite1hPerMTok: 4,    outputPerMTok: 10 },
  // Haiku 5.5 prices rise for prompts over 100k tokens; see longPrompt.
  'claude-haiku-5-5':  { provider: 'anthropic', inputPerMTok: 0.10, cachedInputPerMTok: 0.01, cacheWritePerMTok: 0.125, cacheWrite1hPerMTok: 0.20, outputPerMTok: 0.50,
    longPrompt: { overTokens: 100_000, inputPerMTok: 0.50, cachedInputPerMTok: 0.05, cacheWritePerMTok: 0.625, cacheWrite1hPerMTok: 1, outputPerMTok: 2.50 } },
  'claude-fable-5-1':  { provider: 'anthropic', inputPerMTok: 10,   cachedInputPerMTok: 0.25, cacheWritePerMTok: 12.50, cacheWrite1hPerMTok: 20,   outputPerMTok: 50 },

  // OpenAI (Manager). Cache writes are 1.25x input on the models below (30-minute default lifetime).
  'gpt-6-astra':   { provider: 'openai', inputPerMTok: 10,   cachedInputPerMTok: 1.00, cacheWritePerMTok: 12.50, outputPerMTok: 50 },
  'gpt-6.1-sol':   { provider: 'openai', inputPerMTok: 2,    cachedInputPerMTok: 0.10, cacheWritePerMTok: 2.50,  outputPerMTok: 10 },
  'gpt-6.1-terra': { provider: 'openai', inputPerMTok: 1,    cachedInputPerMTok: 0.05, cacheWritePerMTok: 1.25,  outputPerMTok: 5 },
  'gpt-6-luna':    { provider: 'openai', inputPerMTok: 0.10, cachedInputPerMTok: 0.01, cacheWritePerMTok: 0.125, outputPerMTok: 0.50 },
};

/** Suggested defaults; the app's settings decide. */
export const SUGGESTED_MODELS = { manager: 'gpt-6.1-sol', worker: 'claude-opus-5-5' };

export function priceFor(model, overrides = {}) {
  return overrides?.[model] ?? pricing[model] ?? null;
}

/**
 * Normalised usage, in "billing buckets" so that both providers price the same way:
 *   uncachedInputTokens + cachedInputTokens + cacheWriteTokens = whole prompt
 * @typedef {{uncachedInputTokens:number, cachedInputTokens:number, cacheWriteTokens:number, cacheWrite1hTokens?:number, outputTokens:number}} Buckets
 */

/** Dollars for one call. Returns null when the model has no price entry. */
export function costFromBuckets(model, b, overrides) {
  let p = priceFor(model, overrides);
  if (!p) return null;
  const prompt = b.uncachedInputTokens + b.cachedInputTokens + b.cacheWriteTokens + (b.cacheWrite1hTokens ?? 0);
  if (p.longPrompt && prompt > p.longPrompt.overTokens) p = { ...p, ...p.longPrompt };
  const w1h = p.cacheWrite1hPerMTok ?? p.cacheWritePerMTok ?? p.inputPerMTok;
  const usd =
    b.uncachedInputTokens * p.inputPerMTok +
    b.cachedInputTokens * (p.cachedInputPerMTok ?? p.inputPerMTok) +
    b.cacheWriteTokens * (p.cacheWritePerMTok ?? p.inputPerMTok) +
    (b.cacheWrite1hTokens ?? 0) * w1h +
    b.outputTokens * p.outputPerMTok;
  return round6(usd / 1_000_000);
}

/**
 * Upper bound for a call before it is sent, so the runner can reserve budget
 * for in-flight work. Assumes every prompt token is uncached (cache writes
 * priced at the write rate, which is the highest input rate) and that the model
 * uses the whole output allowance. Prompt tokens are over-counted at ~3 chars
 * per token; real tokenizers usually give fewer.
 */
export function worstCaseCostUsd(model, { system = '', messages = [], maxOutputTokens = 0 }, overrides) {
  let p = priceFor(model, overrides);
  if (!p) return null;
  const chars = system.length + messages.reduce((n, m) => n + String(m.content ?? '').length, 0);
  const promptTokens = Math.ceil(chars / 3) + 50;
  if (p.longPrompt && promptTokens > p.longPrompt.overTokens) p = { ...p, ...p.longPrompt };
  const inRate = Math.max(p.inputPerMTok, p.cacheWritePerMTok ?? 0);
  return round6((promptTokens * inRate + maxOutputTokens * p.outputPerMTok) / 1_000_000);
}

function round6(n) { return Math.round(n * 1e6) / 1e6; }
