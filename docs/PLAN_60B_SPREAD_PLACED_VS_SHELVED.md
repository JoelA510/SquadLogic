# Plan: #60b, weigh a spread-refused slot against the TIME TBD it causes

Status: **APPROVED 2026-10-12.** Docs only; no code changes.

Operator decision (2026-10-12): **option (b).** Before the rule gate refuses a
slot for `CONFLICT_SPREAD_EXCEEDED`, compare the spread if the game is placed
there against the spread if the game is shelved as TIME TBD. Admit the slot,
with a warning, when shelving is no better.

Evidence labels used below, per CLAUDE.md: _read_ (statically reviewed),
_executed_ (run, output quoted), _test-verified_ (a committed test asserts it).

---

## 0. Headline: option (b) recovers none of the four sweep TIME TBDs

The four TIME TBDs from #519's 679-run sweep (#51, #57, #649, #652;
`docs/PHASE_8_PROGRESS.md:7448-7450`) are **not** this case. All four are the
opposite case: shelving the game is strictly better for the spread than any
slot the facility admits. Option (b) refuses those slots too, so all four stay
TIME TBD. See §2 for how this was measured and §2.3 for what does cause them.

Option (b) is still worth doing. It fixes the case pinned in
`tests/ruleGate.test.js:911-951`, where refusing the slot costs a kickoff and
does not protect the bound. But it should go ahead knowing it does not touch
the sweep's four. Across the whole sweep it changes 0 candidate verdicts
(§2.4), so on the corpus it is behaviour-neutral. Q1 in §13 asks whether the operator wants those four
addressed separately.

---

## 1. Current behaviour (_read_)

### 1.1 Where the spread is measured

| What                                                                                                                                           | Where                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Gated codes include `CONFLICT_SPREAD_EXCEEDED`                                                                                                 | `packages/core/src/resolve/ruleGate.js:101-105`                     |
| Groups a move can touch (the game's coaches' teams, from the roster)                                                                           | `ruleGate.js:313-328` `spreadGroupsTouchedBy()`                     |
| Spread instances: `conflictFairnessRule.evaluate()` over every roster team of those groups, every commitment projected, then the waiver ledger | `ruleGate.js:351-419` `conflictSpreadInstances()`                   |
| A commitment to a game absent from `state.games` projects to `null` and is dropped                                                             | `ruleGate.js:193-210`, the `return null` at `:200`                  |
| "Fewer groups examined than asked" throws                                                                                                      | `ruleGate.js:388-393`                                               |
| The spread arm in the per-candidate gate                                                                                                       | `ruleGate.js:521-528`                                               |
| Governing record: `conflict-fairness`, `HARD`, `maxConflictSpread: 1`, `waivable: false`                                                       | `constraints/adapters/season2026Constraints.js:399`, `:401`, `:416` |

An instance is `CONFLICT_SPREAD_EXCEEDED|<groupLabel>`, valued at the group's
**excess**: `spread − maxSpread` (`ruleGate.js:405-406`). A group within the
bound has no instance, which reads as excess 0.

### 1.2 What the placer accepts

`acceptedSpreadFor()` (`packages/core/src/resolve/stages.js:244-259`) builds the
accepted record for one game. For each touched group it takes the larger of:

1. the excess the published schedule carried (`context.baselineSpread`,
   recorded once by `recordBaselineSpread()`, `stages.js:972-980`);
2. the excess **with this game back on its published slot**, everything else
   where `state` has it.

A third term, "the excess with this game absent", does not exist. That is the
gap option (b) fills.

### 1.3 Where the refusal happens

In `chooseSlot()` (`stages.js:588-743`):

- `spreadAccepted` is measured once per call (`:642-645`), because no
  candidate changes `state`.
- `acceptedRules` merges it with the pair-keyed record (`:646-648`).
- `ruleGrown = newBlockingCodes(ruled.instances, acceptedRules)` (`:654`).
- **Pass 1 refusal** (`:655-665`): any grown code other than an overlap alone,
  when pass 2 is enabled, is refused and counted in
  `context.ruleGateRefusals[gameId]`.
- **Pass 2 pool** (`:687-716`): only candidates refused for
  `TRAVEL_COMMITMENTS_OVERLAP` _alone_. A candidate that grows the spread never
  enters it, which is Q1 of #60 ("refused in both passes").
- **Pass 2** (`:721-742`): the fewest new overlaps, then score.

