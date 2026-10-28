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
| `auto-scheduler` | Long-running CPU work | Hill-climbing loop that stops at a 1.5 s compute cap measured from the request's start (`CPU_CAP_MS`; a request gets 2 s of CPU on every plan, and awaiting does not reset it), returns its best schedule with `terminationReason: 'cpu-cap'`, and keeps a 140 s wall-clock guard and progress events. It also reads each division's practice settings (one paged read of `teams` joined to `divisions`, as the caller) before the search; a practice a week is a unit, so a division at several a week multiplies the units the search places. |
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
