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

**Not a required check yet.** The job reports as
`npm audit (high and critical block)`. Until the owner adds that context to the
`main` ruleset (and to `.github/rulesets/main.json` in the same change, teaching
`tests/rulesetRequiredChecks.test.js`, which looks only in `ci.yml`, to find
it in `audit.yml`), a red
audit is visible on the pull request but does not block the merge. It can be
required safely: the workflow has no `paths` filter and the job no `if`, so it
reports on every pull request, docs-only ones included.
`tests/checkAudit.test.js` fails if that changes.

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

Both deploy jobs install the CLI with `supabase/setup-cli@v2` and
`version: ${{ env.SUPABASE_CLI_VERSION }}`. The version is set once, in the
workflow-level `env:` block of `ci.yml`: **`2.118.0`**.

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
`.github/workflows/` uses `latest` or has no version. It also fails if the
`ci.yml` steps disagree, or if the version differs from the one named in the
`migrationGuard.mjs` header.

**How to bump it.**

1. Capture the new version's `migration list` and `db push --dry-run` JSON
   against a local, production-shaped ledger (see
   [`migration-ledger-normalisation.md`](./migration-ledger-normalisation.md)).
   Update the fixture shapes in `tests/migrationGuard.test.js` if they changed.
2. In one PR, change `SUPABASE_CLI_VERSION` in `ci.yml` and the version named in
   the headers of `scripts/ci/migrationGuard.mjs` and
   `tests/migrationGuard.test.js`.
3. Run `npm run test`. The pin test fails until all of these agree.

`pgtap.yml` pins its own CLI (`2.95.4`) for `supabase start`. It is a separate
workflow, and this pin does not change it.

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
  `Deno Mirror Tests`, both jobs of `ci.yml`, reported by GitHub Actions. The
  branch must contain the latest `main` before it can merge ("strict").
- **No force pushes and no deletion of `main`.**
- **Not required:** an approving review, or resolving review conversations
  (`required_review_thread_resolution: false`, the template skeleton's
  default). Turning conversation resolution on is the owner's call; until
  then, an unresolved review thread does not block a merge.

Not required: CodeQL (it runs through GitHub's code scanning default setup,
reported as the `Analyze (...)` checks, not through a workflow in this
repository), the Vercel deployment check, and pgTAP. pgTAP runs only on pull requests that touch its `paths`, so as a
required check it would never report on the rest and would block them forever;
it joins once it runs on every pull request (plan item M3.2, decision D5).

**Why these two checks can be required.** A required check that never reports
blocks the pull request forever, so each must report on every pull request to
`main`, including docs-only ones. `ci.yml` has no `paths` or `paths-ignore`
filter on `pull_request`, and both jobs' only `if` is
`github.event_name != 'schedule'`. `Build & Test` runs on a docs-only pull
request too: its docs-only path skips the build steps inside the job, and the
job itself still reports. `tests/rulesetRequiredChecks.test.js` fails if a
required context stops matching a job's `name`, or if the trigger or a job's
condition changes in a way that could stop it reporting.

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

- Every merge needs both checks green on a branch that is up to date with
  `main`; when `main` moves, "Update branch" re-runs CI (about 15-20 minutes)
  before the merge is allowed.
- Force pushes to `main` are refused. This repository's history has been
  rewritten by force push before; a future rewrite needs the ruleset disabled
  first (Settings -> Rules -> Rulesets -> the ruleset -> Enforcement status:
  Disabled), and enabled again afterwards.
- A check renamed in `ci.yml` must be renamed in `main.json` in the same
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
and every pull request gets a preview. A deploy does not wait for CI; the ruleset gates the
merge, not the deploy.

Project `squadlogic` (team SecureYourTech), read through the Vercel API and the production
build log on 2026-10-13:

| Setting | Value | Where it is set |
| --- | --- | --- |
| Framework | Vite | `vercel.json` `framework` |
| Build command | `npm run frontend:build` | `vercel.json` `buildCommand` (the Vite preset's default, `npm run build`, is not a build: plan item M6.1) |
| Output directory | `dist` | `vercel.json` `outputDirectory` (where `vite.config.js` builds: `root` plus `build.outDir`) |
| Install command | `npm install` | Vercel's default for npm; not set anywhere |
| Node.js | 24.x | `package.json` `engines` ([ENVIRONMENT.md](./ENVIRONMENT.md#node-runtime)) |
| Region | `iad1` | Vercel's default |
| Deployment protection | Vercel Authentication on every deployment except custom domains | Dashboard |
| Environment variables | By name in [ENVIRONMENT.md](./ENVIRONMENT.md#what-the-vercel-project-sets) | Dashboard |

`vercel.json` overrides the dashboard's build settings, so a project imported from the
repository builds the same way with only its environment variables set.
`tests/vercelBuildSettings.test.js` holds the three `vercel.json` values to `package.json` and
`vite.config.js`.

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
