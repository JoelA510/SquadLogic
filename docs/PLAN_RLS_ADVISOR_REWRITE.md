# Plan: rewrite the RLS policies the advisors flag (`auth_rls_initplan`, `multiple_permissive_policies`)

Approved by the owner on 2026-10-18, with every recommendation as written.

Status: **APPROVED 2026-10-18; PR 1 (the persona matrix, §4.2) on branch
`claude/vibrant-allen-hr7y7s-rlsmatrix`, then PR 2 (the rewrite) on
`claude/vibrant-allen-hr7y7s-rlsrewrite`, stacked on it.** Was: PROPOSED,
awaiting the owner's approval (§9). A schema change to
row-level security, so plan first; applied by CI on merge. Resume queue,
Wave 2, with a deadline: the advisor waivers in
`docs/security/supabase-advisor-waivers.json` expire on **2027-01-11**, after
which the required pgTAP job fails every pull request. Start by early December
at the latest. Two PRs: `test/rls-policy-matrix` (tests only), then
`fix/rls-advisor-rewrite`.

Evidence labels, per `AGENTS.md` rule 4: _read_ (statically reviewed),
_executed_ (run, output quoted), _test-verified_ (a committed test asserts it).
Repository state: `main` at `cab8ce1`.

---

## 0. Headline

- **31 findings, the same in three places** (_executed_): the waiver file names
  11 `auth_rls_initplan` policies and 20 `multiple_permissive_policies` tables;
  production's advisors (`get_advisors`, performance, 2026-10-17) report exactly
  those 11 and those 20; and the fresh build's policies are identical to
  production's (82 policies, expressions compared by hash,
  `docs/operations/schema-drift-2026-10.md` §2.4).
- **Both lints are performance, not access**: the policies call `auth.uid()`
  once per row, and SELECT evaluates two permissive policies where one would
  do. Production has almost no rows, so nothing is slow today; the cost is the
  expiring waiver.
- **The rewrite is mechanical and provably behaviour-preserving**: wrap every
  flagged `auth.uid()` as `(select auth.uid())`; split each admin `FOR ALL`
  policy into `INSERT`, `UPDATE` and `DELETE` policies with the same
  expression, which leaves exactly one permissive SELECT policy per table
  (an admin is always a member, so the member SELECT already admits every row
  the admin ALL admitted); drop one redundant legacy `import_jobs` policy.
- **Proof is a persona matrix**: a pgTAP test, landed on `main` first and green
  against today's policies, records what each of seven personas can read and
  write on every affected table; the rewrite must leave it green unchanged. A
  scratch version of it ran here on four of the tables: 48 probes identical
  before and after, and two planted mistakes each caught (_executed_, §4.3).
- **One trap**: `reconcile_prod_rls_drift()` (`20260928000000`) and its smoke
  re-create `scheduler_runs_write_admin` and the legacy `import_jobs` policy
  from a fixed spec, so the rewrite has to update that function and its smoke
  in the same PR (Q3).

---

## 1. The findings (_executed_)

Three sources, compared:

1. `docs/security/supabase-advisor-waivers.json`: the two waivers' `cacheKey`s.
2. Production: Supabase MCP `get_advisors` (type `performance`), project
   `mmwupqsjkikqzvmdvuzm`, 2026-10-17, read-only. Lints at WARN:
   `auth_rls_initplan` 11, `multiple_permissive_policies` 20 (and, at INFO,
   `unindexed_foreign_keys` 90 and `unused_index` 19, not in scope).
3. The fresh build (`pg_policies` on the harness build of all 129 migrations),
   for each policy's exact expression.

The 11 policies and 20 tables are the same in 1 and 2, name for name.

### 1.1 `auth_rls_initplan`: 11 policies

