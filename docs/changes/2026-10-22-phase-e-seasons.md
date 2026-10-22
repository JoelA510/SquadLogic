# Phase E: seasons, programs and registration windows

Status: **draft for owner approval** (AGENTS.md rule 14: persistence and the domain model). It
applies decisions 5.1, 5.2, 5.3 and "Registration" of `2026-10-20-core-roadmap.md` to research
item 5 (`2026-10-20-research-defects.md`). Three PRs, in the order below, each reviewed once before
it opens. Every claim about main (6a22d29) is _statically reviewed_ unless marked _executed_.

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
- **`submit_registration` ignores the season.** Latest body `20261019010000:84-94` checks only
  `rf.organization_id` and `rf.status = 'open'`; it is pinned `SET timezone = 'UTC'`
  (`20261021040000:120`), so `current_date` inside it is a UTC date.
- **Forms cannot be bound to a division through any RPC.** `admin_create_registration_form`
  takes no division (`20260613000005:100-109`); `admin_update_registration_form` allows only
  title, description, status, waiver_text, fields, season_id (:46); the page has no division
  field. A per-program window would gate no form made in the UI today.
- **Imports pick their own season.** `finalize_import_job`, latest body
  `20261020020000:103-109`: `ORDER BY (s.status = 'active') DESC, s.season_start DESC NULLS
LAST, s.created_at DESC LIMIT 1`. `import_jobs` has no season column (`20260331000000:703-717`);
  `create_import_job(uuid,text,text)` (`20261018050000:30-34`) takes none. A draft can never be
  imported into. The body also declares `v_now := timezone('utc', now())` (:46).
- **TeamAnalysisPage's roster settings** are now `:189-201` (research cited 188-193). Division
  columns: `20260331000000:282-296`, `20260502001000`, `20260530000000:27-31`.
- **"Programs" are divisions in the UI.** `TeamAnalysisPage.derivePrograms` (:111-126) groups by
  division; `resolveDivisionName` (:74-88) reads the CSV's `Program` column as a division name;
  `ProgramOverview.jsx` and `coach_interested_programs` (`20260421060000:54-62`) agree.
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
| `submit_registration`                                                                                         | any open form                     | open form, its season active, its program's window open                                                                                |
| server-side reads (`20261021010000:174`)                                                                      | team's division's season          | unchanged                                                                                                                              |
| `upsert_division_for_import`, `admin_upsert_division_settings`                                                | explicit season id                | refuse a `completed` season; a division they create joins the season's default program (E2)                                            |

## Data model (E1, E2)

- `season_settings.status` NOT NULL DEFAULT `'draft'`; unique partial index
  `season_settings_one_active ON (organization_id) WHERE status = 'active'`; unique index on
  `(organization_id, lower(btrim(name)))`. Direct INSERT/UPDATE/DELETE policies dropped: every
  writer is a SECURITY DEFINER RPC (inventory above).
- `programs` (id, organization_id, season_settings_id, name, registration_opens_on and
  registration_closes_on dates, is_default, copied_from_program_id, timestamps DEFAULT `now()`),
  unique `(season_settings_id, lower(btrim(name)))`, one `is_default` per season, a CHECK that
  `registration_closes_on` is not before `registration_opens_on`, UNIQUE `(id, season_settings_id)`.
  `divisions.program_id` NOT NULL with the composite FK `(program_id, season_settings_id)
REFERENCES programs (id, season_settings_id)`, so a division cannot sit in another season's
  program. Backfill: one default program per existing season (window NULL), every division in it.
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
  policy, so `admin_upsert_program` (definer, `is_org_admin`) is the only writer; `anon` gets no
  grant. pgTAP: an Org B member reads none of Org A's programs, every direct write is refused, and
  `definer_function_grants.sql` covers the new RPCs.
- **A form's division is in the form's organization and season, by the schema.** E2 adds UNIQUE
  `(id, season_settings_id)` on `divisions` and a composite FK `registration_forms (division_id,
season_id) REFERENCES divisions (id, season_settings_id)`, and drops the
  `registration_forms_admin_insert` and `registration_forms_admin_update` policies
  (`20261018030000:219,230`, widened in `20261020030000:214,225`), so the form RPCs are the only
  writers. pgTAP: a direct PATCH to another org's or another season's division is refused (42501
  with the policies gone; 23503 through the FK).
