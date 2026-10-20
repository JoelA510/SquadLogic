# Five defects found by the Zuluru3 comparison: recommendations

Status: **recommendations, for owner decision**. Requested by the owner 2026-10-20. Source: the
Zuluru3 research report (2026-10-19), section 1.1, items 1-5. Each was re-checked on `main` at
`4459faf` (v1.1.0) and, where it is a database fact, on production read-only (2026-10-20). Every
fix touches persistence, the domain model or the solver, so each needs its own plan before it is
built (AGENTS.md rule 14). This file chooses the order and the shape; the plans come next.

## Summary

| # | Defect | Still true? | Severity | Recommended next step | Size |
| --- | --- | --- | --- | --- | --- |
| 1 | Any org member reads every player's full record (medical, guardian, DOB) and every team's calendar token | Yes (production policies and grants read 2026-10-20) | **High**: privacy, AGENTS.md data rules | Plan now; build before any real users | Medium |
| 2 | Any coach or staff member in the organization can set any game's score | Yes (`update_game_score` role list, migration `20260504010000`) | Medium: integrity | Plan with 1; small build | Small |
| 3 | Team generation ignores the eligibility review it computes, and swallows two failures | Yes (`TeamAnalysisPage.jsx:806-812`) | Medium: wrong rosters, silently | Plan after 1-2 | Medium |
| 4 | Home and away are decided by team id | Yes (`gameScheduling.js:58-59`, pair sorted, smaller id home) | Low-medium: fairness | Plan after 3; direct generator tests | Small |
| 5 | No way to create a second season | Yes (only `initialize_new_tenant` inserts `season_settings`) | Medium, **dated**: blocks spring 2027 | Plan after 1; build before the next season opens | Large |

**Recommended order:** 1 and 2 (one plan, both authorization), then 3, then 4. Plan 5 in
parallel, because it has a calendar deadline rather than a severity.

## 1. Privacy-scoped reads (players, coaches, teams)

