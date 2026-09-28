# 8.6 PR 3b — wiring the practice repair: approved plan

Status: **APPROVED by the operator 2026-09-27**, with the rulings of 2026-09-24
folded in. This is the plan every 3b PR is briefed against; a PR that departs
from it says so in its body. Drafted by a plan agent from `0abb4cb`; claims
below carry the file:line they were verified at on that commit — re-verify
before relying on a line number.

Supersedes the first 3b plan (which proposed a `practice_time_tbd` table, a
split for every loss, and a 3b-0 retire off-by-one fix — the latter was **not
live**: `20260907000000_field_delete_booking_guard.sql:667` redefines
`admin_retire_field`, whose helper already uses `upper(range) - 1`).

## Operator rulings this plan implements

1. **Blackouts are in scope.** A loss has an optional end (`until`); a
   retirement is a loss with no end. For affected practices the system
   *recommends* a move, one per affected practice series, each with a one-click
   *enact*. Recommendations are computed **jointly** so no two point at the
   same slot or overlapping ground at the same time. A *decline* releases the
   slot and re-offers it to the next most eligible affected team.
2. **Everything already assigned is locked** — auto, manual, repair, or enacted
   recommendation. Neither the auto-scheduler nor the repair may move or
   re-range it unless an admin accepts an explicit override prompt. An ordinary
   run places only unassigned teams.
3. **Coach preferences** replace the 340-minute question. Coaches *request*;
   only admins approve or change. Per coach, for each of weekday, start time and
   venue: `must_keep` | `prefer_keep` | `dont_care`. The auto-scheduler and the
   repair both honour them.

## 1. `loss.until`, blackouts, and the temporary override

**`repair.js` changes (solver, domain).**
- `loss` gains optional `until` (ISO date, `until >= from`) and optional
  `startMinutes`/`endMinutes` (both or neither — blackouts carry them,
  `field_blackouts.sql:59-64`). Today `loss` is `{surfaceIds, from, reason}`,
  strict (`practice/schemas.js:237-243`).
- *Displaced* = the series range intersected with `[from, until ?? ∞]` holds at
  least one weekday occurrence (reuse `firstWeekdayOnOrAfter`, `repair.js:243`)
  and, when the loss has minutes, the series times overlap them. Placement is
  tested against frozen series over **the window only** (`againstFrozen`,
  `marginal`, `repair.js:333, :398`).
- **A bounded loss does not split the series.** The original assignment stays
  whole and locked; the window gets a temporary **exception**, one per affected
  series-window. Results carry `representation: 'override'` and
  `window: {from, until}`. `repairedPlan` splits around the window in memory
  only, so metrics stay series-based.
- **A retirement (no `until`) still splits**: the row is closed in place at D-1
  and a new row starts at D. An open-ended exception would leave the series on
  retired ground forever and keep the retirement dry-run listing it
  (`20260907000000:346-366`).
- Loss sources: retirement → D = `effective_to` + 1; blackout → `from` =
  `blackout_from`, `until` = `blackout_until`, minutes if set, surfaces = the
  field or every field of the location. `reason` is the blackout's enum value,
  never the free-text `note`.

**New table `practice_exceptions` (persistence).** Columns: `id`,
`organization_id`, `season_settings_id`, `team_id`, `assignment_id` (FK to
`practice_assignments` **ON DELETE RESTRICT**), `window` daterange NOT NULL,
`kind` in (`relocated`, `time_tbd`), `practice_slot_id` (required iff
`relocated`), `tbd_reason` (a `PRACTICE_TBD_REASON` value), `cause_kind` in
(`blackout`, `retirement`), `cause_id`, `run_id`, `created_by`, `created_at`,
`withdrawn_at`, `withdrawn_by`. An exclusion constraint forbids two overlapping
non-withdrawn exceptions on one assignment.
- Why a separate table: the #444 prune keys on `practice_assignments` by
  (team, slot, range) and removes auto rows of teams absent from the payload
  (`20260924000000:509-519`). A temporary move stored as a second assignment
  row would be deleted by the next save, and readers would show both the lost
  ground and the moved practice during the window. The `RESTRICT` FK turns any
  path that deletes an overridden series (the unlocked prune,
  `admin_cancel_practice_assignment`) into a loud 23503, never an orphan.
- Retirement TIME TBD uses the same table: `kind = 'time_tbd'`, window
  `[D, series.until]`.
- Readers (PR 12) expand each row by its own range, then apply exceptions
  within their windows (show the moved practice, or TIME TBD).

## 2. Joint recommendations, enact, decline

**Computation**, one recommendation per affected series-window:
1. **Tier 1, unchanged:** the exact same-venue branch-and-bound
   (`repair.js:384-560`), which already rejects conflicting ground at an
   overlapping time (`marginal`, `:405-410`).
