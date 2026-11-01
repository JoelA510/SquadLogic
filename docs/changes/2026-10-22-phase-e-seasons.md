# Phase E: seasons and programs

Status: **E1 and E2 built (one PR; see "As built (E1)" and "As built (E2)"); E3 built in two PRs (E3a, E3b; see the build notes in `2026-10-27-season-enrollment.md`).**
Owner rules of 2026-10-26 are in Decisions 9 and 10. It
applies decisions 5.1, 5.2 and 5.3 of `2026-10-20-core-roadmap.md` to research item 5
(`2026-10-20-research-defects.md`). The roadmap's "Registration" row (per-program registration
windows) is withdrawn: registration runs on the league's own platform (GotSport, Byga) and
SquadLogic takes its export; the in-app registration flow is removed (owner, 2026-10-22), so nothing
here reads or writes registration forms. Three PRs, in the order below, each reviewed once before it
opens. Every claim about main (6a22d29) is _statically reviewed_ unless marked _executed_; the
corrections found against main at f70340d (Phase B, admin-focus R0-R7 and demo D2-D5 had merged) are
under "Step 0 corrections", and the text above them is left as it was written.

## What is true today (re-verified against main)

- **One writer creates seasons.** `initialize_new_tenant` (latest body `20260913000000:124-138`)
  inserts the only row, `status 'active'` (:135), with no `season_start`/`season_end`. The other
  `season_settings` writer is `admin_set_season_timezone` (`20260917000000:146`, timezone only).
  Nothing writes the dates or `age_cutoff_mode`; the frontend only selects
  (`OrganizationContext.jsx:130`). Admins may still write the table directly (RLS policies
  `20261018030000:264-305`, widened to staff by `20261020030000:256-295`).
- **The newest season is "current".** `OrganizationContext.jsx:129-133` orders by `created_at`
  desc and falls back to `data[0]` (:148-151). Edge `readSeasonTimezone` does the same when no id
  is passed (`_shared/timing/seasonSettings.ts:94-99`), and its Deno test asserts it
  (`_shared/tests/anchor-wall-times_test.ts:247-258`). A fresh draft would become current.
- **Stored-season lookup is by name, and shares a key with a free-text field.**
  `OrganizationContext.jsx:141-147` matches `s.id === stored || s.name === stored` and stores
  `name || id` (:151, :272-277). `ThemeContext.jsx:52-54,70-80` keeps the same localStorage key
  `squadlogic-current-season`, written by Settings > Season's free-text "Current Season Label"
  (`SeasonModule.jsx:125-150`): typing a draft's name there would select the draft. No unique
  key on names (`20260331000000:260-274`; only an org index, `20251214000003:19`).
- **Imports pick their own season.** `finalize_import_job`, latest body
  `20261020020000:103-109`: `ORDER BY (s.status = 'active') DESC, s.season_start DESC NULLS
LAST, s.created_at DESC LIMIT 1`. `import_jobs` has no season column (`20260331000000:703-717`);
  `create_import_job(uuid,text,text)` (`20261018050000:30-34`) takes none. A draft can never be
  imported into. The body also declares `v_now := timezone('utc', now())` (:46).
- **TeamAnalysisPage's roster settings** are now `:189-201` (research cited 188-193). Division
  columns: `20260331000000:282-296`, `20260502001000`, `20260530000000:27-31`.
- **"Programs" are divisions in the UI.** `TeamAnalysisPage.derivePrograms` (:111-126) groups by
  division; `resolveDivisionName` (:74-88) reads the CSV's `Program` column as a division name;
  `ProgramOverview.jsx` and `coach_interested_programs` (`20260421060000:54-62`) agree (the
  table was dropped with the coach leads by `20261025010000`).
- **Only `finalize_import_job` reads `season_settings.status`** in SQL (grep of 2026
  migrations); `packages/core/src` queries no season, it takes the row as input.

## Current-season readers, and what each selects after E