**Re-checked, *executed*.** On production, `players_select_member`, `Coaches: members access` and
`Teams: members access` are each `is_org_member(organization_id)` for `authenticated`, which also
holds table-level SELECT. So any member, including a parent, reads every player's
`medical_info`, `guardian_contacts`, `contact_info` and `date_of_birth`, and every team's
`calendar_token` (the credential to that team's ICS feed), through the REST API.

**Why it matters.** It breaks AGENTS.md's data-minimisation and RLS rules. No page shows the data,
but the API serves it. There are no real users yet, so this is the cheapest it will ever be to
fix.

**Recommendation: restrict rows and columns, then add the narrow reads pages need.** RLS
filters rows, never columns: a policy that lets a coach read a player row hands over every column
of it. So each table needs both a row rule and a column rule, and the column rule is enforced by
privileges, not by what the pages happen to select.

- **`players`, rows:** SELECT for org admins and staff, for the coaches of the player's current
  team (through `team_coach_assignments`), and for guardians linked through `profile_players`.
  Everyone else sees no player rows. "Coach of the team" always means a **live** assignment:
  `team_coach_assignments` keeps ended rows on purpose (`effective_to`), so every coach check in
  this change (the policy, `get_player_detail`, the calendar link, `update_game_score`) uses one
  shared predicate, `effective_from <= current_date AND (effective_to IS NULL OR effective_to >=
  current_date)`, never a bare `EXISTS`.
- **`players`, columns:** revoke table-level SELECT from `authenticated` and grant it back column by
  column. The columns every row-holder may read are the roster columns (name, team, division, the
  eligibility fields). Sensitive columns (`medical_info`, `guardian_contacts`, `contact_info`,
  `date_of_birth`, `emergency_contacts`, `registration_history`, notes, location coordinates, flags:
  every column not on the roster list) are read only through a `SECURITY DEFINER` RPC,
  `get_player_detail(player_id)`, which applies decisions 1.1 to 1.4 per column. A column revoke
  breaks every `select('*')` on the table, so the plan must list and migrate each one
  (`usePlayersData`, `DashboardPage`, `PlayerRecordPage`, `CoachesPage`, `TeamAnalysisPage`,
  `EnterpriseDashboard`, the mock client), each to an explicit column list or the RPC.
- **`coaches`:** the same split. Members read name and team only, through a `SECURITY DEFINER`
  read like `get_organization_members`; full rows go to admins. Two pages read the `coaches` table
  to find the signed-in user's own coach row: `CoachPreferenceRequests.jsx:139` and
  `usePracticeLightingOverrides.js:248` (coach-scoped by `user_id`). They move to a narrow
  self-identity read, `get_my_coach_identity(org_id)` returning `{ id, full_name }`, so a coach
  is not locked out of their own preferences and lighting screens. A third reads another coach:
  `TeamRecordPage.jsx:115` loads the team's coach with `coaches.select('*')` for the Staff tab
  (name, email, phone, status). It moves to a team-scoped contact read,
  `get_team_staff(team_id)`, open to the members who can see the team. Which contact fields it
  returns is decision 1.5. The page gets a test under the reduced grants.
- **Definer RPCs that return a whole player row.** A `SECURITY DEFINER` function is not bound by
  the column grants. `coach_update_player_compliance` (`20260611000100:415`) authorizes a lead
  coach and `RETURNS public.players`, so a coach could send the current compliance value and get
  back every sensitive column. It is narrowed to return the roster columns and the compliance
  fields it changed. The plan lists every function in `public` that returns `players` or
  `setof players` (two admin RPCs in the same migration do too; admins may read everything, so
  they stay) and tests the coach RPC's return shape.
- **`teams.calendar_token`:** move it out of the member-readable row (column revoke, as above).
  Expose it through an RPC, `get_team_calendar_link(team_id)`, for admins, the team's coaches, and
  guardians of players on the team. Those are the people the portal's Calendar Subscription
  dialog serves. A column revoke fails the whole of any `select('*')` on `teams`, for admins too,
  so every wildcard read of `teams` is migrated to an explicit column list in the same change:
  `useTeamPortal`'s `PORTAL_TEAM_SELECT` (`*` plus embeds), `DashboardPage.jsx:79`,
  `PlayerRecordPage.jsx:69`, `TeamBuilderPage`, and any other the plan's search finds. Each page
  gets a test under the reduced grant, and the calendar dialog reads the link through the RPC.
- **`rotate_calendar_token`:** it is `SECURITY DEFINER`, authorizes any `is_org_member` caller,
  and returns the new token (`20260324000002`, the only definition; *statically reviewed*). Left
  alone it is a second path to every team's feed: any parent can rotate a team's token and read
  the new one, which also breaks the subscriptions of the team's real families. It gets the same
  authorization as `get_team_calendar_link`, with admins and the team's coaches allowed to
  rotate and guardians not, and refuses with `42501` instead of returning a status object.
  `TeamRecordPage.jsx:630` and the mock client follow.
- **Tests:** `rls_policy_matrix.sql` encodes whole-row reads as expected (`:696-704`). Its rows
  change to the new expectations, and the old policies must fail them, shown red before merge.
  New pgTAP proves the column rule, not just the row rule:
  - a coach of the player's team can read the roster columns but gets `42501` selecting
    `medical_info`, `emergency_contacts` or `registration_history` directly;
  - a coach whose assignment ended yesterday reads no player row of that team and gets nothing
    from `get_player_detail`;
  - `get_player_detail` returns or withholds each sensitive column per decisions 1.1 to 1.4;
  - a parent, and a coach of another team, cannot read `calendar_token` or rotate it;
  - `get_my_coach_identity` returns only the caller's own row.
- **`docs/security/rls-policies.md`:** corrected.

**Decisions for you:**

1. Do a team's coaches see its players' `medical_info`? *Recommended: yes, own team only.* They
   are the adults present at practice.
2. Do a team's coaches see `guardian_contacts`? *Recommended: yes, own team only.*
3. Do guardians see only their linked children? *Recommended: yes.*
4. Does `staff` read like an admin? *Recommended: yes for reads, as today for other tables.*
5. Which coach contact fields do team members see on the Staff tab? *Recommended: name, email
   and phone of the team's live coaches.* That is what the tab shows today, and parents use it to
   reach the coach.

## 2. Score authorization

**Re-checked, *statically reviewed*.** `update_game_score` admits `admin`, `tenant_admin`,
`staff` and `coach` org-wide (`20260504010000:99`), not only the two teams' coaches. "Final" means
both numbers are present. Overwrites are audited but not flagged.

**Recommendation.** Admit org admins, `tenant_admin` and `staff` (if decision 1.4 says staff acts
like an admin), plus the head and assistant coaches of either team in the game, read from
`team_coach_assignments` as of the game date. Refuse everyone else with `42501`. The existing
audit row stays. A "disputed" state is deferred until standings matter. Test with pgTAP:
- the coach of the home team can set the score;
- the coach of an unrelated team is refused;
- an admin can set it.

**The callers change with it.** `ScoresPage` (`/scores`) and `LeagueStandings` show every game's
score as editable to anyone with `MANAGE_SCHEDULE`, which coaches hold. After the RPC change, an
unrelated coach would still see the controls, and each edit would be applied optimistically and
then refused. Both pages show editing only on games the caller may score and keep the rest
read-only. UI tests cover a coach of one team in the game and a coach of an unrelated team.

Plan it with item 1: both are "who may touch what".

## 3. Eligibility honoured and explained

**Re-checked, *statically reviewed*.** `TeamAnalysisPage.jsx:806-812` runs `prepareTeamingInput`
with `remapBlocked: false` and passes `prepared.players` to `generateTeams` (line 835). Those
players carry `placement`, `needsReview` and `reviewReason`, but `generateTeams` never reads them,
so a play-down the policy forbids is seated like any other player, without a flag. (The report
said the annotations were dropped on the page; they are dropped in the generator.) If the
pipeline throws, `console.warn` fires and generation goes ahead on the raw roster, and the
operator is never told. A second silent path sits above it: the `coach_team_requests` read
(line 776) destructures only `data`, so a query error leaves `coachLinks` null and generation runs
with no coach anchors and no error.

**Recommendation.**
- **Honour the annotation in the domain layer.** Either `generateTeams` or a pre-filter in
  `packages/core` moves every player whose placement is blocked out of the pool and into an
  explicit `unplacedPlayers` result, each with its `reviewReason`. That follows the TIME TBD
  pattern: the player stays visible with a reason and is never silently dropped (AGENTS.md).
  The plan picks one of the two after reading how `generateTeams`' existing late and unassigned
  outputs are shaped, so there is one "not seated" contract, not two.
- **Never unseat a protected player.** On a rerun, `TeamAnalysisPage` passes an `existingSnapshot`
  in review mode, and a player absent from the pool is treated as dropped from the roster. So the
  move to `unplacedPlayers` applies only to players with no manual, reviewed, published or locked
  placement. A player who is already seated that way and is now blocked stays where they are. The
  run stops for review and lists them, and only an authorised unlock or removal changes the
  roster (AGENTS.md: incremental generation never reshuffles such a roster). A rerun test seats a
  player on a locked roster, makes them blocked, and asserts the player stays put and is listed.
- **Check the `coach_team_requests` error** and throw it.
- **Turn the pipeline failure into a visible error that stops generation**, instead of the
  `console.warn` and raw-roster fallback.
- Show the unplaced players and their reasons on the Teams page.
- **Tests:**
  - a core test where one blocked player lands in `unplacedPlayers` with its reason and on no
    team, and fails against today's generator;
  - a page or hook test where the `coach_team_requests` read returns an error and generation
    stops with that error shown, and fails against today's destructuring;
  - the same for a thrown pipeline.
- Re-run the season fixture (AGENTS.md: domain change).

**Decision:** does missing paperwork block a placement or only flag it? *Recommended: flag only.*
Paperwork arrives late in real seasons, and blocking would hold players off rosters for a
clerical gap.

## 4. Home/away balance

**Re-checked, *statically reviewed*.** In `generateRoundRobinWeeks`, each pair is sorted
(`ordered = [home, away].sort(...)`, line 58), so the team with the smaller id is home in every
meeting. In a single round robin, the smallest id plays every game at home. `gameMetrics` counts
home games but nothing warns.

**Recommendation.**
- Use the standard circle-method rule instead of sorting: alternate home and away by round, and
  flip the fixed team's side every round. That gives every team a home count within one of every
  other's.
- Add a `gameMetrics` warning when two teams' home counts differ by more than one.
- **Direct generator tests.** The season-2026 fixture does not call `generateRoundRobinWeeks`
  (it is used only by `GameSchedulingPage`), so re-running it proves nothing here. New tests in
  `tests/gameScheduling.test.js` generate a 4-team and a 5-team round robin and assert every
  team's home count is within one of every other's. Both fail on today's pair sorting (with 4
  teams, the smallest id is home 3 of 3). The existing tests that pin `homeTeamId` order in that
  file are updated in the same change, and the plan lists each one.
