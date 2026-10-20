# Five defects found by the Zuluru3 comparison: recommendations

Status: **recommendations, for owner decision**. Requested by the owner 2026-10-20. Source: the
Zuluru3 research report (2026-10-19), section 1.1, items 1-5. Each was re-checked on `main` at
`4459faf` (v1.1.0) and, where it is a database fact, on production read-only (2026-10-20).

**What this document is, and is not.** It recommends what to do about each defect, in what order,
and what you need to decide. It is not the design. Every fix touches persistence, the domain
model or the solver, so each gets its own plan, written after your decisions and approved before
it is built (AGENTS.md rule 14). Function names, signatures, error codes and locking belong in
those plans. What this document carries forward is a list, per item, of the requirements that plan
must meet. Each requirement is a fact found in review that a plan could otherwise miss.

## Summary

| # | Defect | Still true? | Severity | Next step | Size |
| --- | --- | --- | --- | --- | --- |
| 1 | Any org member reads every player's full record (medical, guardian, DOB) and every team's calendar token | Yes (production policies and grants read 2026-10-20) | **High**: privacy, AGENTS.md data rules | Plan now; build before any real users | Large |
| 2 | Any coach or staff member in the organization can set any game's score | Yes (`update_game_score` role list, migration `20260504010000`) | Medium: integrity | Plan with 1 | Small |
| 3 | Team generation ignores the eligibility review it computes, and swallows two failures | Yes (`TeamAnalysisPage.jsx:776`, `806-835`) | Medium: wrong rosters, silently | Plan after 1-2 | Medium |
| 4 | Home and away are decided by team id | Yes (`gameScheduling.js:58`) | Low-medium: fairness | Plan after 3 | Small |
| 5 | No way to create a second season | Yes (only `initialize_new_tenant` inserts `season_settings`) | Medium, **dated**: blocks spring 2027 | Plan after 1; build before the next season opens | Large |

**Recommended order:** 1 and 2 (one plan, both authorization), then 3, then 4. Plan 5 in
parallel, because it has a calendar deadline rather than a severity.

## 1. Privacy-scoped reads (players, coaches, teams)

**Re-checked, *executed*.** On production, `players_select_member`, `Coaches: members access` and
`Teams: members access` are each `is_org_member(organization_id)` for `authenticated`, which also
holds table-level SELECT. Any member, a parent included, reads every player's `medical_info`,
`guardian_contacts`, `contact_info` and `date_of_birth`, and every team's `calendar_token` (the
credential to its calendar feed), through the REST API. No page shows the data, but the API
serves it. With no real users yet, this is the cheapest it will ever be to fix.

**Recommendation.** Restrict both rows and columns, and give each page the narrow read it actually
needs. Players are readable by admins and staff, the team's current coaches, and the player's own
guardians. Sensitive columns and the calendar token come only through server-side reads that check
who is asking. Coaches see a name-and-team list of other coaches; contact details only reach the
people on that team.

**The plan must cover:**
1. RLS filters rows, not columns. The column rule is enforced with privileges, and a column revoke
   fails every `select('*')` and every explicit select of a revoked column, for admins too. Every
   reader of `players`, `coaches` and `teams` is inventoried by search and migrated, each with a
   test under the reduced grants. Readers known so far:
   - `players`: `usePlayersData`, `DashboardPage` (`:706`), `PlayerRecordPage`, `CoachesPage`,
     `TeamAnalysisPage` (`:669/676`), `EnterpriseDashboard`, `ImportContext.jsx:173`
     (`external_registration_id`), `useCoedTransition.js:37` (`gender`), the mock client;
   - `teams`: `useTeamPortal`'s `PORTAL_TEAM_SELECT`, `DashboardPage.jsx:79`,
     `PlayerRecordPage.jsx:69`, `TeamBuilderPage`;
   - `coaches`, the caller's own row: `CoachPreferenceRequests.jsx:139`,
     `usePracticeLightingOverrides.js:248`, `DashboardPage.jsx:589-605`;
   - `coaches`, another coach's contact details: `TeamRecordPage.jsx:115` (the Staff tab).