| Reader                                                                                                        | Today                             | After E                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `OrganizationContext.jsx:126-152`                                                                             | stored id or name, else newest    | stored **id** (new key) if the row is `active`, or a draft and the caller is an admin or staff; else `status = 'active'`; never newest |
| `ThemeContext.jsx:52-80`, `SeasonModule.jsx:125-176`                                                          | free-text label on the shared key | label control removed; the season name gets an audited writer (E3)                                                                     |
| `TopBar.jsx:172-177` switcher                                                                                 | every season, newest first        | active first, status shown; drafts listed for admins only                                                                              |
| 19 `currentSeasonSetting` consumers (hooks, pages, `seasonClockSlots.js`)                                     | the context row                   | unchanged; they inherit the context                                                                                                    |
| `ImportContext.jsx:893-898`, `importJobLifecycleActions.js:2`                                                 | job has no season                 | job created with the viewed season's id                                                                                                |
| `readSeasonTimezone` (`seasonSettings.ts:79-107`)                                                             | given id, else newest             | given id, else `eq('status','active')`; none is `timezone: null`                                                                       |
| its callers: `auto-scheduler/index.ts:181-195`, `fairness-scoring/index.ts:137-139`, `teamFeed.ts:135-138`    | as above                          | unchanged; inherit                                                                                                                     |
| `practice-`, `game-`, `team-persistence` (`:164-210`, `:92-108`, `:189-205`); `calendar-feed/index.ts:90,142` | by explicit id or team's division | unchanged                                                                                                                              |
| `finalize_import_job`                                                                                         | active-or-newest                  | the job's `season_settings_id`; legacy job without one: the active season                                                              |
| server-side reads (`20261021010000:174`)                                                                      | team's division's season          | unchanged                                                                                                                              |
| `upsert_division_for_import`, `admin_upsert_division_settings`                                                | explicit season id                | refuse a `completed` season; a division they create joins the season's default program (E2)                                            |

## Data model (E1, E2)

- `season_settings.status` NOT NULL DEFAULT `'draft'`; unique partial index
  `season_settings_one_active ON (organization_id) WHERE status = 'active'`; unique index on
  `(organization_id, lower(btrim(name)))`. Direct INSERT/UPDATE/DELETE policies dropped: every
  writer is a SECURITY DEFINER RPC (inventory above).
- `programs` (id, organization_id, season_settings_id, name, is_default, copied_from_program_id,
  timestamps DEFAULT `now()`), unique `(season_settings_id, lower(btrim(name)))`, one
  `is_default` per season, UNIQUE `(id, season_settings_id)`.
  `divisions.program_id` NOT NULL with the composite FK `(program_id, season_settings_id)
REFERENCES programs (id, season_settings_id)`, so a division cannot sit in another season's
  program. Backfill: one default program per existing season, every division in it.
  The demo seed (`demo_seed`, demo-mode plan D3) is the exception: E2 gives it its real programs
  from the fixture's `Payment Plan` (Minis U4, Micro U5-U6, Junior U7-U8, Select U14-U19; U9, U10
  and U12 in the default program), so a demo shows programs spanning divisions.
- **Every division writer supplies a program.** `upsert_division_for_import` and
  `admin_upsert_division_settings` (whose create path, `20260504020000:109-130`, inserts no
  program) put a new division in the season's default program; E2 replaces both bodies from their
  latest definitions. A pgTAP case creates a division through each and finds it in the default
  program (both fail with a not-null violation if a writer is missed).
- **`programs` is read and written like the other tenant tables.** RLS enabled; SELECT for members
  of the program's organization (`is_org_member`), as `divisions` is; no INSERT, UPDATE or DELETE
  policy, so the four program RPCs below (definer, `is_org_admin`) are the only writers;
  `organization_id` is `ON DELETE CASCADE`, as `divisions`' is (`20260331000000:284`), so a demo
  purge removes them; `anon` gets no grant. pgTAP: an Org B member reads none of Org A's
  programs, every direct write is refused, and `definer_function_grants.sql` covers the new RPCs.
- **For Phase B:** a program is a stable uuid within a season (`divisions.program_id`, never
  null). B keys per-program aggregates on `program_id` and team counts on `division_id`; it never
  keys on a name. Rollover gives programs new ids, linked by `copied_from_program_id`.