| #   | Table                         | Policy                                          | Cmd, role             | Expression today (abridged)                                                                                        | Rewrite                                                 |
| --- | ----------------------------- | ----------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| I1  | `audit_log`                   | Audit Log: admins view                          | SELECT, authenticated | `is_org_member(organization_id) AND EXISTS (… om.profile_id = auth.uid() … om.role = 'admin')`                     | wrap `auth.uid()`                                       |
| I2  | `import_jobs`                 | Users can view their organization's import jobs | SELECT, **public**    | `organization_id IN (SELECT organization_id FROM organization_members WHERE profile_id = auth.uid())`              | **drop** (M9: it repeats "Import Jobs: members access") |
| I3  | `organization_schema_history` | Schema History: Admins Only                     | SELECT, public        | `EXISTS (… organization_id = … AND profile_id = auth.uid() AND role = 'admin')`                                    | wrap                                                    |
| I4  | `profile_players`             | Profile Players: users view own                 | SELECT, authenticated | `(profile_id = auth.uid()) OR is_org_member(organization_id)`                                                      | wrap                                                    |
| I5  | `profiles`                    | Profiles: users update own                      | UPDATE, authenticated | `auth.uid() = id` (no WITH CHECK)                                                                                  | wrap (`ALTER POLICY`)                                   |
| I6  | `profiles`                    | Profiles: users view own                        | SELECT, authenticated | `auth.uid() = id`                                                                                                  | wrap                                                    |
| I7  | `registration_forms`          | registration_forms_admin_manage                 | ALL, authenticated    | `is_org_member(organization_id) AND EXISTS (… auth.uid() … role = 'admin')`, no WITH CHECK                         | wrap, and split (M17)                                   |
| I8  | `registrations`               | registrations_user_own_or_admin                 | ALL, authenticated    | `((profile_id = auth.uid()) AND is_org_member(organization_id)) OR is_org_admin(organization_id)`, same WITH CHECK | wrap in both                                            |
| I9  | `season_settings`             | Season Settings: admins manage                  | ALL, authenticated    | as I7                                                                                                              | wrap, and split (M18)                                   |
| I10 | `telemetry_log`               | Insert telemetry for own organization           | INSERT, authenticated | WITH CHECK `org_id IN (… profile_id = auth.uid())`                                                                 | wrap                                                    |
| I11 | `telemetry_log`               | View telemetry for own organization             | SELECT, authenticated | `org_id IN (… profile_id = auth.uid() AND role = ANY ('admin','tenant_admin'))`                                    | wrap                                                    |

"Wrap" means every `auth.uid()` in the expression becomes `(select auth.uid())`,
nothing else: Postgres then evaluates it once per statement (an InitPlan)
instead of once per row, and the value is the same.

**Kept exactly, on purpose**: I7 and I9 test `om.role = 'admin'`, which is
narrower than `is_org_admin` (that admits `tenant_admin` too). The rewrite must
not "tidy" them onto `is_org_admin`; the matrix has a `tenant_admin` persona to
catch it (§4.3 shows it does).

### 1.2 `multiple_permissive_policies`: 20 tables (SELECT, authenticated)

Every finding is the same shape: a member SELECT policy plus an admin `FOR ALL`
policy, both permissive, so a SELECT evaluates both.

| #      | Tables                                                                                                                                                                                                                                               | Member SELECT (kept)                                                                  | Admin ALL (split)                                                       |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| M1-M14 | `email_log`, `evaluation_findings`, `evaluation_metrics`, `evaluation_run_events`, `evaluation_runs`, `export_jobs`, `game_slots`, `games`, `player_buddies`, `players`, `practice_assignments`, `scheduler_runs`, `staging_players`, `team_players` | `<t>_select_member`: `is_org_member(organization_id)`                                 | `<t>_write_admin`: `is_org_admin(organization_id)` USING and WITH CHECK |
| M15    | `practice_exceptions`                                                                                                                                                                                                                                | Practice exceptions: members select                                                   | Practice exceptions: admins write (as above)                            |
| M16    | `organization_members`                                                                                                                                                                                                                               | Org Members: view members                                                             | Org Members: admins manage (as above)                                   |
| M17    | `organizations`                                                                                                                                                                                                                                      | Organizations: members can access, `is_org_member(id)`                                | Organizations: admins manage, `is_org_admin(id)`                        |
| M18    | `registration_forms`                                                                                                                                                                                                                                 | registration_forms_member_access: `is_org_member(organization_id) OR status = 'open'` | registration_forms_admin_manage (I7)                                    |
| M19    | `season_settings`                                                                                                                                                                                                                                    | Season Settings: members access                                                       | Season Settings: admins manage (I9)                                     |
| M20    | `import_jobs`                                                                                                                                                                                                                                        | Import Jobs: members access                                                           | (two SELECT policies, no admin ALL: I2 is the second)                   |

