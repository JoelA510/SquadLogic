## [← Back to Documentation Index](../README.md)

# Edge Functions Inventory

> **Status**: Reference for the Supabase Edge Functions layer as deployed to production. Inventory grounded in `supabase/functions/` source — that directory is the source of truth for what exists.

## 1. Purpose

Edge Functions are Deno/TypeScript handlers hosted by Supabase at the edge. They sit between the browser client and the database for three classes of work:

1. **Transport security for writes.** The frontend never holds the service-role key. Writes that need RLS-elevation (e.g., looking across `organization_members` before mutating) go through an Edge Function that authenticates the caller's JWT, re-checks org membership with the service client, and then calls a `SECURITY DEFINER` RPC (see [`persistence-rpc-layer.md`](./persistence-rpc-layer.md)).
2. **JWT-authenticated read surfaces.** `calendar-feed` is the only public read surface; every other function enforces `getUserFromRequest()` + `verifyOrgMembership()` / `getUserOrgIds()` before returning data.
3. **Cross-region low latency and CPU isolation.** The auto-scheduler's Hill Climbing loop and the fairness scoring engine run on the edge isolate rather than the caller's browser, which keeps the UI responsive and keeps the scoring algorithm out of the shipped JS bundle.

Decision rule (see §4 below): push database-only transactional work into an RPC and invoke it from the shortest possible Edge Function wrapper. Only reach for an Edge Function when the work needs transport-level auth, CPU isolation, rate-limiting, or cross-API composition.

## 2. Inventory

Seven functions are deployed. Each has its own directory under `supabase/functions/` with a single `index.ts` entry file. Dependencies use Deno-style URL imports resolved via `supabase/functions/import_map.json`.

### 2.1 `import-validation`

- **Purpose**: Server-side validation and staging gate for the GotSport CSV import flow (Phase 2.1, finding H-1). The browser parses the CSV with PapaParse client-side; rows are POSTed here after an `import_jobs` row exists. The function validates headers (strict alias map, not fuzzy matching), required fields, data types, string length caps, strips HTML/control characters, stages valid player rows in `staging_players`, and stages valid non-player rows in `staging_import_rows`.
- **Invoked by**: `frontend/src/contexts/ImportContext.jsx` via `supabase.functions.invoke('import-validation', …)`.
- **Authentication**: `getUserFromRequest()` → returns `401` on missing/invalid bearer. Requires admin/tenant-admin membership for the target organization before staging rows.
- **Rate limit**: `checkRateLimit(user.id)` — 10 req/min per user.
- **Size caps**: 5000 rows, 500 char/field, 10 MB payload.
- **RLS interaction**: Uses the service-role client for staging writes, but gates every write with `verifyOrgAdmin()` and verifies the `import_job_id` belongs to the requested organization. Final player promotion uses the admin-only `finalize_import_job(uuid, jsonb)` RPC; non-player promotion uses `finalize_coach_import_job(uuid, jsonb)` and `finalize_field_import_job(uuid, jsonb)`.

### 2.2 `team-persistence`

- **Purpose**: Persist the output of the team-generation engine. Upserts a `scheduler_runs` row, the `teams` batch, and the `team_players` batch by calling the `persist_team_schedule` RPC. Blocks persistence if any `overrides` in the payload are still in `pending` status.
- **Invoked by**: `frontend/src/utils/teamPersistenceClient.js` via the `apiClient.post('team-persistence', …)` helper.
- **Authentication**: JWT + role allow-list (`authenticated`, `service_role`, `admin`, `scheduler`; configurable via `TEAM_PERSISTENCE_ALLOWED_ROLES`). Validates Zod payload schema, resolves the requested organization from run metadata, season settings, divisions, teams, and players, then requires the caller to be an admin/tenant-admin of that single organization before using the service client (IDOR guard).
- **Rate limit**: `checkRateLimit(user.id)` — default 60 req/min.
- **RPC used**: `persist_team_schedule(run_data, teams, team_players)`; returns the persisted scheduler run id and treats the submitted roster rows as authoritative for the teams in the payload.
- **Audit**: `recordAudit(action: 'team.saved', ...)` fire-and-forget.

### 2.3 `practice-persistence`

- **Purpose**: Persist the output of the practice-scheduling engine. Upserts a `scheduler_runs` row and the `practice_assignments` batch via the `persist_practice_schedule` RPC.
- **Invoked by**: `frontend/src/utils/*` via `apiClient.post('practice-persistence', …)`.
- **Authentication**: Same JWT + role allow-list + Zod payload as team-persistence. Resolves `team_id` → `organizations.id` via `resolveOrgIdsFromTeamIds()` and asserts each is in the caller's org set.
- **Rate limit**: `checkRateLimit(user.id)` — default 60 req/min.
- **RPC used**: `persist_practice_schedule(run_data, assignments)`; returns the persisted scheduler run id, links current assignment rows to that run via `practice_assignments.run_id`, and rejects cross-org season, team, or slot references.
- **Audit**: `recordAudit(action: 'practice.saved', ...)`.

