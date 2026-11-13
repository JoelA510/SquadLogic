# Settings scope (F11-4): one setting at organization, program and division level, the most specific winning

Kind: FEATURE with a persistence change (a settings store, a resolver, a setter, a rollover copy).
Drawn up: 2026-11-13 against `origin/main` `0687cae` (PR 11 merged). Owner: the repository owner.
Status: **APPROVED 2026-11-13** by the coordinator under the owner's delegation (see "Decisions record (2026-11-13)");
F11-4a in progress. AGENTS.md rule 14 applies (persistence and the domain model). This is the "own small plan" that
the F11 plan (`docs/changes/2026-11-06-games-table-source-of-truth.md`, "F11" below) requires before F11-4 starts
(F11:732-737, decision D7 (a), F11:822-824). "Expansion" below is `docs/changes/2026-11-03-schedule-expansion.md`.

## Labels and method

Every claim about the code is _statically reviewed_ (read at `0687cae`) unless marked _executed_. _Executed_ here means
a search or a small script run in the worktree on 2026-11-13; the "Receipts" section lists each one. No test, build,
lint, typecheck, pgTAP, harness run or migration was run, nothing was read from production, and nothing is _fully
validated_. A claim of absence names the search and its positive control.

## Why

`docs/product.md` (Users): league administrators run the league in SquadLogic. The owner's principle (expansion 6.2,
2026-11-06; expansion:1228-1245): optional behaviours are configurable at organization, program and division level; an
unset level inherits from the level above; the most specific wins. Two behaviours need it now:

- **Standings and outside clubs** (expansion decision 5; F11 "The settings cascade", F11:466-502): a league whose U12
  division plays a neighbouring club in league play wants those results counted there, and not in U8. Today the setting
  is organization-wide only.
- **Paired practice days** (expansion 5.7, PR 12; expansion:1027-1087, 1909-1939): optional per division, with program
  and organization defaults "through one resolver, built with its first user".

## Size verdict (prompts/plan-change.md, Step 0)

Planned, not small. It changes a data model and adds a migration (a settings table, a key registry, three functions,
two function replacements); it changes authorization paths (a new admin RPC) and what a rollover copies; it changes
behaviour other code relies on (`standings_counts_outside`, read by `view_league_standings`); it is AGENTS.md rule 14
(persistence and the domain model). It adds no dependency, service or environment variable.

**Size: L in total; two pull requests recommended (decision S7).** F11-4a, the database half (migration, resolver,
setter, rollover, core twin, mock): M to L, about 900 lines with tests (estimate). F11-4b, the screen: M, about 350
lines with tests. F11 sized F11-4 as one M pull request (F11:524); the difference is under "Contradictions".

## What exists (findings, each cited)

1. **The standings toggle is a key in `organizations.feature_flags`.** `standings_counts_outside(p_division_id)` is a
   SQL `SECURITY DEFINER` function that returns `org_flag(d.organization_id, 'standings_count_outside_results', false)`
   for a division of an organization the caller is a member of, else false
   (`supabase/migrations/20261122010000_game_scores.sql:3410-3427`). `org_flag` reads a boolean key of
   `organizations.feature_flags`, the default when absent or not a boolean, and is closed to every client role
   (`20261021010000_server_side_reads.sql:280-293`, `:596`). The view calls the seam once per scored side
   (`20261122010000:3446`). The client registry names the key, off unless turned on, and offers it on the Features
   page tied to Standings (`frontend/src/constants/featureFlags.js:86-90`, `:245-254`). The mock reads the same key
   (`frontend/src/lib/mockGameScores.js:165-167`). (statically reviewed)
2. **`feature_flags` can be written without the audited RPC.** The audited writer is `update_org_feature_flags(org,
flags)`, which replaces the whole object and records `feature_flags.updated` with `{field, old, new}`
   (`20260403000000_settings_audit_rpc.sql:28-73`). But `organizations` has an admin `UPDATE` policy
   (`20261018030000_rls_advisor_rewrite.sql:208-211`), so an admin can update the column directly with no audit row.
   The heat-settings migration chose a table for exactly this reason (`20261006000000_org_heat_settings.sql:15-19`). A
   search for a trigger guarding `feature_flags` found none (_executed_, R6). (statically reviewed, with R6)
3. **The client parse of `feature_flags` is fragile for a non-boolean value.** `FeatureFlagSchema` is
   `z.record(z.string(), z.union([z.boolean(), z.string()]))` (`featureFlags.js:263-291`); an array value fails the whole
   parse and the context falls back to **no flags at all** (`frontend/src/contexts/OrganizationContext.jsx:283-292`).
   The schema also drops unknown keys, and `updateFeatureFlags` sends the parsed object as the whole new value
   (`OrganizationContext.jsx:240-262`), so a key the registry does not know is erased by the next Features-page save.
   PR 12's value is a set of weekday pairs (finding 9), which would break both. (statically reviewed)
4. **Programs.** `programs` (`id`, `organization_id`, `season_settings_id`, `name`, `is_default`,
   `copied_from_program_id`, timestamps), one default program per season ("No program") made by a trigger
   (`20261101020000_programs.sql:103-125`, `:152-172`); `divisions.program_id` with a composite key to the program's
   season (`:187-195`); members `SELECT`, no write policy, writes only through four admin definer RPCs
   (`:136-146`, `:268-601`), each taking the organization's season lock and audited (`program.upserted`,
   `program.deleted`, `program.merged`; `:89-92`, `:353`). A client change of `divisions.program_id` is refused by a
   trigger because the divisions policies would otherwise allow it (`:228-255`). A program spans divisions; each
   division is in one program (expansion:1051, 1232). (statically reviewed)
5. **Divisions.** Typed columns; members select; **admins insert, update and delete directly**
   (`20260502001000_division_roster_constraints.sql:103-118`; the live list, `supabase/catalog-snapshot.json`,
   policies `divisions|...`). Names are unique per season (`20260331000000_definitive_schema.sql:295`). (statically
   reviewed)