**The rewrite for M1-M19**: drop the admin ALL policy and create, with its exact
expression (wrapped where I7/I9 apply):

- `<t>_insert_admin` `FOR INSERT WITH CHECK (<expr>)`,
- `<t>_update_admin` `FOR UPDATE USING (<expr>) WITH CHECK (<expr>)`,
- `<t>_delete_admin` `FOR DELETE USING (<expr>)`.

Where the ALL policy has no WITH CHECK (I7, I9), Postgres already used its USING
for the check, so writing the same expression in both places changes nothing.
Names follow each table's existing convention (`players_insert_admin`,
"Season Settings: admins insert", …).

**Why SELECT is unchanged**: after the split the only permissive SELECT policy is
the member one. The admin ALL admitted, for SELECT, only rows where the caller
is an admin of the row's organization; every such caller is a member of it
(`is_org_admin` and the inline `role = 'admin'` test both require an
`organization_members` row for that organization and `auth.uid()`, which is
exactly `is_org_member`'s test). So `member OR admin` = `member`, and for
`registration_forms`, `member OR open OR (member AND admin)` = `member OR open`.

**M20**: dropping I2 leaves "Import Jobs: members access". The two are equal
for every caller: `organization_id IN (SELECT organization_id FROM
organization_members WHERE profile_id = auth.uid())` is `is_org_member(organization_id)`
written as a subquery, including a null `organization_id` (false either way);
for `anon`, `auth.uid()` is null and I2 admitted nothing.

### 1.3 After

Policies on `public`: 82 → 119 (17 tables gain 2 each by splitting, I7 and I9's
tables 2 each, `import_jobs` loses 1). No policy changes on any other table.

---

## 2. The trap: `reconcile_prod_rls_drift()` and old smokes

`20260928000000_reconcile_prod_rls_drift.sql` created an owner-only function that
re-creates a fixed list of policies "where missing" and refuses a same-named
mismatch. Its spec includes `scheduler_runs_write_admin` (ALL) and the legacy
`import_jobs` policy (I2) (`:157-165`, `:202-205`). After the rewrite:

- re-running it would **re-create both**, and with them two of the findings;
- `docs/sql/20260928000000_smoke.sql` runs it on the harness's head build and
  asserts it "creates nothing" (step 1) and recreates the legacy `import_jobs`
  policy as part of its simulated drift (step 2), so the harness would fail.

So the rewrite PR also replaces `reconcile_prod_rls_drift()` wholesale with the
new spec (the three `scheduler_runs` admin policies; I2 removed), and updates
that smoke to the new spec, saying so in its header (Q3). Two other checks name
policies of these tables and are re-read in the build: `docs/sql/20260726000000_smoke.sql`
and `supabase/tests/rls_stale_broad_write_policies_removed.sql` (they test that
broad member-write policies stay absent, which the rewrite does not change), and
`scripts/dbharness/prove.sh`'s plants on `20260928000000` (the 5.4-hour prover,
not run in CI; a re-run is noted as follow-up, not required).

---

## 3. The migration, `<next version>_rls_advisor_rewrite.sql`

One transaction:

1. `ALTER POLICY ... USING (...)` / `WITH CHECK (...)` for I1, I3-I6, I8, I10,
   I11 (wrap only; the names stay, so nothing that names them changes);
2. `DROP POLICY "Users can view their organization's import jobs" ON public.import_jobs` (I2/M20);
3. for M1-M19: `DROP POLICY <admin ALL>`; `CREATE POLICY` ×3 as in §1.2;
4. `CREATE OR REPLACE FUNCTION public.reconcile_prod_rls_drift()` with the
   updated spec (§2);
