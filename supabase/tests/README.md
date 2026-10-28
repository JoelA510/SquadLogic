# pgTAP tests

Live-Postgres tests that exercise RLS invariants and other DB-state
properties Vitest can't see. Runs inside the database via the
`extensions.pgtap` extension (enabled by
`supabase/migrations/20260423065246_enable_pgtap.sql`).

This harness is the **dynamic** complement to Wave 6a's static
`scripts/advisor-lint.js`. Advisor-lint greps migration files for known
anti-patterns (missing `search_path`, tables without `ENABLE ROW LEVEL
SECURITY`, `USING (true)` catch-all policies). pgTAP runs the real queries
under real roles and checks the behavioral outcome — a policy that **looks**
correct in the migration text but still leaks rows will slip past
advisor-lint and get caught here.

## Quickstart

```bash
# One-time install: Supabase CLI 2.118.0 (the version CI pins) + Docker Desktop.
# Local ports come from supabase/config.toml:
# API 55421, Postgres 55422, Studio 55423, Mailpit 55424.

supabase start            # ~3 min first time; pulls images & applies migrations
npm run test:db           # runs every supabase/tests/*.sql
supabase stop

# Single file:
npm run test:db:once supabase/tests/rls_cross_org_isolation.sql
```

## Directory layout

| File                                     | Purpose                                                                           |
| ---------------------------------------- | --------------------------------------------------------------------------------- |
| `_template.sql.txt`                      | Copy-starting-point for new tests; renamed so auto-discovery does not execute it. |
| `_harness.sql`                           | Trivial self-test; fails fast if pgTAP itself is broken.                          |
| `_fixtures.sql`                          | Shared seed data; standalone guard lets auto-discovery execute it safely.         |
| `rls_cross_org_isolation.sql`            | Org A member cannot SELECT Org B's rows.                                          |
| `rls_anonymous_gate.sql`                 | `anon` role reads zero rows from every domain table.                              |
| `rls_admin_vs_coach.sql`                 | `audit_log` visible to admins, invisible to coaches.                              |
| `rls_service_role_bypass.sql`            | `service_role` sees every row across orgs.                                        |
| `rls_import_efficiency_metrics_view.sql` | `security_invoker = on` view is org-scoped for its caller.                        |
| `contact_surfaces_removed.sql`           | No read a coach can call returns an email or phone; the contact surfaces stay gone. |
| `division_roster_constraints.sql`        | Division roster/team bounds persist and stay admin-owned.                         |
| `storage_exports_bucket.sql`             | `exports` is private: members of the folder's org read, its admins upload.        |
| `rls_policy_matrix.sql`                  | Seven personas' read and write access on the 26 advisor-flagged tables.           |

## Conventions

Every test file MUST:

1. Wrap its body in `BEGIN ... ROLLBACK` — the DB must be untouched after
   the test runs. No test relies on state left by another test.
2. Include fixtures where possible:

   ```sql
   \set squadlogic_fixture_include 1
   \ir _fixtures.sql
   ```

   If a fixture doesn't provide the rows you need, **extend `_fixtures.sql`**
   rather than inlining INSERTs. Per-test INSERTs are forbidden.

3. Declare `SELECT plan(N)` with the exact number of assertions you make.
   Too many or too few asserts → test fails.
4. Simulate a user with `SET LOCAL role = 'authenticated'` plus
   `SET LOCAL "request.jwt.claims" TO '{"sub":"<uuid>"}'`. The Supabase
   RLS helpers (`auth.uid()`, `is_org_member()`, `is_org_admin()`) read
   from the JWT claims.
5. Finish with `SELECT * FROM finish();` before `ROLLBACK;`.

See `_template.sql.txt` for a copy-paste starter.

## Canonical fixture identities

Defined in `_fixtures.sql`. Reuse these UUIDs in new tests — don't mint
fresh ones unless the test specifically needs a new identity.

| Entity                   | UUID                                   |
| ------------------------ | -------------------------------------- |
| Alice (admin of Org A)   | `11111111-1111-1111-1111-111111111111` |
| Bob (admin of Org B)     | `22222222-2222-2222-2222-222222222222` |
| Charlie (no membership)  | `33333333-3333-3333-3333-333333333333` |
| Org A                    | `a1111111-1111-1111-1111-111111111111` |
| Org B                    | `b2222222-2222-2222-2222-222222222222` |
| A-Team (Org A)           | `aaaaaaaa-0000-0000-0000-000000000001` |
| B-Team (Org B)           | `bbbbbbbb-0000-0000-0000-000000000002` |

## CI

`.github/workflows/pgtap.yml` runs this suite on every pull request to
`main`, and its job is a required check (plan item M3.2): a failing suite
blocks the merge. See `docs/testing/pgtap.md` and
`docs/operations/ci-cd.md` ("Database tests on pull requests").

Manual triggering is available via `workflow_dispatch` from the Actions
tab if you need to validate the suite without an open PR.

## Adding a new test

1. Copy `_template.sql.txt` to a descriptive filename — `<area>_<invariant>.sql`
   (e.g. `trigger_audit_log_append_only.sql`).
2. Decide which fixture rows you need; extend `_fixtures.sql` if the shared
   seed is missing something.
3. Write assertions. Prefer `results_eq` for row-set comparisons and
   `throws_ok` for "this SHOULD raise a permission error" assertions.
4. Run locally (`supabase start && npm run test:db && supabase stop`).
5. Open a PR — CI will re-run pgTAP on the same suite automatically.

## When a test fails

If a test fails because current RLS policies are **weaker** than the test
expects, **that is the point of pgTAP**. Don't weaken the test to make it
pass. Instead:

- File a separate PR that fixes the policy (with its own targeted test).
- If the weakness is acceptable (documented trade-off), amend
  `docs/security/rls-policies.md` to record it and adjust the assertion.

See `docs/testing/pgtap.md` for the wider how-to + CI reference.