2. **Tier 2, new:** a joint exact search over cross-venue candidates for the
   series tier 1 left TBD, with tier-1 placements as frozen occupants. It
   replaces standalone cross-venue options and `sharedWith`. An enacted
   cross-venue recommendation carries `origin: approved-option` semantics.
3. The rest is TIME TBD with a reason — never dropped.

**Most eligible**, defined from the one objective (`resolve/objective.js`), not
a new ranking. When series S declines shape X: add (S, X) to the declined set
Δ; treat S as TBD at `tbdCost` (the `UNPLACED_GAME` weight, `repair.js:348`).
- *Eligible* T: affected, not enacted, T ≠ S, (T, X) ∉ Δ, durations match,
  `marginal(T, X, R∖{T}, coachDays(R∖{T}))` is not null, T's `must_keep`
  preferences hold, the change budget holds, and X is cross-venue only if T is
  currently TBD (the objective prices a venue change at only
  `changedSurface = 1`, so same-venue-first stays structural, as in 3a).
- `gain(T)` = cost of T's current recommendation (marginal, or `tbdCost` if
  TBD) − `marginal(T, X, …).cost`. Most eligible = highest gain, gain > 0.
  Ties: the search's own order — fewest same-venue candidates, then assignment
  id (`repair.js:388-394`).

**Re-offer chain.** When T moves Y → X, Y is released and the same rule applies
to Y. Each series moves at most once per decline event (visited set V). The
chain stops when no eligible T has gain > 0, every eligible T is in V, or after
|affected| hops; it always terminates because V only grows. Afterwards, if S
was not re-placed, it takes its cheapest admissible free candidate outside Δ
(no new chain), else TIME TBD with new reason `declined`. A declined slot never
returns to S in that session except by an explicit **undo-decline** (removes
(S, X) from Δ and re-runs the rule for X). After any decline the result is
locally repaired, not proven optimal: stamp `PRACTICE_REPAIR_RECOMMENDATION_LOCAL`.
New pure module `practice/recommendations.js`: `declineRecommendation(state, S)`,
`undoDecline`. Deterministic, no DB.

**Enact.** One click per recommendation, following the `approved-option`
precedent: re-judged against a fresh DB snapshot and fingerprint
(`resolve/schemas.js:42-47`); written through the RPC; the series joins the
enacted set and is locked; remaining recommendations are re-validated and any
now inadmissible are released through the chain rule. A retirement enact
re-ranges a locked row, so its confirmation dialog **is** the ruling-2 override
prompt for that assignment.

## 3. Lock everything assigned

**Enforced in the RPC, not only the UI.** `persist_practice_schedule` v3:
- **Default mode is add-only.** Any existing row the call would delete, re-range
  or move — a payload team's missing key, an absent team's auto rows, `closes`,
  withdrawing an exception — refuses with 22023 "assignment X is locked", unless
  its id is in `unlock: [{assignment_id, reason}]`. A new row that double-books
  its team -- a row the team still holds with an overlapping range AND a slot
  on the same weekday at overlapping minutes -- refuses the same way; another
  weekday or a non-overlapping time is an addition and is allowed. (Amended on
  #461 from "an overlapping range": 176 of the 281 (sheet, team) pairs in the
  season-2026 corpus practise on two weekdays over one range.)
- `unlock` requires an org admin (the existing check, `20260924000000:213-217`)
  and writes one `practice.unlock_accepted` audit row per assignment with the
  before-image.
- New column `practice_assignments.assigned_via` in (`auto`, `manual`,
  `repair`, `recommendation`, `override`); `source_enum` stays
  (`definitive_schema.sql:36`).
- #444's `teams_without_practice` stays; in an ordinary save it now names only
  never-placed teams.
- This **reverses #444's default prune**; the prune survives only for unlocked
  rows.

**Payload builder.** `buildPracticeAssignmentRows` (`practiceSupabase.js:219-300`)
takes optional per-assignment `effectiveFrom`/`effectiveUntil`, validated inside
the slot window; absent → today's behaviour; key set unchanged. New placements
start at max(`slot.validFrom`, today on the season clock). The page's
`toPersistenceAssignment` (`PracticeSchedulingPage.jsx:332-338`, called at
:704) carries `id`, `effectiveDateRange`, `assignedVia`.

**Auto-scheduler Edge Function (solver).** Loads the season's current
`practice_assignments` itself, as the user through RLS, and locks all of them;
the client's `lockedAssignments` becomes a cross-check (mismatch refuses the
run). Locked occupancy is a list, so a split team keeps both rows — fixing the
one-slot-per-team collapse (`auto-scheduler/index.ts:128-129`). An ordinary run
places only teams with no row and returns only those placements. Stated
limitation: locked rows consume their slot for the whole season (the Edge
Function has no date model) — never double-books, may under-use a slot.

