[← Back to Documentation Index](../README.md)
---

# CI/CD Operations

## GitHub Actions

The primary workflow is [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml).
It runs on pushes to `main`, pull requests targeting `main`, weekly
Supabase keep-alive schedules, and manual dispatch.

## Reproducibility

CI installs dependencies with `npm ci` from `package-lock.json`, on the Node
version `.nvmrc` pins (every `setup-node` step reads it; see
[`ENVIRONMENT.md`](./ENVIRONMENT.md#node-runtime)). The local fresh-checkout
baseline is:

```bash
npm ci
npm run typecheck
npm run lint
npm run test:coverage
npm run test:perf
npm run build
npm run check:bundle
npm run check:advisors
```

`npm run build` (the same as `npm run frontend:build`; plan item M6.1) is a
production build, so it fails, naming the
variable, without `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (plan item
M2.2). CI's step sets well-formed stand-ins; to build what CI builds (and
measures), run
`VITE_SUPABASE_URL=https://ci-build.invalid VITE_SUPABASE_ANON_KEY=sb_publishable_ci-build-stand-in VITE_SENTRY_DSN=https://00000000000000000000000000000000@sentry-ci-build.invalid/0 npm run build`
(the DSN stand-in makes it the shape production ships, with Sentry; without it
`check:bundle` fails, see [`bundle-budget.md`](./bundle-budget.md)).
`VITE_USE_MOCK_SUPABASE=true` also builds, but with the mock chunk, which is
not what CI measures. See [`ENVIRONMENT.md`](./ENVIRONMENT.md#production-safety).

`npm run check:bundle` must run after `npm run build` because it
reads `dist/assets`. If the build artifact is missing, the bundle gate fails
loudly and tells the operator to build first.

`npm run test:coverage` is `npm run test` with v8 coverage, and it fails when
coverage of `packages/core/src/**` and `frontend/src/hooks/**` drops below the
thresholds in `vitest.config.js` (plan item M3.1): about 3 points under what
was measured, overall and, separately, for the hooks, which the well-covered
core would otherwise hide. It leaves out `tests/performance.test.js`, the
team-generation benchmark, which times the engine by the wall clock: v8's
instrumentation slows that engine about 9x, so under coverage it measured the
instrumentation (20.0 s in CI against 0.9-2.1 s without). Build & Test runs it
alone in the next step, `npm run test:perf`, against its 3 s budget. Build & Test's
"Unit & Integration Tests" step runs it; `tests/workflowPins.test.js` fails if
the step goes back to `npm run test` or is made unable to fail.

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

The weekly dependency audit (Mondays 06:00 UTC) is described under
[Dependency audit](#dependency-audit).

Raw import retention is handled by
[`.github/workflows/cleanup-raw-imports.yml`](../../.github/workflows/cleanup-raw-imports.yml).
It requires `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, validates
`dry_run`, and fails fast when either secret is missing.

## Dependency audit

[`.github/workflows/audit.yml`](../../.github/workflows/audit.yml) runs
`npm run check:audit` (`scripts/check-audit.mjs`) on every pull request to
`main`, on pushes to `main`, weekly (Mondays 06:00 UTC) and on manual
dispatch. It fails on any high or critical advisory that
`docs/security/audit-waivers.json` does not waive, on an expired or stale
waiver, and on an audit report it cannot read or reconcile. It reads the
lockfile only (no install), on the npm `package.json` pins. A failed scheduled
run opens one issue, "Dependency audit is failing on main". Policy, waivers and
how to fix an advisory: [`dependency-policy.md`](../security/dependency-policy.md).

**A required check.** The job reports as `npm audit (high and critical block)`,
and `.github/rulesets/main.json` requires it (see
[Branch Protection](#branch-protection)), so a red audit blocks the merge. It can
be required safely: the workflow has no `paths` filter and the job no `if`, so it
reports on every pull request, docs-only ones included.
`tests/checkAudit.test.js` and `tests/rulesetRequiredChecks.test.js` fail if
that changes. A new advisory published against `main` turns every open pull
request red until it is fixed or waived; that is the point.

## Workflow audit

[`.github/workflows/workflow-audit.yml`](../../.github/workflows/workflow-audit.yml)
runs [zizmor](https://docs.zizmor.sh/) (pinned, 1.30.1) over `.github` (every workflow and
`.github/dependabot.yml`; not the template's skeletons under `prompts/`) on pull requests to `main`, pushes to `main` and manual
dispatch (plan item M3.5). Any finding fails the job: an action pinned by tag,
a checkout that keeps the job's token in `.git/config`, an expression
interpolated into a `run:` script, a `pull_request_target` checkout of the pull
request's code, and the rest of zizmor's default audits. With the job's token
it also checks online that each pinned SHA is a commit of the action it names.

- **Pins.** Every `uses:` names a full commit SHA with its release in a comment
  (`actions/checkout@3d3c42e… # v7.0.1`). Dependabot's weekly `github-actions`
  updates (`.github/dependabot.yml`) rewrite both together. To pin a new action
  by hand, resolve the release tag to its commit
  (`git ls-remote --tags https://github.com/<owner>/<action>.git`; for an
  annotated tag take the `^{}` line) and never copy a SHA from memory.
  `tests/workflowPins.test.js` holds the pin shape offline in `npm run test`.
- **Exceptions.** zizmor's configuration is `.github/zizmor.yml`, each loosened
  default with its reason (today one: Dependabot's 3-day cooldown, which
  matches `.npmrc`'s `min-release-age=3`). A one-off is an inline
  `# zizmor: ignore[<audit>] -- <reason>` on the line it excuses.
- **Locally:** `uvx --from 'zizmor==1.30.1' zizmor --offline .github` (or
  `pipx run`), from the repository root.
- **Bumping zizmor:** new audits arrive in minor releases and can fail the job
  on workflows nobody changed, so bump the pinned version by hand, in a pull
  request that fixes or configures what the new release reports.

**Required in `main.json`; enforced once the owner applies it.** The job
reports as `Workflow audit (zizmor)`; it has no `paths` filter and no `if`, so
it reports on every pull request, and `.github/rulesets/main.json` requires it
with the others in [Branch Protection](#branch-protection). GitHub does not
read that file: until the owner adds the check to the live ruleset (the owner
step there), a pull request can merge with this job red.

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
`2.118.0`; see [Supabase CLI version](#supabase-cli-version).

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

### Supabase CLI version

Every `supabase/setup-cli` step installs the CLI with
`version: ${{ env.SUPABASE_CLI_VERSION }}`: the two deploy jobs in `ci.yml` and
the pgTAP job in `pgtap.yml`. The version is set in the workflow-level `env:`
block of each of those two files: **`2.118.0`**. pgTAP pinned `2.95.4` until
plan item M3.2, so the schema CI tested was built by a different CLI from the
one that deployed it; 2.118.0 was kept rather than 2.95.4 because the migration
guard parses 2.118.0's JSON output, and pgTAP's whole suite and the advisors run
green on it (workflow_dispatch run 38484268374).

**Why it is pinned.** With `version: latest`, setup-cli looks up the newest
release through an unauthenticated GitHub API call. On push-to-main runs 1156
(2026-09-29) and 1174 (2026-09-30), that call failed with `Failed to resolve
latest Supabase CLI release: rate limit exceeded`. Each time "Deploy Edge
Functions" failed and `main` went red, although Build & Test had passed and no
deploy command had run. A pinned version needs no lookup. Also, the migration
guard parses this version's `--output-format json` output:

- `migration list`: `{"migrations": [{"local", "remote", ...}]}`;
- `db push --dry-run`: `{"dryRun": true, "upToDate", "migrations": ["<version>_<name>.sql"], "seeds"}`;
- a CLI failure: `{"_tag": "Error", "error": {"message"}}`.

`tests/supabaseCliPin.test.js` fails if any `supabase/setup-cli` step in
`.github/workflows/` uses `latest` or has no version. It also fails if any two
steps in any workflows disagree, or if the version differs from the one named in
the `migrationGuard.mjs` header.

**How to bump it.**

1. Capture the new version's `migration list` and `db push --dry-run` JSON
   against a local, production-shaped ledger (see
   [`migration-ledger-normalisation.md`](./migration-ledger-normalisation.md)).
   Update the fixture shapes in `tests/migrationGuard.test.js` if they changed.
2. In one PR, change `SUPABASE_CLI_VERSION` in `ci.yml` and `pgtap.yml` and the
   version named in the headers of `scripts/ci/migrationGuard.mjs` and
   `tests/migrationGuard.test.js`, and the prerequisites in
   `docs/testing/pgtap.md` and `supabase/tests/README.md`.
3. Run `npm run test`. The pin test fails until all of these agree. The pull
   request's pgTAP run is the proof that `supabase start`, the advisors and the
   suites work on the new version; a new version can bring new advisor lints.

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

## Database tests on pull requests

Three jobs exercise the schema itself. None needs a secret, and none touches
production.

### pgTAP (`pgtap.yml`, required)

[`.github/workflows/pgtap.yml`](../../.github/workflows/pgtap.yml), job
**Run pgTAP against local Supabase**, runs on every pull request to `main` and
on manual dispatch. It starts a local Supabase with the pinned CLI
(`supabase start`, which applies every migration to an empty database), runs
the advisors (next section), then `npm run test:db`: every suite in
`supabase/tests/` (53 files, 662 assertions on 2026-10-13). It skips the
services no suite uses (Edge Functions, Studio, image transformation, the mail
catcher, analytics); the edge runtime's health check once failed a run that
touched none of it. A run takes about two minutes.

It had a `paths` filter until plan item M3.2, so it ran only on pull requests
touching SQL and could not be required: a required check that does not report
blocks the pull request forever. It now runs on every pull request, docs-only
ones included, and the ruleset requires it. The repository is public, so
standard-runner minutes cost nothing. Suite conventions and running it locally:
[`docs/testing/pgtap.md`](../testing/pgtap.md).

### Supabase advisors

The same job runs Supabase's own advisors (the database linter the dashboard's
Security and Performance Advisors use) over the migrated local database:
`supabase db advisors --local --type all --level info --fail-on none
--output-format json`, read by
[`scripts/ci/supabaseAdvisors.mjs`](../../scripts/ci/supabaseAdvisors.mjs)
(plan item M3.3, audit finding 8.6). It fails on:

- any WARN or ERROR finding that
  [`docs/security/supabase-advisor-waivers.json`](../security/supabase-advisor-waivers.json)
  does not waive. A waiver names one lint, the findings it covers by the
  advisor's own `cacheKey` (one per policy, per table, role and action, or per
  function body, so a new policy on a waived table or a changed function body
  is a new finding and blocks), a reason, and `expires`: `null` for a finding
  accepted by design, or a date at most 180 days out for debt (announced as a
  warning in its last 30 days). INFO findings (unindexed foreign keys, unused
  indexes) are reported, never blocking;
- an expired or invalid waiver (it covers nothing), and a stale one: a waived
  finding the advisors no longer report must be removed, or it would
  pre-approve the finding if it came back;
- advisors output it cannot read, a CLI error, or a report with no findings at
  all (this schema always has INFO findings, so an empty report examined
  nothing). These exit 2: "couldn't check" is never "clean".

The CLI's own `--fail-on warn` is not used because it has no waivers. Triage on
2026-10-13 (CLI 2.118.0, 176 findings, 33 at WARN): `function_search_path_mutable`
on `public.min` (an aggregate, which cannot carry a `search_path`) and
`public.set_updated_at` (calls only `now()`), accepted (`20261018040000` later
dropped `set_updated_at`, an orphan only a fresh build had, and its waiver);
`auth_rls_initplan` (11
policies on 9 tables) and `multiple_permissive_policies` (20 tables), debt until
2027-01-11: performance, not access, and rewriting RLS policies is its own
reviewed change. Tests: `tests/supabaseAdvisors.test.js`.

**The local advisors are a subset of the hosted ones.** The hosted project's
advisors also report every `SECURITY DEFINER` function callable by `anon` or
`authenticated` (lints 0028 and 0029: by design here, since every write is a
definer RPC) and Auth's leaked-password protection, a project setting. CLI
2.118.0 does not carry those lints, so the gate cannot see them; read them in
the dashboard, or with the Supabase MCP `get_advisors`.

**To clear a finding:** fix it in a migration (with its `docs/sql/` revert and
smoke scripts; CI applies it on merge), or add a waiver with the reason in the
same pull request. Never edit an applied migration to make the finding go away.

### Running the database harness (`dbharness.yml`)

[`scripts/dbharness/run.sh`](../../scripts/dbharness/run.sh)
(`npm run test:db:local`) applies every migration to a throwaway PostgreSQL 16
cluster, runs every smoke script under `docs/sql/`, checks each revert after
its forward migration, and ends with `HARNESS OK` or `HARNESS FAILED`. pgTAP
applies the migrations too but runs no smoke and no revert, so this is the
only place either runs. It needs no network and no Docker.

**In CI.** [`.github/workflows/dbharness.yml`](../../.github/workflows/dbharness.yml),
job **Migration harness (PostgreSQL 16)**, runs it on pull requests that touch
`supabase/`, `docs/sql/`, `scripts/dbharness/` or the workflow (plan item M3.4),
and on manual dispatch. It is path-filtered, so it is not a required check (a
required check with a `paths` filter would block every other pull request). It
creates the `pgrunner` user, runs the harness as root, and fails unless the run
exits 0 and prints `HARNESS OK`. About three minutes.

**Locally.** The harness needs:

- **root**: it switches to the cluster's owner with `runuser`, and installs stub
  `pg_cron` and `pgtap` extensions into the server's share directory;
- **PostgreSQL 16** server binaries at `/usr/lib/postgresql/16/bin` (Debian and
  Ubuntu's `postgresql-16` package; the server need not be running), and
  `python3`;
- **an OS user to own the cluster**, `HARNESS_PGUSER`, default `pgrunner`. That
  user exists nowhere by default: create it (`useradd --create-home pgrunner`,
  as CI does), or point the variable at one that exists. The sandbox the
  October 2026 audit ran in had only `postgres`, so it ran
  `HARNESS_PGUSER=postgres npm run test:db:local`; another agent session created
  a `pgrunner2` user by hand for the same reason and ran with
  `HARNESS_PGUSER=pgrunner2`. Any unprivileged user with a home directory works;
  each run uses a private `mktemp -d ~/harness.XXXXXX` under it.

```bash
sudo useradd --create-home pgrunner     # once
sudo npm run test:db:local              # or: sudo HARNESS_PGUSER=postgres bash scripts/dbharness/run.sh
```

`npm run test:db:local:prove` replays the planted defects the harness is
proven against (`scripts/dbharness/prove.sh`).

### Catalogue drift check

Production's schema was never built by replaying `supabase/migrations/`, and
until October 2026 nothing compared the two: 17 triggers and a function
overload existed only in production, three orphan functions only in what CI
builds, and one of those triggers deleted data
([`schema-drift-2026-10.md`](./schema-drift-2026-10.md); fixed by
`20261018040000_reconcile_trigger_drift`). Two halves keep it closed. Neither
gives CI a production credential.

**In the harness, on every pull request that touches `supabase/`.**
[`supabase/catalog-snapshot.json`](../../supabase/catalog-snapshot.json) is the
fresh build's catalogue: every `public` function signature, every `public`
trigger (`pg_get_triggerdef`) and a digest of every `public` policy, as read by
[`scripts/dbharness/catalog_snapshot.sql`](../../scripts/dbharness/catalog_snapshot.sql).
The harness reads the same catalogue off the database it built to head, before
the smokes run, and prints `FAIL catalog snapshot` with every entry only one
side has if they differ. A migration that adds, drops or re-signs a function, a
trigger or a policy therefore updates the snapshot in the same pull request:

```bash
sudo HARNESS_WRITE_CATALOG_SNAPSHOT=1 bash scripts/dbharness/run.sh   # rewrites the file and fails; review, commit, run again
```

Function bodies are not compared (production's early bodies were applied from
other texts than the repository's: LF where some files have CRLF, and at least
one without the file's comments, so a body hash reports drift that changes no
behaviour; recorded as a gap in the remediation plan), nor are extension-owned functions
(pgcrypto sits in `public` on the harness's bare cluster and in `extensions` on
Supabase).

**By the operator, after every `deploy-migrations` that applied a migration.**
The one thing the snapshot cannot see is production. Generate the comparison
query from the committed snapshot and run it read-only against production (SQL
editor, or the Supabase MCP `execute_sql`; it is a single `SELECT` on the system
catalogues and writes nothing):

```bash
python3 scripts/dbharness/catalog_snapshot.py compare-sql supabase/catalog-snapshot.json > /tmp/catalog-compare.sql
```

Production matches when the only rows are the three `count` rows (`functions`,
`policies`, `triggers`). A `search_path` row means the session lacks `public` on
its search path, so names print qualified; run it from a default session. An `only_in_database` row is an object production has
and the repository does not build; an `only_in_snapshot` row carries a key,
which `python3 scripts/dbharness/catalog_snapshot.py name supabase/catalog-snapshot.json <key>`
names. Either is drift: record it in the remediation plan and fix it with a
migration, never by hand. Measured on 2026-10-18, before `20261018040000`
deployed: exactly the 29 objects that migration drops (17 triggers, 12
functions) were `only_in_database`, and nothing was `only_in_snapshot`.

## Real-backend E2E (`e2e-real-backend.yml`)

[`.github/workflows/e2e-real-backend.yml`](../../.github/workflows/e2e-real-backend.yml),
job **E2E against local Supabase**, runs a few end-to-end scenarios through
the app's real Supabase client, RPCs and Edge Functions (plan item M4.1, audit
findings 13.2 and 6.4); the main E2E suite in `ci.yml` runs only against the
in-browser mock. It runs on every pull request to `main` (no `paths` filter,
no job-level `if`) and on manual dispatch, needs no secret, and touches no
other environment.

- **The stack.** `supabase start` with the pinned CLI, as `pgtap.yml` does, but
  with the edge runtime, which serves `supabase/functions/*` (the import and
  persistence paths call them). A failed start is retried once, with a
  warning, for the edge runtime's health check (the 502 that once failed a
  pgTAP run); that risk is why this is its own job and not a step in the
  required pgTAP job. Before the start, the job copies
  `supabase/functions/import_map.json` to a `deno.json` beside each function
  `config.toml` gives an `import_map` (auto-scheduler, fairness-scoring) and
  drops those lines from its own copy of `config.toml`: the local edge runtime
  does not apply the per-function import map (their bare `zod` import fails to
  boot), while the deploy job's bundling does. Nothing is committed; the step
  fails if no function names an import map any more.
- **The seed.** [`tests/e2e/real-backend/seed.sql`](../../tests/e2e/real-backend/seed.sql),
  applied with `psql`: one administrator who can sign in, an onboarded
  organization, an active season dated from the day of the run, one division,
  two fields with weekday practice slots. Pseudonymous throughout
  (`example.test` addresses, a password that exists only on the throwaway
  stack). It is not `supabase/seed.sql`, which fails against the migrated
  schema (its own header says why).
- **The scenarios.** The `real-backend` Playwright project
  (`playwright.config.ts`), which exists only when the job exports the stack's
  URL (`E2E_REAL_BACKEND_SUPABASE_URL`, `E2E_REAL_BACKEND_ANON_KEY`), so
  `npm run test:e2e` and `ci.yml` see the mock project alone, and the job sees
  this one alone (no mock dev server is started). It serves a
  production build (`vite build` into `.real-backend-dist/`, then `vite
  preview`), the shape that ships. Features and steps
  are under [`tests/e2e/real-backend/`](../../tests/e2e/real-backend/), outside
  the mock project's globs: a narrower re-import that must keep the guardians
  the first import recorded (migration `20260726000300`), each import leaving its
  `audit_log` rows as the administrator (import-validation's and
  `finalize_import_job`'s, read with the administrator's own session); import, teams synced
  through `team-persistence`, practices placed by `auto-scheduler` and applied
  through `practice-persistence`, the master export built from what the
  database returns, and "Upload to Storage" putting it and a file per team in
  the `exports` bucket under the organization's folder (migration
  `20261017000000`; the listing is read with the administrator's own session),
  after a publish with one team file refused (a Playwright route) has removed
  the files it did upload;
  and every `verify_jwt` function refusing a request with
  only the anon key (read from `supabase/config.toml`, each refusing on its own,
  not only at the gateway), and `calendar-feed` answering without one. One
  worker, in file order, against one database. (A CORS preflight check was
  tried and dropped: the local stack allowed the headers even with a
  function's own CORS headers stripped, so it could not fail.)
- **When it fails.** The job log carries each failed scenario's page text,
  browser console errors and HTTP failures, then the edge runtime, auth and
  REST container logs; the trace is in the `e2e-real-backend-test-results`
  artifact.

**Running it locally** needs Docker. Do what the job does, in a scratch
checkout or with the two changes undone afterwards: copy
`supabase/functions/import_map.json` to `supabase/functions/auto-scheduler/deno.json`
and `supabase/functions/fairness-scoring/deno.json`, delete the two
`import_map =` lines from `supabase/config.toml`, then `supabase start`, then
`psql "$(supabase status -o env | sed -n 's/^DB_URL=//p' | tr -d '"')" -f tests/e2e/real-backend/seed.sql`,
then export `E2E_REAL_BACKEND_SUPABASE_URL` and `E2E_REAL_BACKEND_ANON_KEY` from
`supabase status -o env` (`API_URL`, `ANON_KEY`) and run
`npx bddgen && npx playwright test --project=real-backend --workers=1`. The
scenarios expect a fresh database (the first import inserts its players), so
before running them again: `supabase db reset` and the seed again.

**Required in `main.json`** since 2026-10-14 (owner decision, after five green
runs on a throwaway branch and green runs on #578 and the pull requests after
it); enforced once the owner re-imports the ruleset (see "Branch Protection").

`tests/integration/staging.test.js`, the suite this replaces as the check
against a real backend, was deleted with plan item M4.5: it targeted
production, ran in no gate, and could not fail where it mattered (run against
production on 2026-10-14, a table that does not exist passed its schema check).

## Branch Protection

`main` is protected by one repository ruleset, "main: pull requests with green
CI" (id `25015698`), imported on 2026-10-13 from
[`.github/rulesets/main.json`](../../.github/rulesets/main.json), which is its
record. GitHub does not read that file: the owner changes the live ruleset in
Settings (an agent cannot), and an edit to the file changes nothing until the
live ruleset is changed to match. Keep exactly one such ruleset: GitHub applies every active
ruleset, so a second one imported beside it adds its required checks to this
one's.

What it enforces on the default branch:

- **Pull requests only.** A direct push to `main` is refused. No approving
  review is required (the owner is the only maintainer).
- **Required checks, on an up-to-date branch:** `Build & Test` and
  `Deno Mirror Tests` (jobs of `ci.yml`), `Run pgTAP against local Supabase`
  (`pgtap.yml`, since plan item M3.2), `npm audit (high and critical block)`
  (`audit.yml`), `Workflow audit (zizmor)` (`workflow-audit.yml`, since
  M3.5) and `E2E against local Supabase` (`e2e-real-backend.yml`, since M4.1),
  all reported by GitHub Actions. The branch must contain the
  latest `main` before it can merge ("strict").
- **No force pushes and no deletion of `main`.**
- **Not required:** an approving review, or resolving review conversations
  (`required_review_thread_resolution: false`, the template skeleton's
  default). Turning conversation resolution on is the owner's call; until
  then, an unresolved review thread does not block a merge.

Not required: CodeQL (it runs through GitHub's code scanning default setup,
reported as the `Analyze (...)` checks, not through a workflow in this
repository), the Vercel deployment check, and the migration harness
(`dbharness.yml`, path-filtered: see
[Running the database harness](#running-the-database-harness-dbharnessyml)).

**Why these six checks can be required.** A required check that never reports
blocks the pull request forever, so each must report on every pull request to
`main`, including docs-only ones. `ci.yml`, `pgtap.yml`, `audit.yml`,
`workflow-audit.yml` and `e2e-real-backend.yml` have no `paths` or
`paths-ignore` filter on `pull_request`; the two `ci.yml` jobs' only `if` is
`github.event_name != 'schedule'`, and the pgTAP, audit, zizmor and
real-backend E2E jobs have none. `Build & Test` runs on a docs-only pull request too: its docs-only path
skips the build steps inside the job, and the job itself still reports.
`tests/rulesetRequiredChecks.test.js` reads every workflow in
`.github/workflows/` and fails if a required context matches no job's `name`
(or more than one), or if a trigger or a job's condition changes in a way that
could stop it reporting.

**Adding pgTAP, the audit and zizmor (owner, once the pull requests that added
them to `main.json` have merged).** `main.json` gained `Run pgTAP against local
Supabase`, `npm audit (high and critical block)` and `Workflow audit (zizmor)`;
the live ruleset does not change until the owner changes it. Settings -> Rules
-> Rulesets -> "main: pull requests with green CI" -> Require status checks to
pass -> Add checks -> add all three (source GitHub Actions) -> Save. Or delete
the ruleset and import `main.json` as described below. Then confirm with the
rules API that all five contexts are listed. (Done by the owner 2026-10-14.)

**Adding the real-backend E2E (owner, once the pull request that added it to
`main.json` has merged).** Same steps: add `E2E against local Supabase`
(source GitHub Actions), or re-import `main.json`; six contexts are then
listed.

**Changing or restoring it (owner):** Settings -> Rules -> Rulesets -> "main:
pull requests with green CI" -> edit, then save, and change `main.json` to
match in a pull request. To restore it from the file (for example after it was
deleted), delete any ruleset left on `main` first, then New ruleset -> Import a
ruleset -> choose `.github/rulesets/main.json` -> Create; never import the
file beside a live one. Check afterwards with
`gh api repos/JoelA510/SquadLogic/rules/branches/main` (public, lists the
active rules and the ruleset each comes from), or with the
agent-ready-template's `check:settings` (`core.settings-branch-protected`).

**What changes once it is active:**

- Every merge needs every required check green on a branch that is up to date with
  `main`; when `main` moves, "Update branch" re-runs CI (about 15-20 minutes)
  before the merge is allowed.
- Force pushes to `main` are refused. This repository's history has been
  rewritten by force push before; a future rewrite needs the ruleset disabled
  first (Settings -> Rules -> Rulesets -> the ruleset -> Enforcement status:
  Disabled), and enabled again afterwards.
- A required job renamed in its workflow must be renamed in `main.json` in the same
  change (the test fails otherwise) and in the live ruleset when it merges;
  otherwise every pull request waits on a check that no longer exists. The
  test reads only the file: nothing compares the file with the live ruleset,
  so check the live rules after any change to either. The first ruleset
  (id `25014911`, 2026-10-13) required agent-ready-template's own CI job
  names, which no SquadLogic workflow reports, and blocked every merge until
  it was deleted and `25015698` imported from this file.

**Rollback:** set the ruleset's enforcement to Disabled (one toggle). The file
stays.

## Frontend deploys (Vercel)

Vercel builds and deploys the frontend on its own, not from GitHub Actions: every push to
`main` becomes a production deployment (`squadlogic.vercel.app`, `squadlogic.secureyour.tech`),
and a pull request gets a preview unless its branch is one that does not deploy on push (see
"Which branches deploy" below). A deploy does not wait for CI; the ruleset gates the
merge, not the deploy.

Project `squadlogic` (team SecureYourTech), read through the Vercel API and the production
build log on 2026-10-13:

| Setting | Value | Where it is set |
| --- | --- | --- |
| Framework | Vite | `vercel.json` `framework` |
| Build command | `npm run frontend:build` | `vercel.json` `buildCommand` (`npm run build`, the Vite preset's default, runs the same script since plan item M6.1) |
| Output directory | `dist` | `vercel.json` `outputDirectory` (where `vite.config.js` builds: `root` plus `build.outDir`) |
| Install command | `npm ci` | `vercel.json` `installCommand` (#559), so Vercel installs exactly what the lockfile pins, as CI does |
| Node.js | 24.x | `package.json` `engines` ([ENVIRONMENT.md](./ENVIRONMENT.md#node-runtime)) |
| Region | `iad1` | Vercel's default |
| Deployment protection | Vercel Authentication on every deployment except custom domains | Dashboard |
| Environment variables | By name in [ENVIRONMENT.md](./ENVIRONMENT.md#what-the-vercel-project-sets) | Dashboard |

`vercel.json` overrides the dashboard's build settings, so a project imported from the
repository builds the same way with only its environment variables set.
`tests/vercelBuildSettings.test.js` holds the three `vercel.json` values to `package.json` and
`vite.config.js`.

**Which branches deploy.** `vercel.json` `git.deploymentEnabled` turns off automatic
deployments for `claude/**` (agent branches) and `dependabot/**`; every other branch,
including `main`, deploys on push as before. To preview one of those branches, deploy it on
request (Vercel dashboard, or `vercel deploy` from a checkout of the branch).
`tests/vercelBuildSettings.test.js` fails if `main` would stop deploying or if either
pattern stops matching. Why: see "Free-tier budgets" below.

## Free-tier budgets

The project runs on free plans (GitHub Free with a public repository, Vercel Hobby, Supabase
Free). The limits that bit, and the levers:

| Budget | What spends it | Lever |
| --- | --- | --- |
| Vercel Hobby: 100 deployments a day (error `api-deployments-free-per-day`, 2026-10-14) | Every push to any branch with automatic deployments on | `git.deploymentEnabled` (above); previews on request. On 2026-10-13/14, 100 deployments in 12.8 h: 13 `main`, about 61 agent branches, 14 from a notes branch with no app, 11 Dependabot |
| GitHub Actions | Each push runs every workflow (about 17 min for `Build & Test`); the strict ruleset makes every merge re-run CI on each open pull request once it is brought up to date | Minutes are free on standard runners for a public repository; the cost is wall time. At most two pull requests in flight; push once per pull request after local gates pass |
| Dependabot | Each pull request and each rebase is a push | `.github/dependabot.yml`: monthly, minors and patches grouped, majors grouped as one inventory PR (not merged as such), rebasing off, a small open-PR limit |
| Supabase Free | Hosted project resources; Pro-only features | CI runs pgTAP and the real-backend E2E against a local `supabase start`, never the hosted project. Leaked-password protection is Pro-only (Supabase docs, 2026-10-14): set a minimum length and required character classes instead. Keep the Supabase GitHub integration's "Deploy to production" and "Automatic branching" off (`deploy-migrations` is the only migration writer; branching also redeploys Vercel previews) |

## Rollback

### Frontend

`VITE_` variables are read when the bundle is built (see
[ENVIRONMENT.md](./ENVIRONMENT.md#production-safety)). Instant Rollback and "Promote to
Production" of an existing production deployment serve that deployment as it was built, with the
values it was built with: neither picks up a variable changed since.

- **A bad frontend release, environment unchanged:** Instant Rollback. Vercel → the project →
  Deployments → the last good production deployment → ⋮ → Instant Rollback (or the API:
  `POST /v1/projects/{projectId}/rollback/{deploymentId}`). It is instant and needs no rebuild.
  Afterwards Vercel stops assigning the production domains to new deployments, so pushes to
  `main` build but do not go live until the rollback is undone ("Undo Rollback" on the
  production deployment, or promoting a deployment). On the Hobby plan only the immediately
  previous production deployment can be rolled back to; on Pro, any earlier one.
- **A change to an environment variable** (a wrong Supabase URL, turning on mock mode): change
  it in Settings → Environment Variables, then **Redeploy** the deployment that should be live
  (Deployments → ⋮ → Redeploy). The redeploy rebuilds with the current variables; a promote or
  an Instant Rollback would not.
- Then fix forward in a pull request, and undo the rollback once it is merged and deployed.
- Frontend and database roll back separately: an Instant Rollback serves an older bundle against
  the current schema. A migration the older bundle cannot work with is reverted by hand (next
  section).

### Workflows and migrations

Workflow changes are rolled back by reverting the pull request that introduced
them. Reverting a workflow change does not undo migrations that
`deploy-migrations` has already applied. Those are reverted by hand; see
[Database migrations](#database-migrations-deploy-migrations).