2. Security-invoker views over these tables change meaning under the new rules
   (`view_org_metrics`, read by `EnterpriseDashboard`; `coach_team_map`, read by older policies).
   Each is moved to a server-side function or documented as per-viewer.
3. The lookup "is the caller a coach of this team" reads `coaches`, which becomes admin-only, so
   it runs with definer rights. Otherwise every coach is locked out of their own players. The
   positive case (a current coach reads their own players) is tested, not only the refusals.
4. "Current coach" means a live assignment. `team_coach_assignments` keeps ended rows. Every
   check uses one shared rule, and "today" is computed in a zone the caller cannot set: not
   `current_date`, which follows the session zone a PostgREST caller controls. It is tested at the
   date boundary under extreme session zones.
5. Definer functions are not bound by column grants. `coach_update_player_compliance` returns the
   whole player row to a coach today. Every function returning `players` is listed, and any that a
   non-admin can call is narrowed.
6. `rotate_calendar_token` lets any member rotate any team's token and read the new one. It gets
   the calendar link's authorization; guardians can read the link but not rotate it.
7. The Staff tab's contact read is limited to the team's own people. `/team/:teamId` is unguarded,
   and every member reads every team.
8. `rls_policy_matrix.sql` (`:696-704`) encodes the whole-row reads as expected. Its expectations
   change, and the old policies are shown failing them.

**Decisions for you:**
1. Do a team's coaches see its players' `medical_info`? *Recommended: yes, own team only.* They
   are the adults present at practice.
2. Do a team's coaches see `guardian_contacts`? *Recommended: yes, own team only.*
3. Do guardians see only their linked children? *Recommended: yes.*
4. Does `staff` read like an admin? *Recommended: yes for reads, as today for other tables.*
5. Which coach contact fields do team members see on the Staff tab? *Recommended: name, email and
   phone of the team's current coaches*, which is what the tab shows today.

## 2. Score authorization

**Re-checked, *statically reviewed*.** `update_game_score` admits `admin`, `tenant_admin`,
`staff` and `coach` org-wide (`20260504010000:99`), not only the two teams' coaches. Overwrites
are audited but not flagged.

**Recommendation.** Admins (and staff, per decision 1.4) plus the current coaches of either team in
the game may set a score; everyone else is refused. The existing audit row stays. A "disputed"
state waits until standings matter. Plan it with item 1: both are "who may touch what".

**The plan must cover:**
1. "Current coach" is item 1's live-assignment rule, judged today, not on the game's date: a
   coach removed yesterday must not keep the right to rewrite last week's scores.
2. `ScoresPage` and `LeagueStandings` show every score as editable to anyone with
   `MANAGE_SCHEDULE`, which coaches hold. They change with the RPC, so editing appears only where
   the caller may score. Without that, an unrelated coach's edit is applied optimistically and then
   refused.
3. Tests cover a coach of either team, an unrelated coach, a former coach, and an admin, in the
   RPC and in the UI.

## 3. Eligibility honoured and explained

**Re-checked, *statically reviewed*.** `TeamAnalysisPage` annotates each player with `placement`,
`needsReview` and `reviewReason` and passes them to `generateTeams` (line 835), which never reads
them. A play-down the policy forbids is seated like any other player, with no flag. (The report
said the page dropped the annotations; it is the generator that ignores them.) Two failures are
swallowed:
- if the pipeline throws, `console.warn` fires and generation runs on the raw roster;
- the `coach_team_requests` read (line 776) ignores its `error`, so a failed read means no coach
  anchors and no error.

**Recommendation.** The domain layer honours the annotation. A blocked player is never seated; they
appear in an explicit "not placed" result with the reason, on the Teams page, following the TIME
TBD pattern (visible, never silently dropped). Both swallowed failures become visible errors that
stop generation.

**The plan must cover:**
1. One "not placed" contract. `generateTeams` already has late and unassigned outputs, and the
   plan extends one of them rather than adding a second.
2. Never unseat a protected player. On a rerun the page passes the existing snapshot in review
   mode, where a player missing from the pool is treated as dropped. A player already on a manual,
   reviewed, published or locked roster who is now blocked stays put. The run stops for review and
   lists them (the incremental-roster invariant in AGENTS.md).
