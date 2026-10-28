# Per-season enrollment (Phase E3)

Status: **revised twice on 2026-10-27 with the owner's decisions; C1-C3 settled by the owner** (AGENTS.md rule 14: the domain model and persistence). The
owner decided on 2026-10-26 (Phase E plan, Decision 11) that a player is enrolled per season, so a
draft season can take registration imports. On 2026-10-27 the owner added: **a new season starts
from its own import data, and no player or coach is assumed to be returning.** Code read at
`origin/main` c74d7d3 and re-checked at 9128db9 (_statically reviewed_; file:line references get
re-checked in task 0). Production counts are _executed_ (read-only, 2026-10-27): 1 organization,
**0 players**, 0 team_players, 0 buddy pairs.

## Owner decisions (2026-10-27)

1. **A player row belongs to one season, and nothing carries over.** Each season's registration
   import creates that season's rows. There is no link to an earlier season's row and nothing is
   copied forward: years of experience come from the registration answer (for clubs that ask it),
   and skill level from the club's own evaluations, imported after the general player and coach
   imports (C2 below).
2. **Starting a new season copies no players** (divisions and programs only).
3. **A completed season's players are kept until an admin deletes that season's data.**
4. **Age cutoff is a club option per season**: two presets and a custom date (C3 below). The
   season year is the year the season starts.
5. **Only league admins sign in** (owner, 2026-10-27, second answer). Coaches are imported data
   that admins manage, with no sign-in or screen of their own; admins may belong to several
   organizations, and a coach may appear in several. Removing coach access is its own plan
   (`2026-10-27-admin-only.md`) and lands before E3a.
6. **Years of experience and skill level are separate fields**, each optional at import and
   editable afterwards.
7. **Custom cutoff** is one cutoff day per season year by default; a division can also carry its
   own birth-date range when it needs one (e.g. a U4 program that takes older 2-year-olds, or all
   3-and-unders).

## Today

- **A player row mixes the person with the season.** `players` holds names, gender, grade, notes,
  the external registration id and season facts (`division_id`, `team_id`, `natural_age`, status,
  rating, years played, skill tier, buddy request, coach-volunteer answers, `custom_attributes`).
  It has no season column; the season is reachable only through `division_id`.
- **The import matches across seasons.** `finalize_import_job` matches an existing player by
  organization and external registration id and overwrites it
  (`20261101010000:591-640`). That is why E1 refuses imports into any season but the active one.
- **Teams, rosters and buddies are season-scoped in effect** through divisions.
- **Readers take every player in the organization** (Players page, Team Builder, roster
  directory, sidebar count, setup progress, `view_org_metrics`, both dashboards). The header
  already has a season switcher (`TopBar.jsx`, `OrganizationContext.jsx`).
- **Coaches are one row per person, not per organization or season**: `coaches.email` is unique
  across all organizations and `coaches.user_id` is unique (`20261020040000:19-20`). Six frontend
  readers list coaches. The admin-only plan removes the sign-in link.
- **The age cutoff** is `season_settings.age_cutoff_mode`, `birth_year` (Jan-Dec) or
  `school_year_aug_jul` (the default), with no screen to change it.

## Design

### Players (decision 1)

- **Schema.** `players.season_settings_id` (NOT NULL after backfill; must equal the season of
  `division_id` when one is set, enforced by a trigger, since a CHECK cannot read another table)
  and a unique index on `(season_settings_id, external_registration_id)` where the id is present.
  No link column. Backfill: production has 0 players; the demo seed and any other row take the
  season of its division, else the organization's active season.
- **The import** matches existing rows in the **destination season only**. A registration id seen
  in another season is a new row in this one; nothing is read from or written to the other row.
  The E1 guard changes from "the active season only" to "the active season or a draft season;
  never a completed one" (E3b).
- **Other writers**: `admin_create_player` takes the season (default the active one);
  `apply_player_patch` refuses a division or team outside the player's season;
  `persist_team_schedule` refuses a roster naming another season's player (today it checks only
  organization, `20261018070000:599-629`); buddy pairs are refused across seasons;
  `start_demo_session` sets the demo season.