- New SQL uses `now()`, never `timezone('utc', now())`: `tests/utcNowIdiom.test.js` fails any
  later migration that does (_executed_: passes on main). A replaced body changes `v_now` to
  `now()` and re-adds `SET timezone = 'UTC'`, which CREATE OR REPLACE resets.

## The seven points

**1. Nothing is live before activation.** _Change:_ readers as in the table. _Tests:_
`tests/organizationContextSeasonDefault.test.jsx`: seasons [active older, draft newer] selects the
active one; a legacy name key equal to the draft's name does not select it; a stored draft id
selects the draft for an admin and falls back to the active season for a coach (the first two fail
today, :141-151). The Deno test at `anchor-wall-times_test.ts:247-258` is rewritten to assert
`eq('status','active')` and no `created_at` order (it asserts the defect today).

**2. Every division column copies, from the catalogue.** _Change:_ `rollover_division_columns()`
returns the copied list; the RPC builds its INSERT from it with `format('%I')`. Excluded: id,
season*settings_id, season_start, season_end, created_at, updated_at; program_id is remapped.
\_Tests:* pgTAP compares `information_schema.columns` for `divisions` with copied plus excluded,
and fails when the test adds a column in its own transaction (the plant); a value test checks
the six roster settings of `TeamAnalysisPage.jsx:189-201`, the age band and birthdate window.

**3. Activation needs a clock and dates.** _Change:_ `admin_activate_season` refuses a NULL or
unknown timezone (checked against `pg_timezone_names`), a NULL start or end, end before start,
and a NULL `season_year` (age groups read it, `useTeamAnalysis.js:39`). _Tests:_ pgTAP, one case
per refusal with its errcode; the season stays draft and no audit row is written.

**4. One active season, enforced in the database.** _Change (E1):_ inventory first: the
migration RAISEs, listing the orgs, if any has two `active` rows or duplicate names (refuse, do
not guess). An org with no active season gets its newest season activated, which is what every
reader shows it today; NULL statuses become `'draft'`. Then the indexes. _Tests:_ pgTAP: a
second `active` row for one org raises 23505, two orgs each with one pass; smoke
`docs/sql/<v>_smoke.sql` asserts zero orgs with more than one active and zero with none (if
any seasons); revert drops the indexes and restores the policies. Concurrency: below.

**5. Imports carry the season.** _Change:_ `import_jobs.season_settings_id` (FK, nullable for
legacy jobs); `create_import_job` gains `p_season_settings_id uuid DEFAULT NULL` (the 3-argument
signature is dropped and recreated with the new trailing argument, so every existing named call,
including `tests/fieldAvailabilityLifecycle.test.js:57`, `real_backend.ts` and a cached frontend
mid-deploy, still resolves; validated: same org, not completed; NULL means the active season);
the exact-signature grant and readiness contracts (`definer_function_grants.sql`,
`import_rpc_readiness_contract.sql`) move to the new signature;
`finalize_import_job` uses the job's season. _Tests:_ pgTAP: a job made for a draft season
finalizes its divisions into the draft (fails today, `20261020020000:104-109`); a completed
season is refused; a legacy job without a season lands in the active one. Mock twin, and
`tests/importJobLifecycleRpcs.test.js` extended for the new argument.

**6. Creation and activation are audited, each in its own transaction.** _Change:_ each RPC
calls `record_audit_event` before it returns, as in `20261018070000`: `season.created_from`
(source, new id, counts copied), `season.activated` (previous
active id now completed). _Tests:_ pgTAP: one audit row per success with that metadata; a
refused call, or a rollover made to fail after its divisions insert, leaves no row and no copy.

**7. Names unique per organization.** _Change:_ the index in point 4; the context stores the id
under `squadlogic-current-season-id`, never the name. _Tests:_ pgTAP: "2027 Season" twice, or
" 2027 season", raises 23505; vitest: `switchSeason` writes the id only.

## Programs (E2)

- **What a program is.** A named group of divisions within a season (Junior: U7-U8 boys and
  girls), used to group teaming: Phase B's per-program aggregates and team-count recommendations
  key on `program_id`. It gates nothing; it has no registration window.
