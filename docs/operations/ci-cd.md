[← Back to Documentation Index](../README.md)
---

# CI/CD Operations

## GitHub Actions

The primary workflow is [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml).
It runs on pushes to `main`, pull requests targeting `main`, weekly
Supabase keep-alive schedules, and manual dispatch.

## Reproducibility

CI installs dependencies with `npm ci` from `package-lock.json`. The local
fresh-checkout baseline is:

```bash
npm ci
npm run typecheck
npm run lint
npm run test
npm run frontend:build
npm run check:bundle
npm run check:advisors
```

`npm run check:bundle` must run after `npm run frontend:build` because it
reads `dist/assets`. If the build artifact is missing, the bundle gate fails
loudly and tells the operator to build first.

## Pull Request Scope

PRs that touch only Markdown or files under `docs/` run a docs-only path:

- checkout
- changed-file classification
- `git diff --check`

All code, config, workflow, package, Supabase, test, or asset changes run the
full Node/build/test matrix. Workflow files are intentionally not considered
docs-only, even when their changes are comment-only, because they affect
release automation.

## Artifacts

The full matrix uploads these artifacts when present, including on failure:

- Playwright HTML report: `playwright-report/`
- Playwright traces, screenshots, videos, and error contexts: `test-results/`
- Bundle-budget command output: `bundle-budget-report.txt`
- Coverage output: `coverage/`

The Playwright artifact upload is part of the failure triage loop: use the
HTML report and trace zip before changing feature files or assertions.

## Scheduled Jobs

The weekly keep-alive job validates `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY`, then pings the Supabase REST API. Missing secrets
or API failures fail the scheduled run; the workflow must not silently hide a
paused or unreachable project.