`evaluateCandidate()` (`stages.js:770-818`) asks the same three questions for a
slot somebody else chose. It uses the same `acceptedSpreadFor()`
(`:777-780`). It is read by `change-request-apply` (`stages.js:1091`), the
cross-venue options pass (`relocationOptions.js:143`) and the scenario
proposer's probe (`relocationOptions.js:321`).

### 1.4 What happens to a game every slot refuses

`initial-assignment` shelves it (`stages.js:1402-1440`). The move is
`MOVE_KIND.TIME_TBD` and the finding is `RESOLVE_GAME_TIME_TBD`. The reason
names the rule-gate refusal counts, for example
`2 for CONFLICT_SPREAD_EXCEEDED`.

`verify` then calls `reportConflictSpreadCarried()` (`stages.js:1666`,
`:1843-1866`). It warns `RESOLVE_CONFLICT_SPREAD_CARRIED` (compromise) for every
group whose finished excess is above the baseline. The schedule it reads is the
one where the game is shelved.

### 1.5 The pinned edge case (_test-verified_, `tests/ruleGate.test.js:911-951`)

- The synthetic group SYN holds two teams. One has 2 synthetic conflicts. The
  other has exactly 1, carried by game #564. Spread 1, excess 0.
- #564 is displaced. Both of its facility-admitted slots overlap nobody. On
  either slot the team drops to 0 conflicts and the spread becomes 2
  (excess 1, above the accepted 0).
- Both are refused in pass 1. The pass-2 pool is empty, so #564 is shelved.
  The reason contains `\d+ for CONFLICT_SPREAD_EXCEEDED`.
- Shelving also drops that conflict, so SYN finishes at spread 2 anyway, and
  `RESOLVE_CONFLICT_SPREAD_CARRIED` names SYN.

The test comment calls this "declared, not fixed: the gate does not weigh a
slot against the TIME TBD outcome". Executed on main at `55c6b16`:
`tests/ruleGate.test.js` and `tests/ruleGateWaivers.test.js` pass, 55/55.

---

## 2. Measurement: the sweep's four TIME TBDs (_executed_)

### 2.1 Method

I wrote a read-only classifier (in the session scratchpad, not committed). It
imports `packages/core/src` directly and writes nothing to the repository.
For each game it does the following:

1. It replays the sweep workload exactly as `displace()` in
   `tests/ruleGate.test.js:118-139` does. That means:
   - pin the first same-date, same-venue, same-format game at another kickoff
     onto the displaced game's slot;
   - freeze everything except that date;
   - `holdChanges: true`.
2. It confirms the game ends TIME TBD, and checks that no other game moved
   apart from the requested one.
3. It rebuilds the state the placer judged: the finished schedule with the
   game absent.
4. It asks the gate's own exported functions about that state:
   `spreadGroupsTouchedBy`, `conflictSpreadInstances`, `checkPlacement`,
   `candidateSlotsFor` and `ruleGateInstances`. From these it computes, per
   touched group:
   - `accepted` = max(baseline, home), today's record;
   - `shelved` = the excess with the game absent;
   - for every candidate: the facility verdict, today's grown codes, and the
     grown codes with the accepted record raised to max(accepted, shelved),
     which is option (b).

### 2.2 Result

All four have the same shape:

| Game | Requested | Touched groups | Baseline / home / **shelved** excess | Facility-admitted candidates | Excess placed there | Grown today      | Grown under (b)  |
| ---- | --------- | -------------- | ------------------------------------ | ---------------------------- | ------------------- | ---------------- | ---------------- |
| #51  | #43       | U06, U08       | 0 / 0 / **0**                        | 2 of 21                      | U06 1, U08 1        | spread + overlap | spread + overlap |
| #57  | #43       | U06, U08       | 0 / 0 / **0**                        | 2 of 21                      | U08 1               | spread + overlap | spread + overlap |
| #649 | #633      | U06, U08       | 0 / 0 / **0**                        | 2 of 21                      | U06 1, U08 1        | spread + overlap | spread + overlap |
| #652 | #633      | U06, U08       | 0 / 0 / **0**                        | 2 of 21                      | U08 1               | spread + overlap | spread + overlap |

The other 19 candidates per game are `OCCUPIED_SAME_SURFACE`. Each game's
TIME TBD reason matches what the run reported:
`2 for CONFLICT_SPREAD_EXCEEDED, 2 for TRAVEL_COMMITMENTS_OVERLAP`. Each run
moved no game besides the requested one, and none raised
`RESOLVE_CONFLICT_SPREAD_CARRIED`, because shelving left every group within
the bound.

