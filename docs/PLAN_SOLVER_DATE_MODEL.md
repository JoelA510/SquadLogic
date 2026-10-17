# Plan: M4.8, a date model for the auto-scheduler's solver

Status: **PROPOSED, awaiting the owner's approval** (§11). No code until it is
approved (`AGENTS.md` rule 14: the solver).
Remediation plan item M4.8
(`docs/audits/2026-10-production-readiness/remediation-plan.md`). It finishes
what M4.7 (`docs/PLAN_SCORING_DATE_MODEL.md`, approved and built) did for the
evaluators, in the one place that decides placements. To be built by one PR,
`fix/solver-date-model`.

Evidence labels, per `AGENTS.md` rule 4: _read_ (statically reviewed),
_executed_ (run, output quoted), _test-verified_ (a committed test asserts it).
Everything in §1 is _read_ on `main` at `cab8ce1` unless marked otherwise; line
numbers are from that commit.

---

## 0. Headline

The solver still reduces every weekly slot to **one instant**, its first
occurrence, for both of its hard constraints, and holds every locked row for
the **whole season**. Measured on today's solver (§2):

- **It double-books a coach (M4.7's W4 shape).** Two Tuesday 16:00 slots, one
  valid from 2026-08-10 and one from 2026-09-01, and two teams sharing one
  coach: the solver places one team on each, and its own evaluation reports
  **0 conflicts**. The truth is one clash on **12 Tuesdays** (5 from today,
  2026-10-17). The panel's dated evaluation of the same output finds it
  (`firstDate 2026-10-20`, 5 dates) and its score falls from 1 to 0.85. The
  same happens when one team is locked and the other is placed: the solver
  picks the clashing Tuesday over a free Wednesday.
- **An ended series still blocks its slot and its coach.** A capacity-1 slot
  whose only locked row ended on 2026-09-14 leaves a new team unplaced
  (`no-slot-available`) although the slot is free on every remaining date;
  the same row also blocks its coach on another field at that weekday and time.
- **On the undated season-2026 corpus the dated rule changes nothing.** Over a
  sweep of lock shares 0 / 0.5 / 0.9, seeds 1 / 2 / 3, and two "today"s, every
  one of about 277,000 hard-constraint checks the solver made got the same
  verdict from a dated oracle; the oracle itself is shown able to disagree.

The proposal (§3): the solver judges **dated occupancy**. A new placement is
live on its slot's weekday from `max(slot first date, today)` to the slot's
last date, which is the range the page already writes (`newPlacementRange`).
A locked row is live on its slot's weekday inside its own range and the slot's
validity. Two windows clash for a coach when they share a live date and their
wall windows overlap; a slot is full on a date when its live count there
reaches capacity. The live-date arithmetic is M4.7's
(`practice-live-dates.ts`), and each slot's dates come from the store, as the
daylight pass already reads them, so **the page payload does not change**.
`scoreSchedule` scores dated (Q1), so the solver's objective, its persisted
evaluation and the panel agree.

Production holds **no** practice slots, assignments, exceptions or teams today
(_executed_, §2.4), so no live schedule moves.

---

## 1. What exists today (_read_)

### 1.1 Where the solver compares instants

| Place                                                                           | What it does                                                                                                                    |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `checkHardConstraints` (`practice-coaches.ts:138-152`)                          | refuses when the slot's remaining capacity is 0, or any coach window has `slot.start < a.end && slot.end > a.start`             |
| `TimeWindow` (`practice-coaches.ts:10-15`)                                      | `{ start: Date, end: Date, teamId, slotId }`: the slot's first-occurrence instants, nothing else                                |
| `buildLockedOccupancy` (`auto-scheduler-solver.ts:163`)                         | every locked row takes one unit of its slot and puts its coaches' window in, **season-long** (`:19-20` declares it)             |
| relocations, same function                                                      | a live `relocated` exception holds its target slot the same way, season-wide (11d-0)                                            |
| `generateGreedySeed` (`:436`), `tryMutate` (`:332`), `explainUnplaced` (`:524`) | every seat goes through `admissible` → `checkHardConstraints` (`:107`)                                                          |
| `scoreSchedule` (`:221`)                                                        | calls the scoring engine **undated by construction** (`:238`, M4.7 §11): it strips each slot to `id, day, start, end, capacity` |

The slot instants come from the request (`auto-scheduler/index.ts`, `anchored.rows`,
on the season's clock). Nothing in the search reads a date range.

### 1.2 What the server already knows about dates

- **Each slot's dating, from the store.** The daylight pass loads every run
  slot from `practice_slots` as the caller (`loadVenueDaylight`,
  `practice-daylight.ts:295-314`) and builds a `DaylightSlot`: `firstDate`
  (`valid_from` moved to the slot's weekday) and `effectiveUntil`
  (`valid_until`), the store winning and the body's fallback used only where
  the store is null (`toDaylightSlot`, `:232-250`). That is the page's own
  fallback rule (`normalizePracticeSlot`, `PracticeSchedulingPage.jsx:181-210`).
- **Each locked row's range**: `lock.rows[].effectiveDateRange`, loaded as the
  caller (`practice-lock.ts`), already passed to the solver (`index.ts:479-484`)
  and read today only by the daylight report.
- **Today**: `seasonCalendarDate(Date.now(), season.timezone)` (`index.ts:499`),
  passed to the daylight pass.
- **The new placement's range** is the page's, not the solver's:
  `newPlacementRange(slot, seasonToday)` = `[max(slot.effectiveFrom, today), slot.effectiveUntil]`
  (`PracticeSchedulingPage.jsx:417-424`), shortened to `effectiveUntil` when the
  daylight pass truncated it.

So every input the dated rule needs is already on the server, read from the
store. The remediation item's "the page's auto-scheduler payload (slot
dating)" is not needed (§3.6).

### 1.3 The core twin

`packages/core/src/autoScheduler.js:156` has the same first-occurrence check.
No frontend or Edge file imports `autoScheduler.js` (M4.7 §1.3, re-checked:
_executed_ grep). It is not on any live path (Q6).

---

## 2. Measurement (_executed_)

### 2.1 Method

A scratch Vitest file (in the session scratchpad, copied into `tests/` only to
run and deleted after; not committed) that runs the Edge solver module
(`runPracticeOptimizer`, as `tests/autoSchedulerLock.test.js` does) with seed 42,
300 iterations. Season 2026-08-10 to 2026-11-20, `America/New_York`; "today" is
2026-10-17 unless stated. Truth is counted from the dates by hand.

### 2.2 Witnesses (today's solver)

| Case  | Input                                                                                                        | Solver output                     | Its evaluation | Truth                                                                 |
| ----- | ------------------------------------------------------------------------------------------------------------ | --------------------------------- | -------------- | --------------------------------------------------------------------- |
| W4-S1 | Tue 16:00-17:00 slots `sA` (first 08-11) and `sB` (first 09-01); `T1`, `T2` share coach `c1`; both placeable | `T1->sA`, `T2->sB`                | 0 conflicts    | **1 clash**: 12 Tuesdays from 09-01 (season-start run), 5 from today  |
| W4-S2 | `T1` locked season-long on `sA`; `T2` (same coach) placeable on `sB` or a free Wednesday `sC`                | `T2->sB`                          | 0 conflicts    | `T2->sC`: `sB` clashes with `T1` from 09-01                           |
| E1    | capacity-1 Tue slot `sX`; locked row `[2026-08-10,2026-09-15)` (ended); placeable `N`                        | `N` unplaced, `no-slot-available` | 0              | `sX` free on all 5 remaining Tuesdays: `N->sX`                        |
| E2    | as E1, `N` shares the locked team's coach, only slot `sY` (another field, same Tue 16:00)                    | `N` unplaced, `no-slot-available` | 0              | the ended row holds nothing from today: `N->sY`                       |
| E3    | locked row starting in the future, `[2026-11-02,2026-11-21)`, on capacity-1 `sX`; placeable `N`              | `N` unplaced                      | 0              | `N` from today would share 3 Tuesdays with it: unplaced is right (Q4) |

W4-S1's output, scored by the M4.7 dated engine (each placement ranged
`[2026-10-17,2026-11-20]`): 1 conflict, `firstDate 2026-10-20`, `sharedDates 5`;
`fairnessScore` 1 → 0.85. The persisted run would say "no conflicts" about a
schedule the panel then flags.

E3 is the control: the dated rule must not free a slot for a row that has not
started yet when the new placement would overlap it.

### 2.3 The season-2026 corpus sweep

Input: the M1.2 parity extract (`scoring-parity.season-2026.json`: 132 teams,
142 capacity-1 slots, all season-long, "93 Combined"). The first
`round(share × 142)` of its 142 assignments are locked; every roster team
without a locked row is placeable. Each `checkHardConstraints` call the solver
made was also judged by a **dated oracle** (same weekday, overlapping wall
window, a shared live date; locked rows live season-long, new placements from
`today`), and the two verdicts compared.

| Lock share | Locked rows | Placeable | Placed | Unplaced | Conflicts | Checks (seed 1 / 2 / 3)  | Verdicts that differ |
| ---------- | ----------- | --------- | ------ | -------- | --------- | ------------------------ | -------------------- |
| 0          | 0           | 132       | 132    | 0        | 0         | 9,409 / 18,186 / 9,400   | **0**                |
| 0.5        | 71          | 78        | 71     | 7        | 0         | 17,691 / 17,698 / 17,691 | **0**                |
| 0.9        | 128         | 48        | 14     | 34       | 0         | 13,921 / 13,930 / 20,659 | **0**                |

Each row holds for both `today = 2026-08-10` and `today = 2026-10-17` (the
same counts): 277,170 checks in all. The counts are the same across seeds at
each share; the placements themselves were not compared across seeds.

**The oracle can fail:** run on W4-S1's slots it disagreed with the solver on
301 of 603 checks (for example `T2` on `sB`: undated admits, dated refuses).
Limits: the oracle is mine, written for this measurement; it judges the coach
rule only, since every corpus slot and locked row is season-long and so the
two capacity rules cannot differ there.

So on the undated corpus the dated hard constraint admits exactly what today's
admits, which is the property that keeps the search byte-identical (§6).

### 2.4 Production (_executed_, read-only)

One `SELECT count(*)` per table through the Supabase MCP against
`mmwupqsjkikqzvmdvuzm`, 2026-10-17: `practice_slots` 0, `practice_assignments` 0,
`practice_exceptions` 0, `teams` 0. Nothing was written.

---

## 3. The design

### 3.1 What "live" means (M4.7's rule, reused)

- **A slot's dating** is `{ firstDay, lastDay, startSec, endSec }`: `firstDate`
  and `effectiveUntil` from the run's `DaylightSlot` (store first, body only
  where the store is null, §1.2), as day numbers; the wall window from the
  slot's `start`/`end` read on the season's clock (`toDaylightSlot` already
  makes that reading; it keeps only the end minute today, so it gains the
  start). No `Date` is built for a date (GAP-30).
- **A new placement** is live on the slot's weekday dates in
  `[max(firstDay, today), lastDay]`: `assignmentLiveSpan` with
  `notBefore = today` (`practice-live-dates.ts:55-84`), which is the range the
  page writes.
- **A locked row** is live on `assignmentLiveSpan({ firstDay, lastDay, range })`
  with its stored `effectiveDateRange`: the row's range inside the slot's
  validity. No `notBefore`: a row that started earlier is live from where it
  is; one that has ended has no date from today on, and one that is wholly
  past holds nothing a new placement can meet, because new placements start
  at today.
- **Shared dates**: `sharedLiveDates` (`:87-96`), which is also the weekday
  test (two spans meet only when their first days are a multiple of 7 apart).
- **Capacity**: `peakLiveCount` (`:99-112`) over the slot's occupants, clipped
  to the candidate's span.

The Edge already has these functions and `tests/scoringEngineDrift.test.js`
holds them to core's. The solver imports them; no fourth reader of a
`daterange` is written.

### 3.2 The hard constraint

`TimeWindow` gains the occupant's span (`first`, `last` day numbers) and its
wall window (`startSec`, `endSec`). `checkHardConstraints(team, slot,
coachWindows, slotOccupants, capacity)` refuses a candidate span when:

1. it is empty: the slot has no live date from today on (a new reason, Q3);
2. the slot's peak live count over the candidate's span, with the candidate
   added, would exceed its capacity; or
3. for any coach on the team, an existing window shares a live date with the
   candidate and their wall windows overlap
   (`a.startSec < b.endSec && b.startSec < a.endSec`, so back-to-back is not a
   clash, as today).

Capacity stops being a running counter and becomes the slot's list of
occupant spans; `buildState`, `tryMutate`'s `add`/`remove` and the greedy seed
keep that list as they keep the coach windows today. The search itself (move
types, acceptance, restarts, PRNG draws) does not change.

### 3.3 Locked rows and relocations

- **Locked rows**: one occupant per row, on its own span (§3.1). A row with an
  unreadable range is **held season-long, as today, and reported**
  (`lock.unreadableRange`), never freed (Q2). A row whose span is empty from
  today on is held for nothing and counted (`lock.endedRows`) so the run says
  why a slot it used to block is now offered.
- **Rows outside the run** (slot not among the run's): unchanged, reported.
- **Relocations** (`relocated` exceptions): unchanged, season-wide on their
  target slot, declared (Q5). Over-holding never double-books; dating them
  needs their `window`, which the lock loader does not read yet, and belongs
  with M4.7's exceptions follow-up.

### 3.4 The objective (`scoreSchedule`): dated (Q1)

`scoreSchedule` sends the dated fields M4.7 defined: each slot's `firstDate`,
`lastDate`, `startTime`, `endTime`; each locked row's stored range; each new
placement's `[max(firstDate, today), lastDate]`. The engine then reports
`dateModel: 'dated'`, and the persisted `edgeEvaluation` matches what the panel
shows for the same review.

Trade-off, measured where it can be:

|                                  | Dated (recommended)                                                                                                                                                                                         | Undated (today)                                                                                                                                                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agreement                        | the objective, the hard constraint, the persisted run and the panel all use one rule                                                                                                                        | the search may avoid placements the constraint allows (a false conflict with an ended series costs 0.0225 each), and the persisted run reports conflicts that are not there and misses ones that are (W4-S1: 0 vs 1) |
| The search on the undated corpus | the same scores, so the same moves (C0 neutrality, M4.7 §2.3; §2.3 here)                                                                                                                                    | unchanged                                                                                                                                                                                                            |
| Cost                             | 2.15 ms per evaluation of the 170-row corpus case C1, against 1.28 ms undated (_executed_, 300 calls each, warm): about +0.9 s of CPU over the page's 1,000 iterations, under 0.1 s per 100-iteration yield | none                                                                                                                                                                                                                 |
| What changes                     | `summary.dateModel`, `assignmentRows`, `firstDate`/`sharedDates` appear in the persisted evaluation (M4.7 §11's dated shape)                                                                                | nothing                                                                                                                                                                                                              |

Under the dated hard constraint the search cannot create a coach conflict, so
the conflict term only ever counts conflicts among locked rows, a constant per
run; the objective is then coverage plus a constant, which is what it was
meant to be.

### 3.5 Today

The run's today is the server's `seasonCalendarDate(Date.now(), season.timezone)`,
the value the daylight pass already uses. The response carries it as
`liveFrom`, and the page's `newPlacementRange` uses that instead of its own
clock when it stages the review, so the range written is the range the solver
judged even across midnight (Q7).

### 3.6 What is not changed

- **The page payload.** Slot dating is read from the store on the server
  (§1.2); the page's `effectiveUntil` is already the fallback. No new body
  field, nothing parsed and unread.
- **The lock contract**: every loaded row stays locked, unmoved, unranged;
  the cross-check, TIME TBD exclusion, coach preferences, daylight post-pass
  and its D8 truncation are untouched.
- **Core `autoScheduler.js`** (Q6).

### 3.7 A slot the solver cannot date

A run slot whose first date or end cannot be read (the store holds none and
the body's start and end fall on different dates, the one case
`toDaylightSlot` returns `null` for) **refuses the run** with 422
`SLOT_DATING_UNREADABLE`, naming the slots, as M4.7's mixed-dating refusal
does. The solver never guesses a season for one slot (Q3).

---

## 4. The default-freeze contract under the dated rule

`AGENTS.md`: solver changes default to maximum freeze and minimal diff; global
re-optimisation only when asked for by name. Under M4.8:

1. **Every locked row is frozen**: never moved, removed, re-ranged or
   truncated, whatever its dates. The dated rule only changes how much of its
   slot and its coaches' time a row **holds**: exactly its own live dates.
2. **Nothing before today moves.** A new placement starts at
   `max(slot first date, today)`; a past date can be neither given away nor
   taken, so a published past week is never touched.
3. **Only placeable teams are searched** (no row, no TIME TBD series), as
   today. The dated rule widens their candidate set only by dates no locked
   row is live on, and narrows it only by clashes that are real on a date.
4. **Minimal diff**: on any input where every slot and every locked row is
   live on every date from today to the season's end (the undated corpus),
   the run's placements are **byte-identical** to `main`'s, pinned by a
   committed golden (§5) over the §2.3 sweep. Where they differ, every moved
   placement is explained by a date (an ended row freed a slot, or a
   staggered slot clashed), quoted in the PR.
5. **Never silently dropped**: a team the dated rule leaves without a legal
   slot is unplaced with a reason (`no-slot-available`, or `no-live-date` when
   every slot it could take has ended, Q3), shown on the page as today.

---

## 5. Test gate, witnesses and plants

Every subject set is enumerated from the inputs (the roster, the loaded rows,
the run's slots), never from the solver's output.

- **Node** (`tests/autoSchedulerLock.test.js`, new `describe`): W4-S1, W4-S2,
  E1, E2, E3 from §2.2, plus a slot pair straddling the 2026-11-01 DST change
  (wall windows, not instants), a locked row with an unreadable range (held
  season-long, reported), and a run whose only slot ended before today
  (`no-live-date`). Each shown failing on today's solver first (§2.2 already
  measures W4-S1, W4-S2, E1, E2).
- **Deno** (`_shared/tests/practice-coaches_test.ts`, `practice-lock_test.ts`):
  the same constraint cases against the Deno runtime.
- **The M4.7 guard is inverted**: "the solver scores undated, whatever the page
  sends" (`autoSchedulerLock.test.js:201-243`) becomes "the solver scores
  dated, from the store's dating", with `dateModel: 'dated'` asserted on the
  persisted evaluation.
- **The golden sweep** (`tests/autoSchedulerDatedSweep.test.js`): the §2.3
  grid (3 shares × 3 seeds), placements generated on `main` **before** the
  change and committed as a fixture; the test asserts byte-identical
  placements and literal floors (132 / 71 / 14 placed), so an empty or stale
  golden fails.
- **Wiring** (source pin, `index.ts`): the run passes `liveFrom` and the
  daylight slots' dating to the solver; the response carries `liveFrom`; the
  page's review uses it (beside the existing `newPlacementRange` tests,
  `autoSchedulerLock.test.js:494-508`).
- **Season-2026 fixture suite** (`AGENTS.md`): the `season2026*`, parity and
  drift tests, plus the full `npm run test:coverage`.

**Plants**, each shown caught before the PR opens:

- P1 the locked row's range ignored (E1, E2 go red);
- P2 slot validity ignored (W4-S1, W4-S2);
- P3 `notBefore = today` dropped for new placements (E3 and the ended-slot case);
- P4 capacity counted as rows, not the peak per date (E1);
- P5 an exclusive upper bound where inclusive is meant (a touching-ranges case);
- P6 instants compared instead of wall windows (the DST pair);
- P7 `scoreSchedule` left undated (the inverted M4.7 guard);
- P8 a change in one engine only (Deno and Node disagree).

---

## 6. Season fixture and sweep impact

- **Predicted byte-identical** on the undated corpus: §2.3's 0 differing
  verdicts in 277,170 checks, and M4.7's C0 neutrality for the score.
  The implementing PR executes the golden and quotes it.
- `edgeEvaluation` changes shape for every run (dated fields), which is the
  point of Q1. Runs persisted before and after compare on counts only where no
  series is cut by a range.
- The rule-engine digests and game scheduling are untouched (practice solver
  only).

---

## 7. Declared, not enforced (after the implementing PR)

- **Relocations** hold their target slot season-wide (Q5).
- **No partial placement**: a team whose only free span is shorter than its
  slot's remaining validity (E3's shape, free until a future locked row
  starts) is not placed for the free part (Q4).
- **Core `autoScheduler.js`** keeps the first-occurrence check, with a header
  saying it is not on a live path and is undated (Q6).
- **`today` is the season's calendar date on the server**; a run that straddles
  midnight judges by the date it started.

---

## 8. Size estimate

| Piece                                                                   | Est. LOC |
| ----------------------------------------------------------------------- | -------- |
| `practice-coaches.ts`: dated `TimeWindow`, the check                    | 60       |
| `auto-scheduler-solver.ts`: occupant spans, locked spans, dated scoring | 140      |
| `auto-scheduler/index.ts`: dating, refusal, `liveFrom`                  | 40       |
| Page: `liveFrom` into `newPlacementRange`                               | 10       |
| Tests: Node witnesses, Deno twins, inverted guard, wiring               | 400      |
| Golden sweep test and its fixture generator                             | 120      |
| Golden fixture (generated)                                              | ~1,500   |

About 250 lines of product code and 520 of tests, **one PR**. No migration, no
RPC change; an Edge deploy of `auto-scheduler` and a frontend deploy. Effort M,
as the remediation plan says.

---

## 9. Risks

- **The search moves on real data.** Intended where a date explains it; the
  golden pins the undated corpus, and the PR quotes every moved placement on
  any dated input it measures.
- **CPU.** Dated scoring costs about 1.7× per evaluation (§3.4); the run yields
  every 100 iterations under the free tier's 2 s burst, with headroom.
- **Two clocks.** The server's today and the page's could differ by a day near
  midnight; `liveFrom` (Q7) removes it.
- **An unreadable range freed by mistake.** Held season-long and reported (Q2);
  P1 guards the reading.
- **A field parsed and unread.** Nothing new is read from the body; the dating
  comes from the store's loader the daylight pass already uses.

---

## 10. Rollback

Revert the PR and redeploy `auto-scheduler` and the frontend. No data and no
migration. Runs persisted in between keep their dated `edgeEvaluation`; they
read correctly and nothing recomputes them.

---

## 11. Questions for the owner

**Q1. Does `scoreSchedule` score dated?**
_Recommendation:_ yes. Under a dated hard constraint the undated score
disagrees with the constraint: it penalises placements the constraint allows
next to an ended series, and the persisted run says "0 conflicts" about W4-S1's
clash that the panel then reports. Dated scoring costs about 1.7× per
evaluation (+0.9 s CPU per 1,000-iteration run) and on the undated corpus gives
the same scores, so the same search. The alternative, keeping it undated,
changes nothing in the search but leaves the persisted evaluation wrong
whenever dates matter.

**Q2. A locked row whose stored range cannot be read: hold its slot
season-long and report it, or refuse the run?**
_Recommendation:_ hold and report. It is today's behaviour for every row, so it
never double-books, and refusing would block every run on one bad row the
operator may not be able to fix from the page. The writer refuses such ranges,
so it should not occur.

**Q3. A slot with no live date from today on: never a candidate, and a team
left with none unplaced as `no-live-date`; a slot the solver cannot date at all
refuses the run (422)?**
_Recommendation:_ yes to both. Today such a slot is offered and the page would
stage a range whose start is after its end (_read_, `newPlacementRange`; what
the writer then does is unverified). A separate reason tells the operator the
season's slots have run out rather than that the teams do not fit.

**Q4. No partial placements: a team whose slot is free only until a future
locked row starts (E3) stays unplaced?**
_Recommendation:_ yes, in M4.8. Placing it for the free weeks means a new kind
of range (ending before the slot does) and a TIME TBD remainder, which is the
daylight pass's D8 machinery applied to a new cause; worth its own plan if the
operator wants it.

**Q5. Relocations stay season-wide in M4.8, dated with the exceptions
follow-up?**
_Recommendation:_ yes. Season-wide over-holds and never double-books; dating
them needs the exception's `window` loaded, which is the follow-up's read.

**Q6. Core `autoScheduler.js`: leave undated and declare it, rather than port
the rule?**
_Recommendation:_ declare. Nothing imports it on a live path, and porting a
second solver nobody runs doubles the test surface for no user. Retiring it is
a separate refactor to flag.

**Q7. The response carries `liveFrom` (the server's today) and the page's
review uses it for each new placement's range?**
_Recommendation:_ yes. It makes the range written the range judged; without it
a run started before midnight and reviewed after would write a range one day
narrower than the one the solver checked.

**Q8. A committed golden of the corpus sweep's placements, generated on `main`
before the change?**
_Recommendation:_ yes. "Byte-identical on the undated corpus" is the minimal-diff
promise; a golden makes it a test that fails rather than a number in a PR body.