- Existing saved schedules are untouched (maximum freeze); only newly generated weeks change.

## 5. Season rollover

**Re-checked, *statically reviewed*.** Only `initialize_new_tenant` inserts a `season_settings`
row (migrations `20260416000001` and its `20260913000000` redefinition). Season dates and
`age_cutoff_mode` have no UI writer. Starting spring 2027 today would need SQL.

**Recommendation.** Build an `admin_create_season(p_from_season_id, p_patch)` RPC. It copies
season-keyed settings into a **draft** season, and nothing becomes active until the admin
confirms. It copies:
- division bounds;
- registration forms, each with its `division_id` mapped to the matching newly created division
  (a form with no division stays organization-wide). Each form starts as `draft` whatever its
  source status was. `submit_registration` accepts any `open` form regardless of its season's
  status, so a copied open form would take registrations into an unconfirmed season. Tests: a
  copied form points at the new season's division, a registration through it places the player
  there, and a copied form refuses submissions until it is explicitly opened.

Two things the report listed are not copied:
- **Heat settings** are not season data. `organization_heat_settings` is keyed by
  `organization_id` alone (its primary key; *executed*, read-only), so the new season already
  uses them. Copying would mean inserting a second row for the same organization.
- **Blackouts** have no recurrence model. A `field_blackouts` row is a fixed date range, so
  "blackouts that recur" cannot be selected. Copying them would carry last season's dates into
  the new one. They are left behind, and decision 5.3 asks whether a recurrence model is wanted.

