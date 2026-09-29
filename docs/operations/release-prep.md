[← Back to Documentation Index](../README.md)

# Release Prep Closure

**Last refreshed:** 2026-06-11
**Status:** Code-completable release-prep hardening is current through the Lightning-class redesign merge (PR #322); not a final release sign-off.

> **2026-06-11 update:** the Lightning-class redesign merged with five new
> migrations (`20260611000000`–`20260611000400`: player roster fields, audited
> admin mutation RPCs, expanded GotSport mapping, audit-action whitelist,
> `team_players` sync trigger). Before final sign-off, apply the batch to
> production and re-run the Supabase advisors; the open operator items
> (Sentry DSN, leaked-password protection, branch protection) are tracked in
> [`docs/expansion/03_ROADMAP.md`](../expansion/03_ROADMAP.md) §Open Items.

This page closes the current release-prep documentation drift. It does not
replace the final review-pass sign-off, and it does not claim production
security, database, or observability settings that were not directly verified.

## Verified Evidence

- **Current repo head:** local `main` and `origin/main` are at
  `7c5793bde74d0734ce8f0d14eca419e49e8bcb55`, the squash merge for PR #268
  (`chore(supabase): untrack cli temp state`).
- **Recent merged production-readiness PRs:** #257 registration-form writes, #258
  invite revoke, #259 schema-builder saves, #260 facility mutations, #261 team
  portal communication writes, #262 import job lifecycle writes, #263 release
  evidence refresh, #264 Edge Function budget guidance, #265 legacy evaluation
  RPC overload removal, #266 legacy `current_user_role()` removal, #267 release
  evidence refresh, and #268 Supabase CLI temp-state untracking.
- **Frontend direct-write scan:** `rg -U` found no routed Supabase
  `insert`/`update`/`upsert`/`delete` calls under `frontend/src` outside the mock
  client. The only generic mutation matches in app code were local cache
  `Map.delete()` operations in `frontend/src/lib/cache.js`.
- **Vercel project:** `secureyourtech/squadlogic`
  (`prj_tdCn9qLkRFB9LFAVmp2AKJCkcDJ9`) exists, reports framework `vite`, and
  reports Node `24.x`. Project domains reported by the connector are
  `squadlogic.vercel.app`, `squadlogic.secureyour.tech`,
  `squadlogic-secureyourtech.vercel.app`, and
  `squadlogic-git-main-secureyourtech.vercel.app`.
- **Latest Vercel deployment visible in connector:** deployment
  `dpl_9ceG8vFfde3TZ2XCLrNv8swHK3pW` is `READY` for `main` commit
  `7c5793bde74d0734ce8f0d14eca419e49e8bcb55` (PR #268); its target is
  `production`.
- **GitHub `main` branch protection:** GitHub API returned `404 Branch not
  protected` for `repos/JoelA510/SquadLogic/branches/main/protection` during
  this refresh after PR #268 merged.
- **Repo migration inventory:** 74 SQL migration files are present locally; the
  latest file is
  `supabase/migrations/20260504100000_drop_current_user_role_helper.sql`.
- **Repo pgTAP inventory:** 31 SQL test files are present under
  `supabase/tests/`, covering RLS plus targeted RPC contracts added during the
  production-readiness PR queue.
- **CI and DB harness:** PR #209 restored hosted CI/E2E; PR #211 restored local
  and hosted pgTAP for DB-affecting PRs. PR #262 hosted checks reported
  `Build & Test`, pgTAP, CodeQL, GitGuardian, and Vercel as passing. PR #266
  hosted checks reported `Build & Test`, pgTAP, CodeQL, GitGuardian, and Vercel
  as passing before merge. PR #268 hosted `Build & Test`, CodeQL, and
  GitGuardian passed before merge; Vercel's PR status failed because the project
  hit the free daily deployment quota, but the connector later reported the
  `main` production deployment above as `READY`.
- **Production Supabase security advisors:** `supabase db advisors --linked
  --type security --level warn --fail-on error` returned zero ERROR-level
  issues but 68 WARN findings: 5 `function_search_path_mutable`, 31
  `anon_security_definer_function_executable`, 31
  `authenticated_security_definer_function_executable`, and 1
  `auth_leaked_password_protection` (see
  [leaked-password-protection.md](./leaked-password-protection.md)). This is
  verified as **not clean** and must be remediated or formally accepted before
  final release sign-off.
- **Release checks available today:** `npm ci`, `npm run typecheck`,
  `npm run lint`, `npm run test`, `npm run test:coverage`,
  `npm run frontend:build`, `npm run check:bundle`,
  `npm run check:advisors`, `npm run test:e2e -- --workers=1`, and
  `npm run test:db`.

## Explicit Deferrals

- **Final Lighthouse score:** no repo-native Lighthouse command exists. Use
  browser/manual Lighthouse during Task 9 or Task 10, then record the exact
  URL, mode, device profile, and score. Do not claim Lighthouse closure before
  that evidence exists.
- **Performance budget tightening:** current bundle budgets remain the active
  gate. Chart-vendor splitting, asset optimization, and tighter earned budgets
  are deferred to the performance polish task.
- **Vercel/CI Node parity:** resolved 2026-06-12 — CI now verifies on Node 24,
  matching the Vercel runtime (`package.json` still declares `>=20` as the
  minimum supported runtime). The original release-prep decision had deferred
  this to a separate fully-verified PR.
- **Production Supabase migration reconciliation:** exact linked migration
  listing requires `SUPABASE_DB_PASSWORD` in this environment after
  `supabase/.temp/` became local-only. Operators must run
  `supabase migration list --linked` with the production DB password and
  reconcile local-vs-remote history before final release sign-off.
- **Sentry:** the SDK is wired, but `VITE_SENTRY_DSN` production/preview values
  and the synthetic event smoke remain operator-owned until verified with
  [`sentry-smoke.md`](./sentry-smoke.md).

## Operator Checks Before Final Sign-Off

- Configure `main` branch protection and required checks, or document an
  intentional exception. Connector/API evidence during this refresh showed
  `main` was not protected.
- Confirm the production-target Vercel deployment for the intended release
  commit remains `READY` after the final release candidate is chosen.
- Confirm Vercel production/preview environment variables, especially
  `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_USE_MOCK_SUPABASE`, and
  `VITE_SENTRY_DSN`.
- Configure or intentionally disable the raw-import cleanup workflow secrets:
  `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
- Resolve or formally accept the 68 production Supabase security advisor WARN
  findings recorded above.
- Confirm production Supabase migration count and reconcile local-vs-remote
  history with `supabase migration list --linked`.
- Run the full final validation suite listed in the release-readiness plan.

## Rollback

This document is docs-only. Roll back by reverting the PR that changed it. No
runtime, schema, or data rollback is required.