### 2.4 `game-persistence`

- **Purpose**: Persist reviewed game schedules and manual game moves after the routed game page stages them for apply/rollback.
- **Invoked by**: `frontend/src/utils/gamePersistenceClient.js` via a direct POST to `/functions/v1/game-persistence`.
- **Authentication**: Same JWT + role allow-list + Zod payload as the other persistence functions; verifies `runMetadata.organizationId`, `runMetadata.seasonSettingsId`, and all target home/away teams resolve to exactly one caller organization before using the service client. The RPC also rejects cross-org game slots, fields, teams, and season references.
- **Rate limit**: `checkRateLimit(user.id)` — default 60 req/min.
- **RPC used**: `persist_game_schedule(run_data, assignments)`; returns the persisted scheduler run id, links current assignment rows to that run via `game_assignments.run_id`, and rejects cross-org season, team, slot, or field references.
- **Audit**: `recordAudit(action: 'game.saved', ...)`.

### 2.5 `fairness-scoring`

- **Purpose**: Evaluate a practice and/or game schedule against the Edge scoring engine in `supabase/functions/_shared/engines/scoring-engine.ts` (a separate implementation from `packages/core`'s — see §3.5). Returns `metrics_summary` and structured `findings`. With `persist: true`, also writes an `evaluation_runs` row through the three-arg `persist_evaluation_run` overload.
- **Invoked by**: `frontend/src/components/EvaluationPanel.jsx` via `supabase.functions.invoke('fairness-scoring', …)`.
- **Authentication**: `getUserFromRequest()` + `verifyOrgMembership(supabase, user.id, body.organizationId)`.
- **Rate limit**: `checkRateLimit(user.id)` with the default 60 req/min.
- **RPC used**: `persist_evaluation_run(p_run_data, p_findings, p_metrics)` when `persist: true`.
- **Audit**: Writes an `evaluation.run` audit row via `recordAudit()` when persisted.

### 2.6 `auto-scheduler`

- **Purpose**: Phase 8 Intelligent Auto-Scheduler. Runs a Hill Climbing optimization loop (seeded PRNG, greedy seed + swap/relocate/chain-swap mutations) on the edge isolate. Scores each candidate via the scoring engine. Publishes realtime progress via `scheduler.auto_progress` audit events that the frontend subscribes to. Hard-capped at 140 s wall-clock and yields periodically to avoid CPU-budget violations.
- **Invoked by**: `frontend/src/hooks/useAutoScheduler.js` via a direct `fetch` to `/functions/v1/auto-scheduler`.
- **Authentication**: `getUserFromRequest()` + `verifyOrgMembership()` + `checkRateLimit()`.
- **Rate limit**: Enforced via the shared `rateLimit.ts` helper.
- **RPC used**: `persist_evaluation_run(p_run_data, p_findings, p_metrics)` for the final best result; `record_audit_event` directly for the `scheduler.auto_started` / `scheduler.auto_progress` / `scheduler.auto_completed` / `scheduler.auto_failed` stream.
- **Logging**: Structured events via `_shared/logtail.ts` → BetterStack (gated on `BETTERSTACK_SOURCE_TOKEN`).

### 2.7 `calendar-feed`

- **Purpose**: Public ICS calendar feed for a single team. Generates an RFC 5545-compliant `.ics` body with team games and expanded practice occurrences.
- **Invoked by**: External calendar clients via `webcal://` URLs subscribed in `frontend/src/pages/TeamPortalPage.jsx`.
- **Authentication**: Token-based via `?token=<uuid>` query parameter. The token is a UUID stored on `teams.calendar_token` with a 90-day expiry (`teams.calendar_token_expires_at`). Expired tokens return `403`. No JWT or org-membership check — the token itself is the authorization grant. Rotated via the `rotate_calendar_token` RPC.
- **Rate limit**: Not enforced (public read surface; protected by UUID-token unguessability).
- **Service-role**: Yes. The function uses the service-role client specifically because there is no authenticated user session; RLS would otherwise block the read. The token validates the request instead.
- **RPC used**: None (reads only).

### Shared Summary

| Function               | Entry                           | Lines | Auth                               | Rate limit | RPC called                                             | Service-role read? | Invoked by                 |
| ---------------------- | ------------------------------- | ----- | ---------------------------------- | ---------- | ------------------------------------------------------ | ------------------ | -------------------------- |
| `import-validation`    | `import-validation/index.ts`    | ~315  | JWT + org scope                    | Yes        | — (writes directly)                                    | —                  | `ImportContext.jsx`        |
| `team-persistence`     | `team-persistence/index.ts`     | ~285  | JWT + role allow-list + IDOR guard | Yes        | `persist_team_schedule`                                | —                  | `teamPersistenceClient.js` |
| `practice-persistence` | `practice-persistence/index.ts` | ~290  | JWT + role allow-list + IDOR guard | Yes        | `persist_practice_schedule`                            | —                  | Frontend practice utils    |
| `game-persistence`     | `game-persistence/index.ts`     | ~330  | JWT + role allow-list + IDOR guard | Yes        | `persist_game_schedule`                                | —                  | `gamePersistenceClient.js` |
| `fairness-scoring`     | `fairness-scoring/index.ts`     | ~230  | JWT + `verifyOrgMembership`        | Yes        | `persist_evaluation_run` (3-arg)                       | —                  | `EvaluationPanel.jsx`      |
| `auto-scheduler`       | `auto-scheduler/index.ts`       | ~800  | JWT + `verifyOrgMembership`        | Yes        | `persist_evaluation_run` (3-arg), `record_audit_event` | —                  | `useAutoScheduler.js`      |
| `calendar-feed`        | `calendar-feed/index.ts`        | ~220  | Token-based (`?token=`)            | No         | —                                                      | Yes                | External ICS clients       |

Line counts are approximate and drift as features evolve. The source of truth is `supabase/functions/<name>/index.ts`.

## 3. Shared Utilities

Located under `supabase/functions/_shared/`.

### 3.1 `_shared/auth.ts`

Exports used by every function (except `calendar-feed`, which is token-based):

- `getUserFromRequest(request, serviceClient)` — parses `Authorization: Bearer <jwt>`, calls `supabase.auth.getUser(token)`, returns `User` or `null`. Service-role client is used _only_ for `auth.getUser()`, never for data reads.
- `verifyOrgMembership(serviceClient, userId, organizationId)` — single-org membership check against `organization_members`.
- `getUserOrgIds(serviceClient, userId)` — returns _all_ organization IDs the user belongs to. Used for IDOR guards that must check each target org.
- `resolveOrgIdsFromTeamIds(serviceClient, teamIds)` — returns the distinct `organization_id`s implied by a batch of `team_id`s. Used by `practice-persistence` and `game-persistence` to guard against cross-tenant payloads.
- `recordAudit(serviceClient, {organizationId, action, resourceType, resourceId, metadata})` — fire-and-forget audit log write via the `record_audit_event` RPC. Failures are logged but never block the response.
- `corsHeaders` — canonical `Access-Control-Allow-*` headers including `GET, POST, PATCH, PUT, DELETE, OPTIONS` in the methods list.
- `jsonResponse(payload, status)` — JSON response helper that includes `corsHeaders`.

### 3.2 `_shared/rateLimit.ts`

In-memory per-user sliding-window rate limiter (Phase 3.2, finding M-4). Defaults to 60 requests per minute per user. Per-isolate rather than global — a single user flooding a specific Edge Function is blocked; global protection relies on Supabase's gateway-level limits. Exports `checkRateLimit(userId, config?)` and `rateLimitExceededResponse(result)`.

### 3.3 `_shared/logtail.ts`

BetterStack (Logtail) structured logger. Gated behind `BETTERSTACK_SOURCE_TOKEN` env var; when absent, logs are `console`-only. Exported as `edgeLogger` with `.info`, `.warn`, `.error`, and `.flush()` methods. Used by `auto-scheduler` for the progress stream.

### 3.4 `_shared/schemas/scoring.ts`

Zod schemas shared by `fairness-scoring` and `auto-scheduler`: `TeamSchema`, `SlotSchema`, `PracticeAssignmentSchema`, `GameAssignmentSchema`, and the top-level `ScoringInputSchema`. Uses `.passthrough()` to tolerate additional fields without schema drift blocking the caller.

### 3.5 `_shared/engines/scoring-engine.ts`

The Edge arm of the scoring engine. Exports `evaluatePracticeSchedule()` and `evaluateGameSchedule()`.

**It is not shared with the browser, and the same bytes do not run in both places** — which is what this entry claimed until the two arms were measured. The browser uses `packages/core/src/practiceMetrics.js` and `gameMetrics.js`; this is a separate, narrower reimplementation, written because an Edge Function cannot import `packages/core`. Core's practice report publishes thirteen top-level keys, this one six, and only three names appear in both. While the "same bytes" claim stood, the two drifted on `summary.assignedTeams` (rows here, distinct teams in core) and published a negative `unassignedTeams`.

The fields the two arms must agree on, and the ones that are deliberately arm-specific, are stated and enforced in `tests/scoringEngineDrift.test.js`, which imports both and runs them over one vector table.

### 3.6 `_shared/tests/scoring-engine_test.ts`

Deno-runtime unit test for the scoring engine. Runs under `deno test` rather than Vitest; not part of the main `npm run test` suite.

### 3.7 `_shared/import_map.json` (at `supabase/functions/import_map.json`)

Shared dependency pinning. Lets individual function files import `'zod'` (and similar bare specifiers) consistently, rather than hard-coding full URLs per file.

## 4. When to Add a New Edge Function

Default to an RPC. Reach for an Edge Function only when at least one of the following holds:

| Signal                                                                        | Choose            | Why                                                                                                                      |
| ----------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Pure DB work (read, write, or transaction across tables all in one org)       | **RPC**           | Cheapest transport, strongest RLS story, no cold-start, free tier.                                                       |
| Need to call an external API (BetterStack, Sentry, a partner service)         | **Edge Function** | The database cannot make outbound HTTP calls on Supabase's free tier.                                                    |
| Need to validate and sanitize a client payload before it touches tables       | **Edge Function** | Keeps parsing, size caps, and string sanitization out of RPC bodies. See `import-validation`.                            |
| Need to rate-limit per user for DoS protection                                | **Edge Function** | Postgres has no request context. The `_shared/rateLimit.ts` helper is isolate-scoped but sufficient for per-user abuse.  |
| Need CPU isolation for a long-running loop (scheduler, scoring, optimization) | **Edge Function** | An RPC blocks the Postgres connection; edge isolates have their own 140 s wall-clock budget. See `auto-scheduler`.       |
| Need to stream realtime progress to the caller                                | **Edge Function** | `audit_log` INSERT during long work triggers Supabase Realtime subscriptions; RPCs don't produce mid-transaction events. |
| Need token-based public read without JWT                                      | **Edge Function** | The token check lives in the function body; no authenticated session means no RLS context. See `calendar-feed`.          |

When the answer is "Edge Function," still keep the function thin: authenticate, validate, re-check org membership, then call an RPC to do the actual mutation. The current `team-persistence` / `practice-persistence` functions are the template. Long-lived business logic inside an Edge Function body (like the auto-scheduler's 800 lines) is the exception, not the rule — and only because the work is CPU-bound and inherently edge-shaped.

## 5. Cost Discipline

Edge Functions are the single most expensive free-tier line item if they runaway (per-invocation CPU, egress, and cold-start minutes). Keep function bodies small and reuse RPCs.

- **Asset-size discipline** for the frontend sits in [`operations/bundle-budget.md`](../operations/bundle-budget.md). Edge Function cost and complexity discipline is covered in [`operations/edge-function-budget.md`](../operations/edge-function-budget.md).
- Avoid importing heavyweight deps into Edge Functions. Prefer `std@` and `esm.sh` with a pinned version; `_shared/import_map.json` exists specifically so shared deps load once.
- Do not log PII into `console.*` — BetterStack ingestion is structured and regulated by the `logtail.ts` helper. Raw `console.error` in an Edge Function still reaches the Supabase log pipeline; treat it with the same scrutiny.

## 6. Known Gaps

v1.1-deferred items surfaced while writing this inventory:

- **pgTAP coverage is broader than the original RLS baseline but still not Edge-Function-complete.** The 31 SQL test files in `supabase/tests/` cover RLS plus many RPC contracts used by Edge Functions, but they do not execute every Edge handler branch directly. Continue adding targeted pgTAP or Deno tests when Edge/RPC contracts change.
- **No observed invocation telemetry baseline.** We have the BetterStack hook but no dashboard that tracks per-function invocation counts or p95 latency. When that's in place it belongs in [`operations/`](../operations/) alongside `sentry-smoke.md`.
- **`calendar-feed` token leakage risk.** The token is a plain UUID query parameter; any intermediary that logs URLs (browser history, proxy logs, analytics) could capture it. Mitigated by 90-day expiry + `rotate_calendar_token` RPC, but consider HMAC-signed tokens in v1.1.
- **`auto-scheduler` is 800+ lines in a single file.** A lot of Hill Climbing detail lives inline. Candidate for extraction into `_shared/engines/` on the next refactor pass, similar to how the scoring engine lives there.
