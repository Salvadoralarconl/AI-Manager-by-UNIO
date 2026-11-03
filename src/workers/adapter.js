// Worker adapter interface. Every provider (OpenAI Manager, Claude workers,
// home AI, simulator) implements this shape. Plain ESM JavaScript with JSDoc.
//
// The runner owns scheduling, leases, budgets, retries, artifacts and events.
// An adapter only turns one request into one provider call (or simulated step)
// and reports what happened. It must never retry an external side effect itself.

/**
 * @typedef {Object} AdapterRequest
 * @property {'execute'|'review'} mode     execute = do the task; review = Manager judges an output
 * @property {string} projectId
 * @property {string} taskId
 * @property {string} runId
 * @property {string} idempotencyKey       stable per (task, kind, attempt); pass to providers that accept one
 * @property {string} model                configurable model identifier
 * @property {string} system               agent instructions + stored project context (scoped to this project only)
 * @property {{role:'user'|'assistant', content:string}[]} messages
 * @property {number} maxOutputTokens
 * @property {number|null} costLimitUsd    hard cap for this run; adapter should stop if it can tell it will exceed
 * @property {AbortSignal} signal          aborted on cancel, pause-with-abort, or timeout
 * @property {(text:string)=>void} onActivity   call with a short observable action ("Requesting model", "Writing output")
 * @property {(state:'requesting'|'responded'|'error')=>void} onProviderState
 */

/**
 * @typedef {Object} AdapterUsage
 * @property {number|null} inputTokens
 * @property {number|null} outputTokens
 * @property {number|null} cachedInputTokens
 * @property {number|null} cacheWriteTokens
 * @property {number|null} costUsd
 * @property {'reported'|'estimated'|'unknown'|'simulated'|'local'} costKind
 */

/**
 * @typedef {Object} AdapterResult
 * @property {'succeeded'|'failed'} status
 * @property {string} summary              short phrase for Latest work, e.g. "Checkout updated"
 * @property {string} [outputText]         deliverable body (saved as an artifact by the runner)
 * @property {string} [outputName]         file name for the artifact, e.g. "checkout-notes.md"
 * @property {{verdict:'approve'|'rework'|'block', notes:string}} [review]  required when mode = 'review'
 * @property {AdapterUsage} usage
 * @property {string} [providerRequestId]
 * @property {string} [error]              concise, already redacted
 * @property {boolean} [retryable]         false for errors a retry cannot fix (auth, bad request)
 */

/**
 * @typedef {Object} Adapter
 * @property {string} id                   'openai' | 'anthropic' | 'local' | 'simulated'
 * @property {('manager'|'worker')[]} kinds
 * @property {() => Promise<{ok:boolean, detail:string}>} healthCheck   must not incur paid usage
 * @property {(req: AdapterRequest) => Promise<AdapterResult>} run
 */

export const ADAPTER_METHODS = ['healthCheck', 'run'];

export function assertAdapter(a) {
  for (const m of ADAPTER_METHODS) if (typeof a?.[m] !== 'function') throw new Error(`Adapter ${a?.id} missing ${m}()`);
  return a;
}

// Placeholder for providers that are not wired yet (Phase 3). Fails safely without network calls.
export function unavailableAdapter(id, reason) {
  return {
    id,
    kinds: ['manager', 'worker'],
    async healthCheck() { return { ok: false, detail: reason }; },
    async run() {
      return { status: 'failed', summary: 'Provider not connected', error: reason, retryable: false,
        usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, cacheWriteTokens: null, costUsd: 0, costKind: 'unknown' } };
    },
  };
}