- **For Phase B:** a program is a stable uuid within a season (`divisions.program_id`, never
  null). B keys per-program aggregates on `program_id` and team counts on `division_id`; it never
  keys on a name. Rollover gives programs new ids, linked by `copied_from_program_id`.
- New SQL uses `now()`, never `timezone('utc', now())`: `tests/utcNowIdiom.test.js` fails any
  later migration that does (_executed_: passes on main). A replaced body changes `v_now` to
  `now()` and re-adds `SET timezone = 'UTC'`, which CREATE OR REPLACE resets.

## The eight points

**1. Nothing is live before activation.** _Change:_ readers as in the table; copied forms are
`'draft'`; `submit_registration` joins the form's season and refuses unless `status = 'active'`
(22023); the migration backfills NULL `registration_forms.season_id` to the org's active season.
_Tests:_ `tests/organizationContextSeasonDefault.test.jsx`: seasons [active older, draft newer]
selects the active one; a legacy name key equal to the draft's name does not select it; a stored
draft id selects the draft for an admin and falls back to the active season for a coach or a
guardian (the first two fail today, :141-151). The Deno test at `anchor-wall-times_test.ts:247-258` is rewritten to assert
`eq('status','active')` and no `created_at` order (it asserts the defect today). pgTAP
`supabase/tests/season_rollover.sql`: an open form in a draft season is refused (fails today).

**2. Copied forms point at the copied division.** _Change:_ the rollover keeps an old-to-new
division map in the transaction; a form's `division_id` is remapped; a form whose division is
not in the source season is copied with NULL and listed in the result and the audit row.
_Tests:_ pgTAP: every copied form with a division has `divisions.season_settings_id` = the new
season; plant (map to the old id) fails it. Mock twin in `tests/seasonRollover.test.js`.

**3. Every division column copies, from the catalogue.** _Change:_ `rollover_division_columns()`
returns the copied list; the RPC builds its INSERT from it with `format('%I')`. Excluded: id,
season*settings_id, season_start, season_end, created_at, updated_at; program_id is remapped.
\_Tests:* pgTAP compares `information_schema.columns` for `divisions` with copied plus excluded,
and fails when the test adds a column in its own transaction (the plant); a value test checks
the six roster settings of `TeamAnalysisPage.jsx:189-201`, the age band and birthdate window.

**4. Activation needs a clock and dates.** _Change:_ `admin_activate_season` refuses a NULL or
unknown timezone (checked against `pg_timezone_names`), a NULL start or end, end before start,
and a NULL `season_year` (age groups read it, `useTeamAnalysis.js:39`). _Tests:_ pgTAP, one case
per refusal with its errcode; the season stays draft and no audit row is written.

**5. One active season, enforced in the database.** _Change (E1):_ inventory first: the
migration RAISEs, listing the orgs, if any has two `active` rows or duplicate names (refuse, do
not guess). An org with no active season gets its newest season activated, which is what every
reader shows it today; NULL statuses become `'draft'`. Then the indexes. _Tests:_ pgTAP: a
second `active` row for one org raises 23505, two orgs each with one pass; smoke
`docs/sql/<v>_smoke.sql` asserts zero orgs with more than one active and zero with none (if
any seasons); revert drops the indexes and restores the policies. Concurrency: below.

