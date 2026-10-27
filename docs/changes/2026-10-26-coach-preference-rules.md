# Coach practice preferences: several requests, several values

Status: **approved by the owner 2026-10-26** (decisions below); build with Phase D (AGENTS.md rule 14: persistence, the domain model and the
solver). Owner request, 2026-10-26: a coach can log several requests, and pick several values in one
("prefers Tuesday and Thursday", "must start at 5:00 or 6:00"). Code read at `origin/main` f70340d
(_statically reviewed_ through a research pass; paths and lines are from it and get re-checked in
task 0). Production counts are _executed_ (read-only, 2026-10-26).

## Revised 2026-10-27: admins import preferences (supersedes the coach-facing parts)

Only league admins sign in (`2026-10-27-admin-only.md`). What changes from the plan below:

- **Preferences arrive by an admin's import**, not a coach screen. Clubs collect them however they
  like (a Google Form exported to CSV, for example). One row is one rule: the coach (by email, the
  coach import's key), the team (optional when the coach has one team in the season; when a coach
  with several teams leaves it blank, the rule applies to each of their teams, and the import
  preview says so), the requested level (prefer or must), days, start times, venues, an optional
  date window and an optional priority (High, Medium, Low). A row naming no known coach or team is
  listed, never created. Re-importing replaces the imported rules of the teams the file names;
  rules an admin added in the app are left alone. The import runs after teams exist.
- **A must counts only once an admin accepts it in the app.** An imported must request is in force
  as prefer and appears on the **Pending musts** list (Accept as must, Keep as prefer, each with
  the impact preview), plus **Accept all** for a file the admin reviewed before importing, with a
  confirmation naming how many rules it makes must and listing any conflicts first.
- **Admins can add, edit and remove rules in the app**, as before.
- **Dropped:** the coach screens, coach withdraw, the admin notifications and the bell
  (decision 4 no longer applies). Decisions 1 (all rules apply; priority for visibility), 2 (per
  team) and 3 (only an admin grants must; a declined must is prefer) stand.
- **PR split:** P1 as below (data model, solver, RPCs) plus the preference import's server side;
  P2 the admin screens: the import with its preview, Pending musts with Accept all, the rules list
  and editor.

## Today

- **One value per row.** `coach_practice_preferences` stores a `dimension` (`weekday`,
  `start_time` or `venue`), a `level` (`must_keep`, `prefer_keep`, `dont_care`) and a scalar `value`:
  one weekday code, one start minute, or one location id. NULL means "keep the series' current
  value" (`20260927000000_coach_practice_preferences.sql:39-81`, CHECK at :63-73).
- **One approved row per coach and dimension.** The unique index
  `coach_practice_preferences_one_approved` (:93-95) allows any number of pending requests, but
  approving one supersedes the last (`admin_decide_coach_practice_preference`, :216-336). Core's
  `CoachPreferenceInputSchema` and its Deno twin refuse a second row for a (coach, dimension)
  (`packages/core/src/practice/coachPreferences.js:152-165`,
  `supabase/functions/_shared/engines/coach-preferences.ts:161-162`). So a coach has at most three
  preferences in force, one per dimension.
- **Per coach, not per team.** There is no team column. A coach with two teams has one set that
  applies to both (`coachPreferences.js:195-201`).
- **Matching is equality.** `judgeCoachPreferenceCandidate` compares the slot's weekday, start or
  location to the one value (`coachPreferences.js:272-289`). must_keep filters candidate slots in
  the solver and in repair; a team that has legal slots only before that filter goes to TIME TBD
  with reason `coach-preference` and the violated dimensions
  (`auto-scheduler-solver.ts:269-302, 827-860`; `repair.js:255, 957, 1544`). prefer_keep is a
  tiebreak in the solver and a weighted breach (100) in repair.
- **The screens.** The coach page shows one form per dimension, each with one select or one time
  field (`CoachPreferenceRequests.jsx:219-227`, `PreferenceFields.jsx:56-124`), and uses only the
  user's first coach record (:152). The admin grid shows one approved row per coach and dimension
  (`AdminPreferenceReview.jsx:430`).
- **Production:** 1 approved and 2 superseded rows, all `weekday` (_executed_).

## Change

A preference becomes a **rule**: what a coach asks for, for one team or all their teams, at one
level, over a date window.

