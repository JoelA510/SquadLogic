[← Back to Documentation Index](../README.md)

# Release Prep Closure

**Last refreshed:** 2026-10-22, for release **1.2.0**.
**Status:** release candidate. The code side is closed; the operator checks below not marked
done remain the owner's before the `v1.2.0` tag.

This page records the evidence behind the release and what it does not cover. It claims only what
was checked on the date above; each item says how.

## Verified Evidence (2026-10-22)

- **Release contents:** `CHANGELOG.md` section `[1.2.0] - 2026-10-22`: everything merged after
  the 1.1.0 cut (`4459faf`, #622): idempotent evaluation-run saves (#624), the team-count
  recommendation (#626), Phase A (privacy and access), the `admin_delete_team` and UTC-idiom
  fixes, and the plans for phases B to E. `package.json` and the lockfile's root entry move to
  `1.2.0` (`npm version`); the `[1.1.0]` section is unchanged. No tag exists on the remote yet
  (*executed*: `git ls-remote --tags origin` lists none); a draft `v1.2.0` release exists.
- **Migrations, repo against production** (*executed*): 143 SQL migrations under
  `supabase/migrations/` on `main`, and 143 versions in production's
  `supabase_migrations.schema_migrations`, from `20240405180000` to `20261021040000`. CI is the only
  writer (AGENTS.md section 11); the last deploy job (`main` CI run 1507, commit `6a22d29`) pushed
  `20261021040000` and found nothing pending.
- **Database tests:** 63 pgTAP files under `supabase/tests/`, run by the required `Run pgTAP
  against local Supabase` check on every pull request; the migration harness (smokes, reverts,
  planted defects) runs on every pull request touching SQL.
- **Production deployment** (*executed*, Vercel API): `dpl_6zRCz24Tga9nxjTd9gDJjcAAQ3AM` is `READY`,
  target `production`, for `main` commit `6a22d29` (#633). Confirm again for the release commit
  (operator check below).
- **Production security advisors** (*executed*, Supabase advisors, 2026-10-22): no ERROR. WARN:
  - `authenticated_security_definer_function_executable` (98): the RPC layer. Every state write is
    a SECURITY DEFINER RPC that checks the caller itself (AGENTS.md: RPC enforcement), and
    `supabase/tests/definer_function_grants.sql` holds the grants. Accepted by design.
  - `anon_security_definer_function_executable` (1): `submit_registration`, the public
    registration form, excluded on purpose from the anon revoke
    (`20260603120000_revoke_anon_execute_on_definer_functions.sql`). Accepted then; migration
    `20261022020000` drops the function, so the next refresh expects 0, and
    `supabase/tests/definer_function_grants.sql` asserts anon can run no SECURITY DEFINER function.
  - `function_search_path_mutable` (1): `public.min(uuid)` is an aggregate, which cannot carry
    `SET search_path`; its state function `min_uuid` pins it
    (`20260612000000_min_uuid_aggregate.sql`). A false positive.
  - `auth_leaked_password_protection` (1): needs the Pro plan; accepted with compensating controls
    in [leaked-password-protection.md](./leaked-password-protection.md).

  The June refresh recorded 68 WARN findings in other categories (5 mutable search paths, 31
  anon-executable definer functions); those are closed.
- **Node parity:** `.nvmrc` 24, `engines.node` `^24.15.0`, CI reads `.nvmrc`, Vercel builds on
  `24.x` (remediation plan item M1.4).
- **Release checks:** `npm ci`, `npm run typecheck`, `npm run lint`, `npm run check:unused`,
  `npm run test:coverage`, `npm run frontend:build`, `npm run check:bundle`,
  `npm run check:advisors`, `npm run test:e2e -- --workers=1`, and the pgTAP suite; each ran green
  in CI on the pull requests that make up the release.

## Explicit Deferrals

- **Lighthouse:** no repo-native command. Run it manually against production and record the URL,
  mode, device profile and score before claiming it.
- **Sentry:** the SDK is wired and its release tag pinned (`tests/sentryConfig.test.js`).
  `VITE_SENTRY_DSN` is set in Vercel Production (*owner-confirmed* 2026-10-22; the Vercel API
  refused to list environment variables to us, 403). That an event reaches Sentry was not
  checked: [sentry-smoke.md](./sentry-smoke.md).
- **Storage retention:** the scheduled `Cleanup storage buckets (retention)` workflow failed its
  runs from 2026-10-20 to 2026-10-22 for lack of its two Actions secrets. The owner set them on
  2026-10-22, and a manual dry run (run 183) passed both jobs (*executed*). Both buckets held no
  objects (*executed*, `storage.objects`), so that run proved the secrets are present and the list
  call is accepted, not a deletion ([storage-retention.md](./storage-retention.md)).
- **Phases B to E:** planned (`docs/changes/2026-10-22-phase-*.md`), not built; each waits for the
  owner's approval. They are not part of 1.2.0.

## Operator Checks Before Tagging

- Confirm the production deployment for the release commit (the merge of this release PR) is
  `READY` in Vercel.
- Done 2026-10-22 (*owner-confirmed*): Vercel Production sets `VITE_SENTRY_DSN`,
  `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, and not `VITE_USE_MOCK_SUPABASE`; the live
  `main` ruleset matches `.github/rulesets/main.json`. Done (*executed*): the retention secrets
  and a green dry run (run 183).
- Tag `4459faf` (#622, the 1.1.0 cut) as `v1.1.0`, so that release has its own tag.
- Publish the draft `v1.2.0` release with its target set to the merge commit of this release PR
  (publishing creates the tag there), using the `[1.2.0]` notes.

## Demo launch (owner checklist)

Demo mode (`docs/changes/2026-10-22-demo-mode.md`, D3 to D5) is merged dark: nothing shows until the
steps below, in this order. The settings live in Supabase, Cloudflare and Vercel, outside the
repository, so none of this is *executed* by the code's checks; each step names how to confirm it.

1. **Migrations applied.** `deploy-migrations` has pushed `20261030010000` (the demo organization,
   its fences and the purge job) and `20261031010000` (anonymous sign-ins skip the password-length
   check). Confirm: `supabase migration list` shows both, and `select jobname from cron.job` lists
   `purge-expired-demos`. **Do not enable anonymous sign-ins before this:** the fences are what keep
   an anonymous visitor out of everything real.
2. **Production's password-length function.** `20261031010000` replaces
   `public.check_password_length_on_auth_users()` in place (no trigger DDL: the deploy role does not own
   `auth.users`), so an anonymous insert skips the check and a first password is checked like any
   change. Read on 2026-10-26 (*executed*, read-only): the function body's md5 is
   `bfc595ef5b1716f20b70f5182f4d5bf4`, the repository's text with its comments stripped. The migration
   replaces only a body whose md5 is that, the build's (`57d76d79...`, or `be77982e...` without carriage
   returns) or the revert's; any other aborts the deploy. Confirm after it deploys:
   `select prosrc from pg_proc where proname = 'check_password_length_on_auth_users'` shows
   `NEW.is_anonymous IS TRUE` and `IS DISTINCT FROM`, and `proconfig` is `{search_path=public}`.
3. **Turnstile.** Create a Cloudflare Turnstile widget that allows the official domain. Keep its
   site key (public) and secret key.
4. **Vercel Production variables:** `VITE_DEMO_ENABLED=true`, `VITE_OFFICIAL_SITE_URL` (the
   official deployment's URL, on this project only) and `VITE_TURNSTILE_SITE_KEY` (the site key).
   Redeploy: they are read at build time. Confirm the sign-in page shows **Try the demo**.
5. **Supabase, Authentication:** enable **anonymous sign-ins**, then enable **CAPTCHA protection**
   (provider Turnstile, the secret key). **Deploy step 4 first**: CAPTCHA covers sign-in, sign-up,
   password reset and anonymous sign-in, and an app without the site key cannot send the token.
6. **Try it:** from a private window, **Try the demo**; see the timer; try to import (the notice
   opens); leave. Then confirm the purge: the demo's organization is gone within ten minutes of its
   expiry, and `select * from demo_purge_log order by ran_at desc limit 3` shows runs.
7. **Confirm the watch:** the `Demo purge health` workflow (`demo-health.yml`) has run green once
   (Actions, run it by hand with `workflow_dispatch` if no scheduled run has happened yet).

Rollback is `docs/changes/2026-10-22-demo-mode.md`, "Risks and rollback": unset
`VITE_DEMO_ENABLED` and redeploy, disable anonymous sign-ins, then (only if wanted) revert the
migrations with their `docs/sql/` scripts.

## Rollback

This page and the changelog are docs only: revert the PR that changed them. Migrations from
`20260530000000` on have a revert under `docs/sql/`, except four recorded as deferred gaps in the
remediation plan: `20260602010000`, `20260603190000`, `20260612000000` and `20260612000001`.
Earlier migrations predate the revert rule. Tagging runs none of them.