6. **The audited division settings RPC.** `admin_upsert_division_settings`, 13 arguments
   (`20261105010000_practices_per_division.sql:1459-1733`). It SETS every roster rule to what it is given, a null
   clearing it (`:1667-1673`), while `plays_games`, `practices_per_week` and `practice_minutes` take null as "keep"
   (`:1557-1574`); audited as `settings.updated` with `setting: 'division_team_generation_rules'`, `previous` and
   `current` (`:1684-1720`). Because of the mixed null rule, PR 11's import re-reads a division and sends its roster
   rules back, refusing when they changed since the import read them (`frontend/src/utils/practiceImportClient.js:265-331`);
   the follow-up "an RPC that sets a division's practice settings alone" is recorded (expansion:1869-1875).
   (statically reviewed)
7. **The settings audit trail.** `get_settings_audit_log(org)` returns `settings.updated` and `feature_flags.updated`
   rows, admin only (`20260403000000:83-120`); `audit_log.action` is a foreign key to `audit_actions`
   (`20260613000006_audit_actions_lookup.sql:1-11`). The page renders `{field, old, new}` as a diff and anything else as
   JSON; a null shows as "None" (`frontend/src/components/settings/SettingsAuditLog.jsx:92-133`). (statically reviewed)
8. **Rollover.** `admin_create_season_from` (`20261111010000_season_rollover.sql:669-818`) takes the season lock
   (`:709`), copies the source's non-default programs by name with `copied_from_program_id` (`:750-754`), links the new
   default to the old default (`:755-759`), and copies divisions by the column catalogue `rollover_division_columns()`
   (`:150-174`, `:765-778`), refusing a partial copy (`:780-784`). A program carries nothing but its name across. The
   pgTAP holds every `divisions` column to the copied-or-skipped catalogue (`supabase/tests/season_rollover.sql:66-81`).
   No later migration replaces the function (_executed_, R4). (statically reviewed, with R4)
9. **What PR 12 needs.** A division value now and program and organization defaults through one resolver (expansion
   5.7, 6.2). Its value is **not a boolean**: a set drawn from `mon-wed`, `tue-thu`, `wed-fri`, empty meaning off
   (expansion:1039-1046). It is read by the practice writer's gate in SQL (`practice_new_auto_row_refusals`), by two
   solver twins (core and Edge) and by the Teams page (expansion:1075, 1080-1086), and it only makes sense for a division
   with exactly two practices a week (expansion:1069). Its M0 sizes "where program-level settings are stored" and stops
   if PR 12's one migration cannot carry it (expansion:1917-1923). (statically reviewed)
10. **The deploy window.** Vercel deploys every push to `main` (`docs/operations/ci-cd.md:711-716`); the migration job
    starts on the same push and finishes later (the brief: about 40 minutes), and a migration whose client must deploy
    first ships in its own PR (`ci-cd.md:233-236`). Precedent for a missing-object fallback: `usePrograms` treats
    42P01, PGRST205 and 42703 as "not available yet" (`frontend/src/hooks/usePrograms.js:13-34`). (statically reviewed)
11. **Tests that read the seam today.** `supabase/tests/game_scores.sql:496-501` and `:562-578` turn the organization
    flag on through `feature_flags`; `tests/standingsOutsideClubs.test.jsx:191-230` holds the key to the text of
    `20261122010000` and to the Features catalog; the demo census lists `standings_counts_outside` as a client-callable
    function (`supabase/tests/demo_sessions.sql:640-642`). Replacing the seam's body moves all three (lesson 108).
    (statically reviewed)

## Behavior

- **Now.** One organization-wide switch, "Count results against outside clubs", decides for every division. It lives in
  `feature_flags`, can be changed by a direct table write with no audit row (finding 2), and is not copied anywhere at
  rollover (it is not per season). PR 12 has nowhere to put a program default.
- **After.** An administrator sets "Count results against outside clubs" for the organization, for a program, or for a
  division, or leaves a level as "Inherit". A division's standings count those results when its own value says so,
  else its program's, else the organization's, else the default (not counted). An explicit "Don't count" on a division
  beats "Count" on its program or organization, and the reverse. Each change writes one `settings.updated` audit row
  naming the level, the key and the value before and after ("Inherited" when unset). Starting the next season copies
  each program's and each division's values to their copies. The setting is shown and changed in one Settings panel
  that also says, for each division, what applies now and where it comes from. PR 12 adds its key with one row in the
  registry and uses the same resolver, setter and panel.
- **Unchanged (each is a test; the task list names it).**
  - With no program or division value, every standings row equals today's for the same organization value (the
    organization value is carried over by the migration): `game_scores.sql`'s standings cases, re-seeded through the
    setter, give the same numbers.
  - `view_league_standings` keeps its fifteen columns in order (it is not replaced; only the seam's body is).
  - `standings_counts_outside` keeps its signature, its definer rights, its grants and its answer for a non-member
    (false).
  - `admin_create_season_from` copies the same programs, divisions and columns, with the same counts and refusals, and
    keeps its signature and result keys (it gains one key, appended, in its audit metadata and result).
  - `admin_upsert_division_settings` is not replaced.
  - `get_settings_audit_log` is not replaced; the new rows appear in it because they use `settings.updated`.

## Out of scope

- PR 12's key, its applicability rule and its gate (PR 12 adds them; this plan says what it must decide, below).
- A season-level value (decision S3), play-down at program or division level, and the two "Published" switches
  (expansion 6.2 lists them as not planned).
- A per-fixture override of the standings policy: **named, not built.** Where it would live: a nullable
  `counts_for_standings boolean` on `game_scores` (the score row, F11:313-316), consulted before the division's
  resolved value; no column, no UI, no test in this plan.
- Closing the direct-write gap on `organizations.feature_flags` for the keys that stay there (finding 2): recorded as
  a follow-up; this plan moves the one scoped key out of it.
- Freezing a completed season's standings: they are computed live, so an organization-level change alters a completed
  season's table today and after this change alike (recorded under Risks).

## Against the rules

- **Rule 14 (stop and agree a plan first):** this plan is the stop: persistence (a table, a migration) and the domain
  model (which value a division gets). No solver change.
- **Rule 2 (minimal diffs):** two functions are replaced whole (`standings_counts_outside`, `admin_create_season_from`),
  each behind the md5 of its current body; the Features page loses one switch, which moves to the new panel. Flagged
  here; no other refactor.
- **Rule 3 / section 10 (env):** no variable.
- **RPC enforcement, Zod, audit immutability, RLS (AGENTS.md section 3):** the table has a member `SELECT` policy and no
  write policy; its one client writer is the setter, which writes the audit row in the same transaction; the screen's
  input is a Zod schema before the call.
- **Verification conventions:** the precedence test's subject is the full product of levels (8 combinations, two value
  patterns), not a sample; the rollover test enumerates values from the source season, not from the copy; the parity
  test reads its case table out of the pgTAP file, so the two arms cannot each choose their own cases.