5. a closing `DO` block that asserts, on the catalogue, what the advisors
   check: no `public` policy expression contains `auth.uid()` outside
   `( SELECT auth.uid() AS uid)` (the deparsed form); and no table, role and
   command in `public` with more than one permissive policy. It raises,
   aborting the migration, if either holds.

Waivers: both entries are **removed** from `supabase-advisor-waivers.json` in the
same PR. The M3.3 gate fails on a stale waiver, so if every finding is gone the
gate passes only without them, and if one remains it fails as unwaived. Either
way the gate itself confirms completeness.

**Revert** (`docs/sql/<version>_revert.sql`): every original policy re-created
from its source migration's text (cited per policy), the split policies
dropped, I2 re-created, and `reconcile_prod_rls_drift()` restored from
`20260928000000`. **Smoke** (`docs/sql/<version>_smoke.sql`): the closing
assertions of step 5, the policy count (119), and a member and an admin session
reading and writing one table each, in `BEGIN ... ROLLBACK`.

---

## 4. Proof that behaviour is unchanged

### 4.1 The existing RLS tests stay green, unchanged

`supabase/tests/`: `rls_admin_vs_coach.sql`, `rls_anonymous_gate.sql`,
`rls_cross_org_isolation.sql`, `rls_field_blackouts.sql`,
`rls_import_efficiency_metrics_view.sql`, `rls_organizations_admin_scoped_write.sql`,
`rls_record_audit_event_authz.sql`, `rls_service_role_bypass.sql`,
`rls_stale_broad_write_policies_removed.sql`, and the RPC suites that touch these
tables. They are thin on the 26 tables in scope (2 to 11 assertions each), which
is why 4.2 exists.

### 4.2 The persona matrix (new, landed first)

`supabase/tests/rls_policy_matrix.sql`, in its own PR **before** the rewrite,
green on `main` against today's policies:

- **Personas** (from `_fixtures.sql`, plus three it adds): admin of Org A,
  `tenant_admin` of Org A, coach of Org A, parent of Org A, admin of Org B, a
  signed-in user with no membership, and `anon`.
- **Subjects**: the 26 tables of §1 (the 20 of §1.2 and the six more of §1.1), each seeded with one row in Org A and one
  in Org B (enumerated from the findings list, not from `pg_policies`, so a
  dropped policy cannot shrink the subject set).
- **Probes**, per persona and table: rows visible to `SELECT`; `INSERT` of an
  Org A row (allowed or the SQLSTATE); rows reached by `UPDATE` and by
  `DELETE` of Org A's row. Every write probe undoes itself (it raises a private
  SQLSTATE after the write and catches only that), so no probe sees another's
  effect.
- **Assertion**: `results_eq` against a literal expected table generated on
  `main` and reviewed by hand (about 26 × 7 × 4 ≈ 730 cells). A meta-assertion
  counts the probes and fails below the expected number.
- **The rewrite PR does not touch this file.** It passing unchanged is the proof.

### 4.3 What a scratch run showed (_executed_)

On the harness build, inside `BEGIN ... ROLLBACK`, with the pgTAP fixtures, the
three extra personas, and table grants for `authenticated` (the bare cluster has
none, so without them every refusal would be a grant error, not RLS): 8 probes
× 6 personas on `players`, `season_settings`, `import_jobs` and `profiles`,
before and after applying this plan's rewrite for those four (M10, I9/M19,
I2/M20, I5/I6):

```
PROBES 48 before, 48 after        (no DIFF lines)
```

Two plants, each caught:

```
players_update_admin on is_org_member:   DIFF coachA | players update orgA | 0 -> 1
                                         DIFF parentA | players update orgA | 0 -> 1
season settings update on is_org_admin:  DIFF tenantA | season_settings update orgA | 0 -> 1
```

The second is the "tidy it onto `is_org_admin`" mistake §1.1 warns about. The
first version of this probe leaked its own inserts into later personas' counts
and reported six false differences; making every write undo itself fixed it,
and the committed test carries the same rule.

### 4.4 Plants for the build