- **Writers.** The program RPCs below, and a Programs section in Settings > Season. League admins'
  field and reservation views take no program filter (5.2): none is added.
- _Tests:_ pgTAP: another season's program raises 23503; `program_id` never NULL.

## Program management (E2)

Owner, 2026-10-22: admins create, modify, delete and merge programs, and assign a division to a
program, move it to another, or remove it from one. A division is in at most one program.

- **"No program" is the season's default program.** `divisions.program_id` stays NOT NULL (the
  composite FK is what keeps a division in its own season's program); removing a division moves
  it to the default, which the UI shows as "No program". The default cannot be renamed, deleted
  or merged away. Decision 8.
- **Four writers**, each SECURITY DEFINER, `is_org_admin`, refusing a `completed` season, under
  the season lock rollover takes (Concurrency, below) so a rollover never copies a half-moved set,
  each with a frontend Zod schema and one audit row. Each takes the season it checks from the
  rows it changes (an existing program's, the division's), never from the caller alone:
  `admin_upsert_program` with an `id` refuses one whose season is not `season_id`, so a
  completed season's program cannot be edited by naming an active season.

  | RPC                                                   | Does                                                                                                                                           | Audit                                                     |
  | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
  | `admin_upsert_program(season_id, id, name)`           | create (id NULL) or rename; name unique per season (23505); the default refuses a rename                                                       | `program.upserted` (created or updated; old and new name) |
  | `admin_set_division_program(division_id, program_id)` | assign or move; `program_id` NULL removes (to the default); another season's program raises 23503                                              | `division.program_changed` (from, to)                     |
  | `admin_delete_program(program_id)`                    | moves its divisions to the default, then deletes it, in one transaction                                                                        | `program.deleted` (name, moved division ids)              |
  | `admin_merge_programs(source_id, target_id)`          | moves every source division to the target, deletes the source; the target keeps its name; same season; source is not the target or the default | `program.merged` (source name, moved division ids)        |

  The four actions are registered in `audit_actions` by the same migration.

- **What a move changes.** Only the grouping: teams, players and schedules key on the division.
  Phase B's per-program aggregates follow on their next read. The confirmation for a delete or
  a merge names the divisions that move.
- **Rollover** copies every program (the default included) and each division's assignment through
  `copied_from_program_id`.
- **Demo organizations** may use all four: programs hold no personal data.
- _Tests:_ pgTAP per RPC: a non-admin, another organization's program, and a completed season are
  refused; deleting, renaming or merging away the default, and merging a program into itself, are
  refused; `admin_upsert_program` with a completed season's program `id` and an active `season_id`
  is refused (planted: validating only the supplied season); each upsert's audit row carries the old
  and new name; a delete leaves its divisions in the default and one audit row naming them; a merge
  leaves the source gone, every division in the target, one audit row. Mock twin in
  `tests/programs.test.js`; Vitest for the Programs section: a delete's and a merge's confirmation
  name the divisions that move.

## PR split (nothing can create a draft until every reader ignores drafts)

- [x] E1 (see "As built (E1)")
- [x] E2 (see "As built (E2)")
- [x] E3 (E3a: per-season enrollment; E3b: rollover, drafts, activation, the Seasons page)

| PR  | Contents                                                                                                              | Live effect                                 |
| --- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| E1  | status backfill and indexes, name uniqueness, policies dropped, readers to active, stored id, import season           | none for one active season; guards in place |
| E2  | programs, `program_id`, the program RPCs and Programs section, UI copy "program" for divisions renamed "division"     | divisions grouped; nothing gated            |
| E3  | `admin_create_season_from`, `admin_update_draft_season`, `admin_activate_season`, Seasons page, label control removed | first PR able to make a draft               |

Each PR: migration, `docs/sql/<v>_revert.sql` and `_smoke.sql`, pgTAP, the mock twin.

## Concurrency