- **Readers** filter by the season the header's switcher shows (the current season by default).
  RLS stays organization-scoped: a season filter is not an authorization boundary.

### C1. Coaches: a row per season, like players (settled)

With no coach sign-in (decision 5), a coach row is data and is handled exactly as a player row:
`coaches.season_settings_id`, a season's coach import creates that season's rows, nothing is
carried over, and the unique key becomes `(organization, season, lower(email))`. That depends on
the admin-only plan dropping `coaches.user_id` and the global email uniqueness, which it covers.
`coach_team_requests` and team assignments already hang off teams, which are per season; a link is
refused across seasons.

### C2. Years of experience and skill level (settled)

Two separate player fields, both optional: `years_played` (a whole number of years, from the
registration question for clubs that ask it) and the skill level (`skill_tier`, or the numeric
rating where a club rates). Either may be absent from the registration import, and an admin can
set or change either afterwards (the Players grid and the player patch, audited, as today).
**E3c** adds an evaluations import into an existing season: a file with the registration id and
either or both fields **only updates** matching players in that season; an unmatched row is
listed and never created; a blank cell leaves the stored value alone. It reuses the import
pipeline (allowlist, staging, audited finalize). Teaming uses whichever fields are present, as it
does today.

### C3. Age cutoff per season (settled)

On the season's settings (E3b's Seasons page):

- **School year, Aug 1 - Jul 31** (the default). AYSO, US Club Soccer and US Youth Soccer use it
  from the 2026-27 registration year; US Soccer let each member set its own rules from 2026-27.