Raw import retention is handled by
[`.github/workflows/cleanup-raw-imports.yml`](../../.github/workflows/cleanup-raw-imports.yml).
It requires `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, validates
`dry_run`, and fails fast when either secret is missing.

## Edge Functions (`deno-mirror-tests`)

The `deno-mirror-tests` job runs on pushes and pull requests. It has two steps,
and `deploy-edge-functions` needs both to pass:

- `scripts/deno-mirror-tests.sh` runs `deno test` on every `_shared/tests/`
  file, under two host zones. This type-checks only the tests and what they
  import. No test imports an `index.ts`.
- `scripts/deno-check-edge.sh` runs `deno check` on each Edge entrypoint. It
  finds every directory directly under `supabase/functions/`, except
  `_`-prefixed ones like `_shared`. A new function is checked without editing
  the script. The script fails if it finds no function directories, or if a
  function directory has no `index.ts`.

Both scripts set `DENO_NO_PACKAGE_JSON=1` and use
`supabase/functions/import_map.json`. Run them locally with
`bash scripts/deno-check-edge.sh` and `bash scripts/deno-mirror-tests.sh`.

We have not confirmed whether `supabase functions deploy` type-checks. The
Supabase docs say it bundles each function into an ESZip. Their deploy
troubleshooting guide suggests running `deno check` as a separate step. Do
not count on the deploy to catch type errors. `calendar-feed` had two type
errors on `main`, and every gate still passed (#483).

## Database migrations (`deploy-migrations`)

Approved by the operator on 2026-09-28. Until then CI deployed Edge Functions
but applied no migrations, and production fell 17 migrations behind.

**When it runs.** On push to `main` only, after `build-and-test` succeeds. It
uses the GitHub `production` environment, and `deploy-edge-functions` now
`needs:` it, because functions can depend on new database objects. A failed
migration run therefore also blocks the function deploy.

**Steps.** `supabase link` → `supabase migration list` → `supabase db push
--dry-run` → safety guard → `supabase db push --yes` → `supabase migration list`
plus a verify step that fails if anything is still pending. The CLI is pinned to
`2.118.0` through `supabase/setup-cli@v1`, because the guard parses that
version's `--output-format json` output. (`deploy-edge-functions` still uses
`version: latest`.)

**The guard** ([`scripts/ci/migrationGuard.mjs`](../../scripts/ci/migrationGuard.mjs),
tests in `tests/migrationGuard.test.js`) fails the job before anything is
applied when:

- a pending version is `<=` the highest version already applied (out of order).
  _Fix:_ rename the file to a later timestamp in a new PR. If it is already
  applied in substance, record it with
  `supabase migration repair --status applied <version>` instead;
- more than `MAX_PENDING_MIGRATIONS` are pending. The default is 5; override it
  with a repository **variable** of that name. _Fix:_ compare
  `supabase migration list` with production. If the batch is intended, raise
  the variable for one run and then remove it;
- the remote ledger is empty, or has versions with no local file. _Fix:_ see
  [`migration-ledger-normalisation.md`](./migration-ledger-normalisation.md).
  **Never** run `migration repair --status reverted` on production: that is
  the replay-everything path;
- `migration list` and the dry-run disagree about what is pending, or the dry
  run would push seed data;
- either CLI output is not the expected JSON. Unparseable output is a failure,
  never a pass.

**Missing secrets.** The job follows the same contract as
`deploy-edge-functions`: if `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_ID` or
`SUPABASE_DB_PASSWORD` is missing, it logs a `::warning::`, writes a
"Database migrations SKIPPED" line to the job summary, and succeeds without
migrating. Edge Functions still deploy in that case, as they did before this job
existed.

**Reverts are never automatic.** A migration that applies and later proves
wrong is reverted by hand with its `docs/sql/<version>_revert.sql`, followed by
a forward-fix migration. CI never runs a revert. If `db push` fails part-way,
the failing migration's own transaction rolls back. Earlier migrations in the
same push stay applied, and the verify step fails and shows which ones.

**Ordering hazards the guard cannot see.** A migration whose runbook says
"deploy the frontend first" (see `production-cutover.md`) must now ship in its
own PR, after the frontend PR has deployed. The Vercel deploy and this job both
start on the same push.

**PR-time static check.** The Build & Test job runs
[`scripts/ci/migrationVersions.mjs`](../../scripts/ci/migrationVersions.mjs).
It checks that every migration is named `<14-digit version>_<name>.sql` (the CLI
silently skips anything else) and that every version is unique (the single
owner of that rule; `tests/migrationVersions.test.js` runs it against the real
directory). On pull requests it also checks that every **added** migration has a
version greater than the latest on the base branch, and that no existing
migration was renamed, edited or removed. It needs no secrets.

### Operator setup (GitHub)

1. **Secret `SUPABASE_DB_PASSWORD`** (new). This is the production database
   password for project `mmwupqsjkikqzvmdvuzm` (Supabase dashboard → Project
   Settings → Database). `SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_ID`
   already exist for the Edge Function deploy.
2. **Environment `production`** (Settings → Environments). Add **required
   reviewers** so every migration run waits for an approval. Note that
   `deploy-edge-functions` waits on this job, so it waits for the approval too.
   If the secrets are moved into the environment, keep them available to the
   `deploy-edge-functions` job as well, which does not use the environment.
3. Optional **variable `MAX_PENDING_MIGRATIONS`** (Settings → Variables) to
   change the default limit of 5.
4. The one-time ledger normalisation in
   [`migration-ledger-normalisation.md`](./migration-ledger-normalisation.md)
   was **executed on production on 2026-09-28** (117 rows, `20240405180000` …
   `20260924000000`; the original 141 rows are kept in
   `supabase_migrations.schema_migrations_backup_20260928`). Without it the
   guard would fail every run, because the ledger's apply-time versions were
   remote-only.

**First run.** The first push to `main` after this job lands applies
`20260927000000_coach_practice_preferences` (#453) and
`20260928000000_reconcile_prod_rls_drift` (#454), and nothing else. Once that
run is green, drop the ledger backup table (see the normalisation doc).

**From now on, CI is the only writer of repo migrations.** Do not apply a repo
migration through the Supabase MCP `apply_migration` tool. It records an
apply-time version, and the next push would try to run the file again.

## Branch Protection

`main` must be protected before release work can merge. Required checks should
include the primary CI workflow, CodeQL, the Vercel deployment check, and the
pgTAP workflow for database-affecting pull requests. Conversation resolution
and pull-request review should remain required.

## Rollback

Workflow changes are rolled back by reverting the pull request that introduced
them. Reverting a workflow change does not undo migrations that
`deploy-migrations` has already applied. Those are reverted by hand; see
[Database migrations](#database-migrations-deploy-migrations).