Teams, rosters, registrations and schedules are not copied. Season dates must be entered, not
copied. A season page edits dates, the age cutoff and the status (draft, then active, then
completed).

**Imports bind to an explicitly chosen season.** Today they cannot: `create_import_job` takes no
season, `import_jobs` has no season column, and `finalize_import_job` picks the active season, or
the newest (`20260726000300:123-129`). With last season still active and the new draft selected,
an import would land in last season. The rollover carries the selected season id through
`ImportContext`, `create_import_job`, a new `import_jobs.season_settings_id` and finalization,
which refuses a season of another organization. A test imports into a draft while another season
is active and asserts where the divisions and players land.

**Decisions:**
1. Which settings carry over? *Recommended: the list above.*
2. Can two seasons be active at once? *Recommended: no.* One active season per organization
   keeps every "current season" reader correct. The plan must list those readers: season pickers,
   the `localStorage` season, imports, and the Edge Functions' season reads. Two of those fall
   back to the most recently created season without looking at its status:
   `OrganizationContext`'s season fetch and the Edge `readSeasonTimezone`, both ordered by
   `created_at desc`. A new draft would become "current" the moment it was created. Every
   automatic fallback selects the active season instead, while an admin can still pick a draft
   explicitly. Each fallback gets a test with a newer draft present.
3. Should blackouts recur (for example, a fixed holiday each year)? *Recommended: not in the
   rollover change.* Admins re-enter next season's blackouts, as they enter season dates. A
   recurrence model, if wanted, is its own plan.

**Deadline.** Before registration for the next season opens. Please tell me the date.

## What I need from you

Answers to 1.1 to 1.5, 3, and 5.1 to 5.3, plus the date in item 5. With those, I write plans for
1 and 2 together first, and build them once you approve the plan.
