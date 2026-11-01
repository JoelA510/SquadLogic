[← Back to Documentation Index](../README.md)

# Edge Function Budget - How To

> Source of truth: [`supabase/functions/`](../../supabase/functions/).
> Companion docs: [`edge-functions-inventory.md`](../architecture/edge-functions-inventory.md) and [`bundle-budget.md`](./bundle-budget.md).

## What This Budget Controls

Supabase Edge Functions are budgeted on invocation count, wall-clock time, CPU
work, egress, and logs. SquadLogic keeps the browser small with the frontend
bundle budget; this document applies the same discipline to server-side edge
work.

The current function inventory is:

| Function | Budget Class | Expected Shape |
| --- | --- | --- |
| `team-persistence` | Thin write wrapper | Authenticate, validate, rate-limit, org-scope check, call `persist_team_schedule`, audit. |
| `practice-persistence` | Thin write wrapper | Authenticate, validate, rate-limit, org-scope check, call `persist_practice_schedule`, audit. |
| `game-persistence` | Thin write wrapper | Authenticate, validate, rate-limit, org-scope check, call `persist_game_schedule`, audit. |
| `import-validation` | Validation and staging | Chunked CSV validation, capped rows/fields, staging writes. |
| `fairness-scoring` | CPU-bound scoring | Score one submitted schedule and optionally persist evaluation output. |
| `auto-scheduler` | Long-running CPU work | Hill-climbing loop that stops at a 1.5 s compute cap measured from the request's start (`CPU_CAP_MS`; a request gets 2 s of CPU on every plan, and awaiting does not reset it), returns its best schedule with `terminationReason: 'cpu-cap'`, and keeps a 140 s wall-clock guard and progress events. It also reads each division's practice settings (one paged read of `teams` joined to `divisions`, as the caller) before the search; a practice a week is a unit, so a division at several a week multiplies the units the search places. Three modes (Phase D PR D, below): `solve` is the search above; `prepare` and `verify` are the two requests of a browser search. |
| `calendar-feed` | Token-based public read | Generate one team calendar feed from a valid expiring token. |

## Guardrails

Use these limits when changing an existing function or adding a new one:

| Area | Default Budget | Escalation Rule |
| --- | --- | --- |
| Thin persistence functions | Single RPC call plus audit | Move branching database work into the RPC before adding Edge Function logic. |
| Request payloads | Explicit Zod/schema validation and size caps | Add a documented cap before accepting new arrays or free-form objects. |
| Rate limiting | Per-user `checkRateLimit()` for authenticated functions | New public functions need a token or gateway-level abuse story in the PR. |
| Wall-clock work | Return quickly unless the function is explicitly CPU-bound | Long loops need a hard cap (max 140s), progress behavior, cancel/failure semantics, and periodic yielding. |
| Dependencies | Reuse `import_map.json`; prefer pinned small imports | Justify any new heavyweight dependency in the PR body. |
| Logging | Structured, metadata-only logs | Do not log raw CSV rows, medical data, names, emails, tokens, or full URLs. |

## Before Adding A Function

Default to an RPC for database-only work. Add or expand an Edge Function only
when at least one of these is true:

- It needs transport-level auth or a service-role wrapper.
- It needs request-size validation before data reaches the database.
- It needs per-user rate limiting.
- It performs CPU-bound work that should not block Postgres or the browser.
- It calls an external service.
- It exposes a token-based public read surface without a JWT session.

If the work is a write, the function should stay thin: authenticate, validate,
check org scope, rate-limit, call the dedicated RPC, and record audit metadata.

## The auto-scheduler's three modes (Phase D PR D)

The body's `mode` chooses (`solve` when it names none; an unknown mode is a 400). The search itself
is the same solver, `_shared/engines/auto-scheduler-solver.ts`, which the page's Web Worker
(`frontend/src/workers/practiceOptimizer.worker.js`) imports with the 1.5 s cap off and a 20 s wall
budget, so a league too big for the server's 2 s of CPU is searched in the browser.

| Mode | Does | CPU shape | Writes |
| --- | --- | --- | --- |
| `solve` | Loads every input as the caller, searches until the 1.5 s cap or its iterations, scores, persists the run. | Dominated by the search: up to the cap. Unchanged. | Evaluation run, audit rows. |
| `prepare` | Loads the same inputs, the same refusals, and answers with the solver's input (canonical JSON, `_shared/engines/solver-input.ts`) and its SHA-256 digest. Searches nothing. | Loading, then one encoding and one digest. | Nothing (a refusal is audited, as in `solve`). |
| `verify` | Loads everything again itself, compares the digest of what it loaded with the one in the body (409 `INPUT_CHANGED` if they differ), seats the proposed placements in sorted order through the search's own admissibility check, runs the daylight pass, scores, persists the run, answers in `solve`'s shape. | Loading, one encoding and digest, then linear in the placements: no search. | Evaluation run, audit rows. |

**Measured (_executed_, 2026-11-01, Deno 2.9.6 on a shared container, synthetic leagues of 2 practices
a week per team, 3 slots a day Monday to Friday, `tests/fixtures/practiceOptimizerLeague.js`'s rules
scaled up; the Supabase edge runtime was not available, so these are Deno's figures, not the
platform's):**

| League | Practices to place | Slots | `verify` alone (median of 9) | Encode and digest, warm | Encoding, uncompressed |
| --- | --- | --- | --- | --- | --- |
| 64 teams | 128 | 300 | 6 ms | (first call in the process: 345 ms) | 148 KB |
| 128 teams | 256 | 600 | 19 ms | 11 ms | 297 KB |
| 500 teams | 1,000 | 1,500 | 41 ms | 27 ms | 782 KB |

`verify` alone includes scoring and the daylight pass. For scale, 100 iterations of the search cost
236 ms, 472 ms and 2,373 ms on the same three leagues in Node (the figure the cap protects against).
The first digest in a fresh process cost 345 ms (cold start of the encoder and `crypto.subtle`); a
cold `verify` request therefore spends roughly that plus the loads, well inside the 2 s of CPU. The
loads (paged reads as the caller) are the same ones `solve` makes and are not counted here. A league
past about 1,500 practices would make `prepare`'s response several MB; it is gzip-compressed on the
wire, and the encoding leaves out every preference verdict that says nothing.

Rate limit: a browser run is two requests (`prepare`, `verify`) and, when it falls back, a third
(`solve`), against the existing 10 a minute per user.

## Review Checklist

Every Edge Function PR should state:

- Which function changed and whether it is thin-wrapper, validation, CPU-bound,
  or public-read work.
- The org-scope check used before service-role data access.
- The rate-limit behavior.
- The maximum request size or batch size affected by the change.
- Whether any logs could include sensitive data.
- Local verification, including `deno check` for touched function files when
  practical.

## Measuring Drift

Line count is not a pass/fail budget, but it is a useful signal:

```bash
wc -l supabase/functions/*/index.ts
```

When a thin wrapper grows substantially, prefer extracting validation helpers or
moving transactional database branching into an RPC. When a CPU-bound function
grows, prefer extraction into `supabase/functions/_shared/engines/` so tests can
exercise the core logic directly.

## Operator Metrics

The repo does not currently store production invocation counts, p95 duration,
egress, or log volume. Operators should review those in Supabase and BetterStack
before final sign-off. If a dashboard or export becomes available, record the
baseline in this document or a linked operations note without exposing tokens,
request payloads, or personal data.

## Rollback

Documentation-only changes roll back by reverting the PR. Runtime budget
changes roll back by reverting the function or migration PR that changed the
behavior, then redeploying the affected function.