**6. Imports carry the season.** _Change:_ `import_jobs.season_settings_id` (FK, nullable for
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

**7. Creation and activation are audited, each in its own transaction.** _Change:_ each RPC
calls `record_audit_event` before it returns, as in `20261018070000`: `season.created_from`
(source, new id, counts copied, forms left without a division), `season.activated` (previous
active id now completed). _Tests:_ pgTAP: one audit row per success with that metadata; a
refused call, or a rollover made to fail after its divisions insert, leaves no row and no copy.

**8. Names unique per organization.** _Change:_ the index in point 5; the context stores the id
under `squadlogic-current-season-id`, never the name. _Tests:_ pgTAP: "2027 Season" twice, or
" 2027 season", raises 23505; vitest: `switchSeason` writes the id only.

## Programs and registration windows (E2)

- **Window on the season's clock.** Open from 00:00 on `registration_opens_on` through the end
  of `registration_closes_on`, in the season's timezone: `(now() AT TIME ZONE ss.timezone)::date`
  inside the function, never `current_date` (it is UTC under the pin). NULL bound: no limit.
- **Default.** A program created by rollover or by an admin gets `opens_on` = May 1 of the year
  after its creation (season clock), `closes_on` NULL, computed once in SQL
  (`default_registration_opens_on(tz)`) and stored as a date the admin edits. Programs that
  exist at deploy get no window, so no open form closes on deploy.
- **With form status.** A submission needs both: the form `open` and the window open. A window
  never opens a closed form. A form with no division (re-registration only) has no program and
  no window. One SQL function `registration_form_availability(form_id)` returns open, reason,
  opens_on; `submit_registration` and `RegistrationFlow.jsx` both use it, so the parent sees
  "Registration for Recreational opens 1 May 2027" before filling the form.
- **Writers.** `admin_upsert_program` (Zod schema in the frontend, audited `program.upserted`);
  form RPCs accept `division_id` (same org and same season as the form); a Programs section in
  Settings > Season and a division picker in `RegistrationForms.jsx`. League admins' field and
  reservation views take no program filter (5.2): none is added.
- _Tests:_ pgTAP: opens tomorrow refused with a hint, today allowed, closed yesterday refused,
  NULL allowed, org-level form unaffected, a zone whose date differs from UTC's
  (`Pacific/Kiritimati`); another season's program raises 23503; `program_id` never NULL.
  Vitest: RegistrationFlow shows the opening date (fails today: no message).

## PR split (nothing can create a draft until every reader ignores drafts)

| PR  | Contents                                                                                                                                       | Live effect                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| E1  | status backfill and indexes, name uniqueness, policies dropped, readers to active, stored id, `submit_registration` season gate, import season | none for one active season; guards in place |
| E2  | programs, `program_id`, form division writer, windows, availability read, UI copy "program" for divisions renamed "division"                   | windows only where an admin sets one        |
| E3  | `admin_create_season_from`, `admin_update_draft_season`, `admin_activate_season`, Seasons page, label control removed                          | first PR able to make a draft               |

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

1. **(blocking)** A division is in exactly one program, and division names stay unique within a
   season across programs ("U10 Competitive", "U10 Rec"). _Recommended:_ yes. The alternative,
   names unique per program, changes the import's name matching (`20261020020000:156,380-388`),
   `upsert_division_for_import`, and `findDivisionRowForProgram` (`TeamAnalysisPage.jsx:156-187`).
2. Program names: _recommended free text_, unique per season, rather than a fixed enum.
3. "The following year": _recommended_ May 1 of the year after the program is created, on the
   season's clock, editable, no close date by default.
4. Birthdate windows on copy: _recommended_ shifted by the `season_year` difference, shown in the
   draft for review (verbatim would put each age group a year off).
5. Season columns copied: _recommended_ timezone, age_cutoff_mode, school_day_end,
   roster_formula, exports_config; not the dated daylight_adjustments (catalogue-tested too).
6. A completed season cannot be reactivated in E (_recommended_); a mistake is a new draft.
7. `age_cutoff_mode` and `season_year` editable on drafts only; name and dates on draft and
   active (_recommended_).

## Investigation notes

- _Executed_ (production, read-only, 2026-10-22): one organization, one season, `active`; no
  duplicate season names; 0 registration forms (so none with a `division_id` or a NULL
  `season_id`); 32 divisions. E1's inventory RAISE still guards a database that differs.
- Not checked, outside E unless the owner says: should the forms SELECT policy
  (`20260331000000:1100`) require an active season; should `persist_*` RPCs refuse a completed
  season; do `field_availability_profiles` (imported with `season_settings_id` NULL and a text
  `season_label`, `20260908000000:207`) belong to a season.
- Not traced: whether every `fairness-scoring` caller sends `seasonSettingsId`.