- **Calendar year, Jan 1 - Dec 31** (the 2016-2026 birth-year rule; US Soccer's ODP keeps Jan 1).
- **Custom**: a cutoff month and day the club picks, applied every season year.
- **Per-division range**, optional on any division: its own birth-date window
  (`divisions.birthdate_start/end`, which core already treats as authoritative,
  `ageGroups.js:17-18,277`). Because the server stores no birth date (R5), the window is applied
  at import, where the birth date is read, and the stored natural age and division follow from it.
  Rollover shifts a division's window by one year.

`age_cutoff_mode` gains `custom` with `age_cutoff_month` / `age_cutoff_day`; the import's natural
age (`import-validation`, `_shared/natural-age.ts` and core's twin, held equal by
`naturalAgeParity.test.js`) honours the mode and the division windows. The season year is the year
the season starts. Changing the cutoff or a division's window once the season has players is
refused (their stored ages were computed with the old rule); a draft season can change them
freely.

### Rollover and completed seasons (decisions 2, 3)

`admin_create_season_from` copies divisions (windows shifted one year) and programs, and no
players or coaches. Completed seasons are read-only, players and coaches included, until an admin
deletes that season's data.

## Tests

- pgTAP: the season column and its division-season trigger; the unique (season, external id); an
  import into a draft season leaves the active season's row untouched (the case Codex found on
  #666); no row of another season is read or written; an import into a completed season is
  refused; a roster or buddy pair across seasons is refused; a coach row of another season cannot
  be assigned or linked; the evaluations import updates only matched rows and leaves blanks
  alone; the cutoff and a division's window cannot change once a season has players.
- Unit: each reader asks for the selected season only; natural age under each cutoff mode and a
  division window (a U4 taking older 2-year-olds), parity between core and the Edge twin; the mock
  mirrors per-season matching for players and coaches.
- E2E (mock): import into the active season, create a draft, import a file where one child
  reappears in an older division; the active season's Players page is unchanged and the draft's
  shows a separate row; a coach imported only into the active season is not listed in the draft.

## PR split

| PR | Contents | Live effect |
| --- | --- | --- |
| E3a | season column on players and coaches, per-season unique keys and import matching, writers and readers filtered by season, demo seed; the E1 guard still allows only the active season (after the admin-only PR) | none visible for one active season |
| E3b | season rollover, draft season edit and activation, the Seasons page with the age cutoff and division windows (C3), the guard widened to drafts | admins prepare next season and import into it |
| E3c | the evaluations import (C2) | clubs add experience or skill after registration |

## Build notes: E3a (2026-10-28)

Built as written; where the code or production differed from the plan:

- **Production holds 130 coaches, not 0** (read-only, 2026-10-28: 1 organization, 1 active season,
  0 players, 130 coaches, 0 buddy pairs, 0 child links). The backfill rule covers it (a coach takes
  the organization's active season), so the 130 take the one season there is.
- **Where the rules live.** Migration `20261108010000`: `players.season_settings_id` and
  `coaches.season_settings_id` (NOT NULL, FK to `season_settings` ON DELETE CASCADE), filled on insert
  by `players_enforce_season` / `coaches_enforce_season` (the division's season, else the active one)
  so existing writers and fixtures that name no season keep working, immutable after, and held to the
  season of the division and team. `player_buddies`, `team_players`, `team_coach_assignments`, the
  `teams` coach columns and `coach_team_requests` each refuse another season's row (23514).
  `persist_team_schedule` is not replaced: its roster insert goes through the `team_players` trigger,
  which is what refuses a roster naming another season's player (pgTAP calls it through the writer).
- **Keys.** `coaches_email_normalised` (lower-case and trimmed) is kept; only the per-organization
  unique key is replaced, by a unique index on `(organization_id, season_settings_id, lower(email))`.
- **`view_org_metrics`** gains `season_settings_id` last and has a row per season; its one reader
  (the Reports page) asks for the season shown.
- **Not touched, by design:** the `teams` table has no season column (a team's season is its
  division's), so team lists are scoped through the season's divisions; `PlayerRecordPage` reads one
  player by id; `useCoedTransition` reads players through the season's divisions already;
  `coach_team_requests` has no season column and is scoped through its coach.
- **Left for E3b:** the guard widening to drafts (the coach finalizer now has the same guard as the
  player finalizer, so E3b widens both), the Seasons page, rollover, the cutoff. E3c: the evaluations
  import.

## Build notes: E3b (2026-10-28)

Built as written; where the plans left a choice, the recommended option was taken (listed in the PR body
under "For the owner"). Migration `20261109010000_season_rollover.sql`.

- **RPCs.** `admin_create_season_from(source, name, year, start, end)`, `admin_update_draft_season(season,
  patch)`, `admin_activate_season(season)` and, for the optional window the C3 section names,
  `admin_set_division_birthdate_window(division, start, end)`. Each takes the organization's season lock and
  is audited (`season.created_from`, `season.updated`, `season.activated`, `division.window_changed`). What a
  rollover copies is two catalogues (`rollover_division_columns()` and its skipped list, the same for
  `season_settings`) that pgTAP holds equal to the table's columns: a column added later fails until it is
  classified.
- **Age cutoff.** `age_cutoff_mode` gains `custom` with `age_cutoff_month/day` (a CHECK ties them to the mode). A
  custom cutoff of Jan 1 is the calendar year, Feb 29 is Mar 1 in a year without one. The window rule for the
  natural age: a birth date inside a division's window (both ends) takes that division's age, which is the age
  the cutoff gives brought into the division's band (`min_age/max_age`, else the U-numbers in its name); two
  windows holding a date take the lower age; a window with no readable band is ignored. Core
  (`ageGroups.js`), the Edge twin (`natural-age.ts`, `import-validation` reads the season's divisions) and the
  mock agree on a corpus (`tests/naturalAgeParity.test.js`, `natural-age_test.ts`), and the Teams page's
  birth-date path (`resolveNaturalAge`, `applyPlayUpEligibility`, `computeAgeGroup`) uses the same rule. The
  Teams page reads each division's `birthdate_start`/`birthdate_end` with the rest of its row (it did not at
  first, so the window never reached `applyPlayUpEligibility`; Codex's finding on #680), and counts ages
  against the windows compiled once per roster (`compileDivisionWindows`): the season fixture's play-up
  comparison counts ~600,000 ages, and reading the window dates per player took its tests from ~2.3s to
  ~3.5s under coverage, past vitest's 5s in CI.
- **Once a season has players** its cutoff, season year and its divisions' windows cannot change: triggers on
  `season_settings` and `divisions` (22023, `season_has_players`), so a direct write meets them as the RPCs do.
  Name and dates change on a draft or the active season; the year and cutoff on a draft only (Decision 7).
  **Nor while a player import is pending** (22023, `import_pending`; Codex's finding on #680): the import
  stages each row's natural age under the rule in force, so changing the rule between the staging and the
  apply would store ages counted under the old one. `season_has_pending_player_import(season)` is an
  unfinished registration job of the season (a legacy job with no season counts for the active one) with
  staged rows not yet promoted; cancelling a job fails it, which ends it, and a coach-only job stages no
  player rows. Ages are never recomputed: the rule waits instead.
  **The window the pending check cannot see** (Codex, rounds two and three on #680): `import-validation` reads
  the rule and only then stages its first row, so a change between the two finds nothing pending, and a
  change followed by its reversal (A, B, A) leaves a rule that looks the same. So `season_settings` carries
  an `age_rule_revision` that only goes up, bumped by a trigger on every change that moves an age (the cutoff
  mode, month, day, the season year, and a window-bearing division's window, `min_age`/`max_age` or, where a
  band column is empty and the name supplies the band, its name; a window-bearing division arriving or
  going). One service-role RPC, `import_age_rule(org, job, restart)`, returns the rule the validation needs
  (the season's year, cutoff and its window-bearing divisions) with the revision from one statement, and
  stamps the job with the season and that revision; the Edge Function counts every age from what it
  returned and reads nothing of its own. `finalize_import_job` takes the season lock and refuses a stamped
  job whose season and revision are not the season's now (22023, `age_rule_changed`), leaving the job to be
  validated again. A revision rather than a digest of the values: a digest cannot tell A, B, A from no
  change, and the revision is taken from the same snapshot as the data. The first batch of a file replaces
  a stamp (validating again refreshes it); a later batch keeps the first's. A job with no stamp (a coach
  or field job, or one made before this migration) is never refused.
- **A division's band is part of the rule.** The guard on `divisions` also covers `min_age`, `max_age` and a
  name that supplies the band, but only for a division that bears a window (a division with none does not
  move an age): once the season has players (`season_has_players`) or while an import is pending
  (`import_pending`), the change is refused. `upsert_division_for_import` is left as it is and meets the
  trigger: a call that names no band (the coed transition's) changes nothing, and one that moves the band
  of a window-bearing division in such a season is refused loudly rather than ignored, since silently
  keeping the old band would hide that the admin's request did nothing.
- **Guard widening.** `create_import_job`, `finalize_import_job` and `finalize_coach_import_job` allow the
  active season or a draft and refuse a completed one; `finalize_field_import_job` (organization-level
  locations and fields) and a field job for a draft stay active-only.
- **Completed seasons** are read-only for a signed-in caller by a trigger on `players` and `coaches`
  (22023, `season_completed`), whichever writer; a job with no signed-in user (the retention job, the demo
  purge) and the cascade of a deleted organization pass. A completed season can be opened from the header to look
  back at (a notice above each page says it is read-only). **Schedules too** (Codex's finding on #680): the
  same rule, one more trigger function, on `teams`, `team_players`, `team_coach_assignments`,
  `practice_assignments`, `practice_exceptions` and `game_assignments`. A row's season is its team's
  division's (a team has no season column), or `practice_exceptions.season_settings_id`; an update is judged on
  the old row and the new, so a team cannot be moved out of or into a completed season. They are triggers, not
  checks in the writers, so the persistence RPCs a later PR replaces (`schedule_tbd`, #678) are covered
  without being edited; a table that PR adds joins the trigger list. The Teams, Practice and Game pages turn
  Generate, Apply, Save, the manual override and the cancels off on a completed season and say why
  (`useSeasonReadOnly`, `SeasonReadOnlyNote`), so the database's refusal is not the first the admin hears.
- **Activation** needs a known timezone, both dates (end not before start) and a season year, completes the
  previous active season and activates the draft in two statements; a completed season is never reactivated
  (Decision 6).
- **Seasons page.** A section of Settings, Season & Calendar (above Programs): the list, "Start next season from
  this", Edit (name, dates, year, cutoff presets and custom, each division's window) and Activate. The
  "Current Season Label" control and its ThemeContext state are removed.
- **Verification** is in the PR body. Not done here, left for E3c: the evaluations import.