**Answer: 0 of 4 are the option (b) case.** In each, placing would grow excess
from 0 to 1 and shelving leaves it at 0. Shelving is strictly better for the
bound, so (b) refuses exactly as today.

### 2.3 What causes the four instead

Every facility-admitted slot double-books a coach. Under #61 that alone would
be admitted in pass 2, and before #519 it was: TIME TBD 0 -> 4
(`PHASE_8_PROGRESS.md:7449`). The overlap **is** a new coach conflict for both
teams of the pair, so the same slot also grows U06/U08's spread. Q1 of #60
refuses spread growth in both passes, so the pass-2 pool is empty. These are
the cost of Q1 meeting #61, not of the gate failing to compare against TIME
TBD. §13 Q1 asks whether the operator wants that revisited.

### 2.4 Whole-sweep exposure of option (b) (_executed_)

The same classifier was run over every game: 679 runs, 0 skipped for a
missing partner, 4m52s.

| Measure                                                                                                     | Value                                               |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Runs                                                                                                        | 679                                                 |
| Runs ending TIME TBD                                                                                        | 4: #51, #57, #649, #652, the same set #519 reported |
| Runs where any game moved besides the requested and the displaced one                                       | 0                                                   |
| Facility-admitted candidates the gate refuses today with `CONFLICT_SPREAD_EXCEEDED` among their grown codes | 52                                                  |
| Of those, candidates whose grown codes change under (b)                                                     | **0**                                               |

So on the corpus's displacement workload option (b) admits no new candidate.
It cannot change any run's placement, and the sweep is expected to be
byte-identical to main.

Limits of the method:

- It examines the displaced game only. With 0 other moves, that is every game
  the placer handled in those runs.
- It rebuilds the placer's accepted records from the exported pieces; it does
  not call the private `acceptedBlockingFor` and `acceptedRulesFor`. The repair
  scope is empty in this workload, so they reduce to the same
  `acceptedAtSlot()` call.
- It does not emulate scoring. With 0 flips, scoring has nothing to decide.

The implementation PR must still measure the sweep main -> branch (§10). The
classifier is a prediction, not the proof.

The corpus therefore cannot exercise (b) at all. The only witnesses that reach
it are synthetic (§9), which is why W-b1 is built on `spreadSchedule()`.

---

## 3. The comparison, precisely

**"Spread if shelved"** is `conflictSpreadInstances(context, state, groups)`
with no override, where:

- `state` is the state the placer is judging in. The moving game is already
  absent from `state.games`, because a pending game always is
  (`applyMove()`'s guarantee, stated at `stages.js:826-828`).
- `groups` is the **same** list the candidate side uses,
  `spreadGroupsTouchedBy(context, gameId)`. The groups come from the coaches'
  roster teams, not from the game, so the game's absence cannot shrink them.

The game's commitments then project to `null` (`ruleGate.js:200`) and drop out.
Every other commitment and every roster team stays where `state` has it. The
same evaluator, the same team universe and the same ledger are used, so the
two sides differ in one thing only: whether this game stands on the candidate
or nowhere.

**The rule, per group key `k`:**
`placed[k] <= max(baseline[k], home[k], shelved[k])` admits.

In code this is a third term in the accepted record. It is not a second
comparison beside it. It is per group, and counts, not presence, as today.

- **Tie (`placed == shelved > accepted`): admit, with a warning.** This is (b)
  as decided.
- **Placed better than shelved:** admit. If `placed <= accepted` it was already
  admitted silently today. If `accepted < placed < shelved`, (b) admits it with
  the warning.
- **Placed worse than shelved, and worse than accepted:** refuse, as today (§2).
- **Several groups:** every grown key must clear its own floor. A slot that
  lowers U06 but raises U08 past U08's floor is refused, as today's per-key
  contract does (Q4).

**When the floor applies: only when the game is absent from `state.games`.**
The alternative "shelved" exists only for a game that stands nowhere. This is
one condition inside `acceptedSpreadFor()`, and the same condition holds for
every caller:

| Caller                                                            | Game absent?                   | Floor applies?                       |
| ----------------------------------------------------------------- | ------------------------------ | ------------------------------------ |
| `initial-assignment` -> `placePending()` -> `chooseSlot()`        | yes, always pending            | **yes**                              |
| `local-search` (`stages.js:1487`)                                 | no, standing on illegal ground | no; the alternative is staying put   |
| `pair-repair` (`stages.js:1618`)                                  | no, the counterpart stands     | no                                   |
| options pass, trigger `time-tbd` (`relocationOptions.js:143`)     | yes                            | **yes** (parity with the placer, Q5) |
| options pass, trigger `coach-overlap`                             | no                             | no                                   |
| `change-request-apply` judging a proposer slot (`stages.js:1091`) | no                             | no                                   |
| scenario proposer probe (`relocationOptions.js:321`)              | no; every game starts standing | no                                   |

Keying it on absence rather than on a stage or a flag keeps
`evaluateCandidate()` and `chooseSlot()` on one definition of "clears the gate"
(`stages.js:752-755`). It also means no caller can reach the floor for a
standing game.

---

## 4. Which passes change

There is **one accepted record**, so both passes read the floor. There is no
pass-specific branch.

- **Pass 1:** a tie candidate is no longer refused for the spread. If nothing
  else grew, it is scored with the others. "No rule term in the score" stays
  true (`stages.js:670-673`), because an admitted candidate's rule instances
  do not exceed what the slot accepts.
- **Pass 2:** a candidate whose spread growth is within the floor but which
  adds an overlap is now refused for the overlap _alone_. So it enters the
  pass-2 pool. This is what (b) literally says ("before refusing"), and it is
  why Q2 asks the operator to confirm it.

---

## 5. Reason codes

- **Reuse `RESOLVE_CONFLICT_SPREAD_CARRIED`** (`resolve/reasonCodes.js:254`,
  compromise) for the group-level warning. It is already emitted from the
  finished schedule, independent of `verify`. A floor-admitted placement grows
  the group past baseline, so it fires with no new code. Two changes:
  - Its message (`stages.js:1854`) says growth "came from a move the gate does
    not judge". That becomes false, so it gains a third source.
  - Its JSDoc (`reasonCodes.js:243-253`) says the placer "refuse[s] it in both
    passes". It gains the same caveat.
- **Add one per-game code: `RESOLVE_SPREAD_ADMITTED_NO_WORSE_THAN_TBD`**
  (compromise). The group warning names no game, but the operator needs to
  know _which_ placement was admitted under (b). It is emitted in
  `placePending()` beside `RESOLVE_GAME_REPLACED`. Its details are `gameId`,
  `slot`, `groups` (each with `placedExcess`, `shelvedExcess`,
  `acceptedExcess`), and `tie: boolean`.
  - `chooseSlot()` returns the admitting groups on the chosen candidate, as
    `viaOverlapFallback` is returned today (`stages.js:736-742`). It is not re-derived
    from a string.
  - `RESOLVE_REASON_SEVERITY` gains the entry. Any exhaustive code table the
    tests hold gains it too.
  - Q3 asks whether one code (reuse only) is preferred.
- **New counters on `ledger.meta`:**
  - `spreadShelvedFloorsMeasured`: once per `acceptedSpreadFor()` call that
    took the floor;
  - `spreadAdmittedByShelvedFloor`: once per chosen placement the floor
    admitted.

  These are the meta-assertions' subjects (§9).

---

## 6. The waiver ledger and Q3 (`conflict-fairness` unwaivable)

- The floor goes through the same `conflictSpreadInstances()`, which reads the
  ledger before severity (`ruleGate.js:394-417`). The placed, home and shelved
  terms are therefore all judged the same way, and a waiver cannot cover one
  side and not the other.
- Under the season record (`waivable: false`) the ledger never changes a
  spread instance. Option (b) is **not a waiver**. It suppresses no finding.
  `verify` still reports the group's `CONFLICT_SPREAD_EXCEEDED` as a new
  violation, exactly as it does today when the game is shelved. Q3 of #60
  stands untouched.
- The "declared, not enforced" note in `ruleGate.js:66-69` (the carried warning
  reads post-ledger instances) extends to the new per-game code unchanged.

---

## 7. Determinism, minimal diff, maximum freeze

- **Determinism.** The floor is a pure function of `state` and the touched
  groups. It is measured once per `chooseSlot()` call, as `spreadAccepted` is
  today. Candidate order (`candidateSlotsFor`) and the tie-break are unchanged.
  The same input gives the same output (witness W-b8).
- **Maximum freeze.** The floor applies only to a game that is already pending.
  - It never decides that a standing game must move.
  - It never lifts a game.
  - It is never consulted by `local-search` or `pair-repair`.
  - Frozen games are untouched, because `mayMove()` and the freeze audit are
    unchanged.
- **Minimal diff.** The direct effect turns some TIME TBDs into placed games;
  the family sees a time instead of "TBD". There is one side effect: in a run
  where the game was placed anyway, a newly admitted tie slot may score lower
  than the slot chosen today, which changes _which_ slot it gets. On the
  corpus that happens 0 times (§2.4).
- **Order sensitivity, declared.** With several pending games in one group,
  game A's floor is measured with game B also absent, because that is `state`
  at that moment. The placed side is measured in the same state, so the
  comparison is consistent. But a different placement order could admit
  differently. The order is the existing one, so this is deterministic and not
  new, but it is recorded in §10.

---

## 8. Edge / Deno twin parity (_read_)

There is **no Deno twin of the resolve gate.** A grep of `supabase/` for
`conflictSpread`, `CONFLICT_SPREAD`, `conflict-fairness`, `maxConflictSpread`,
`ruleGate`, `chooseSlot` and `GATED_RULE_CODES` matches 0 files.
`supabase/functions/auto-scheduler/index.ts` is the practice/initial scheduler.
Its "TIME TBD" is the daylight remainder (D8), not a resolve placement, and it
has no spread or overlap gate. `#60`'s plan left this "not examined"
(`PLAN_60_62_GATE_GAPS.md:505-506`). It is now examined, and nothing needs to
stay in parity. If a twin is ever written, it inherits this contract.

---

## 9. Witnesses and plants

Each "red-first" witness must fail on `main` before the fix. Each "guard"
witness passes on `main`, and it is listed with the plant that must turn it
red. Every plant is applied locally and its failing assertion is quoted in the
PR, per CLAUDE.md.

All of them live in `tests/ruleGate.test.js` beside the existing #60 blocks,
unless noted, and reuse `spreadSchedule()` / `displaceOn()`.

**Red-first**

- **W-b1. The pinned case flips** (rewrite of `ruleGate.test.js:911-951`).
  - #564 is placed on one of its two clean slots, not shelved.
  - `ruleGateRefusals` for it has no `CONFLICT_SPREAD_EXCEEDED`.
  - `RESOLVE_CONFLICT_SPREAD_CARRIED` still names SYN at spread 2.
  - One `RESOLVE_SPREAD_ADMITTED_NO_WORSE_THAN_TBD` names #564, SYN,
    `placedExcess: 1`, `shelvedExcess: 1`, `tie: true`.
  - **Fails on main:** `whereIs(run, X)` is `null`.
- **W-b2. The same verdict from verify either way.** For W-b1's schedule,
  `verify`'s `CONFLICT_SPREAD_EXCEEDED` violation for SYN has the same instance
  key and excess as `main`'s shelved run. This proves (b) changes the kickoff,
  not the bound's verdict.
  - The assertion has two clauses: #564 is placed, and SYN's verify instance
    equals a literal taken from main's shelved run (key and excess 1).
  - **Fails on main:** the first clause, because the game is unplaced. The
    second clause alone would pass on main; it is the half that pins "(b)
    changes the kickoff, not the bound's verdict".
- **W-b3. The options pass agrees with the placer.** Call
  `evaluateCandidate()` on a state where the game is absent and the slot ties
  shelving.
  - Expected: `cleared === true` and `spreadAdded === 0`.
  - **Fails on main:** `ruleGrown` contains the spread code.
- **W-b4. Tie plus overlap goes to pass 2** (only if Q2 = yes). Use a SYN
  variant whose only clean-for-spread slot also double-books a coach.
  - Expected: it is placed with `viaOverlapFallback`, and
    `overlapFallbackEntered === 1`.
  - **Fails on main:** the game is shelved.
  - If Q2 = no, the expectation inverts and the witness becomes a guard.

**Guard**

- **W-b5. Shelving strictly better: still refused.** Displace #51 on the real
  season. It stays TIME TBD with
  `2 for CONFLICT_SPREAD_EXCEEDED, 2 for TRAVEL_COMMITMENTS_OVERLAP`, and the
  new per-game code is absent. This is §2's measurement, made a test.
  - Plant: admit when `placed <= shelved + 1`, or drop the `placed` side and
    always admit. Turns it red.
- **W-b6. A standing game gets no floor.** Build a proposer probe
  (`createPlacementProbe`) over W-b1's schedule. The same #564 slot is
  `cleared === false`, because #564 stands.
  - Plant: take the floor unconditionally (drop the `state.games[gameId] ===
undefined` test). Turns it red.
- **W-b7. Ties admit; a strict comparison would not.** This is W-b1 itself.
  - Plant: `<` in place of `<=` (admit only strictly better). Turns W-b1 red.
- **W-b8. Floor measured with the game absent, not at home.**
  - Plant: compute the floor with the published-slot override (which
    duplicates the `home` term). Turns W-b1 red, because the floor then reads 0.
- **W-b9. The floor goes through the ledger** (`tests/ruleGateWaivers.test.js`).
  Use W14's custom registry where `conflict-fairness` is waivable and a waiver
  covers SYN. The placed and shelved sides both read 0, and no per-game code is
  emitted.
  - Plant: read the floor from the raw `conflictFairnessRule.evaluate()`
    subjects, skipping `waivedSubjects()`. Turns it red (a spurious per-game
    code).
- **W-b10. The floor does not replace the record, it raises it.** Covered by
  the existing W2 (baseline over, displacement leaves it equal, placed).
  - Plant: `accepted = shelved` instead of `max(...)`. Expected red on W2.
    That expectation is unproven, and the PR must show it.
- **W-b11. Determinism.** Run W-b1 twice and require deep equality of
  `schedule`, `unplaced` and `findings`.
  - Plant: iterate the touched groups from a `Set` of insertion-dependent
    order in the floor. It may not redden. If it cannot be made to fail, it is
    recorded as an unfalsifiable guard, not counted.

**Meta-assertions**

- **M-b1.** In W-b1, `spreadShelvedFloorsMeasured >= 1` and
  `spreadAdmittedByShelvedFloor === 1`.
  - Plant: compute the floor over `[]` groups. Both counters fail, and W-b1
    fails.
- **M-b2.** The floor's `groupsExamined` equals the touched-group count. This
  is the existing throw at `ruleGate.js:388-393`, re-used rather than
  duplicated.
  - Plant: pass a label the roster does not hold. It throws (production
    reachable, as #519's fix).
- **M-b3.** Across the 679-run sweep the PR quotes
  `spreadShelvedFloorsMeasured` summed. Zero would mean the floor never ran on
  the corpus, which would be a loud fail of the measurement, not a pass.

---

## 10. Season fixture and digest impact, and how it will be verified

**Expected:**

- **Rule-engine digest** (`runRuleEngine` over season-2026): unchanged. The
  rule engine is not touched.
- **No-op resolve digest:** unchanged. A no-op run has no pending game, so the
  floor never applies.
- **679-run displacement sweep:** byte-identical to main, 0 of 679 runs
  differing. The prediction is from §2.4: 0 of 52 spread-refused candidates
  change verdict. The 4 TIME TBDs stay.
- **Fixture suite** (`fixtures/season-2026/`): the full suite plus
  `tests/ruleGate.test.js`, `tests/ruleGateWaivers.test.js`, the resolve suites
  and the scenario/relocation suites, all green. The only expected test edit is
  W-b1 replacing the pinned expectation.

**Verified by:**

1. The sweep (the `displace()` workload over all games), run on main and on
   the branch. Each run's `schedule`, `unplaced` and `findings` are hashed,
   and the PR quotes the count of differing runs and lists each by id.
2. The classifier flags no run, so any differing run fails the PR until it is
   explained.
3. The rule-engine and no-op digests are quoted as equal.

---

## 11. Declared, not enforced (after this PR)

- **The four sweep TIME TBDs remain** (§2). They are overlap-induced spread
  growth, refused in pass 2 by #60 Q1. Option (b) does not reach them.
- **Placing at a tie does not protect the bound.** Neither does shelving. The
  group still breaches `maxConflictSpread`, and `verify` still reports it.
  Option (b) chooses the kickoff over a TIME TBD that would not have helped.
- **The floor is spread-only.** The turnover arm has no "shelved" analogue,
  because shelving a game never creates a turnover shortfall, so none is
  needed. The overlap arm has pass 2 instead.
- **Order sensitivity across pending games** in one group (§7). It is
  deterministic and unchanged in kind, but the comparison is local to the
  placement order.
- **A floor-admitted game is not offered cross-venue options.** Only
  `time-tbd` and `coach-overlap` trigger the options pass
  (`relocationOptions.js:97-118`), unless Q5 extends it.
- **Standing games never get the floor.** `local-search` and `pair-repair`
  keep refusing tie slots. Their alternative is the game staying put, not
  TIME TBD, so this is by design, not an omission.

---

## 12. Size estimate

- **Production:** about 30-45 lines.
  - `acceptedSpreadFor()`: the third term behind the absence test, plus the
    per-group detail returned.
  - `chooseSlot()`: carry the admitting groups on `best` and on the pass-2
    pick.
  - `placePending()`: one finding.
  - `reasonCodes.js`: one code and one severity entry, plus doc text.
  - `reportConflictSpreadCarried()`: message text.
  - Two ledger counters (`reasonCodes.js:536-539`, `types.js:351-352`).
- **Tests:** about 180-260 lines across `tests/ruleGate.test.js` and
  `tests/ruleGateWaivers.test.js`.
- **Docs:** this plan's answers section, `PHASE_8_PROGRESS.md`, `CHANGELOG.md`.
- **One PR** (`fix/60b-spread-placed-vs-shelved`). It touches the solver, so it
  needs `/code-review` before opening and the full fixture suite.

---

## 13. Questions for the operator

**Q1. The sweep's four TIME TBDs (#51, #57, #649, #652) are not fixed by (b).
Leave them as #60 Q1 decided, or open a separate question?** In each, the only
free slots double-book a coach, and the overlap itself grows the spread from
excess 0 to 1. Shelving leaves 0.
_Recommendation (not an answer):_ leave them. They are Q1 working as decided.
Shelving really is better for the bound there, and #61 allowed overlaps only
as a last resort. If kickoffs matter more than the spread in that shape, that
is a change to Q1, not to (b), and it deserves its own plan.

**Q2. Should the floor also apply in pass 2? That is, a slot whose spread
growth ties shelving but which adds a coach overlap would enter the
overlap-fallback pool.**
_Recommendation (not an answer):_ yes. (b) says "before refusing", and the
accepted record is shared by both passes. Excluding pass 2 would need a
pass-specific branch. It would also refuse a slot that is no worse for the
spread and only carries the overlap #61 already allows as a last resort.

**Q3. Is the new per-game code (`RESOLVE_SPREAD_ADMITTED_NO_WORSE_THAN_TBD`)
wanted, or is the existing group warning enough?**
_Recommendation (not an answer):_ add it. The group warning names no game. An
operator reviewing a run needs to see that this game was placed despite a
spread breach and why. The cost is one code and one finding.

**Q4. With several touched groups, must every group clear its own floor (per
group), or is the sum of excess over the touched groups compared?**
_Recommendation (not an answer):_ per group. It matches the existing per-key
contract (`grownInstances`). A sum would let one age group's fairness pay for
another's.

**Q5. Should the cross-venue options pass use the same floor for a `time-tbd`
game, and should a floor-admitted game be offered cross-venue options the way
an overlap-fallback game is?**
_Recommendation (not an answer):_ the first yes, for parity. With the absence
test it comes free, and W-b3 witnesses it. The second no, for now. It widens
#53's trigger set and its output on every affected run. It can follow if
operators ask for alternatives to a tie placement.

**Q6. At a strict improvement (`accepted < placed < shelved`), should the
placement also carry the per-game warning, or only at an exact tie?**
_Recommendation (not an answer):_ warn in both. The placement still grows the
group past what it stood at with the game home, so the operator should see it.
`tie: false` in the details distinguishes the two.

---

## 14. Operator answers (2026-10-12)

The operator said: "Follow your recommendation on the 60b plan". Every
question is approved as recommended.

- **Q0 (supervisor), approved:** build (b), at low priority, after 11d.
- **Q1, approved as recommended:** leave the 4 TIME TBDs as #60 Q1 decided.
- **Q2, approved as recommended:** the floor also applies in pass 2.
- **Q3, approved as recommended:** add
  `RESOLVE_SPREAD_ADMITTED_NO_WORSE_THAN_TBD`.
- **Q4, approved as recommended:** each group must clear its own floor.
- **Q5, approved as recommended:** the options pass uses the floor; no extra
  cross-venue options.
- **Q6, approved as recommended:** warn on both a tie and a strict
  improvement, with `tie` in the details.
