[← Back to Documentation Index](../README.md)

---

# Schema drift between a fresh build and production (investigation, 2026-10-17)

Status: **read-only investigation, no change made.** The fix it recommends is a
migration, so it needs the owner's approval (§6) and then goes through CI like
any other. Resume queue, Wave 0: "find out why `set_updated_at()` exists on a
fresh build but not in production".

Evidence labels, per `AGENTS.md` rule 4: _statically reviewed_ (read),
_executed_ (run, output quoted). Repository state: `origin/main` at `cab8ce1`.

---

## 0. Headline

- **`set_updated_at()` is an orphan on the fresh build, not a missing function
  in production.** `20251217000000_communication_schema` creates it and one
  trigger, `trigger_event_rsvps_updated_at` on `event_rsvps`. On a from-scratch
  replay, `20260331000000_definitive_schema`'s "fresh-replay canonicalization"
  block then drops the interim tables `CASCADE` (`event_rsvps` among them),
  which removes the trigger but not the function, and recreates `event_rsvps`
  with `event_rsvps_set_timestamp -> trigger_set_timestamp()`. Production never
  ran the early chain as written, so it never had the function. Both sides end
  with the same trigger on `event_rsvps`. **No trigger is missing in production
  because of `set_updated_at`, and nothing breaks.** (_executed_, §2)
- **The same reset hides a larger drift, in the other direction.** Production
  has **17 triggers the fresh build does not**, so CI (pgTAP, the harness and
  the real-backend E2E) tests a schema without them:
  - 15 `set_org_id_*` triggers that fill `organization_id` from a parent row
    when an insert leaves it null (`20260324000000_phase1_rls_unification`);
  - `set_scheduler_runs_created_by` (fills `scheduler_runs.created_by` from
    `auth.uid()`, `20251208000000`);
  - **`trigger_manage_field_subunits`** on `fields`
    (`20251216000000_facility_multi_tenancy`). This one changes behaviour that
    matters: in production, every `admin_update_field` call with
    `supports_halves = false` hard-deletes the field's sub-surfaces, and the
    `ON DELETE CASCADE` on `practice_slots.field_subunit_id` deletes their
    practice slots and, through `practice_assignments`' cascade, the
    assignments on them, with no audit row and past the retirement and
    booking guards of `20260907000000` and `20260911000000`. Shown on a
    scratch build carrying production's trigger (_executed_, §3.2).
- Production also has one function the fresh build lacks: a second overload
  `persist_evaluation_run(jsonb, jsonb[], jsonb[])` beside the
  `(jsonb, jsonb, jsonb)` one, with the **same argument names**. PostgREST
  picks an overload by argument names, so a call naming `p_run_data`,
  `p_findings` and `p_metrics` may be refused as ambiguous (PGRST203) in
  production only. **Unverified**: production holds 0 `evaluation_runs`, which
  fits but does not prove it (§3.3).
- **RLS policies do not drift**: all 82 `public` policies are identical in name,
  command, roles and expression text on both sides (_executed_, §2.4). The RLS
  rewrite plan relies on this.

**Recommendation (§5):** one forward migration that makes the two converge,
plus a CI check that the fresh build's trigger and function catalogue matches a
committed snapshot of production's, so this cannot reopen silently. Until then:
**no new migration may reference `set_updated_at()`, create a `set_org_id_*`,
`set_scheduler_runs_created_by` or `trigger_manage_field_subunits` trigger
without `DROP TRIGGER IF EXISTS` first, or create a
`persist_evaluation_run` overload.** Each would pass CI and fail, or behave
differently, at `deploy-migrations` on `main`.

---

## 1. Where `set_updated_at()` is defined and who calls it (_statically reviewed_, then _executed_)

A search of the repository for `set_updated_at` (migrations, `seed.sql`,
`config.toml`, scripts, functions, docs) finds one definition and one caller:

| Where                                                                            | What                                                                                                                   |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `supabase/migrations/20251217000000_communication_schema.sql:127-134`            | `create or replace function public.set_updated_at()` (no `search_path`; sets `new.updated_at = now()`)                 |
| same file `:136-143`                                                             | `trigger_event_rsvps_updated_at BEFORE UPDATE ON public.event_rsvps`, its only caller, inside an `IF NOT EXISTS` guard |
| `docs/security/supabase-advisor-waivers.json`                                    | the `function_search_path_mutable` waiver for it (expires `null`), whose reason already records the drift              |
| `docs/operations/ci-cd.md:361`, `docs/architecture/persistence-rpc-layer.md:163` | descriptions                                                                                                           |

Nothing in `supabase/seed.sql`, `supabase/config.toml` or the `extensions`
schema defines or calls it. No Edge Function, frontend or core file names it.

What removes the caller on a fresh build: `20260331000000_definitive_schema.sql:63-180`.
When `season_settings.id` is `bigint` (the interim schema the early chain
builds), it refuses if any listed table has rows, then
`DROP TABLE IF EXISTS ... public.event_rsvps, ... CASCADE` and rebuilds the
tables; `:612-628` recreates `event_rsvps` with `event_rsvps_set_timestamp`.
`DROP TABLE ... CASCADE` drops the table's triggers, not the functions they
call. The same block is what removes the 17 triggers in §0, which were created
on tables it drops (`field_subunits`, `practice_slots`, `games`, `fields`,
`scheduler_runs`, ...), and leaves two more orphans,
`ensure_assistant_coach_ids_valid()` and `ensure_game_team_consistency()`
(`20251208000000:228`, `:276`; their triggers at `:319`, `:326`).

## 2. Measurement

### 2.1 A fresh build, here (_executed_)

The harness's own way of building (`scripts/dbharness/run.sh`): a throwaway
PostgreSQL 16 cluster on a unix socket, `scripts/dbharness/prelude.sql`, the
stub `pg_cron`/`pgtap` extensions, then every file in `supabase/migrations/` in
order with `ON_ERROR_STOP=1`: **applied 129**.

| Query on the fresh build                                        | Result                                               |
| --------------------------------------------------------------- | ---------------------------------------------------- |
| triggers whose function is `set_updated_at`                     | **0**                                                |
| function bodies mentioning `set_updated_at` (other than itself) | 0                                                    |
| event triggers on it                                            | 0                                                    |
| triggers on `event_rsvps`                                       | `event_rsvps_set_timestamp -> trigger_set_timestamp` |
| `public` functions / non-internal `public` triggers             | 183 / 35                                             |

A second database built from the same files **up to `20260324000004`** (the
last before `definitive_schema`) has `season_settings.id` `bigint` and
`event_rsvps.trigger_event_rsvps_updated_at -> set_updated_at`: the trigger
exists until the reset drops it (_executed_).

### 2.2 Production (_executed_, read-only)

Project `mmwupqsjkikqzvmdvuzm`, Supabase MCP `execute_sql` and
`list_migrations`, 2026-10-17. Every statement was a `SELECT` against the
catalogue or a `count(*)`; nothing was written. Exactly what ran:

1. `pg_proc` for `set_updated_at`, `trigger_set_timestamp`,
   `update_updated_at_column`, `handle_updated_at`, `moddatetime` in any schema:
   `public.trigger_set_timestamp()` and `storage.update_updated_at_column()`
   only. **No `set_updated_at` in any schema.**
2. `list_migrations`, and `count(*)`, `min`, `max` of
   `supabase_migrations.schema_migrations`: **129 rows**, `20240405180000` to
   `20261014000000`, matching the 129 repo files one for one. `20251217000000`
   has `statements = NULL`: it is a row written by the 2026-09-28 ledger
   normalisation (`migration-ledger-normalisation.md`), which recorded every
   repo file up to `20260924000000` as applied "in substance", not a record of
   that file running. The backup of the original 141 apply-time rows,
   `supabase_migrations.schema_migrations_backup_20260928`, **no longer exists**
   (the only table in that schema is `schema_migrations`), so what production
   actually ran for the early chain can no longer be read there.