P1 a split policy written with the member expression (matrix: member writes
allowed); P2 I7 or I9 moved onto `is_org_admin` (matrix: `tenant_admin`); P3 an
unwrapped `auth.uid()` left in (the migration's closing assertion, and the
advisor gate); P4 an admin ALL left beside its split (closing assertion,
advisor gate); P5 a dropped policy not re-created (matrix: members lose reads);
P6 the reconcile spec not updated (the `20260928000000` smoke).

---

## 5. Rollout

1. PR 1, `test/rls-policy-matrix`: the matrix test only. pgTAP runs it on every
   PR, so it is green on `main` before anything changes.
2. PR 2, `fix/rls-advisor-rewrite`: the migration, revert, smoke, the reconcile
   function and its smoke, the waivers removed. CI applies it on merge.
3. After deploy, read-only: `get_advisors` (performance) on production reports 0
   `auth_rls_initplan` and 0 `multiple_permissive_policies`; quoted in the PR.

Timing: after the Wave 2 schema items that touch none of these policies, and no
later than early December, so a failed review round still lands before
2027-01-11. If it slips, renewing the waivers is a one-line change with a new
date (at most 180 days), which the gate allows.

## 6. Risks

- **A lockout** (members lose a read, admins a write): the matrix covers every
  persona and command on every table touched.
- **A widening** (someone gains a write): the same matrix; and P1, P2.
- **The reconcile function** quietly undoing the rewrite: §2, P6.
- **Locks**: each `DROP/CREATE POLICY` takes a brief `ACCESS EXCLUSIVE` lock on
  its table; the tables are nearly empty in production. One transaction, so no
  half-applied state.
- **No performance number**: production has too few rows to measure, so the
  benefit is the advisors' own, not measured here.

## 7. Size

Migration about 350 lines, revert about 300, smoke about 80; the reconcile
function about 120 (copied, a few lines changed) and its smoke edit; the matrix
test about 500 lines plus its expected table. Effort M across two PRs.

## 8. Rollback

A forward migration applying the revert script (CI is the only writer), and the
two waivers restored with a new expiry. The matrix stays: it is true either way.

---

## 9. Questions for the owner

**Q1. Split each admin `FOR ALL` policy into `INSERT`/`UPDATE`/`DELETE`
(recommended), rather than merge member and admin into one `FOR ALL` policy
with an OR?**
_Recommendation:_ split. It keeps every expression exactly as it is, so the proof
is "same expression, fewer commands". One merged policy would need
`member OR admin` for reads and `admin` for writes in one `USING`, which
Postgres cannot express in a single permissive policy without changing who can
write.

**Q2. Drop the legacy `import_jobs` policy (I2) rather than wrap it?**
_Recommendation:_ drop. It admits exactly what "Import Jobs: members access"
admits (§1.2, M20), and wrapping it would still leave two permissive SELECT
policies, which is the other finding.

**Q3. Update `reconcile_prod_rls_drift()` and its smoke in the same PR
(recommended), or drop the function?**
_Recommendation:_ update. It is the documented repair if production drifts
again, and the harness runs its smoke on every build, so it must agree with the
schema. Dropping it loses the repair and still needs its smoke retired.

**Q4. Land the persona matrix as its own PR first?**
_Recommendation:_ yes. A behaviour test written in the same PR as the change it
judges can be shaped by the change; green on `main` first, and untouched by the
rewrite, is the evidence.

**Q5. Keep I7 and I9's `role = 'admin'` test as it is (a `tenant_admin` cannot
manage season settings or registration forms through the table), even though
`is_org_admin` elsewhere admits `tenant_admin`?**
_Recommendation:_ keep, in this PR: the rewrite changes no access. Whether a
`tenant_admin` should manage them is a product question to ask separately;
changing it here would hide an access change inside a performance fix.

**Q6. `registration_forms_member_access` admits any signed-in user, of any
organization, to forms whose `status` is `open`. Keep it unchanged here?**
_Recommendation:_ keep, and confirm separately that it is intended (public
registration needs open forms to be readable). Noted because the matrix will
show the non-member persona reading Org A's open forms, and that row should be
read as deliberate, not as a regression.
