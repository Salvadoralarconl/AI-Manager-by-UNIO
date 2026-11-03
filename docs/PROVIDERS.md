# AI providers and what they cost

This page explains how each agent reaches its AI, who bills you for it, and how the app counts spending. Read it before you turn on paid execution.

Prices and API details were checked against official documentation on **3 November 2026**. Providers change prices; the provider's bill is always the final word.

## The short version

| Agent | AI | How the app connects | Who bills you | What a call costs |
|---|---|---|---|---|
| Manager | OpenAI (GPT) | OpenAI Responses API with an API key | OpenAI API Platform, per token | Tokens in + tokens out, at the model's rate |
| Developer, Researcher, Marketer | Claude | Claude Messages API with an API key | Anthropic Claude Console, per token | Tokens in + tokens out, at the model's rate |
| Intern | Your home AI | OpenAI-compatible endpoint on your network | Nobody sends a bill | Your electricity and hardware, which the app does not measure |

Three things to know:

1. **Your ChatGPT or Claude subscription does not pay for this.** ChatGPT Plus/Pro and Claude Pro/Max are subscriptions for the chat apps. The API is a separate account with separate, usage-based billing (normally prepaid credits or a card on file). You need an API key from [platform.openai.com](https://platform.openai.com) and one from [console.anthropic.com](https://console.anthropic.com). Some subscriptions come with promotional API credits; treat those as a bonus, not as coverage.
2. **The Manager is not this ChatGPT conversation.** It is an OpenAI model that the server calls with our instructions and the project's stored context. It has no memory of your ChatGPT chats, and it only knows what the app sends it on each call.
3. **Nothing is spent until you allow it.** Paid calls are blocked unless `PAID_EXECUTION_ENABLED=1` is set and an API key exists. With them off, the app still works for planning and simulation.

## How a call is charged

Every request is charged by **tokens**, which are pieces of words (roughly 3–4 English characters each).

- **Input tokens** are everything sent: the agent's instructions, the project brief and context, the task, and earlier messages.
- **Output tokens** are everything the model writes back, **including its hidden reasoning**. Both providers bill reasoning as output even though the app never shows or stores it.
- **Cached input** is input the provider has seen recently with an identical beginning. It is billed at a steep discount (5–10% of the normal input rate for the models below). The first time a prompt is cached, it costs a little more (1.25× input for the default cache). The app puts the stable part (instructions and project context) first so repeat runs on the same project hit the cache.

A failed or cancelled call can still cost money for whatever the model produced before it stopped. A request the provider rejects outright (bad key, bad request) is normally not billed.

### Current rates (USD per million tokens, standard tier)

| Model | Input | Cached input | Cache write | Output |
|---|---|---|---|---|
| `claude-opus-5-5` (default worker) | $4.00 | $0.20 | $5.00 | $20.00 |
| `claude-sonnet-5-5` | $2.00 | $0.10 | $2.50 | $10.00 |
| `claude-haiku-5-5` (prompts ≤ 100k tokens) | $0.10 | $0.01 | $0.125 | $0.50 |
| `gpt-6.1-sol` (suggested Manager) | $2.00 | $0.10 | $2.50 | $10.00 |
| `gpt-6.1-terra` | $1.00 | $0.05 | $1.25 | $5.00 |
| `gpt-6-luna` | $0.10 | $0.01 | $0.125 | $0.50 |

Full table and sources: `src/workers/pricing.js`. Model names are settings; if you pick a model that is not in the table, its cost shows as **unknown** and any run with a cost limit refuses to start until you add a price.

### A worked example

A Developer run on `claude-opus-5-5` that sends 25,000 tokens of context (20,000 of them cached from an earlier run) and writes 1,500 tokens:

- 5,000 new input × $4 / 1M = $0.020
- 20,000 cached × $0.20 / 1M = $0.004
- 1,500 output × $20 / 1M = $0.030
- **≈ $0.054**

The Manager reviewing that output on `gpt-6.1-sol` with 8,000 tokens in and 300 out costs about **$0.019**. One task through execute and review is a few cents; long tasks, big context, or many rework loops multiply that.

## How the app counts spending

- **Tokens are provider-reported.** Each response includes exact token counts, and the app stores them per project, task, run and agent.
- **Dollars are estimates.** Neither API returns a dollar amount per call, so the app multiplies the reported tokens by the price table. The dashboard marks these as estimates (≈). Compare against the provider's usage page from time to time.
- **Unknown is shown as unknown.** If a call was sent but no usage came back (for example, the connection dropped), it is counted as an unknown-cost call, not as $0.
- **Home AI is shown as local compute**, never as $0 or "free".
- **Simulated runs** from the demo are labelled simulated and never mix with real spending.

## Limits and why they are approximate

You can set a global daily cap, a per-project daily cap, a per-project total budget, and a per-run limit. Before a call starts, the app works out a **worst case** for it: every input token at the highest input rate, plus the full output allowance at the output rate. It only starts the call if that worst case fits under every cap, counting what is already spent **and** what is reserved by calls still running. When the call finishes, the reservation is replaced by the actual estimate, which is almost always lower.

This keeps you under the caps, with two unavoidable gaps:

- **In-flight calls can't be priced exactly until they finish.** Reserving the worst case covers this, at the cost of sometimes holding back work that would have fit.
- **The price table can be out of date.** If a provider raises prices, estimates (and caps) are off until the table is updated.

For a hard ceiling no software bug can exceed, also set a monthly spend limit in each provider's billing settings.

## Integration details

### Manager: OpenAI Responses API

- Endpoint `POST https://api.openai.com/v1/responses`, header `Authorization: Bearer $OPENAI_API_KEY`.
- `instructions` carries the Manager's role and the project's stored context; `input` carries the task.
- `store: false` so OpenAI does not keep the conversation for later retrieval; the app's database is the memory.
- `prompt_cache_key` is set per project, so cached prompts are never shared between projects.
- Reviews use Structured Outputs (`text.format` with a strict JSON schema) so the verdict is always `approve`, `rework` or `block` with notes.
- Health check: `GET /v1/models`, which costs nothing.
- Docs: [Responses API](https://developers.openai.com/api/reference/python/resources/responses), [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), [pricing](https://developers.openai.com/api/docs/pricing).

### Claude workers: Claude Messages API

- Endpoint `POST https://api.anthropic.com/v1/messages`, headers `x-api-key: $ANTHROPIC_API_KEY` and `anthropic-version: 2026-10-21`.
- Streamed, so long outputs don't time out and the dashboard sees real "receiving output" activity.
- The system prompt (instructions + project context) is marked for prompt caching.
- Effort is `high` by default (`cfg.anthropicEffort` changes it). Lower effort uses fewer tokens.
- Only the visible answer is saved. The model's reasoning is never stored or displayed.
- If Claude declines a request (`stop_reason: refusal`), the run fails without retry and goes to the Manager. Anthropic offers an automatic fallback to another model on refusals; it is **off** here because the fallback model can be priced differently, which would make the per-run worst case unreliable. It can be turned on later if you prefer.
- Health check: `GET /v1/models`, which costs nothing.
- Docs: [pricing](https://platform.claude.com/docs/en/about-claude/pricing), [models](https://platform.claude.com/docs/en/about-claude/models/overview).

**Why the API and not a Claude subscription tool:** the API is the documented, supported way for a server to call Claude unattended, and its usage is reported per call. Claude Code and the Claude Agent SDK can run coding agents with file and shell tools, but they bring their own billing and usage terms; they are a candidate for a later, tool-using Developer, not part of this first version.

### Intern: home AI

- Any OpenAI-compatible endpoint: Ollama, LM Studio, llama.cpp server, vLLM. Set `LOCAL_AI_URL` (for example `http://homebox:11434`); `/v1` is added if missing. `LOCAL_AI_API_KEY` is optional.
- Calls `POST {LOCAL_AI_URL}/v1/chat/completions`, 10-minute timeout. Health check lists models.
- Runs even when paid execution is off, because no provider bill is involved.
- The app does not assume what your model can do. Run the **Intern evaluation** (`src/workers/intern-eval.js`) first: it gives the model short extraction, classification, formatting and summarization tasks with exact pass/fail checks, and reports pass rate, median speed and how often a reviewer would have to redo the work. A task type is marked eligible for local work only if it passes ≥ 90% with a median answer under 20 seconds (both adjustable).
- If the home AI is down or fails, the task keeps its context, the Manager is told, and the runner reassigns it within your permissions and budget.

## What is real, simulated, or not done yet

- **Real (offline-tested):** the three adapters, request building, usage parsing, cost estimates, per-run cost gate, error handling and redaction, Intern evaluation. 36 tests run against fake provider responses; no paid call has been made.
- **Not verified live yet:** a real call to each provider. That waits until you add keys, set a budget and turn on paid execution. The first live check should be one small bounded task: Manager → Claude worker → saved deliverable → Manager review.
- **Not done yet:** tool use (web search for the Researcher, file edits and tests for the Developer), importing actual dollar figures from provider billing reports, batch discounts.