3. Tests, each failing against today's code:
   - a blocked player ends up unplaced with its reason;
   - a protected blocked player stays on their roster;
   - the read error stops generation;
   - a thrown pipeline stops generation;
   - the Teams page shows the unplaced player and the reason.
4. The season fixture is re-run (AGENTS.md: domain change).

**Decision:** does missing paperwork block a placement or only flag it? *Recommended: flag only.*
Paperwork arrives late in real seasons, and blocking would hold players off rosters for a clerical
gap.

## 4. Home/away balance

**Re-checked, *statically reviewed*.** In `generateRoundRobinWeeks` each pair is sorted (line 58),
so the team with the smaller id is home in every meeting; in a single round robin the smallest id
plays every game at home. `gameMetrics` counts home games, but nothing warns.

**Recommendation.** Orient each pairing with a rule that balances home games, and warn when a
schedule is unbalanced.

**The plan must cover:**
1. The rule is proven before it is chosen. With an even number of teams every team's home count
   is within one of every other's. With an odd number every team is home exactly `(n - 1) / 2`
   times. A test checks that for every team count from 2 to 16. A loosely stated "alternate by
   round" rule fails it: simulated in review on today's rotation, the spread was 2 or 3.
2. Saved games keep their sides. `GameSchedulingPage` regenerates the whole round robin on every
   run (line 381), so without a freeze a regenerate-and-save after the change would flip published
   games.
3. The warning is tested directly through `evaluateGameSchedule`, not only through the generator.
   The season fixture never calls the generator, so it proves nothing here. The existing tests that
   pin today's orientation are updated.

## 5. Season rollover

**Re-checked, *statically reviewed*.** Only `initialize_new_tenant` inserts a `season_settings` row
(migrations `20260416000001` and `20260913000000`). Season dates and `age_cutoff_mode` have no UI
writer. Starting spring 2027 today would need SQL.

**Recommendation.** An admin creates the next season from the current one, as a **draft**. It gets
copies of the divisions (with their whole configuration) and the registration forms, and a
timezone. The admin enters the new dates and a new name, then activates it. Activation completes
the old season. Teams, rosters, registrations, schedules and blackouts are not copied. Heat
settings are organization-wide already (`organization_heat_settings` is keyed by organization;
*executed*), so they need no copy.

**The plan must cover:**
1. Nothing becomes live before activation. Copied forms start closed: `submit_registration`
   accepts any open form whatever its season's status. Every automatic "current season" fallback
   selects the active season. `OrganizationContext` and the Edge `readSeasonTimezone` pick the
   newest season today, which would make a fresh draft current.
2. Each copied form points at the new season's copy of its division, not at the old division.
3. Every division column except the season link and dates is copied, from a list read from the
   catalogue (`TeamAnalysisPage.jsx:188-193` uses the roster settings).
4. Activation is refused without a timezone and valid start and end dates. A season without a
   timezone makes every timed slot TIME TBD.
5. One active season per organization is enforced in the database, after inventorying and
   backfilling existing statuses (production has one season, `active`; *executed*). Two admins
   activating at once cannot both succeed.
6. Imports carry the chosen season through to finalization. Today `finalize_import_job` picks the
   active-or-newest season itself (`20260726000300:123-129`), so a draft could never be imported
   into.
7. Creation and activation are both audited, each in its own transaction.
8. The stored-season lookup matches on `name`, so names are unique per organization.

**Decisions:**
1. Which settings carry over? *Recommended: divisions, forms and the timezone, as above.*
2. Can two seasons be active at once? *Recommended: no*, so every "current season" reader stays
   correct.
3. Should blackouts recur (for example, a fixed holiday each year)? *Recommended: not in the
   rollover change.* There is no recurrence model (a blackout is a fixed date range), so admins
   re-enter them with the season dates. A recurrence model, if wanted, is its own plan.

**Deadline.** Before registration for the next season opens. Please tell me the date.

## What I need from you

Answers to 1.1 to 1.5, 3, and 5.1 to 5.3, plus the date in item 5. With those, I write the plan for
1 and 2 first, and build it once you approve it.
