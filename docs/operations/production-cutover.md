[← Back to Documentation Index](../README.md)
---

# SquadLogic v1.0 — Production Cutover Runbook

**Date written:** 2026-04-01
**Last refreshed:** 2026-06-11 (Lightning-class redesign migrations `20260611000000`–`20260611000400` added to the apply list; open operator items tracked in [`03_ROADMAP.md`](../expansion/03_ROADMAP.md) §Open Items)
**Status:** Historical cutover runbook with current release-prep notes; not a final release sign-off
**Supabase project:** `mmwupqsjkikqzvmdvuzm` (us-west-2)
**Production URL:** https://squadlogic.vercel.app

> **2026-04-17 reconciliation note:** Smoke checks on 2026-04-17 surfaced that prod was ~10 days behind disk — the three 2026-04-16 migrations (`security_hardening`, `initialize_new_tenant`, `data_retention_cron`) were pending, `rotate_calendar_token(uuid)` was missing (prod had a stale `refresh_calendar_token` body against a non-existent `integrations` table), and the `auto-scheduler` + `fairness-scoring` Edge Functions were undeployed. All five gaps were closed during that session via MCP Open advisor items at that time (1 ERROR: `public.import_efficiency_metrics` as `SECURITY DEFINER` view; 4 WARN categories) were subsequently closed by the 2026-04-21 hardening migrations (`security_invoker` on the view, private `raw-imports` bucket, `search_path` locks on definer functions). `VITE_SENTRY_DSN` is still not set in Vercel prod — production errors are not flowing to Sentry until that's wired and a redeploy is triggered.
>
> **2026-05-02 release-prep note:** Vercel reports the `squadlogic` project as framework `vite`, Node `24.x`, and latest production deployment `READY` for `main` commit `30f9aa7e9728008b7038228d9b74b46cc7c2141a` (PR #212). CI currently verifies on Node 20. Keep that runtime split documented until a separate parity PR changes either side with full verification. The repo now contains 49 migration files; production migration/advisor state still needs operator verification before final release sign-off.

---

## System State Checklist (confirm before launch)

| System              | Expected state                                                                                 | How to verify                                       |
| ------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Vercel deployment   | Latest `main` production deployment is `READY`                                                  | Vercel dashboard or connector deployment list       |
| Vercel Node runtime | Project currently reports Node `24.x`; CI baseline remains Node 20                              | Vercel project settings and `.github/workflows/ci.yml` |
| Vercel env vars     | `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` set, `VITE_USE_MOCK_SUPABASE` absent            | Vercel dashboard → Settings → Environment Variables |
| Supabase project    | `ACTIVE_HEALTHY`                                                                                | Supabase dashboard or MCP `get_project`             |
| Database migrations | Production has all repo-required migrations applied; local repo currently has 49 migration files | Supabase dashboard → Database → Migrations          |
| Import lifecycle RPCs | All import RPCs resolve in PostgREST *before* deploying a frontend that calls them; reload schema after applying migrations | Run the readiness query in [`ingestion-pipeline.md`](./ingestion-pipeline.md) §1.4.1          |

Roles and their permissions are defined in `frontend/src/constants/permissions.js`.

---

## Monitoring

**Daily (first two weeks):**

- Supabase dashboard → Reports → API requests. Look for spikes in 4xx/5xx.
- Supabase dashboard → Database → Connection pooling. Free tier limit is 60 direct connections.

**Free-tier keep-alive:**
Supabase pauses free-tier projects after 7 days of inactivity. The scheduled
keep-alive lives in `.github/workflows/ci.yml` and validates required secrets
before pinging the Supabase REST API. It must fail loudly if the project is
unreachable or secrets are missing.

```yaml
jobs:
  keepalive:
    if: github.event_name == 'schedule'
    runs-on: ubuntu-latest
    steps:
      - run: curl -sf "$SUPABASE_URL/rest/v1/" \
               -H "apikey: $SUPABASE_ANON_KEY" \
               -H "Authorization: Bearer $SUPABASE_ANON_KEY"
        env:
          SUPABASE_URL: ${{ secrets.VITE_SUPABASE_URL }}
          SUPABASE_ANON_KEY: ${{ secrets.VITE_SUPABASE_ANON_KEY }}
```

See [`ci-cd.md`](./ci-cd.md) for the current workflow policy and artifact
retention.

---

## Operational Policies (Data Retention & Rate Limiting)

**Data Retention (`pg_cron`)**
As part of the final production cutover, automated `pg_cron` jobs run nightly natively inside the Supabase Postgres instance to prune outdated records and conserve database space:
- `export_jobs` older than 7 days are deleted at 2:00 AM.
- `staging_players` older than 30 days are deleted at 3:00 AM.
- `audit_log` records older than 180 days are deleted at 4:00 AM.

*Verification Steps:*
1. Ensure the `pg_cron` extension is enabled in the Supabase Dashboard (Database → Extensions).
2. Run `SELECT * FROM cron.job;` in the Supabase SQL Editor to verify the jobs are actively scheduled.

**Rate Limiting**
Intensive Edge Functions like the `auto-scheduler` are guarded by a sliding-window rate limiter. This restricts individual users (default 60 requests / minute) using highly accurate rolling timestamp arrays. Hitting this limit yields a `429 Too Many Requests` response along with a `retry_after_ms` field based on the oldest request in the current sliding window.

*Verification Steps:*
1. Navigate to the Vercel dashboard → Settings → Environment Variables.
2. Verify that the rate-limiting configuration variables required by the Edge Functions are present and correctly mapped to the `Production` branch.
3. Verify there are no connection errors to the rate-limiting store in the logs.

---

## Rollback procedure

If a critical issue is discovered post-launch, the app can be rolled back to mock mode in under 5 minutes — no database changes required.

**To roll back to mock mode:**

1. Go to Vercel dashboard → squadlogic project → Settings → Environment Variables.
2. Add: `VITE_USE_MOCK_SUPABASE` = `true` (Production environment only).
3. Go to Deployments → click the last known-good deployment → "Promote to Production" (instant, no rebuild).

Users will see the mock client with seed data. No real data is lost. The Supabase project remains untouched.

**To re-enable the live backend:**

1. Remove the `VITE_USE_MOCK_SUPABASE` env var from Vercel.
2. Trigger a new deployment (push any trivial commit, or use Vercel's "Redeploy" button).

---

## Migration ordering: `20260907000000_field_delete_booking_guard`

**Deploy the frontend BEFORE applying this migration**, not after.

`admin_delete_field` gains a `p_confirm boolean DEFAULT false` parameter and a
refusal, and the 2-argument overload is dropped. Because of the default,
PostgREST still resolves a cached pre-PR bundle's 2-key request body against the
new 3-argument function — so the old bundle keeps *working*, which is the
hazard. In the window between applying the migration and shipping the new
frontend:

1. An admin on the old bundle clicks Delete on a field that has bookings.
2. The RPC refuses and returns `{deleted: false, reason: 'bookings_exist', …}`
   with PostgREST's `error` null — a refusal is a return value, not an error.
3. The old `deleteField` discards `data` and removes the row from local state,
   so the field disappears from the list and reappears on the next refresh.

Nothing is lost — the refusal is real and the field survives — but the operator
is shown a deletion that did not happen, which is the defect this migration
exists to remove. Shipping the frontend first closes the window: the new
`deleteField` reads `data.deleted` and surfaces the refusal.

Rolling back uses `docs/sql/20260907000000_revert.sql`, which restores the
2-argument `admin_delete_field` and the pre-migration `admin_retire_field`. It
raises `EXPOSING N practice_assignment(s)` and `RESTORING admin_retire_field`
warnings naming what the rollback costs; read them rather than discarding them.

---

## What does NOT need a runbook step

- **Historical 2026-04-17 remediation** — the three 2026-04-16 migrations and the two missing Edge Function deployments were already reconciled during that session.
- **Vercel connection** — already connected to GitHub; auto-deploys on every push to `main`.
- **SSL/TLS** — handled by Vercel and Supabase automatically.
- **CORS** — the Supabase project's allowed origins are managed in the Supabase dashboard → Settings → API → CORS. Add `https://squadlogic.vercel.app` if not already present.

## What still needs confirmation before final release sign-off

- **Production migrations/advisors** — verify the production database has the
  current 49-file migration set applied and that security/performance advisor
  output matches the release-readiness summary.
- **Import lifecycle RPCs** — confirm the import lifecycle migrations are applied
  and the PostgREST schema cache is reloaded _before_ deploying any frontend
  bundle that calls `create_import_job` / `fail_stale_import_jobs` and the other
  import RPCs. A 404 / `Could not find public.create_import_job(...)` in the
  browser console means the database is behind the deployed bundle. Use the
  readiness check in [`ingestion-pipeline.md`](./ingestion-pipeline.md) §1.4.1.
- **Sentry** — set and smoke-test `VITE_SENTRY_DSN` if production error
  collection is required for the release.
- **Raw import retention** — configure `SUPABASE_URL` and
  `SUPABASE_SERVICE_ROLE_KEY` Actions secrets, or intentionally disable the
  scheduled cleanup workflow.
- **Branch protection** — enable/validate required checks and conversation
  resolution before final sign-off.