**Override prompt.** Triggered by an explicit "re-optimise assigned teams"
action (the named global re-optimisation of CLAUDE.md §3), a retirement enact
that closes a row, or withdrawing an enacted exception. Lists per team each
locked row (weekday, time, ground, range, `assigned_via`) and exactly what would
happen to it, then a count of published practices that could change. Unlocks
**per team** (one checkbox each; "select all" only ticks them); the RPC receives
assignment ids, so the unlock is per row. Admin-only (button disabled with a
visible reason, as in #444) and audited.

## 4. Coach preferences

**Table `coach_practice_preferences` (persistence).** `id`, `organization_id`,
`coach_id` (no FK — the `team_coach_assignments` stance, `20260923000000:92-93`),
`dimension` in (`weekday`, `start_time`, `venue`), `level` in (`must_keep`,
`prefer_keep`, `dont_care`), `value` jsonb nullable (weekday code, minutes, or
location id), `status` in (`requested`, `approved`, `rejected`, `superseded`),
`requested_by`, `decided_by` + timestamps, `effective_from`/`effective_to`. One
approved row per (coach, dimension) at a time. **No free text, no PII beyond
the coach id.**
- RLS: admins and the coach themself (`coaches.user_id = auth.uid()`,
  `definitive_schema.sql:415`) read; no write policy. Three definer RPCs:
  `request_coach_practice_preference` (coach or admin),
  `admin_decide_coach_practice_preference` (approve/reject, optionally with a
  changed level/value), `admin_set_coach_practice_preference`. Audit actions
  `coach_preference.requested|approved|rejected|changed`. Zod schemas in core.
- Change-request reuse: a coach request is like a `proposer` change (never
  effective alone); admin approval is the `approved-option` step, **re-judged**
  at approval — the dialog shows which current series a new `must_keep` would
  make unsatisfiable. This is the first persisted coach-originated request
  lifecycle; task #65 can adopt it.

**Semantics — `practice/coachPreferences.js` (core).**
- Reference: the team's current series when it is being moved; otherwise the
  preference `value`; with neither, the dimension does nothing and a finding
  says so.
- Strictest wins across the team's current coaches (`team_coach_assignments`):
  `must_keep` > `prefer_keep` > `dont_care`. Two `must_keep` with different
  values → unsatisfiable.
- `must_keep` is a hard candidate filter; legal candidates before and none
  after → TIME TBD with new `PRACTICE_TBD_REASON.COACH_PREFERENCE = 'coach-preference'`.
- `prefer_keep` is a soft practice-only objective term `coachPreferenceBreached`,
  once per breached dimension, guarded like `changedWeekday`
  (`objective.js:96-108, 307-310`); games can never count it.
- **No preferences ⇒ byte-identical to today.**

**Deno side.** The Edge Function cannot import core (`auto-scheduler/index.ts:12-13`).
A tiny import-free twin `_shared/engines/coach-preferences.ts` (strictest-level
rule and verdict); the Edge loads approved preferences server-side. Cross-arm
test `tests/coachPreferenceDrift.test.js` (the `scoringEngineDrift` precedent)
compares both arms over the **full enumerated product** (3 levels × 3 dimensions
× match/mismatch × 0-3 coaches with every level combination), pins the weight
constant to `RESOLVE_OBJECTIVE_WEIGHTS.coachPreferenceBreached`, and runs under
`scripts/deno-mirror-tests.sh`.

**Retire dead fields** ("never leave a field parsed and unread"): the Edge
`CoachPreferenceSchema` and its `unavailableSlotIds` path
(`_shared/schemas/auto-scheduler.ts:33-39`, `practice-coaches.ts:141`), and
`coaches.preferred_practice_days` / `preferred_practice_window`
(`definitive_schema.sql:421-422`). **Production count 2026-09-24: 0 of 130
coaches hold a value in either** — safe to drop.

The 340-minute trade-off is unchanged for a coach with no preferences; nothing
in 3b changes the default weights.

## 5. Decisions (all resolved 2026-09-27)

| # | Decision | Resolved as |
|---|---|---|
| 1 | `coachPreferenceBreached` weight | **100** (= a compromise) |
| 2 | Venue dimension granularity | **Venue (location) only**, not field |
| 3 | Edge pricing of `prefer_keep` | Lexicographic tiebreak: fewer breaches first among feasible candidates |
| 4 | TIME TBD series in an ordinary run | Excluded; resolved only in the repair panel |
| 5 | Blackout recommendation granularity | One per series-window |
| 6 | Blackout edited/deleted after enactment | Enacted exceptions stay locked, flagged "cause changed"; withdrawn only via the override prompt |
| 7 | `admin_cancel_practice_assignment` under ruling 2 | Stays an explicit admin action counting as its own prompt; withdraws dependent exceptions in the same transaction, audited |
| 8 | Dead preference columns | Drop (prod count 0) |
| 9 | Who reads preferences | Admins and the coach themself |
| 10 | Declines | Not persisted alone; the enact audit records declined pairs |
| 11 | Delete-field arm | Show "retire to repair"; no repair computed for a deletion |

## 6. Witnesses (each enumerated from roster, registry or pre-apply snapshot)

| Guarantee | Test | Plant that must turn it red |
|---|---|---|
| No two recommendations clash | `practiceRecommendations.test.js`, independent clash predicate on `conflictingSurfacesOf` | Drop the tier-2 joint check |
| Decline re-offers to the most eligible | Same; brute-force gain from the objective | Tie-break by assignment id only |
| Decline chain terminates | Adversarial cyclic fixture | Remove the visited set |
| No declined slot back without undo | Same | Clear Δ inside the chain |
| Occurrences outside a blackout unchanged | Adapter test, every snapshot row expanded before/after | Split instead of exception |
| Every displaced series-window appears once | Adapter test, displaced set from snapshot × windows | Drop one TBD entry |
| The lock | pgTAP/dbharness: ordinary save omitting an existing row refuses | Remove the lock check |
| Unlock is per row | pgTAP | Unlock by team |
| Unlock admin-only and audited | pgTAP | Remove `is_org_admin`; remove the audit call |
| Edge never moves a locked team | `autoSchedulerLock.test.js` over every loaded row | Rebuild the Map keyed by team |
| Exception survives a later save | pgTAP | Store the exception as an assignment row |
| Cancelling an overridden series is loud | pgTAP | FK → CASCADE |
| `must_keep` hard → `coach-preference` TBD | Roster-enumerated fixtures | Filter → penalty |
| Strictest wins | Exhaustive enumeration | First coach's setting |
| Arms agree | `coachPreferenceDrift`, full product | Flip one twin cell |
| No preferences ⇒ byte-identical | Season-2026 sweep + drift-0 control | Default nonzero breach count |
| Approval admin-only | pgTAP: coach approving refuses | Relax the decide RPC |
| No PII in preferences | Schema test refuses free-text keys | Allow `note` |

## 7. PR sequence (S = solver, D = domain, P = persistence)

| # | PR | Touches | Size |
|---|---|---|---|
| 1 | Preferences domain + persistence: table, RPCs, RLS, audit, revert/smoke/pgTAP/plants; `practice/coachPreferences.js` + schemas + tests | D, P | ~750 |
| 2 | Preferences UI: coach request, admin approve/change; mock handlers | — | ~600 |
| 3 | `repair.js`: `loss.until` + minutes, override representation, window placement | S, D | ~750 |
| 4 | Preferences in repair + `coachPreferenceBreached`; fixture sweep | S, D | ~600 |
| 5 | Tier-2 joint search + `practice/recommendations.js` | S | ~800 |
| 6 | Writer v3: lock-by-default, `unlock`, `closes`, `assigned_via`, `practice_exceptions`, fingerprint, `teams_time_tbd`; cancel RPC withdraws exceptions (may split off, ~250); Edge passthrough; per-row ranges | P | ~1,300 (LESSONS #11 full-function copy) |
| 7 | Auto-scheduler lock: server-side load, list occupancy, unassigned only, page payload | S, P | ~700 |
| 8 | Deno preference twin + drift test; retire dead fields | S, D | ~500 |
| 9 | Adapter: DB rows → repair input; result → RPC payload | D | ~750 |
| 10 | Read-only recommendation panel (retire + blackout) with decline/undo; retire `repairProposal()`; flip the unwired pin; remove `PRACTICE_REPAIR_UNWIRED` | — | ~800 |
| 11 | Enact + override prompt, admin-only | P path | ~600 |
| 12 | Readers apply exceptions | P reads | ~400 |

Order: **1 → (3 ∥ 6) → 4 → 5 → 7 → 8 → 9 → 10 → 11 → 12**; 2 any time after 1;
12 any time after 6.

**Cross-plan sequencing with 8.9** (`docs/PHASE_8_9_PLAN.md`): both touch the
auto-scheduler Edge Function (3b PR 7, 8.9 PR 6) and `repair.js` (3b PRs 3-5,
8.9 PR 7). Land 3b PR 7 before 8.9 PR 6, and 3b PR 5 before 8.9 PR 7. Every new
migration takes a timestamp later than every migration on `main` at merge time.

Every PR: `/code-review` before opening; the season-2026 fixture suite when it
touches domain types, constraints or solver stages; each new guarantee shown red
by its plant.
