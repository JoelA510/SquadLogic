# Per-season enrollment (Phase E3)

Status: **revised with the owner's decisions of 2026-10-27; three new design points (C1-C3) need
the owner's approval before E3a starts** (AGENTS.md rule 14: the domain model and persistence). The
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
  across all organizations and `coaches.user_id` is unique (`20261020040000:19-20`). A coach signs
  in and is linked to that row (`link_my_coach_record`). Six frontend readers list coaches.
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

### C1. Coaches: enrolled per season, identity kept (needs approval)

A coach signs in, so the person cannot be re-created each season the way a player row is: the
account link and the global email uniqueness would collide. Proposed: keep one `coaches` row per
person and add **`coach_seasons (coach_id, season_settings_id, organization_id)`**, written by a
season's coach import (and by an admin adding a coach to a season).

- A coach is listed, assignable and linked to children **only in seasons they are enrolled in**.
  A coach imported last season and not this season is not offered this season (decision: no coach
  assumed returning); their account and past seasons are untouched.
- Season facts the coach import carries today move with the enrollment only if they are
  season-specific (e.g. the volunteer answers); identity fields stay on `coaches`.
- `coach_team_requests` and team assignments already hang off teams, which are per season.

Alternative: one coach row per season. Rejected because `coaches.user_id` and `coaches.email` are
unique and a signed-in coach links to exactly one row; dropping those guarantees reopens the
identity holes A2 closed.

Noted, not in E3: `coaches.email` unique **across organizations** means one person cannot coach in
two clubs on this deployment. That is a separate decision.

### C2. Evaluations import (needs approval)

The owner expects clubs to import skill levels from their own evaluations after the general
imports. Proposed **E3c**: an "evaluations" import into an existing season that **only updates**
rating / skill tier (and, if present, years played) on that season's players, matched by
registration id; unmatched rows are listed and nothing is created. It reuses the import pipeline
(allowlist, staging, audited finalize). Ask: confirm the columns (rating and skill tier; years
played too?) and that unmatched rows are reported, never created.

### C3. Age cutoff per season (needs approval of "custom")

On the season's settings (E3b's Seasons page):

- **School year, Aug 1 - Jul 31** (the default). AYSO, US Club Soccer and US Youth Soccer use it
  from the 2026-27 registration year; US Soccer let each member set its own rules from 2026-27.
- **Calendar year, Jan 1 - Dec 31** (the 2016-2026 birth-year rule; US Soccer's ODP keeps Jan 1).
- **Custom**: a cutoff month and day the club picks. A division's own birth-date window
  (`divisions.birthdate_start/end`) still overrides for a single division.

`age_cutoff_mode` gains `custom` with `age_cutoff_month` / `age_cutoff_day`; the import's natural
age (`import-validation`, `_shared/natural-age.ts` and core's twin, held equal by
`naturalAgeParity.test.js`) honours it. The season year is the year the season starts. Changing
the cutoff of a season that already has players is refused (their stored ages were computed with
the old one); a draft season can change it freely. Ask: is "custom" a single cutoff date (this
proposal), or do you need full per-age-group date ranges beyond the per-division windows?

### Rollover and completed seasons (decisions 2, 3)

`admin_create_season_from` copies divisions and programs, and no players or coach enrollments.
Completed seasons are read-only, players and enrollments included, until an admin deletes that
season's data.

## Tests

- pgTAP: the season column and its division-season trigger; the unique (season, external id); an
  import into a draft season leaves the active season's row untouched (the case Codex found on
  #666); no row of another season is read or written; an import into a completed season is
  refused; a roster or buddy pair across seasons is refused; a coach not enrolled in a season
  cannot be assigned there; the evaluations import updates only matched rows; the cutoff cannot
  change once a season has players.
- Unit: each reader asks for the selected season only; natural age under each cutoff mode,
  parity between core and the Edge twin; the mock mirrors per-season matching and enrollment.
- E2E (mock): import into the active season, create a draft, import a file where one child
  reappears in an older division; the active season's Players page is unchanged and the draft's
  shows a separate row; a coach imported only into the active season is not offered in the draft.

## PR split

| PR | Contents | Live effect |
| --- | --- | --- |
| E3a | player season column, unique index, per-season import matching, writers and readers filtered by season, `coach_seasons` and coach readers filtered, demo seed; the E1 guard still allows only the active season | none visible for one active season |
| E3b | season rollover, draft season edit and activation, the Seasons page with the age cutoff (C3), the guard widened to drafts | admins prepare next season and import into it |
| E3c | the evaluations import (C2) | clubs add ratings after registration |