- **A rule has up to three conditions:** days (one or more weekdays), start times (one or more), and
  venues (one or more). It can also say "keep the current day, time or venue" for a dimension, as
  NULL does today.
- **Several values in one condition mean "any of".** {Tue, Thu} is met by a Tuesday or a Thursday
  practice. A team that practises twice a week, with the existing rule that its practices fall on
  different days, then lands on Tuesday and Thursday. {17:00, 18:00} is met by either start.
- **Conditions in one rule must all hold.** "Tuesday at 5:00" is one rule with both conditions.
- **A coach can have many rules, and every rule in force applies** (decision 1). Adding one never
  supersedes the others.
- **A coach can rank their own rules** with an optional priority (High, Medium, Low, or none),
  meaning how much it matters to that coach (decision 1). It is for visibility: the admin's lists
  sort and show it, and it does not change how the scheduler weighs a rule. Making it weigh prefer
  rules later is a small change if wanted.
- **Every rule is for one team** (decision 2): the coach picks which of their teams; a coach with
  two teams adds a rule for each. The 3 existing rows become one rule per team the coach currently
  coaches.
- **A rule can have a date window** (effective from/to), so "Tuesdays until the clocks change"
  is expressible. Today's effective dates already exist on the table.
- **Levels:** must (a hard filter: unmet means TIME TBD with the reason and the rule named, never a
  silent drop) and prefer (soft). `dont_care` stays as "no rule".
- **Only an admin makes a rule a must** (decision 3). A coach may ask for must. A prefer rule takes
  effect as soon as the coach adds it. A must request is in force as a prefer rule while it waits,
  and goes on the admins' **Pending musts** list; approving makes it a must, denying leaves it in
  force as a prefer rule (with the denial recorded and shown to the coach). Admins can also edit
  any rule.
- **Withdrawing takes effect at once** (decision 4) and puts a notice in the admins' notifications
  (below), which an admin can mark acknowledged. New prefer rules, which now need no approval,
  notify the same way, so admins still see every change.
- **Conflicts are found before they bite.** Two must rules for one team with no slot that meets
  both, from one coach or two co-coaches, show as a conflict on the admin's approval preview
  (`previewMustKeep` exists today) and as a TIME TBD reason if approved anyway.

## Data model

- `coach_practice_preferences` gains `team_id` (NOT NULL after the backfill; a team the coach is
  assigned to, in the same organization), `weekdays text[]`, `start_minutes int[]`,
  `venue_ids uuid[]`, per dimension a keep-current flag, `coach_priority` (NULL, or high, medium,
  low), `requested_level` (what the coach asked for) beside `level` (what is in force), and
  `must_decision` (pending, approved, denied, or NULL when must was not asked). CHECKs: each array
  is distinct, non-empty when present, in range (codes SUN-SAT, 0-1439, the organization's
  locations); a rule has at least one condition; `level = 'must_keep'` only when
  `must_decision = 'approved'`.