Rollover and activation take `pg_advisory_xact_lock(hashtextextended('season:' || org, 0))`,
then `SELECT ... FOR UPDATE` the org's seasons, re-read the target's status (must be `draft`),
complete the old active row, then activate the target, in two statements so the partial index
never sees two active rows. Two admins at once: the second waits, then finds the target no
longer draft (or a different active) and is refused; without the lock, the index raises 23505.
_Test:_ the migration's smoke opens a second session with `dblink` while the first holds the
transaction open, and asserts the second is refused (the pattern `docs/sql/20261021030000_smoke.sql`
uses for its lock races), plus the pgTAP index case.

## Decisions

1. **(answered: owner, 2026-10-22)** A division is in at most one program (Program management,
   above), and division names stay unique within a season across programs ("U10 Competitive",
   "U10 Rec"). _Recommended:_ yes for the names. The alternative,
   names unique per program, changes the import's name matching (`20261020020000:156,380-388`),
   `upsert_division_for_import`, and `findDivisionRowForProgram` (`TeamAnalysisPage.jsx:156-187`).
2. Program names: _recommended free text_, unique per season, rather than a fixed enum.
3. _Withdrawn_ (registration windows, owner 2026-10-22).
4. Birthdate windows on copy: _recommended_ shifted by the `season_year` difference, shown in the
   draft for review (verbatim would put each age group a year off).
5. Season columns copied: _recommended_ timezone, age_cutoff_mode, school_day_end,
   roster_formula, exports_config; not the dated daylight_adjustments (catalogue-tested too).
6. A completed season cannot be reactivated in E (_recommended_); a mistake is a new draft.
7. `age_cutoff_mode` and `season_year` editable on drafts only; name and dates on draft and
   active (_recommended_).
8. "No program" as the season's default program (_recommended_), rather than a
   nullable `program_id`: NULL would need its own branch in every per-program read, and the
   composite FK could no longer keep a division in its own season's program. The cost: the
   default is a row the UI must never show as an ordinary program.

9. **(answered: owner, 2026-10-26)** **Programs are optional.** A club that only uses divisions
   (U12B, U10G, ...) is never blocked, nagged or cluttered: no flow, page, import or RPC requires
   creating a program; the season's default program is the "No program" of Decision 8; a club with
   no programs of its own sees no program grouping heading and no empty program UI on its ordinary
   pages (the Programs section of Settings > Season is where programs live). Tests prove it: a
   programs-free organization's import, teaming and scheduling paths work unchanged, and the pages
   that group by program render no "No program" heading when the default is the only program.
10. **(answered: owner, 2026-10-26)** Phase order is E, then C, then D.
11. **(answered: owner, 2026-10-26)** **E3 adds per-season enrollment.** A player is enrolled per
    season, not only per organization, so a draft season can receive registration imports and a
    returning player can be in this season's U10 and next season's U11 at once. E3's PR carries
    the detailed design for approval (AGENTS.md rule 14: it touches the domain model and
    persistence). Until then E1 guards the gap: an import (`create_import_job`,
    `finalize_import_job`, `finalize_field_import_job`) goes only to the organization's active
    season and a draft or completed one is refused (22023, detail `season_not_active` or
    `season_completed`), because players are organization-level and an import into another season
    would move a live-season player's division and natural age. Before E3 no RPC can create a draft
    (`initialize_new_tenant` makes an active season, the direct-write policies are gone), so the
    refusal guards a database that holds one from before E1.

## Step 0 corrections (against main f70340d, 2026-10-26)

Re-verified before any code; none needed a design call. Each is recorded here and the section it
corrects is left as written.

- **Versions.** Main's latest migration is `20261031010000`; E1 is `20261101010000`, E2
  `20261101020000`. The Phase B and demo "As built" sections were read.
