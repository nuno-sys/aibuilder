# Verified facts — DO NOT CONTRADICT

Checked on 2026-09-06 against the actually-installed packages / live npm registry.
Where the architecture document (`.design/00-ARCHITECTURE.md`) disagrees with this file,
THIS FILE WINS.

## Resolved package versions (latest on npm right now)

| Package | Version to use | Note |
|---|---|---|
| `@anthropic-ai/sdk` | `0.124.0` (EXACT pin, no caret) | The architecture doc says "1.x exact" — that is the **Python** SDK's major. The TypeScript SDK's latest is 0.124.0. |
| `zod` | `^4.5.4` | |
| `hono` | `^4.13.7` | |
| `astro` | `^7.3.1` | Architecture doc said Astro 6; actual latest is 7. |
| `wrangler` | `^4.129.0` | |
| `drizzle-orm` | `^0.45.2` | Not used in this phase — see below. |

## Anthropic TypeScript SDK — verified API surface (v0.124.0)

Verified by reading `node_modules/@anthropic-ai/sdk/**/*.d.ts`:

* `client.beta.messages.stream(params, options?) => BetaMessageStream` — EXISTS.
  Await `.finalMessage()` for the complete `BetaMessage`.
* `client.beta.messages.parse(params, options?)` — non-streaming only.
* **`betaZodOutputFormat(zodSchema)` takes exactly ONE argument.**
  Import from `@anthropic-ai/sdk/helpers/beta/zod`.
  The architecture doc's `zodOutputFormat(SiteStructureGen, "site_structure")` is WRONG — drop the 2nd arg.
  The non-beta equivalent is `zodOutputFormat(zodSchema)` from `@anthropic-ai/sdk/helpers/zod`.
* `output_config?: BetaOutputConfig` accepts `effort?: 'low'|'medium'|'high'|'xhigh'|'max'`,
  `task_budget?: BetaTokenTaskBudget`, and `format`.
* `fallbacks?: BetaFallbacksParam` where
  `type BetaFallbacksParam = Array<BetaFallbackParam> | 'default'` — the scalar `'default'` form is valid.
* `thinking.display?: 'summarized' | 'omitted' | 'updates' | null`.
* `usage` has `input_tokens`, `output_tokens`, `cache_creation_input_tokens | null`,
  `cache_read_input_tokens | null`. **There is NO `thinking_tokens` field** — thinking bills inside
  `output_tokens`. Never add such a column or cost term.

## Model / request rules (non-negotiable)

* Model id is exactly `claude-opus-5`. Never append a date suffix.
* `thinking: { type: "adaptive", display: "summarized" }`. `budget_tokens` is REMOVED → 400.
* Assistant prefill is REMOVED → 400. A repair turn must be a `user` message.
* Always branch on `msg.stop_reason` BEFORE reading `msg.content`.
  `stop_details` is populated only when `stop_reason === "refusal"`.
* Streaming is required for large `max_tokens`.
* Prompt cache: `cache_control: { type: "ephemeral" }`, prefix match, stable content first,
  volatile (tenant) content LAST and after the breakpoint. 5-minute TTL (default) — do NOT use `ttl: "1h"`.
* SDK client is constructed with `maxRetries: 0` (Workflows owns retries) and
  `timeout` **in milliseconds**.
* Betas used: `["server-side-fallback-2026-07-01", "task-budgets-2026-03-13"]`
  (`fallbacks: "default"` pairs with the `-07-01` header; the array form pairs with `-06-01`).
* `task_budget.total` minimum is 20000.

## Deliberate deviations from `00-ARCHITECTURE.md` (stated, not accidental)

1. **No Drizzle in this phase.** D1 access is hand-written prepared statements exported from
   `packages/db/src/queries/*` so every shipped statement is greppable and feedable to the
   `EXPLAIN QUERY PLAN` gate. Drizzle arrives in Phase 2 with the dashboard's relational reads.
2. **Scope.** This delivery implements the client's Phase 1 as they scoped it: the onboarding
   modal, the API behind it, the D1 schema, and the Worker logic that builds and dispatches the
   Anthropic prompt. `apps/renderer`, `apps/media`, `apps/app`, `apps/billing` and the
   render/publish workflow steps are NOT in this delivery. Workflow steps that would call them
   are present as typed, documented stubs that throw `NotImplementedInPhase1`.
3. Domain placeholders come from `vars`, never hardcoded: `APP_ORIGIN`, `SITES_ROOT_DOMAIN`.