- The status lifecycle becomes in force / withdrawn / superseded (an admin's edit keeps history);
  the one-approved unique index is dropped.
- **Backfill** the 3 production rows (1 approved, 2 superseded, all weekday): each scalar becomes a
  one-element array, NULL becomes keep-current, and each row is copied once per team its coach
  currently coaches (a coach with no team keeps the row, flagged, and the admin sees it on the
  conflicts view). The approved row's level stays as approved, so a must stays a must. The old
  `dimension`/`value` columns are dropped in the same migration after the end-state check (every
  row has a team or the flag, at least one condition, counts match).
- **RPCs** replaced from their latest bodies (md5 guard), all audited:
  `add_coach_practice_preference` (the coach or an admin; prefer takes effect, a must request is in
  force as prefer and pending), `admin_decide_must_preference` (approve or deny a pending must;
  `coach_preference.must_approved` / `must_denied`), `admin_edit_coach_practice_preference`,
  `withdraw_coach_practice_preference` (the coach or an admin; at once; `coach_preference.withdrawn`).
- **Admin notifications** (new; the header's bell button does nothing today, `TopBar.jsx:343`): a
  table `admin_notifications` (organization, kind, the rule it refers to, created, acknowledged by
  and at), written by the RPCs above for a withdrawal, a new prefer rule and a new must request;
  readable by the organization's admins; `acknowledge_admin_notification` marks one or all read. The
  bell shows the unacknowledged count and opens the list. No email or push.
- RLS is unchanged in shape: admins read their organization's rules, a coach reads their own.

## Solver and repair

- Core `resolveCoachPreferences` collects, per team, every in-force in-window rule of its current
  coaches for that team, and judges a candidate slot against each: must rules
  filter, prefer rules count one breach per unmet rule (the repair weight stays 100 per breach). The
  Deno twin follows, held by `tests/coachPreferenceDrift.test.js` over an enumerated product of
  values.
- The TIME TBD explanation names the rules no legal slot meets, not just the dimension.
- **CPU:** judging a few small arrays per candidate is cheap next to the solver's search; measure it
  on the demo league (128 teams) against the Edge Function's 2 s CPU limit, as the demo work did.

## Screens

- **Coach:** a list of my rules per team (in force, must pending, past), each with its priority and
  a **Withdraw** button, and **Add a request**: a form with the team, prefer or "ask for must", an
  optional priority, days as a checkbox group, start times as a list of
  time fields with add and remove, venues as a checkbox list, an optional date window, and a
  summary sentence of the rule before sending ("Must practise on Tuesday or Thursday, starting at
  5:00 or 6:00 PM, for U10 Boys 2"). A coach with several coach records sees all of them (today's
  first-record-only read is fixed). Keyboard and screen-reader operable, both themes, WCAG 2.2 AA.
- **Admin:** a **Pending musts** list to work through, sorted by the coach's priority then age,
  each with the impact preview and Approve as must or Keep as prefer; all rules by team and coach
  with filters (team, coach, level, priority) and edit; a conflicts view for must rules that cannot
  be met together; and the notifications list from the bell, with Acknowledge and Acknowledge all.

## Tests

- pgTAP: the new CHECKs (empty set, duplicate, out-of-range minute, another organization's venue,
  a team the coach does not coach), many rules per coach, the backfill (a scalar row becomes a
  one-element array per team; a NULL row becomes keep-current; an approved must stays must), a coach
  cannot make a rule must (only `admin_decide_must_preference` can), a denied must stays in force as
  prefer, withdraw is immediate and writes a notification, acknowledge, each RPC's refusals for a
  non-admin and another organization.
- Core: any-of within a condition, all-of across conditions and rules, team scope, date window,
  conflict detection, the TIME TBD reason naming the rule; the drift test over the new shape.
- Solver: a team with {Tue, Thu} must and two practices lands on Tuesday and Thursday; a must rule
  with no legal slot gives TIME TBD with the reason, never a dropped practice; the season-2026
  fixture suite unchanged where no rules exist (AGENTS.md: a change that breaks the season fixture is
  presumed wrong).
- UI: the multi-select controls (axe, keyboard), the rule summary sentence, the coach list, the
  admin approve-with-edits path; a mock E2E feature for request and approval.

## PR split

| PR | Contents | Live effect |
| --- | --- | --- |
| P1 | migration (columns, backfill, index dropped, RPCs), core and Deno twin, solver and repair, mock, tests; the screens keep working by sending one-value rules | none visible; the 3 rows still behave the same |
| P2 | the coach and admin screens above, the Pending musts list, admin notifications and the bell | coaches can add several requests with several values; admins work the musts list |

## Owner decisions (answered 2026-10-26)

1. **Several rules all apply**, with an optional per-coach priority (High, Medium, Low, or none)
   that says how much a rule matters to that coach. It is for visibility, not the admins' ranking,
   and does not change the scheduler's weighing.
2. **Rules are per team.**
3. **Coaches may ask for must; only an admin grants it**, from a Pending musts list. A denied must
   is treated as prefer. (Read as: prefer rules need no approval and take effect at once; a must
   request counts as prefer until decided.)
4. **Withdrawing takes effect at once** and notifies the admins, who can mark the notice
   acknowledged.
5. **Timing:** with Phase D, after Phases E and C.

## Risks and rollback

- The backfill changes the shape of 3 production rows; the revert script restores the scalar
  columns from the one-element arrays, refusing rows with more than one value (which only exist after
  P2 ships).
- Many must rules can make teams unplaceable; the approval preview and the TIME TBD reasons make
  that visible instead of silent.