- **Phase B reads and creates nothing program-shaped in the database.** Its "program" is still the
  division (`TeamAnalysisPage.derivePrograms`, `ProgramOverview`, B4's overview and B6's counts all
  key on the generator's division key and a division name). E2's rename of that copy to "division"
  is therefore a copy change on the page; names, files and props are unchanged.
- **More division writers than the two the plan names.** `finalize_import_job` auto-creates
  divisions (`INSERT INTO public.divisions`), `start_demo_session` (D3) creates a demo's, and
  `divisions` has an admin insert policy. Replacing every body to supply a program was the plan's
  wording; E2 instead fills `program_id` with the season's default in a `BEFORE INSERT` trigger on
  `divisions`, and makes each season's default program in an `AFTER INSERT` trigger on
  `season_settings`, so no writer, present or future, has to know programs exist and a missed one
  cannot leave a NOT NULL violation in a flow the owner said must work unchanged. The migration's
  end-state still refuses a NULL, and pgTAP creates a division through each writer and finds it in
  the default.
- **More current-season readers than the table lists.** `import-validation` counts a player's
  natural age in "the season the finalizer attaches divisions to" (R5, `importSeason` in
  `_shared/natural-age.ts`, which copied the old active-then-start-then-newest order), and
  `finalize_field_import_job` (D2) resolves a practice row's Division in the same season. Both read
  the job's season now, as does the mock twin (`finalize_import_job`, `finalize_field_import_job`,
  `import-validation`). The seven other readers of the table hold.
- **`create_import_job` fixes the season when the job is made** (none named: the active season),
  rather than leaving NULL to mean "the active season at finalize time": a job then keeps the season
  it was started for even if another season is activated before it is finalized. Only a job made
  before E1 has none, and its finalizer uses the active season, as the plan says.
- **`finalize_*` and the two writers also refuse a completed season** (22023, detail
  `season_completed`), and `create_import_job` refuses to name one; E3's activation completes seasons.
- **"Zero orgs with none active" is the migration's check, not the smoke's.** The smoke runs on a head
  database that earlier smokes have seeded with draft-only organizations (a season inserted with no
  status is a draft now), so only "none with two active, none with a NULL status" holds there; the
  migration's end-state check, run when it applies, asserts every organization with seasons has one
  active.
- **Plants aimed at replaced bodies were re-aimed** (ten: M26, M30, M43 x3, M46 x5 now point at
  `20261101010000`), as the harness's pre-flight demanded.
