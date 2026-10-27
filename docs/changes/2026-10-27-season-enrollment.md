# Per-season enrollment (Phase E3)

Status: **draft for owner approval** (AGENTS.md rule 14: the domain model and persistence). The
owner decided on 2026-10-26 (Phase E plan, Decision 11) that a player is enrolled per season, so a
draft season can take registration imports, and a returning player can be in this season's U10 and
next season's U11 at once. This plan is the design. Code read at `origin/main` c74d7d3 (_statically
reviewed_ through a research pass; file:line references are from it and get re-checked in task 0).
Production counts are _executed_ (read-only, 2026-10-27): 1 organization, **0 players**, 0
team_players, 0 buddy pairs.

## Today

- **A player row mixes the person with the season.** `players` holds identity (names, gender,
  grade, notes, external registration id) beside season facts: `division_id`, `team_id`,
  `natural_age` ("for the season of the import that wrote it"), status, rating, years played,
  jersey, skill tier, buddy request, the coach-volunteer answers and `custom_attributes`. It has no
  season column; the season is reachable only through `division_id`
  (`divisions.season_settings_id`).
- **The import matches across seasons.** `finalize_import_job` matches an existing player by
  organization and external registration id and overwrites its division, natural age and the rest
  (`20261101010000:591-640`). That is why E1 refuses imports into any season but the active one.
- **Teams, rosters and buddies are already season-scoped in effect**: a team belongs to a division,
  a division to one season; `team_players` and `player_buddies` hang off players and teams.
- **Readers take every player in the organization**: the Players page and Team Builder
  (`usePlayersData.js:27`, `select *`), the roster directory, the sidebar count, setup progress,
  `view_org_metrics`, both dashboards. Only the co-ed transition narrows by season.
- **The schema already allows one row per player per division**: the baseline's unique
  `(division_id, external_registration_id)` (`20251208000000`) still holds.

## Options

- **A. Split person from enrollment.** A `player_enrollments` table (season, player, division,
  status, rating, natural age, buddy request and the other season columns) beside an org-level
  `players` identity table. The textbook model. Every writer and reader of player columns moves to
  the new table or a join: the import, `apply_player_patch`, the admin player RPCs, the D3 demo
  fences, the Players grid's edits, teaming in `packages/core`, the roster directory, the dashboards
  and the coach roster read. Large, and names are still kept once per organization forever.
- **B. A player row is an enrollment in one season (recommended).** `players` gains
  `season_settings_id`; each season has its own row for a returning player, linked to the previous
  season's row. Writers change only where they choose a row (the import, create, the demo seed);
  readers add one season filter. Names repeat once per season the child plays, which also means a
  completed season's people can be removed with that season (data minimisation). History across
  seasons follows the link.

B does what the owner asked with far less change: the domain logic, the grid, the teaming engine
and the coach view keep reading the same row shape.

## Design (option B)

- **Schema.** `players.season_settings_id` (NOT NULL after backfill; must equal the season of
  `division_id` when one is set, enforced by a trigger, since a CHECK cannot read another table),
  `players.previous_player_id` (nullable, same organization, an earlier season; set by the import
  when it recognises a returning player), and a unique index on
  `(season_settings_id, external_registration_id)` where the id is present. Backfill: production has
  0 players; the demo seed and any other row take the season of its division, else the
  organization's active season.
- **The import** matches existing rows in the **destination season only** (season and external
  id). A registration id seen in an earlier season but not this one inserts a new row and links
  `previous_player_id` to the most recent earlier row; `years_played` and the buddy history come
  forward only through that link, never by overwriting the old row. The E1 guard changes from "the
  active season only" to "the active season or a draft season; never a completed one".
- **Other writers**: `admin_create_player` takes the season (default the active one);
  `apply_player_patch` refuses a division or team outside the player's season;
  `persist_team_schedule` refuses a roster naming a player from another season (today it checks
  only organization, `20261018070000:599-629`); `start_demo_session` sets the demo season. Buddy
  pairs are refused across seasons.
- **Readers** filter by the season the header's season switcher shows (the current season by
  default): the Players page, Team Builder, the roster directory, the sidebar count, setup
  progress, `view_org_metrics` (per season), both dashboards. The coach roster read already goes
  through the team, so it is unchanged. RLS stays organization-scoped (a season filter is not an
  authorization boundary).
- **Rollover** (`admin_create_season_from`) copies divisions and programs, as planned, and **no
  players**: a new season's players arrive by its own registration import. (Owner decision 2.)
- **Completed seasons** are read-only, including their players (E1 already refuses imports there).

## Tests

- pgTAP: the season column and its division-season trigger; the unique (season, external id); an
  import into a draft season leaves the active season's row untouched (the exact case Codex found
  on #666) and links `previous_player_id`; an import into a completed season is refused; a team
  roster naming another season's player is refused; a patch moving a player to another season's
  division is refused; cross-season buddy pairs refused.
- Unit: each reader asks for the selected season only; the sidebar count and dashboards change with
  the season switcher; the mock twin mirrors the import's per-season matching.
- E2E (mock): import into the active season, create a draft, import a file where one child returns
  in an older division; the active season's Players page is unchanged and the draft's shows the
  child in the new division.

## PR split

| PR | Contents | Live effect |
| --- | --- | --- |
| E3a | season column, link, unique index, import per-season matching, writers and readers filtered by season, demo seed; the E1 guard still allows only the active season | none visible for one active season |
| E3b | `admin_create_season_from`, `admin_update_draft_season`, `admin_activate_season`, the Seasons page, the guard widened to drafts | admins prepare next season and import into it |

## Owner decisions

1. **Option B (recommended)**, a player row per season, or option A, a separate enrollment table.
2. **Rollover copies no players (recommended)**: next season's players come from its registration
   import. Alternative: copy every player still `active`, which would create enrollments for
   children who have not registered.
3. **Completed seasons' players**: keep until an admin deletes that season's data (recommended,
   matching the permits decision), or remove automatically N months after the season completes.