3. `event_rsvps`: one trigger, `event_rsvps_set_timestamp -> trigger_set_timestamp`;
   columns as `definitive_schema` declares them; **0 rows**.
4. Every `public` function signature and every non-internal `public` trigger
   (`table.trigger -> function`): 145 and 52.
5. One query carrying the fresh build's 183 signatures and 35 triggers as
   literal arrays, returning each side's `EXCEPT` (§2.3).
6. `pg_get_triggerdef` for the field, `scheduler_runs`, `games` and
   `practice_assignments` triggers; `prosrc` and `proconfig` of
   `handle_field_subunits` and `set_created_by_to_auth_uid`; `field_subunits`'
   constraints and indexes; the foreign keys that reference `field_subunits`;
   `count(*)` of `fields`, `field_subunits`, `scheduler_runs`,
   `evaluation_runs`; `pg_extension` for `pgcrypto`, `pgtap`, `pg_cron`.
7. `pg_get_function_arguments`, `prosecdef`, `proacl` and `md5(prosrc)` of both
   `persist_evaluation_run` overloads.
8. One query carrying the fresh build's 82 policies as `table|name|cmd|permissive|roles|md5(qual#with_check)`
   literals, returning each side's `EXCEPT`.

### 2.3 The difference

| Only on the fresh build (CI)                                                                                                               | Only in production                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `set_updated_at()` (orphan: no caller)                                                                                                     | 15 `set_org_id_*` triggers (below)                                                             |
| `ensure_assistant_coach_ids_valid()`, `ensure_game_team_consistency()` (orphans: no caller)                                                | `scheduler_runs.set_scheduler_runs_created_by -> set_created_by_to_auth_uid`                   |
| 36 `pgcrypto` functions in `public` (an artefact of the bare cluster: production has `pgcrypto` in `extensions`, as `supabase start` does) | `fields.trigger_manage_field_subunits -> handle_field_subunits`                                |
|                                                                                                                                            | `persist_evaluation_run(p_run_data jsonb, p_findings jsonb[], p_metrics jsonb[] DEFAULT '{}')` |