- **"Declared is not enforced":** a program deleted or merged takes its own values with it (foreign-key cascade) and no
  audit row lists them (decision S8); this is said in the dialogs and here.
- **No ADR folder** (AGENTS.md rule 7): the decision is recorded here and, once settled, as a lesson.

## Design

### Data shape: one settings table, a jsonb value per row, a closed key registry (decision S1)

Three shapes were compared.

| Shape                                                       | Program and division storage | Organization level       | Write paths to guard                                                                                                                     | Adding a key (PR 12)                                 | Rollover                                                                           |
| ----------------------------------------------------------- | ---------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| (a) **One table, a row per level and key** [recommended]    | rows                         | rows                     | none: no write policy                                                                                                                    | one `INSERT` into the registry                       | copy rows; replace `admin_create_season_from` once                                 |
| (b) A `settings jsonb` column on `programs` and `divisions` | the column                   | stays in `feature_flags` | divisions' admin `INSERT`/`UPDATE` policies need a guard trigger (as `divisions_program_guard`); `feature_flags` stays directly writable | replace the validator function                       | divisions: join the column catalogue; programs: replace `admin_create_season_from` |
| (c) Typed nullable columns per setting                      | a column per key per table   | stays in `feature_flags` | as (b), per column                                                                                                                       | a migration adding two columns, two rollover changes | per column                                                                         |

Why (a): it is the only shape where **no direct write is possible at any level** (findings 2 and 5; the heat-settings
precedent), so "every change is audited" is true by construction rather than by a trigger each table must remember
(lesson 64). Absent row = inherit, so null-versus-false needs no convention. PR 12's set value fits a jsonb value with a
registry type. Adding a key costs one registry row, not a migration of columns. Rollover copies rows and needs no
column catalogue change. The cost: readers join one more table (indexed), and the rollover maps divisions by name.

**Tables (migration `20261124010000_settings_scope.sql`).**

- `scoped_setting_keys` (reference data, like `audit_actions`): `key text PRIMARY KEY`, `value_type text CHECK
(value_type IN ('boolean', 'text_set'))`, `allowed_values jsonb` (a JSON array of strings for `text_set`, null for
  `boolean`), `default_value jsonb NOT NULL`, `label text NOT NULL`. Members `SELECT`; no write policy; rows only from
  migrations. F11-4 inserts one row: `('standings_count_outside_results', 'boolean', NULL, 'false', 'Count results
against outside clubs')`. The key name is the existing one, so nothing that names it changes meaning.
- `scoped_settings`: `id uuid PK`; `organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE`;
  `program_id uuid REFERENCES programs ON DELETE CASCADE`; `division_id uuid REFERENCES divisions ON DELETE CASCADE`;
  `key text NOT NULL REFERENCES scoped_setting_keys`; `value jsonb NOT NULL CHECK (jsonb_typeof(value) <> 'null')`;
  `updated_at`, `updated_by`. `CHECK (num_nonnulls(program_id, division_id) <= 1)`: a row is the organization's (both
  null), a program's, or a division's. Three partial unique indexes, one per level, on `(organization_id, key)`,
  `(program_id, key)`, `(division_id, key)`; they also index the two foreign keys. RLS: members `SELECT`
  (`is_org_member(organization_id)`); no insert, update or delete policy; `REVOKE ALL` then `GRANT SELECT` to
  `authenticated`, `service_role` (the `programs` idiom, `20261101020000:145-146`).
- **Null means inherit; an explicit false is a row.** A level with no row inherits. `false` (or `[]` for a set) is a
  value, and it beats an inherited `true`. A JSON `null` value is refused by the CHECK, so there is one way to say
  "inherit": no row.
- **The default program ("No program") holds no values** (decision S4): the setter refuses it (22023,
  `default_program`), so a division in no program inherits from the organization.
- **Top level: the organization** (decision S3). Programs are already per season, so a season level would repeat the
  program level for most leagues.

### The resolver: SQL is the source of truth, core is its twin

- **SQL (`scoped_setting_value(p_division_id uuid, p_key text) RETURNS jsonb`)**, `STABLE`, `SECURITY DEFINER`,
  `SET search_path = public`, closed to client roles (internal, like `org_flag`). It reads the division's own row, then
  its program's (unless default), then its organization's, then `scoped_setting_keys.default_value`; the first present
  wins. An unknown key raises 22023 `unknown_setting` (a typo fails loudly); an unknown division returns the default.
  It is what the server enforces: the standings seam now, PR 12's gate later.
