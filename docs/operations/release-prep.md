[← Back to Documentation Index](../README.md)

# Release Prep Closure

**Last refreshed:** 2026-10-22, for release **1.1.0**.
**Status:** release candidate. The code side is closed; the operator checks below remain the
owner's before the `1.1.0` tag.

This page records the evidence behind the release and what it does not cover. It claims only what
was checked on the date above; each item says how.

## Verified Evidence (2026-10-22)

- **Release contents:** `CHANGELOG.md` section `[1.1.0] - 2026-10-22`, which folds in everything
  merged since 2026-10-20: Phase A (privacy and access), the `admin_delete_team` and UTC-idiom
  fixes, and the plans for phases B to E. `package.json` is already `1.1.0`. No tag exists on the
  remote yet (*executed*: `git ls-remote --tags origin` lists none).
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
    (`20260603120000_revoke_anon_execute_on_definer_functions.sql`). Accepted.
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
- **Sentry:** the SDK is wired and its release tag pinned (`tests/sentryConfig.test.js`), but
  whether `VITE_SENTRY_DSN` is set in Vercel Production was **not verified**: the Vercel API refused
  to list the project's environment variables (403). Follow [sentry-smoke.md](./sentry-smoke.md).
- **Phases B to E:** planned (`docs/changes/2026-10-22-phase-*.md`), not built; each waits for the
  owner's approval. They are not part of 1.1.0.

## Operator Checks Before Tagging

- Confirm the production deployment for the release commit (the merge of this release PR) is
  `READY` in Vercel.
- Confirm `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` and `VITE_SENTRY_DSN` in Vercel Production,
  and that `VITE_USE_MOCK_SUPABASE` is unset or `false` there.
- Confirm the live `main` ruleset requires the checks in `.github/rulesets/main.json` (AGENTS.md
  section 11; `docs/operations/ci-cd.md`, Branch Protection). GitHub does not read that file.
- Tag the release commit `v1.1.0` (or the repository's tag form) and publish the `[1.1.0]` notes.

## Rollback

This page and the changelog are docs only: revert the PR that changed them. The release's
migrations each have a revert under `docs/sql/`; none is run by tagging.
