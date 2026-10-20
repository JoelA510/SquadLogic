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
| 3 | Team generation discards the eligibility review it computes, and swallows a pipeline failure | Yes (`TeamAnalysisPage.jsx:806-812`) | Medium: wrong rosters, silently | Plan after 1-2 | Medium |
| 4 | Home and away are decided by team id | Yes (`gameScheduling.js:58-59`, pair sorted, smaller id home) | Low-medium: fairness | Plan after 3; re-run the season fixture | Small |
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

**Recommendation: restrict rows first, then add the narrow reads pages need.**

- **`players`:** SELECT for org admins and staff, for the coaches of the player's current team
  (through `team_coach_assignments`), and for guardians linked through `profile_players`.
  Everyone else sees no player rows. The pages that read players with `select('*')`
  (`usePlayersData`, `DashboardPage`, `PlayerRecordPage`, `CoachesPage`, `TeamAnalysisPage`,
  `EnterpriseDashboard`) are admin or coach surfaces, so their callers keep the rows they need.
- **`coaches`:** members read name and team only, through a `SECURITY DEFINER` read like
  `get_organization_members`. Full rows go to admins.
- **`teams.calendar_token`:** move it out of the member-readable row. Expose it through an RPC,
  `get_team_calendar_link(team_id)`, for admins, the team's coaches, and guardians of players on
  the team. Those are the people the portal's Calendar Subscription dialog serves.
- **`rls_policy_matrix.sql`:** encodes whole-row reads as expected (`:696-704`). Its rows change
  to the new expectations, and the old policy must fail them, shown red before merge.
- **`docs/security/rls-policies.md`:** corrected.

**Decisions for you:**

1. Do a team's coaches see its players' `medical_info`? *Recommended: yes, own team only.* They
   are the adults present at practice.
2. Do a team's coaches see `guardian_contacts`? *Recommended: yes, own team only.*
3. Do guardians see only their linked children? *Recommended: yes.*
4. Does `staff` read like an admin? *Recommended: yes for reads, as today for other tables.*

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

Plan it with item 1: both are "who may touch what".

## 3. Eligibility honoured and explained

**Re-checked, *statically reviewed*.** `TeamAnalysisPage.jsx:806-812` runs `prepareTeamingInput`
with `remapBlocked: false` and keeps only `prepared.players`. `placement`, `needsReview` and
`reviewReason` are dropped, so a play-down the policy forbids is seated without a flag. If the
pipeline throws, `console.warn` fires and generation goes ahead on the raw roster, and the
operator is never told.

**Recommendation.**
- Pass the annotations to the generator. A blocked placement becomes "unplaced, needs review",
  following the TIME TBD pattern: the player stays visible with a reason and is never silently
  dropped (AGENTS.md).
- Show the reasons on the Teams page.
- Turn the pipeline failure into a visible error that stops generation.
- Re-run the season fixture (AGENTS.md: domain change).

**Decision:** does missing paperwork block a placement or only flag it? *Recommended: flag only.*
Paperwork arrives late in real seasons, and blocking would hold players off rosters for a
clerical gap.

## 4. Home/away balance

**Re-checked, *statically reviewed*.** In `generateRoundRobin`, each pair is sorted (`ordered =
[home, away].sort(...)`, line 58), so the team with the smaller id is home in every meeting. In a
single round robin, the smallest id plays every game at home. `gameMetrics` counts home games but
nothing warns.

**Recommendation.**
- Use the standard circle-method rule instead of sorting: alternate home and away by round, and
  flip the fixed team's side every round. That gives every team a home count within one of every
  other's.
- Add a `gameMetrics` warning when two teams' home counts differ by more than one.
- This changes generated output, so the plan must show the season-2026 fixture's before and after,
  and existing saved schedules are untouched (maximum freeze).

## 5. Season rollover

**Re-checked, *statically reviewed*.** Only `initialize_new_tenant` inserts a `season_settings`
row (migrations `20260416000001` and its `20260913000000` redefinition). Season dates and
`age_cutoff_mode` have no UI writer. Starting spring 2027 today would need SQL.

**Recommendation.** Build an `admin_create_season(p_from_season_id, p_patch)` RPC. It copies
settings into a **draft** season, and nothing becomes active until the admin confirms. It copies:
- division bounds;
- registration forms;
- heat category;
- blackouts that recur.

Teams, rosters, registrations and schedules are not copied. Season dates must be entered, not
copied. A season page edits dates, the age cutoff and the status (draft, then active, then
completed). Imports bind to an explicitly chosen season.

**Decisions:**
1. Which settings carry over? *Recommended: the list above.*
2. Can two seasons be active at once? *Recommended: no.* One active season per organization
   keeps every "current season" reader correct. The plan must list those readers: season pickers,
   the `localStorage` season, imports, and the Edge Functions' season reads.

**Deadline.** Before registration for the next season opens. Please tell me the date.

## What I need from you

Answers to 1.1 to 1.4, 3, and 5.1 to 5.2, plus the date in item 5. With those, I write plans for
1 and 2 together first, and build them once you approve the plan.