The 15 `set_org_id_*` triggers (all `BEFORE INSERT`, each a no-op unless the new
row's `organization_id` is null): `field_subunits`, `practice_slots`,
`game_slots` (from `fields`); `team_players`, `practice_assignments` (from
`teams`); `games` (from the home team); `staging_players` (from `import_jobs`);
`player_buddies` (from `players`); `scheduler_runs`, `export_jobs` (from
`season_settings`); `evaluation_runs` (from `scheduler_runs`);
`evaluation_findings`, `evaluation_metrics`, `evaluation_run_events` (from
`evaluation_runs`); `email_log` (from `export_jobs`). Their functions exist on
both sides; only the triggers differ.

The 35 triggers the fresh build has are all in production too.

### 2.4 RLS policies (_executed_)

82 policies in `public` on each side; the `EXCEPT` both ways is empty, with the
expression text compared by `md5(qual || '#' || with_check)`. The 2026-09-28
`reconcile_prod_rls_drift` migration did its job, and the policies CI's pgTAP
exercises are production's.

## 3. Consequences

### 3.1 `set_updated_at()` (_executed_ that nothing calls it; consequence _statically reviewed_)

None at runtime: `event_rsvps.updated_at` is maintained in both places by
`event_rsvps_set_timestamp`. Two consequences for the process:

- the advisor waiver for its mutable `search_path` waives a finding that exists
  only in CI. Harmless, and its reason already says so;
- **a migration that calls it passes CI and fails in production**
  (`function public.set_updated_at() does not exist`) at `deploy-migrations`,
  after merge. That is the reason the resume queue asked for this before any
  new migration.

### 3.2 `trigger_manage_field_subunits` (_executed_ on a scratch build)

Production's definition, read back:
`AFTER INSERT OR UPDATE OF supports_halves ON public.fields FOR EACH ROW`;
the function inserts sub-surfaces `A` and `B` when `supports_halves` is true
(`ON CONFLICT (field_id, label) DO NOTHING`) and runs
`delete from field_subunits where field_id = new.id` when it is false.
`practice_slots.field_subunit_id` references `field_subunits ON DELETE CASCADE`
(production, read back), and `practice_assignments.practice_slot_id` references
`practice_slots ON DELETE CASCADE` (`20260331000000:527`).

`UPDATE OF supports_halves` fires whenever the column is in the `SET` list,
changed or not, and `admin_update_field` always sets it
(`supports_halves = COALESCE(p_supports_halves, false)`,
`20260504060000:271`); the Fields page always sends it
(`FieldManagementPage.jsx:107`, `useFields.js:123`).

Witness on the scratch build, inside `BEGIN ... ROLLBACK`, with production's
function and trigger recreated verbatim:

```
after insert: subunits=2
slots on subunits before=1
after rename (halves true): subunits=2
after halves off: subunits=0, slots on subunits=0
```

So in production:

- **turning "A/B halves" off on a field deletes its sub-surfaces, every
  practice slot on them, and every assignment on those slots**, writes no
  audit row, and goes around `admin_retire_field_subunit`'s booking refusal
  and the delete guard. Production has 0 `fields` today (read back), so
  nothing has been lost yet;
- creating a field with halves creates `A` and `B` in production and **not** in
  CI, so no real-backend test can see sub-surfaces made through the UI, and the
  mock (`mockSupabaseClient.js:2192`, `:2268`) imitates production, not CI.

### 3.3 The extra `persist_evaluation_run` overload (_statically reviewed_; **unverified**)

Both overloads take `p_run_data`, `p_findings`, `p_metrics`; both are
`SECURITY DEFINER` and executable by `authenticated` and `service_role`.
`fairness-scoring` and `auto-scheduler` call it by those three names. PostgREST
resolves an overloaded function by the argument names in the body, and two
candidates with the same names are its documented ambiguity error (PGRST203).
Production holds **0** `evaluation_runs` rows, which is what that would produce,
but also what no use would. Not reproduced: confirming it means calling the RPC
on production, which this investigation does not do. CI cannot see it (the
fresh build has one overload). The real-backend E2E's auto-scheduler run
persists through this RPC on the local stack only.

How to confirm without a write: the function logs for `auto-scheduler` or
`fairness-scoring` after the next real run (`PGRST203` or "Could not choose the
best candidate function"), or a `fairness-scoring` call with `persist: false`
first and then the owner's own run with `persist: true`.

### 3.4 The `set_org_id_*` and `created_by` triggers (_statically reviewed_)

Each only fills a null. Production is therefore more permissive than CI: an
insert that forgets `organization_id` succeeds in production and fails in CI
(the columns are `NOT NULL` in `definitive_schema`). CI is the stricter side, so
nothing CI passes breaks in production because of them. `created_by` is set
explicitly by both Edge writers (`auto-scheduler/index.ts:567`,
`fairness-scoring/index.ts:248`). They are dead weight, and a trap for a
migration that creates one of them again without `DROP TRIGGER IF EXISTS`.

## 4. Cause, in one paragraph

Production's schema was not built by replaying `supabase/migrations/`. Its early
history was applied through the MCP connector under apply-time versions, with
`definitive_schema` applied "as 14 split rows" and several files "superseded"
(`migration-ledger-normalisation.md`), and the ledger was re-keyed to the repo's
versions afterwards. A fresh build replays the repository, where
`definitive_schema`'s fresh-replay reset drops and rebuilds the interim tables
and silently loses every trigger the earlier files had put on them. Neither
side is wrong by its own history; they were never compared. The ledger says
"applied" for files that are applied only "in substance", so no tool reports
the difference.

## 5. Recommended fix (needs a migration)

**One forward migration, `<next version>_reconcile_trigger_drift.sql`**, written
to be a no-op wherever a side already matches the target, so the same file is
right on a fresh build and on production:

1. `DROP FUNCTION IF EXISTS public.set_updated_at();` and the two
   `ensure_*` orphans: nothing calls them on either side (§2.1). Remove the
   `set_updated_at` key from `supabase-advisor-waivers.json` in the same PR, or
   the stale-waiver check fails it.
2. `DROP FUNCTION IF EXISTS public.persist_evaluation_run(jsonb, jsonb[], jsonb[]);`
   (Q3). The repository never defines it after `20260406180000`, which
   `migration-ledger-normalisation.md` lists as "equivalent applied".
3. `trigger_manage_field_subunits` (Q1): `DROP TRIGGER IF EXISTS` and
   `DROP FUNCTION IF EXISTS public.handle_field_subunits()`, and move "create
   `A` and `B` when halves are switched on" into `admin_create_field` and
   `admin_update_field` as an insert-only step. Switching halves off never
   deletes: a sub-surface leaves through `admin_retire_field_subunit`, which
   refuses while it has bookings. This is a persistence change (rule 14), so it
   is the owner's call, and its two RPCs are replaced wholesale (lesson 11).
4. The 15 `set_org_id_*` and `set_scheduler_runs_created_by` (Q2):
   `DROP TRIGGER IF EXISTS` each, so production matches what CI already proves
   (every writer passes the value). The functions stay only if something still
   uses them (`propagate_org_id_from_*` are used by nothing else; drop them too
   if the owner agrees).
5. **A drift check**, so this does not reopen: commit
   `supabase/catalog-snapshot.json`, the sorted list of `public` function
   signatures, `public` triggers and policy digests, generated from a fresh
   build (Q4). A harness step regenerates it and fails on any difference, so a
   migration that changes the catalogue updates the snapshot in the same PR;
   and `docs/operations/ci-cd.md` gains a read-only query an operator runs after
   each `deploy-migrations`, comparing production with the snapshot. No CI job
   reads production (no secret leaves CI for that).

`docs/sql/<version>_revert.sql` recreates exactly what production has today
(the triggers, the overload and `handle_field_subunits` as read back in §2.2),
and `_smoke.sql` asserts: no `set_updated_at`; no trigger calling
`handle_field_subunits`; one `persist_evaluation_run`; a field updated with
halves off keeps its sub-surfaces and their slots (the §3.2 witness, inverted);
a field created with halves through the RPC has `A` and `B`. The harness runs
both on a fresh build; on production, CI applies the migration on merge.

Effort S-M: about 60 lines of migration, the two RPCs rewritten (about 300 lines
copied, 15 changed), the snapshot generator (about 80) and its tests.

## 6. Questions for the owner

**Q1. The field sub-surface trigger: replace it with an insert-only step in the
two field RPCs (recommended), or keep production's behaviour and add the
trigger to the fresh build?**
_Recommendation:_ replace. Deleting a field's sub-surfaces, their slots and
their assignments because a checkbox was saved unticked, with no audit row and
past the guards built in September, is the defect; copying it into CI would
make CI agree with a bug. Production has no fields yet, so nothing is lost
either way today.

**Q2. The 15 `set_org_id_*` triggers and `set_scheduler_runs_created_by`: drop
them in production (recommended), or add them to the fresh build?**
_Recommendation:_ drop. CI has run without them since the reset was written,
which shows every tested writer passes the values, and an insert that forgets
its organization should fail rather than inherit one. The alternative is
harmless but keeps two schemas' worth of behaviour for one schema's worth of
tests.

**Q3. The second `persist_evaluation_run` overload: drop it (recommended)?**
_Recommendation:_ yes, in the same migration. Nothing in the repository defines
or calls it, and while it exists the RPC both Edge Functions persist through is
ambiguous in production only.

**Q4. A committed catalogue snapshot checked by the harness, plus an operator
query after each deploy (recommended), or a CI job that reads production's
catalogue directly?**
_Recommendation:_ the snapshot. A CI job reading production needs a production
credential in CI on every pull request; the snapshot needs none, and the
operator query covers the one thing it cannot see.

**Q5. One migration for all of this (recommended), or the function drops now
and the trigger decisions later?**
_Recommendation:_ one. Each piece is small, they share a revert and a smoke, and
the snapshot check in Q4 only goes green once all of them are in.