- **Existing tests that assumed the old rules were updated, not loosened:** the 20261018030000 smoke
  (76 policies, 17 split tables, and an admin's direct update of `season_settings` reaches nothing),
  `rls_policy_matrix.sql`, `staff_is_admin.sql` (the count of policies naming a role), the
  `create_import_job` signature in `definer_function_grants.sql`, `import_rpc_readiness_contract.sql`
  and the 20260603120000 and 20261018050000 smokes, `demo_sessions.sql` (the four program writers on
  its list of what a demo's admin may call), the calendar feed test's fake season (it asserted the
  newest-season read), and the E2E steps that seeded seasons with no status or selected one by name.

## As built (E1)

- **Migration `20261101010000_one_active_season`** (revert and smoke under `docs/sql/`). It stops
  with a RAISE if an organization has two active seasons or two names that match ignoring case and
  padding (production had neither: _executed_ 2026-10-22), activates the newest season of an
  organization with none active, makes `status` NOT NULL DEFAULT `draft`, adds the partial unique
  index `season_settings_one_active` and `season_settings_org_name_key`, and drops the three direct
  write policies on `season_settings` (every write goes through an RPC). `import_jobs` gains
  `season_settings_id` (FK, ON DELETE CASCADE).
- **Replaced bodies** (`create_import_job` as a 4-argument function, `finalize_import_job`,
  `finalize_field_import_job`, `upsert_division_for_import`, `admin_upsert_division_settings`) are
  rebuilt from the latest body, each behind an md5 `prosrc` guard. The guard compares against the
  body this repo's migrations produce; a production body edited by hand would stop the migration,
  which is the intent.
- **The job's season is fixed at creation** and a finalizer uses it (NULL, only a pre-E1 job: the
  active season). Only the active season takes an import (Decision 11): a completed season is
  refused (22023, `season_completed`) and a draft one, or a job whose season stopped being the
  active one, is refused too (22023, `season_not_active`), so an import never moves a live-season
  player into another season's division. A frontend sends `p_season_settings_id` only for a season
  that is not the active one, so viewing a draft and importing now fails with that message, and the
  call keeps its old shape against a database that has not taken the migration (deploy window below).
- **Frontend:** `utils/seasonSelection.js` holds the "which season am I looking at" rule (a stored
  id, else the active season; never a draft or completed season by default); the top bar shows
  `(status)` after a season that is not active. The mock twin mirrors each refusal.
- **Verification:** `supabase/tests/one_active_season.sql` (31 assertions). Plants: M50 "the
  finalizer ignores the job's season" was caught by the smoke and by pgTAP.

## As built (E2)

- **Migration `20261101020000_programs`.** `programs` (per season, unique name ignoring case and
  padding, one default per season named "No program", member SELECT only), `divisions.program_id`
  NOT NULL with a composite FK `(program_id, season_settings_id)` so a division cannot point at
  another season's program, a BEFORE INSERT trigger that fills the default, and an AFTER INSERT
  trigger on `season_settings` that creates the default. Four audited RPCs: `admin_upsert_program`,
  `admin_set_division_program`, `admin_delete_program` (its divisions return to the default),
  `admin_merge_programs`. Each takes the organization's advisory lock.
- **Optional by construction.** No existing writer changed to know about programs; a club that never
  creates one has one default and every page behaves as before. Tests: `tests/programs.test.js`
  (grouping returns nothing while the default is the only program), the pgTAP file (a division made
  by each existing writer lands in the default), and the Settings > Season E2E.
- **The program is closed at the table boundary.** The divisions UPDATE policy and grant would let
  an admin write `divisions.program_id` past the writers' completed-season refusal, lock and audit
  row, so `divisions_program_guard` (BEFORE UPDATE OF program_id, SECURITY INVOKER) refuses a change
  made as `authenticated` or `anon` (42501). The writers and the demo seed run as their owner and
  pass, any other column updates as before, and no flag is set by a caller (a transaction-local
  marker could be forged by any session that can run SQL). The app writes no division directly
  (statically reviewed: no insert, update or delete of `divisions` outside RPCs). An INSERT that
  names a program is left alone: the composite FK keeps it in its own season, and an admin could
  already insert a division into a completed season.
- **Demo:** `demo_seed.division_programs` gives the 15 demo divisions four programs; `start_demo_session`
  is rebuilt behind an md5 guard.
- **Frontend:** the Programs section lives in Settings > Season (`ProgramsSection.jsx`); confirmations
  name the divisions a delete or merge moves. A remembered merge target that was deleted or merged away reads as no choice, so
  Merge stays disabled. Pages that listed divisions as "programs" now say
  "division" (the word belongs to the new level). `ProgramOverview` groups under a heading only when a
  non-default program holds a listed division.
- **Axe:** the new Season & Calendar scan found two contrast failures already in `SeasonModule`
  (the format hints at `opacity-70`, the selected season pill); both now use the tokens the sibling
  controls use, and the scan passes in both themes.
- **Verification:** `supabase/tests/programs.sql` (77 assertions). Plants: M51 "admin_upsert_program
  judges only the season it is given" and M51 "a new season gets no default program", each caught by
  the smoke and by pgTAP.
- **For E3:** rollover must map the new season's trigger-made default program to the source's, not
  create a second one.
- **pgTAP is not installed here:** both files ran under a local stand-in for its assertion functions;
  CI runs the real extension.
- **Deploy window:** the frontend may ship before the migrations (it sends the new argument only for a
  non-active season and tolerates a missing `program_id`). The frontend only reads `season_settings` (statically
  reviewed: no insert, update or delete of it remains), so dropping the direct-write policies breaks nothing it does.

## Investigation notes

- _Executed_ (production, read-only, 2026-10-22): one organization, one season, `active`; no
  duplicate season names; 0 registration forms; 32 divisions. E1's inventory RAISE still guards a
  database that differs.
- Not checked, outside E unless the owner says: should `persist_*` RPCs refuse a completed
  season; do `field_availability_profiles` (imported with `season_settings_id` NULL and a text
  `season_label`, `20260908000000:207`) belong to a season.
- Not traced: whether every `fairness-scoring` caller sends `seasonSettingsId`.
