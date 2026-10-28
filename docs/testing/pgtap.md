# pgTAP Testing

Live-Postgres tests that exercise RLS invariants, trigger behavior, and
other DB-state properties Vitest can't see. Runs inside the database via
the `extensions.pgtap` extension.

## Why (vs the static advisor-lint)

| Layer                                        | Catches                                                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Static** (`scripts/advisor-lint.js`) | Structural anti-patterns: missing `search_path`, tables without `ENABLE ROW LEVEL SECURITY`, `USING (true)` catch-all policies. Greps migration files. |
| **Dynamic** (pgTAP)                  | Behavioral violations: a policy that exists but still allows cross-org reads; a definer function that leaks rows; a view whose `security_invoker` doesn't enforce what we expect. Runs real queries under real roles. |

Together they cover structural + behavioral regressions.

## Running locally

Prerequisites: Supabase CLI `2.118.0` (the version CI pins) + Docker Desktop. The committed
`supabase/config.toml` uses non-default local ports (`55421` API, `55422`
Postgres, `55423` Studio, `55424` Mailpit) so this repo can run alongside
other local Supabase projects.

```bash
supabase start            # ~3 min first time; pulls images & applies every migration
npm run test:db           # runs every supabase/tests/*.sql in order
supabase stop
```

`supabase/config.toml` disables automatic `supabase/seed.sql` loading. The
historical sample seed still targets the old bigint season schema; pgTAP tests
seed only the rows they need through `_fixtures.sql`.

Single file (for fast iteration while writing a new test):

```bash
npm run test:db:once supabase/tests/rls_cross_org_isolation.sql
```

`test:db:once` always passes `_fixtures.sql` to the Supabase runner before the
requested file. That is intentional: single-file runs only mount explicitly
listed files, while tests include the fixture helper with `\ir`.

## CI

`.github/workflows/pgtap.yml` runs pgTAP against a fresh local Supabase
instance on **every pull request to `main`** (and on manual dispatch), and
its job, `Run pgTAP against local Supabase`, is a required check in the `main`
ruleset (plan item M3.2). Before the suites it runs Supabase's own advisors
over the migrated schema, failing on any WARN or ERROR finding not waived in
`docs/security/supabase-advisor-waivers.json` (plan item M3.3).

Until M3.2 the workflow had a `paths` filter (migrations, tests,
`config.toml`), kept to save Actions minutes, so most pull requests never ran
the suite and it could not be required. The repository is public, so
standard-runner minutes cost nothing; a run takes about two minutes. Details:
[`docs/operations/ci-cd.md`](../operations/ci-cd.md#database-tests-on-pull-requests).

Manual runs are available via `workflow_dispatch` on the Actions tab, on any
branch, when you need to validate the suite without an open PR.

## Writing a test

1. Copy `supabase/tests/_template.sql.txt` to a descriptive filename —
   snake_case, `<area>_<invariant>.sql`:
   - `rls_players_coach_write.sql`
   - `trigger_audit_log_append_only.sql`
   - `function_rotate_calendar_token_rejects_stranger.sql`
2. Wrap the body in `BEGIN ... ROLLBACK`. Tests must leave zero residue.
3. Include the shared seed (two orgs, three users, a team per org, audit
   rows, import rows) with:

   ```sql
   \set squadlogic_fixture_include 1
   \ir _fixtures.sql
   ```

   If the fixture is missing something, extend `_fixtures.sql` — **per-test
   INSERT statements are forbidden**.
4. Declare `SELECT plan(N)` with the exact number of assertions. Too many
   / too few asserts → test fails.
5. Simulate a user:

   ```sql
   SET LOCAL role = 'authenticated';
   SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
   ```

   `auth.uid()`, `is_org_member()`, and `is_org_admin()` read from the JWT
   claims the session has set.

6. End with `SELECT * FROM finish();` before `ROLLBACK;`.

Useful pgTAP assertion helpers:

| Helper                                  | Use for                                                    |
| --------------------------------------- | ---------------------------------------------------------- |
| `is(actual, expected, description)`     | Scalar equality.                                           |
| `isnt(actual, expected, description)`   | Scalar inequality.                                         |
| `ok(boolean_expr, description)`         | Truthy assertion.                                          |
| `results_eq(query, expected, desc)`     | Row-set equality (column list + row list).                 |
| `throws_ok(query, err_code, desc)`      | "This should raise error X" — crucial for write-path RLS.  |

## Canonical fixtures

Defined in `supabase/tests/_fixtures.sql`. Reuse these UUIDs when writing
a new test that needs known identities.

| Entity                    | UUID                                   |
| ------------------------- | -------------------------------------- |
| Alice (admin of Org A)    | `11111111-1111-1111-1111-111111111111` |
| Bob (admin of Org B)      | `22222222-2222-2222-2222-222222222222` |
| Charlie (no membership)   | `33333333-3333-3333-3333-333333333333` |
| Org A                     | `a1111111-1111-1111-1111-111111111111` |
| Org B                     | `b2222222-2222-2222-2222-222222222222` |
| A-Team (Org A)            | `aaaaaaaa-0000-0000-0000-000000000001` |
| B-Team (Org B)            | `bbbbbbbb-0000-0000-0000-000000000002` |

## Canonical suite

| Test                                               | Invariant                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------- |
| `rls_cross_org_isolation.sql`                      | Alice (Org A) cannot SELECT Org B's teams.                                |
| `rls_anonymous_gate.sql`                           | `anon` role reads zero rows from organizations, teams, players, audit_log, organization_members. |
| `rls_admin_vs_coach.sql`                           | `audit_log` is readable by Alice (admin) and blocked for Charlie (a non-member). |
| `rls_service_role_bypass.sql`                      | `service_role` sees every team across every org.                          |
| `rls_import_efficiency_metrics_view.sql`           | The `security_invoker = on` view is org-scoped for its caller.            |
| `rls_policy_matrix.sql`                            | Seven personas' SELECT, INSERT, UPDATE, cross-organization move and DELETE on the 26 tables the advisors flag, against a literal expected table (`docs/PLAN_RLS_ADVISOR_REWRITE.md` §4.2). |

## When a test fails

**Do not weaken a test to make it pass.** A failing pgTAP assertion means
one of:

- The policy you're testing is weaker than the invariant expects → file
  a separate PR to fix the policy (with its own targeted test).
- The test is wrong → fix the test.
- The invariant itself was renegotiated → amend
  `docs/security/rls-policies.md` and update the assertion in the same PR.

There are no known/expected structural failures for
`import_efficiency_metrics`; any structural or behavioral failure on that
path should be treated as a regression and fixed.

Fix-in-follow-up discipline: the suite ships tests and the CI harness;
policy fixes land in their own PRs so the failing-test signal stays
visible in git history.

## Tooling

- pgTAP extension lives in `extensions` schema (see migration
  `supabase/migrations/20260423065246_enable_pgtap.sql`).
- Supabase CLI's `supabase test db` command auto-discovers every
  `supabase/tests/*.sql` file, so simply adding a file is sufficient —
  no test-registry update needed.
- `_fixtures.sql` is also a valid standalone pgTAP file. When run directly by
  auto-discovery it only asserts the helper is available; when included from a
  real test after `\set squadlogic_fixture_include 1`, it seeds fixture rows.
- Revert migration: `docs/sql/reverts/20260423065246_disable_pgtap.sql`.

## Related docs

- `docs/security/rls-policies.md` — the invariants this suite enforces.
- `supabase/tests/README.md` — in-directory quick reference.
- `scripts/advisor-lint.js` — the static half of this belt-and-
  braces arrangement.