- **`standings_counts_outside(uuid)` replaced** (md5-guarded) with the same signature, rights, grants and member check:
  `COALESCE((SELECT (scoped_setting_value(d.id, 'standings_count_outside_results'))::boolean FROM divisions d WHERE
d.id = p_division_id AND is_org_member(d.organization_id)), false)`.
- **Core (`packages/core/src/scopedSettings.js`)**, pure, registered in the index: `SCOPED_SETTING_KEYS` (the registry's
  mirror) and `resolveScopedSetting({ organization, program, division }, key)` returning `{ value, source }`, source one
  of `division`, `program`, `organization`, `default`. It serves the panel ("applies now: Counted, from the program
  Juniors"), the mock's standings and, later, PR 12's solvers.
- **Parity.** `supabase/tests/scoped_settings.sql` holds the case table as one `VALUES` list (16 rows: the 8 set/unset
  combinations of the three levels under two value patterns, organization/program/division = true/false/true and
  false/true/false, plus the all-unset row against the default). `tests/scopedSettingsParity.test.js` reads that `VALUES`
  list out of the .sql text and runs `resolveScopedSetting` over the same rows, so the twin is held to the database's
  cases (lesson 77) and neither side chooses its own. A second assertion holds `SCOPED_SETTING_KEYS` equal to the union
  of every `INSERT INTO public.scoped_setting_keys` across `supabase/migrations/` (key, type, allowed values, default),
  so PR 12's row is checked the day it lands (lesson 108: the union, not one named file).

### The one setter

`admin_set_scoped_setting(p_key text, p_scope text, p_scope_id uuid, p_value jsonb)` returns jsonb `{ changed, scope,
scope_id, key, previous, current }`, `SECURITY DEFINER`, `SET search_path = public`, `SET timezone = 'UTC'`, granted to
`authenticated`. `p_value` SQL `NULL` means "Inherit" (delete the level's row).

1. `auth.uid()` required (42501). `p_scope` in `organization`, `program`, `division` (22023).
2. The organization is read from the scope's **own row** (`p_scope_id` is the organization, or the program's or
   division's `organization_id`); a missing row and another organization's get the same 42501, as
   `admin_upsert_program` does (`20261101020000:296-301`, `:329-333`). `is_org_admin` of that organization (42501).
3. The organization's season lock, `pg_advisory_xact_lock(hashtextextended('season:' || org, 0))`, so a rollover's copy
   and a change cannot interleave (lesson 64; the lock the program writers and the rollover take).
4. The key must be registered (22023 `unknown_setting`). The value must match its type: a JSON boolean; or for
   `text_set` a JSON array of distinct strings each in `allowed_values`, stored sorted (one spelling per set, so
   "unchanged" is an equality). Anything else is 22023 `setting_value_invalid` naming the key.
5. A program: not the default (22023 `default_program`); its season not completed (22023 `season_completed`). A
   division: its season not completed. The organization level has no season.
6. Insert, update or delete the one row; nothing else changes. Unchanged is `changed: false` and no audit row.
7. One audit row: `record_audit_event(org, 'settings.updated', 'scoped_setting', p_scope_id, metadata)` with
   `metadata = { setting: 'scoped_setting', field: <key>, key, scope, scope_id, scope_name, season_settings_id, old,
new }`, where `old` and `new` are the values or JSON null for "Inherited". `field`, `old` and `new` make the existing
   page show it as a diff (finding 7); `settings.updated` is already registered and already returned by
   `get_settings_audit_log`, so neither changes.

**The practice-only division settings RPC (PR 11's follow-up; decision S6).** The setter cannot be that RPC, and should
not host it: the practice settings are typed per-division columns with "null keeps" semantics and their own CHECKs, not
inheritable values, and folding them in would give one function two meanings of null. The **migration** can host it
cleanly: `admin_set_division_practice_settings(p_division_id, p_practices_per_week, p_practice_minutes)`, a sibling
that changes only those two columns (null keeps, `0` minutes is "any slot length", the same range checks as
`20261105010000:1557-1574`), takes the season lock, refuses a completed season, and writes the same
`settings.updated` / `division_team_generation_rules` row shape with only the practice keys in `previous` and
`current`. F11-4b points PR 11's import at it and deletes the read-then-write and its `division_rules_changed`
refusal. PR 12 then needs no 14-argument `admin_upsert_division_settings` for its own setting (below).

### Rollover

`admin_create_season_from` replaced whole (md5-guarded), unchanged except one block after the divisions copy:

- program values: `INSERT INTO scoped_settings (organization_id, program_id, key, value, ...) SELECT ..., np.id, ...
FROM scoped_settings s JOIN programs sp ON sp.id = s.program_id AND sp.season_settings_id = <source> JOIN programs
np ON np.season_settings_id = <new> AND np.copied_from_program_id = sp.id` (the default program has none);
- division values: the same through `divisions sd` (the source's) and `divisions nd` with `nd.season_settings_id =
<new> AND nd.name = sd.name` (names are unique per season and copied exactly);
- a count check, as for divisions (`:780-784`): the rows copied equal the source season's program and division rows,
  else XX000 and nothing is created;
- `scoped_settings_copied` appended to the audit metadata and to the result.

Organization values are not per season and are not touched. No column is added to `divisions`, so the column catalogue
and its pgTAP do not change.

### Migration `20261124010000_settings_scope.sql` (F11-4a)

1. **Starting bodies checked**, the 20261111010000 idiom (`:76-98`): `md5(replace(p.prosrc, E'\r', ''))` of
   `standings_counts_outside(uuid)` and `admin_create_season_from(uuid,text,integer,date,date)` against recorded values,
   else `RAISE EXCEPTION` and nothing is applied. The values computed from the migration files' text are
   `599e5e168256adcd6ff7e67ef4de6594` and `446991cc4145987cad805bd47cc865b4` (_executed_, R7: from the file text, not
   from a database); the build confirms them against a harness build of `0687cae` and production before they are
   written into the migration (lesson 87).
2. `scoped_setting_keys`, `scoped_settings`, policies, grants, comments.
3. **The organization value carried over:** for each organization whose `feature_flags -> 'standings_count_outside_results'`
   is a JSON boolean, one organization row with that value. No audit row (a move of storage, not a change of value; the
   migration header says so). `feature_flags` itself is not edited.
4. `scoped_setting_value`, `admin_set_scoped_setting`, `admin_set_division_practice_settings`.
5. `standings_counts_outside` and `admin_create_season_from` replaced.
6. An end-state check (the 20261122010000 idiom, `:3571-3582`): the seam is a definer with the member check; no client
   role can execute `scoped_setting_value`; `scoped_settings` has no insert, update or delete policy and no client
   write grant; the organization rows carried equal the organizations with a boolean flag.

Revert `docs/sql/20261124010000_revert.sql`: copies each organization row of `standings_count_outside_results` back
into `feature_flags` (so the organization level survives), restores the two bodies from production's text (md5 checked),
drops the three functions and two tables, and reports how many program and division values it dropped
(`RAISE NOTICE`; they remain readable in the audit trail). Smoke `docs/sql/20261124010000_smoke.sql`: objects, grants,
the seam's answer for a seeded division at each level. Catalogue snapshot regenerated; the demo census
(`demo_sessions.sql:640-700`) lists the two new admin RPCs as allowed (admin-gated); harness plants aimed at the two
replaced bodies are re-aimed (lesson 70).

### Authorization, on every path

- Read: members, through RLS on both tables. Values are not personal data.
- Write: only `admin_set_scoped_setting` (admin of the scope row's own organization) and the rollover (admin, season
  lock). No policy admits a direct write; the end-state check and a pgTAP case prove a direct `INSERT` as
  `authenticated` admin is refused.
- Enforcement reads (`standings_counts_outside`, later PR 12's gate) are server-side; the client's resolution is for
  display only.
- Cascades: deleting an organization, a program, a division or a season removes its rows (foreign keys); the demo
  purge and retention therefore need no change.

### Audit

Every change through the setter writes one `settings.updated` row in the same transaction (above). The rollover's
copies are counted in `season.created_from`'s metadata. The migration's carry-over writes none and says so. The
Settings audit page shows a scoped row as "Property: standings_count_outside_results" with "Inherited" for a null side
(a one-line change to `formatValue` for rows whose `metadata.setting` is `scoped_setting`; today a null reads "None").

### The screen (F11-4b; minimal, accessible; decision S5)

One panel in Settings, "Settings by program and division" (`frontend/src/components/settings/modules/ScopedSettingsSection.jsx`,
beside `ProgramsSection.jsx`), for the season being viewed:

- One section per registered key that has a label (today one). A `<table>` with a `<caption>` naming the setting;
  rows: Organization, then each program (default program omitted), then each division grouped under its program;
  columns: the level (a row header), "Setting" (a native `<select>` labelled by its row header via `aria-labelledby`,
  options "Inherit", "Count", "Don't count"; on the organization row "Inherit" reads "Default (don't count)"), "Applies
  now" (words: "Counted, from the program Juniors").
- A change saves at once through the setter (Zod-validated first), the row disabled while in flight, the result read
  back; success and refusal are said in a `role="status"` / `role="alert"` region in words (the database's message with
  ids removed, as PR 11 does). A completed season shows the table read-only with one sentence. Loading, empty ("This
  season has no divisions yet") and error states are words. Tokens only, both themes; native controls, so keyboard and
  screen-reader behaviour come with them.
- When Standings is off, a line says the setting applies when Standings is on (the stored values are left alone).
- The Features page's "Count results against outside clubs" switch is removed from `FEATURE_CATALOG` (F11-4a, so no
  switch writes a key nothing reads); the key stays in `FEATURE_FLAGS`, marked retired, so stored organizations still
  parse (the feature-guardians skill, "Retiring"). The skill and `docs/` are updated to say the standings setting is
  read through `scoped_setting_value`, not `org_flag`.

### The deploy window

**Two pull requests (recommended) need no fallback code.** F11-4a's client changes are the mock, core, and the removal
of the Features switch; it reads no new object, so its deploy at merge is safe while the migration is pending (the
seam still reads `feature_flags` until the migration applies, and nobody can change the value for that hour, which is
acceptable for a switch production has never been shown to use; F-R8 of F11 found no `standings` key on 2026-11-06).
F11-4b (the panel, the audit-row wording, the import's switch to the practice RPC) merges only after F11-4a's migration
is applied and verified, as the expansion's waiting rule already requires (F11:320-323).

**If the owner wants one pull request (S7 (b)),** the panel needs a temporary fallback: on 42P01, PGRST205 or 42703 for
`scoped_settings`, or PGRST202 for the setter, it shows "These settings are available once the database update has
finished (usually within the hour)" and keeps the old organization switch working through `update_org_feature_flags`;
the import keeps its read-then-write. Each fallback carries a comment `DEPLOY-WINDOW FALLBACK (added 2026-11-1x):
remove once 20261124010000 is verified in production, and no later than 2026-11-30`, a test of both arms
(`tests/scopedSettingsDeployWindow.test.jsx`), and a removal task in the next pull request, as F11-2's fallbacks were
removed by F11-3 (F11:642-643).

### What PR 12 takes from this (and must decide itself)

- Its key is one registry row in its own migration: `('practice_pairs', 'text_set', '["mon-wed","tue-thu","wed-fri"]',
'[]', 'Paired practice days')`; `[]` is an explicit "off" that beats an inherited set.
- Its gate reads `scoped_setting_value(division, 'practice_pairs')`; its solvers and the Teams page read the rows and
  `resolveScopedSetting`; the parity test already covers the key once its row exists.
- **Applicability is PR 12's rule, not the resolver's.** An inherited non-empty set reaches divisions that do not have
  two practices a week; the expansion's CHECK (`cardinality(practice_pairs) = 0 OR practices_per_week = 2`) and its
  23514 on changing the count (expansion:1039-1046) cannot see an inherited value. Recommended for PR 12: the pairing
  applies only where the division has exactly two practices a week, the panel says "does not apply: 3 practices a week"
  on such a division, and the setter refuses a non-empty **division-level** value on a division whose count is not 2.

## Risks and rollback

- **Risk:** the precedence is wrong in one corner (an explicit false read as unset) - **watch:** the 16-row case table
  in pgTAP and its parity twin - **if it happens:** fix the resolver; nothing is stored differently.
- **Risk:** a rollover drops a division's value because its name changed between seasons - **watch:** cannot happen in
  the copy (names are copied exactly in the same statement) - the count check refuses a partial copy - **if it
  happens:** the season is not created; nothing is half-copied.
- **Risk:** the standings view slows (the seam now reads up to four rows per scored side) - **watch:** an `EXPLAIN` of
  the view over the harness league in the build's report - **if it happens:** a per-division resolved CTE in the seam;
  the view is not changed.
- **Risk:** an organization had turned the flag on and the carry-over misses it - **watch:** the end-state check
  (organizations with a boolean flag = organization rows) and the pgTAP case that plants a flag before the migration
  (lesson 67) - **if it happens:** the migration refuses and nothing is applied.
- **Risk:** a cached pre-merge browser toggles the old Features switch after the migration - **watch:** a
  `feature_flags.updated` row naming the key after the deploy - **if it happens:** nothing breaks (nothing reads it);
  the panel shows the real value; say so to the admin.
- **Risk:** an organization-level change alters a completed season's standings (computed live; true today) - **watch:**
  owner testing - **if it happens:** a later change snapshots standings at completion; not this plan.
- **Risk:** deleting or merging a program silently drops its values (decision S8) - **watch:** the dialogs' sentence;
  the audit trail shows the program's last values - **if it happens:** re-enter them on the target program.
- **Rollback.** F11-4b: revert the commit (no data). F11-4a: `docs/sql/20261124010000_revert.sql` as above; the
  organization level is written back into `feature_flags`; program and division values are dropped and counted.

## Tasks

Each names its test. Plants: at most three per pull request.

### F11-4a: storage, resolver, setter, rollover, the standings seam (migration; rule 14; Review (c))

Depends on: this plan agreed. One migration; nothing else pending.

- [x] A1 (L) Migration `20261124010000_settings_scope.sql` as designed; revert and smoke; catalogue snapshot; plants
      re-aimed. **First** `supabase/tests/scoped_settings.sql`, red against `0687cae`: - precedence: the 16-row `VALUES` table through `scoped_setting_value` (all eight set/unset combinations of the
      three levels, both value patterns; an explicit `false` beats an inherited `true`, and the reverse; all unset
      gives the registry default); an unknown key raises 22023; - setter: each refusal (no user, wrong scope word, another organization's program, the default program, a
      completed season, an unknown key, a string for a boolean, a JSON null) writes nothing and is paired with an
      allowed control; set, change, unset each write exactly one `settings.updated` row with `old`/`new`; an
      unchanged write writes none; a direct `INSERT` and `UPDATE` as an `authenticated` admin are refused; - rollover: a source season with a value on a program, on a division in that program, on a division in no
      program and at the organization; the new season's program and divisions carry the first three (enumerated from
      the source's rows), the organization row is untouched, the default program has none, the audit metadata counts
      three; - the seam: `standings_counts_outside` follows the cascade (a division "count" under an organization "don't
      count" gives true, a division "don't count" under a program "count" gives false, a division with nothing
      follows its program, a non-member gets false), and one standings row per case through the view; - carry-over: organizations planted before the migration with the flag true, false, absent and a non-boolean
      each resolve after it exactly as `org_flag(org, key, false)` resolved before it (true, false, false, false);
      the first two have a row, the last two have none (lesson 67).
      Rewritten: `game_scores.sql:496-501`, `:562-578` (the organization value through the setter, same expectations);
      `demo_sessions.sql` census (two RPCs added as allowed).
- [x] A2 (S) `admin_set_division_practice_settings` cases in `supabase/tests/division_settings_rpc.sql`: changes only
      the two practice columns (the roster rules, set to non-null values first, are unchanged after), null keeps, `0`
      clears the length, the range refusals, a completed season, another organization's division, one audit row with
      only the practice keys.
- [x] A3 (S) Core `packages/core/src/scopedSettings.js` registered in the index. Tests
      `tests/scopedSettingsParity.test.js` (the pgTAP `VALUES` rows through `resolveScopedSetting`; the registry equal
      to the union of the migrations' `INSERT`s) and `tests/scopedSettings.test.js` (`source` for each level; a value of
      the wrong type at a level is ignored, not trusted).
- [x] A4 (M) Mock: `scoped_settings` and `scoped_setting_keys` tables, the two RPCs with the SQL's refusals, the
      rollover copy, and `computeScoredStandings` reading `resolveScopedSetting` instead of `feature_flags`
      (`mockGameScores.js:165-167`). Test `tests/mockScopedSettings.test.js`: the pgTAP's setter and rollover cases
      through the mock give the same results (lesson 77); `tests/mockGameScores.test.js` unchanged in its numbers.
- [x] A5 (S) Registry: the catalog entry removed, the key marked retired; `tests/standingsOutsideClubs.test.jsx`
      updated (the key is the one `20261124010000` registers and the seam names; it is no longer in the catalog; a
      stored value still parses). Docs: `docs/security/rls-policies.md`, `docs/architecture/persistence-rpc-layer.md`,
      the `squadlogic-feature-guardians` skill (both copies, item 7), `CHANGELOG.md`, one lesson.

Plants: the resolver treats `false` as unset (`COALESCE` over `NULLIF(value, 'false')`): the precedence rows with an
explicit false go red; the rollover's division block removed: the rollover case goes red; the seam still reads
`org_flag`: "the seam follows the cascade" goes red. Stop and report if: either recorded md5 differs from the harness
build or from production; `game_scores.sql` needs more than its setting's seeding changed; the view's columns or their
order change; a client role can write `scoped_settings` by any path; the rollover's count check fires on the harness
league.

**As built (2026-11-13; migration `20261124010000_settings_scope.sql`; the pull request has the detail).** A1 to A5
are done. What differs from the text above, each a decision of the build:

- **A2's cases are in `supabase/tests/scoped_settings.sql`** (section 6), not in `division_settings_rpc.sql`: the
  function is this migration's, and its file's plan count and helpers are this one's. `division_settings_rpc.sql` is
  unchanged.
- **The core twin takes rows as stored** (`scopedLevelsFor`) and does not filter a value of the wrong type: the
  resolver returns whatever the row holds, and the twin must give the same answer (the setter is the type check).
- **The seam compares with JSON true** (`scoped_setting_value(...) = 'true'::jsonb`), as `org_flag` read only a boolean.
- **The resolver skips the default program** even though no row can name it (the setter refuses it): one rule in one
  place.
- **The games import's rollback census** (`supabase/tests/game_import_apply_rollback.sql`) lists
  `divisions<-scoped_settings` as allowed, with its reason: a division that import made and its rollback removes takes
  any value an admin set on it since (S8's rule for programs, applied to divisions). Declared, not guarded: a guard
  waits for the next replacement of `rollback_game_import_job`. The practice import's rollback reads every foreign key
  from the catalogue and keeps such a division.
- **The Standings page's sentence** no longer says "in Settings, under Features" (the switch is gone); it says the
  setting is chosen for the league, a program or a division. F11-4b names the panel.
- **The harness** gains a stage that plants four organizations (the flag true, false, absent and a string) before the
  migration and requires each division to resolve as `org_flag` read it; and a revert check (an organization row
  written back, an unset key removed, the division value counted as dropped). Two plants re-aimed at this migration:
  `M59 the rollover takes no season lock` and `M71 the standings helper runs as its caller` (lesson 70).
- **Smokes:** `docs/sql/20261122010000_smoke.sql` sets the organization's standings value through the setter (its
  `feature_flags` write is no longer read).

### F11-4b: the panel, the audit wording, the import's practice RPC (no migration; Review (a))

Depends on: F11-4a merged, its migration applied and verified.

- [ ] B1 (M) `ScopedSettingsSection.jsx` as designed. Test `tests/scopedSettingsSection.test.jsx` through the mock: the
      three levels shown with "Applies now" and its source; choosing "Don't count" on a division under a program set to
      "Count" saves, reads back and shows "Not counted, set here"; a refusal is shown in words in the alert region; a
      completed season is read-only; the default program is not listed; every select has an accessible name (`axe` in
      the test, both themes).
- [ ] B2 (S) Audit wording: a scoped row's null side reads "Inherited". Test: a case in the existing
      `SettingsAuditLog` test file (the file is named when written).
- [ ] B3 (S) The practice import calls `admin_set_division_practice_settings`; the read-then-write and its
      `division_rules_changed` refusal go. Test: PR 11's import tests, with the case "another admin changed the roster
      rules after the preview" now saving the practice settings and leaving the roster rules as the other admin set
      them.

Plants: the select's label removed (the accessibility case); "Applies now" computed without the program level (the
inherited-from-program case); the import still sends the roster rules (B3's case). Stop and report if any page's
markup outside the new panel changes, or if a refusal can only be shown as a code.

## Owner decisions

S1 and S2 block approval (they decide the storage); the rest have recommendations and can be answered with them.

1. **S1. The data shape.** (a) One table, a row per level and key, jsonb value, closed key registry [recommended:
   no write path to guard, null-versus-false needs no convention, PR 12 is a row]. (b) A `settings jsonb` column on
   programs and divisions with guard triggers. (c) Typed nullable columns per setting.
2. **S2. Where the organization level lives.** (a) In the same table; the existing flag value carried over; the
   `feature_flags` key retired [recommended: `feature_flags` is directly writable, rewritten whole by the client, and
   cannot hold PR 12's set without breaking every flag's parse, findings 2-3]. (b) Stay in `feature_flags` (then
   the Features-page write and the parse need hardening first, and the direct-write gap stays).
3. **S3. The top level.** (a) The organization [recommended: the owner's principle names organization, program,
   division; programs are already per season]. (b) The season. (c) Both (four levels).
4. **S4. The default program ("No program").** (a) Holds no values; its divisions inherit the organization
   [recommended]. (b) It is a level like any other program.
5. **S5. Where it is set.** (a) One Settings panel listing organization, programs and divisions per setting
   [recommended: one component, one place to read what applies]. (b) Three controls (settings page, program page,
   division overview), as F11:491-492 sketched.
6. **S6. PR 11's practice-only RPC.** (a) A sibling function in F11-4a's migration, the import moved to it in F11-4b
   [recommended]. (b) Its own later pull request. (c) A key of the scoped setter (not recommended: two meanings of null
   in one function).
7. **S7. One pull request or two.** (a) Two: F11-4a then F11-4b after the migration is verified; no fallback code
   [recommended]. (b) One, with the dated deploy-window fallbacks described above.
8. **S8. A deleted or merged program's values.** (a) They go with it; the delete and merge dialogs say so; the values
   are listed in the program's audit row at the next replacement of those two functions [recommended: minimal diff].
   (b) Replace `admin_delete_program` and `admin_merge_programs` now so their audit rows list the values dropped.

### Decisions record (2026-11-13)

Approved by the coordinator under the owner's delegation, 2026-11-13. S1 to S8 are decided as recommended: **S1 (a)**
one `scoped_settings` table and the key registry; **S2 (a)** the organization level moves into it and the
`feature_flags` key is retired; **S3 (a)** the organization is the top level; **S4 (a)** the default program holds no
values; **S5 (a)** one Settings panel; **S6 (a)** the sibling `admin_set_division_practice_settings` in F11-4a;
**S7 (a)** two pull requests; **S8 (a)** a program's values go with it and the dialogs say so.

- **PR 12's amendment** (`practice_pairs` as a registry row plus an applicability rule, under "What PR 12 takes from
  this"): **proposed, decided at PR 12 M0.**
- **UNVERIFIED for now:** the production md5 of the two replaced bodies, and whether any organization has the
  standings flag on. The production read failed (the Supabase connector answered 503); the coordinator checks both
  before merge. The migration's guards stay as computed from the repository.
- **The carry-over is exact.** An organization whose `feature_flags` holds the key as a boolean gets that value as an
  organization row; an organization whose `feature_flags` lacks the key (or holds a non-boolean) gets no row and
  inherits the registry default, which must equal today's behaviour (flag absent = off, per `org_flag`'s default of
  false). A test holds that equality (A1).

## Contradictions with the F11 plan and the expansion plan

- **Storage form.** F11:480-483 proposed "one `settings jsonb` on `programs` and on `divisions`"; this plan recommends
  the same jsonb-and-closed-registry idea in one table, because divisions are directly writable by admins (finding 5)
  and the organization's store is too (finding 2). The F11 plan did not consider either policy.
- **The organization level.** F11:496-498 kept the organization toggle "through the existing flag mechanism" and said
  the cascade "replaces that one body"; this plan also moves the organization value (S2), because `feature_flags`
  cannot hold PR 12's value (finding 3) and is not write-guarded.
- **The default.** F11:487-488 resolves to "the caller's default"; here the default is a registry column, one place
  for core and SQL (the caller passes none).
- **Rollover of divisions.** F11:486 says the new column joins `rollover_division_columns()`; with a table there is no
  new column, and `admin_create_season_from` is replaced instead (it had to be for programs anyway, F11:484-486).
- **Screens.** F11:491-492 named three screens; S5 recommends one.
- **Size and placement.** F11:524 sizes F11-4 as M with "1, or in PR 12" migrations; this plan is L in two pull
  requests with its own migration, because the standings user exists now and PR 12 comes after it.
- **PR 12's data shape (expansion 5.7, `:1039-1046`, and PR 12's M1, `:1924-1929`).** `divisions.practice_pairs text[]
NOT NULL DEFAULT '{}'` cannot say "inherit", its CHECK cannot see an inherited value, and the 14-argument
  `admin_upsert_division_settings` would not be needed. PR 12's M0 should be amended to "a registry row, the scoped
  setter, an applicability rule" (above). Proposed, decided at PR 12 M0 (rule 14);
  nothing in PR 12 is touched by this plan.
- **Line references.** F11:486 cites `20261111010000:750-754` and `:755-759` for the program copy; both are right at
  `0687cae` (statically reviewed).

## Done when

- [ ] Every task's test passes, and each "Unchanged" item has a test.
- [ ] The repository's full gate passes, and every new check was shown failing first (the plants above).
- [ ] The F11 plan's three required tests are among them: the eight-combination precedence test with an explicit
      `false` beating an inherited `true` (A1), rollover keeps program and division values (A1), and
      `standings_counts_outside` follows the cascade (A1).
- [ ] `docs/security/rls-policies.md`, `docs/architecture/persistence-rpc-layer.md` and the feature-guardians skill say
      where a scoped setting lives and who may write it; the F11 plan's F11-4 entry points here.

## Receipts: searches and what was not run

Base `0687cae`, worktree `/home/user/wt/sl-f11-4`, 2026-11-13. `grep` is GNU grep.

| Id  | Claim                                                                    | Command                                                                                                                                                                                         | Result and control                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Base                                                                     | `git log --oneline -3`                                                                                                                                                                          | `0687cae` PR 11 at the head; tree clean                                                                                                                                                       |
| R2  | Where the seam's key is named                                            | `grep -rln "standings_counts_outside\|standings_count_outside_results"` over `*.sql *.js *.jsx *.ts`                                                                                            | 10 files: the F11-2 migration, its revert and smoke, two pgTAP files, the registry, the mock, three vitest files                                                                              |
| R3  | Latest definitions                                                       | `grep -rn "FUNCTION public.(update_org_feature_flags\|get_settings_audit_log\|admin_upsert_division_settings\|rollover_division_columns\|admin_create_season_from)"` over `supabase/migrations` | flags RPC last in `20260403000000`; division settings last in `20261105010000:1459`; rollover functions only in `20261111010000`. Control: each name also in `supabase/catalog-snapshot.json` |
| R4  | Nothing after `20261111010000` replaces the rollover                     | the same grep for `admin_create_season_from` outside that file                                                                                                                                  | one comment in `20261114010000:204`, no definition                                                                                                                                            |
| R5  | Later migrations do not touch the division settings RPC or the flags RPC | per-file `grep -c` over `2026111*` and `2026112*`                                                                                                                                               | 0 in every file from `20261112010000` on; positive control: `20261111010000` 13                                                                                                               |
| R6  | No trigger guards `feature_flags`                                        | files naming `feature_flags` and `TRIGGER`, then lines naming both a guard word and the column                                                                                                  | no match. Control: the first stage lists files (the column is named in many migrations)                                                                                                       |
| R7  | md5 of the two bodies to be replaced                                     | a Python script hashing the text between `AS $$` and `$$;` of each `CREATE FUNCTION` with `\r` removed                                                                                          | `standings_counts_outside` `599e5e16...6594` (279 chars); `admin_create_season_from` `446991cc...65b4` (6066 chars). From file text only; to be confirmed on a harness build and production   |
| R8  | Direct client writes                                                     | `grep -rn "from('organizations')"`, `"from('divisions')"`, `"from('programs')"` over `frontend/src` and `supabase/functions`                                                                    | reads only (`useMaintenanceMode.js:30`, `useConnectivityMonitor.js:64`, `usePrograms.js:21-26`, ...); no `update`, `insert` or `delete` on these tables from the client                       |
| R9  | Policies                                                                 | `supabase/catalog-snapshot.json`, policies matching `programs`, `divisions`, `organizations`                                                                                                    | programs: select only; divisions: select, admin insert, update, delete; organizations: select, admin insert, update, delete                                                                   |

**Hygiene.** The placeholder grep of `prompts/plan-change.md` over this file; `git diff --check`. Prettier was not run.

**Not run.** Any test, build, lint, typecheck, coverage, pgTAP, the harness, any migration, any read of production
(so whether any organization has turned the flag on is unknown: F11's F-R8 found no such key on 2026-11-06), an
`EXPLAIN` of the view, `gh pr list`.

## What the planning taught

- **Look at the write policies before choosing where a setting lives.** "A jsonb on programs and divisions" read as the
  small option until the divisions admin `UPDATE` policy and the organizations one showed that two of the three levels
  would be writable around the audited setter. The heat-settings migration had already learned it.
- **A cascade's top level inherits its store's constraints.** The organization store's client parse accepts only
  booleans and strings and erases unknown keys on save, so the second user's value (a set) decided where the first
  user's top level lives.
- **A per-division CHECK cannot see an inherited value.** Any rule that ties a setting to another column of the
  division has to be decided where the value is applied, not where it is stored.

## Output of the planning (prompts/plan-change.md)

1. Size verdict: planned, not small; L in two pull requests.
2. The plan is this file. Departures from AGENTS.md: none; rule 14 is the stop. No ADR (the repository has none).
   Open questions: eight owner decisions; S1 with S2 block approval.
3. The first task and its test: F11-4a's A1, starting with `supabase/tests/scoped_settings.sql`, red against `0687cae`.
4. What the planning taught: the section above.
