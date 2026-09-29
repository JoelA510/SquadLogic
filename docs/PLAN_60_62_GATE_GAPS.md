# Plan: #60 and #62, gaps in the placer's rule gate

**Status:** plan only. No code has changed. Both items touch the solver and the
rule engine, so CLAUDE.md §3 requires operator approval before implementation.

**Evidence levels.** Each claim is marked with one of three labels:

- *read*: statically reviewed at the cited `file:line`.
- *measured*: executed with a read-only scratch script against the season-2026
  corpus, output quoted.
- *estimated*: neither of the above.

No test was run for this plan.

## 0. Correction to the brief

The brief placed the repair gate in `packages/core/src/practice/repair.js`. That
is wrong. `practice/repair.js` imports nothing from `ruleEngine/`. A search for
`fairness`, `CONFLICT_` and `ruleGate` under `packages/core/src/practice/`
returns nothing (*read*). The gate in these issues is the **game** placer's
rule gate, `packages/core/src/resolve/ruleGate.js`, added by #59 / PR #436
(`docs/PHASE_8_PROGRESS.md:5863-5901`). It is called from `chooseSlot()` in
`resolve/stages.js:542`.

Practice repair's lack of any rule-engine check is listed in §5. It is not
part of this plan.

---

## 1. #60: the gate does not check `CONFLICT_SPREAD_EXCEEDED`

### 1.1 Current behaviour (*read*)

**The code and its severity**

| What | Where |
| --- | --- |
| Code defined | `ruleEngine/reasonCodes.js:319` |
| Fallback severity: compromise | `ruleEngine/reasonCodes.js:353` |
| Governing record `conflict-fairness`: `HARD`, `maxConflictSpread: 1`, `waivable: false`, `DECLARED_ONLY` | `constraints/adapters/season2026Constraints.js:396-416` |

Under that record the code is **blocking** (`PHASE_8_PROGRESS.md:5885-5890`,
measured there from engine output).

**The one evaluator**

`conflictFairnessRule` (`ruleEngine/rules.js:1540-1717`) is the only evaluator.
It works in five steps:

1. It groups commitments by person and date (`:1571-1578`).
2. It compares **every** pair on that day (`i < j`, `:1597-1599`) through
   `bookingsOverlapInTime()`.
3. It counts one conflict per (team, game), and only for a team with two or
   more rostered people (`:1639-1643`).
4. It takes the group universe from `schedule.teams`, the roster, not from the
   games (`:1656-1661`).
5. It emits **one subject per group** whose spread (max − min) exceeds the
   maximum (`:1662-1703`).

The violation is aggregate. It names a group and no game.

**The gate does not ask**

- `GATED_RULE_CODES` is `TRAVEL_COMMITMENTS_OVERLAP` and
  `TURNOVER_BELOW_MINIMUM`, nothing else (`resolve/ruleGate.js:60-63`).
- `ruleGateInstances()` evaluates only those two (`ruleGate.js:160-267`).
- `chooseSlot()` refuses a candidate on the facility model
  (`stages.js:565-573`) or on grown gate instances (`stages.js:591-612`).
  Nothing asks about fairness.

**Where spread is seen instead**

- **`verify`** (`stages.js:1565-1655`) diffs rule-engine violation instances
  against the baseline. It reports growth as `RESOLVE_VERIFY_NEW_VIOLATION`.
  That finding is **compromise** whatever the underlying code's severity
  (`resolve/reasonCodes.js:433`). With `verify: false` there is no rule-engine
  run at all (`resolve.js:376`).
- **The objective** charges a blocking violation from a verification
  (`resolve/objective.js:570-575`). The per-candidate score in `chooseSlot()`
  passes no rule term (`stages.js:611-631`), so the charge never reaches slot
  choice.
- **The scenario diff** `blockingByGame()` skips any violation with no game id
  (`scenario/run.js:145-156`). A group-level spread breach is therefore
  invisible to "which games the branch displaces".

**The sibling gates**

- **The facility gate:** `newBlockingCodes(placement.blockingInstanceCounts,
  acceptedBlockingFor(...))` at `stages.js:566-573`. It refuses growth over what
  the published slot already carried, per instance (contract at
  `stages.js:216-236`).
- **The rule gate:** the same comparison against `acceptedRulesFor()` →
  `acceptedAtSlot(context.baselineRules[gameId], …)` (`stages.js:207-214`).
  It is recorded at baseline ingest (`stages.js:892-895`).
- **The standalone rule engine** derives `status` from all findings
  (`ruleEngine/engine.js:623`), so a spread breach makes it `blocked`.

**Answer to the brief's question.** Yes, a repair can return a result the
ordinary path refuses for spread. It happens in three steps:

1. A displaced game is placed by pass 1, or by the #61 pass-2 overlap fallback
   (`stages.js:600-603`, `:632-650`), into a slot that adds a coach conflict.
2. That conflict pushes its age group's spread from 1 to 2.
3. The gate admits the slot. `verify` reports a compromise. The standalone
   `runRuleEngine` over the same schedule reports a **blocking**
   `CONFLICT_SPREAD_EXCEEDED`.

With `verify: false`, nothing in the run names it.

### 1.2 Failing scenario (synthetic)

**Setup**

- Group `U10G` has teams T1, T2 and T3. Each has two rostered people, so each
  is eligible for a conflict.
- Coach C is on T1 and on T9 (group `U12B`).
- Baseline conflicts are T1 = 1, T2 = 0, T3 = 0, so the spread is 1, which is
  allowed.

**Run**

- A field loss displaces T1's game on 2026-10-10.
- The only facility-legal, turnover-clean slot at that venue is 10:00, which
  overlaps T9's 10:00 game.
- Pass 1 refuses the slot for the overlap. Pass 2 admits it (overlap-only pool,
  `stages.js:632-650`) and warns with `RESOLVE_COACH_OVERLAP_CARRIED`.

**Result**

- T1 = 2, T2 = 0, so the spread is 2 against a maximum of 1.
- Expected: refused or loudly flagged, pending Q1.
- Actual: `compromised`, with a `verify` compromise at most.

### 1.3 Proposed fix: adopt the sibling contract

The contract to adopt is **"refuse growth over what the baseline accepted"**,
the one `newBlockingCodes()` + `acceptedAtSlot()` already implement. Do not
invent a third form.

1. **Instance.** The key is `CONFLICT_SPREAD_EXCEEDED|<groupLabel>`. The value
   is the group's excess, `max(0, spread − maxSpread)`. This is the aggregate
   analogue of "counts, not presence" (`stages.js:227-231`): pushing an
   already-over group further is growth.
2. **Baseline.** Record each group's excess once, in `baseline-ingest`, beside
   `context.baselineRules`. The spread belongs to the group, not to a game's
   slot, so it is keyed by group rather than through `acceptedAtSlot()`.
3. **Evaluator.** Ask `conflictFairnessRule.evaluate()` itself. This matches
   the gate's existing "asks the rule engine's own evaluators" contract
   (`ruleGate.js:35-38`). Pass it a projected schedule restricted to:
   - the teams of the moving game's groups;
   - every commitment of every person rostered on those teams, projected
     through `projectCommitment()` with the candidate override
     (`ruleGate.js:80-98`).

   The same projection means the gate and `verify` cannot disagree
   (`ruleGate.js:65-68`).
4. **Where it bites.** It is an extra key in `ruled.instances`. Because it is
   not `TRAVEL_COMMITMENTS_OVERLAP`, `overlapOnlyRefusal` is false
   (`stages.js:600-603`), so it is refused in **both** passes, as turnover is.
   Whether it should be is Q1.
5. **Requested moves.** These stay exempt (`stages.js:590-593`), by the #61
   ruling. A requested move that grows the spread must still say so whether or
   not `verify` runs. That is the same contract as `reportCoachOverlapsCarried()`
   (`stages.js:1581`, defined `:1675`). Add a spread arm there, or a sibling finding
   `RESOLVE_CONFLICT_SPREAD_CARRIED` (Q2).
6. **Refusal reporting.** Use the existing `context.ruleGateRefusals` path
   (`stages.js:604-611`), so a game shelved as TIME TBD carries
   `CONFLICT_SPREAD_EXCEEDED` as its reason, not a silent drop.
7. **Meta-assertion.** Add a ledger counter `ruleGateGroupsExamined`, beside
   `ruleGateCommitmentsExamined` (`stages.js:595-597`). A gated run where the
   moving game has a group label and the counter is 0 is a loud failure.

### 1.4 Blast radius

- **Callers of the gate.** There are four: `chooseSlot()` (`stages.js:592`),
  baseline ingest (`:894`), `evaluateCandidate()` for #53 cross-venue options
  and relocation (`:720`), and the overlap warning (`:1689`, `turnover:
  false`). The warning should skip the spread arm too. Pinned by
  `tests/ruleGate.test.js:244-287`.
- **Season-2026 baseline.** The spread rule examines 9 groups and finds 0
  violations (`tests/ruleEngine.test.js:632`, `:651`). A no-op run's baseline
  excess is 0 everywhere, so the no-op output stays byte-identical
  (*estimated*: follows from the contract; to be confirmed by the fixture
  suite).
- **The 679-run displacement sweep** (*estimated, not measured*). After #61,
  38 overlaps were carried (`PHASE_8_PROGRESS.md:5980-5986`). Only the subset
  that tips a group from spread ≤ 1 to ≥ 2 changes. Each such run moves from
  "placed with warning" to "next pass-2 candidate or TIME TBD with reason". The
  upper bound is 38 placements; the likely number is far lower, because only
  3 of the corpus's baseline commitment pairs overlap (measured, §2.4). The
  sweep harness is not in the repo, so PR B must re-run it and quote before and
  after.
- **Cost.** Each candidate adds a fairness evaluation over one to two groups'
  coaches for the season (*estimated*: small against the facility check).

---

## 2. #62: the gate ignores waivers, and `verify`'s coach check pairs only neighbours

### 2.1 Current behaviour: waivers (*read*)

**Waiver model**

- A waiver record carries a `constraintId` (`waivers/schemas.js:123`), a scope
  and a lifecycle.
- The one corpus waiver is incident 9's board exception
  (`fixtures/season-2026/README.md:157-161`), built at
  `waivers/adapters/season2026Waivers.js:72-77`. Its `constraintId` is
  `COACH_TRAVEL_BETWEEN_VENUES`, scoped to one `personId` and two `venueIds`.

**Where waivers are honoured**

- Only `runRuleEngine` applies the ledger (`ruleEngine/engine.js:562-563`).
- `applyWaivers()` resolves each finding's constraint ids
  (`waivers/apply.js:189`). It skips a constraint that is not `waivable`
  (`:200`) and demotes a covered blocking finding to compromise (`:227-228`).
- `constraintIdsByReasonCode()` links the declared-only constraints to codes
  (`engine.js:222-252`). The overlap code is deliberately linked to nothing
  (`ruleEngine/rules.js:1064-1071`), so it cannot be waived.

**Where waivers are not honoured**

- `ruleGate.js:39-40` says so: "Waivers are not consulted".
- The turnover arm calls `turnoverMinimumRule.evaluate()` directly with no
  ledger (`ruleGate.js:252-255`). It then refuses any **blocking** turnover
  finding (`:260`).
- The coach arm calls `evaluateCoachTravel()` with no ledger
  (`ruleGate.js:209`).
- `verify` runs the engine **with** `engines.waiverLedger` (`resolve.js:380-383`).
  The two halves can therefore disagree about the same instance.

**Is the divergence live today? No: future only** (*read*). Every constraint
that governs a gated code is non-waivable, or the code is unlinked:

| Gated code | Governing record | `waivable` |
| --- | --- | --- |
| `TURNOVER_BELOW_MINIMUM` | `TURNOVER_FLOOR_GLOBAL` | `false` (`season2026Constraints.js:169`, `:189`) |
| `TURNOVER_BELOW_MINIMUM` | `TURNOVER_ORCHARD_PARK` | `false` (`:220`, `:241`) |
| `TURNOVER_BELOW_MINIMUM` | `TURNOVER_PREFERRED_GLOBAL` (preference) | `false` (`:194`, `:215`) |
| `TRAVEL_COMMITMENTS_OVERLAP` | none; linked to nothing | unwaivable (`rules.js:1064-1071`) |
| `CONFLICT_SPREAD_EXCEEDED` (if #60 lands) | `CONFLICT_FAIRNESS` | `false` (`:396`, `:416`) |

The two waivable records, `COACH_TRAVEL_BETWEEN_VENUES` (`:246`, `:266`) and
`COACH_TRAVEL_WITHIN_VENUE` (`:271`, `:291`), govern gap-floor codes. The gate
does not gate those; it only collects them as compromise codes for #53 options
(`ruleGate.js:212-216`).

The divergence becomes live the day any gated record is retyped `waivable:
true`, or a new gated code is linked to a waivable record. The failure then
**fails safe**: the gate over-refuses and `verify` accepts. Per the Phase 2
lesson, "a field parsed and unread" is still the defect class.

### 2.2 Current behaviour: the consecutive coach check (*read*)

- `verify`'s coach check is `coachConflictRule` (`rules.js:1041-1130`). It
  calls `evaluateCoachTravel(schedule.commitments, …)` (`rules.js:1099`).
- `evaluateCoachTravel()` sorts each person-day by start (`coachTravel.js:340-344`).
  It then judges only `ordered[index]` → `ordered[index + 1]`
  (`coachTravel.js:346-348`). This is stated as design in the header
  (`coachTravel.js:22`) and on the function (`:283`).
- `TRAVEL_COMMITMENTS_OVERLAP` fires when `to.startMinutes − from.endMinutes <
  0` for that neighbour pair only.

**Two siblings already compare every pair:**

- the gate: "Pairwise, not consecutive" (`ruleGate.js:178-186`, loop at
  `:206-209`), which calls the same evaluator one pair at a time. It is
  witnessed by `tests/ruleGate.test.js:419-468`.
- the fairness rule (`rules.js:1597-1599`).

The comment at `ruleGate.js:185-186` records that `verify` "keeps the
consecutive blind spot; that is the rule engine's to fix, and filed". That is
this issue.

### 2.3 Failing scenario (synthetic): why neighbours miss a non-adjacent overlap

Coach C, one date, one venue:

| id | team | start | end |
| --- | --- | --- | --- |
| A | T1 | 09:00 | 10:30 |
| B | T2 | 09:10 | 09:20 |
| G | T3 | 10:00 | 11:00 |

Sorted by start, the list is A, B, G, and the neighbour pairs are:

- A→B: gap = 09:10 − 10:30 = −80, so **overlap**, reported.
- B→G: gap = 10:00 − 09:20 = +40, so no overlap. It is judged only against
  the within-venue walking floor.

**A→G overlaps by 30 minutes (10:00-10:30) and is never compared.** B is short
and sits inside A. Sorting by start puts B between A and G, so A's long tail
is never set against G.

**Consequences**

- `verify` reports one overlap. The gate would report two for a move of G
  (`ruleGate.js:206-209`).
- The fairness rule counts conflicts for T1, T2 **and** T3 (it compares every
  pair). The coach rule names only T1 and T2. Two rules in one engine run give
  different answers on the same data.
- `RESOLVE_COACH_OVERLAP_CARRIED` comes from the gate's own every-pair check
  (`stages.js:1689`), so it warns about A-G. `verify`'s instance diff never
  lists it.

### 2.4 Proposed fixes: adopt the sibling contracts

**(a) Pairwise overlap in `evaluateCoachTravel()`, adopting the gate's form.**

- Keep the consecutive loop for the **gap floors**. A travel gap is a
  neighbour question: the next thing you must reach is the next commitment.
- Add a pass for `TRAVEL_COMMITMENTS_OVERLAP` over every same-day pair that the
  neighbour loop did not already judge. Decide each pair the way the neighbour
  loop does (`to.start − from.end < 0` on start-sorted pairs), so there is one
  definition and two coverages, exactly as the gate describes itself.
- A non-adjacent pair with an unknown end yields
  `TRAVEL_FOOTPRINT_UNKNOWN`-style "unjudged", never "clear". This mirrors
  `CONFLICT_OVERLAP_UNJUDGED` (`ruleEngine/reasonCodes.js:321-329`).
- Subject id for a non-adjacent pair: `${personId}|${date}|${a.id}->${b.id}`,
  the same shape as `coachTravel.js:365`. The gate already keys by unordered game pair, so
  instance keys stay stable (`ruleGate.js:42-44`).
- New counter `overlapPairsCompared`, beside `transitionsExamined`.

**(b) The gate honours waivers exactly as `runRuleEngine` does.**

- Pass the gate's turnover (and spread) subjects through `applyWaivers()` with
  the run's `engines.waiverLedger` and the engine's `constraintIdsByReasonCode()`
  map (`engine.js:222-252`).
- Refuse only a finding that is still `blocking` after application.
- Do not re-implement scope matching. A ledger of `null` keeps today's
  behaviour, which is the engine's own `ledger === null` contract
  (`engine.js:562-563`).

### 2.5 Blast radius

**(a) Pairwise overlap**

- **Callers.** `coachConflictRule` (`rules.js:1099`), hence every
  `runRuleEngine` user: `verify`, scenario runs (`scenario/run.js:462-470`),
  the feasibility API and the validation report. The gate's calls
  (`ruleGate.js:209`) pass two commitments, so they are unaffected.
- **Season-2026** (*measured*, read-only scratch script run against this
  branch's base):

  | Quantity | Value |
  | --- | --- |
  | Commitments | 1764 |
  | Person-days | 1627 |
  | Max commitments per person-day | **2** |
  | Person-days with 3 or more | **0** |
  | Same-day pairs | 137 (matches `personPairsCompared` at `tests/ruleEngine.test.js:604`) |
  | Consecutive overlaps | 3 |
  | Every-pair overlaps | 3 |
  | Found by every-pair only | **0** |

  With at most two commitments per coach-day, every pair is a neighbour pair.
  **The season fixture's rule-engine output is unchanged by (a).** Only a new
  counter appears.
- **Displacement runs.** Same-date moves keep each person-day at two or fewer,
  so no change (*estimated*). A cross-date move could create a three-commitment
  day (*estimated: rare*).

**(b) Waivers in the gate**

- **Callers.** The same four gate callers as §1.4.
- **Season-2026.** No change (*read*): no gated code is waivable (§2.1 table),
  and the corpus's only waiver targets a code the gate does not gate.

---

## 3. Witnesses

Every guarantee gets a test, and a plant that must turn that test red. Each
plant must be demonstrated in the PR by applying the break locally and quoting
the failing assertion, per CLAUDE.md "a meta-assertion you cannot make fail is
not a meta-assertion".

### #60: spread in the gate

**W1. The gate refuses a placement that grows a group's spread.**
- Test: `tests/ruleGate.test.js`, new describe, using the §1.2 synthetic
  schedule. Asserts TIME TBD, or the next candidate, with
  `ruleGateRefusals[gameId].CONFLICT_SPREAD_EXCEEDED ≥ 1`.
- Plant: drop the spread key from the gated codes, or skip the fairness call.
- Meta-assertion: `ruleGateGroupsExamined > 0`. A second plant blanks
  `groupLabel` and must fail on the counter, not pass silently.

**W2. Growth is measured against the baseline, not in absolute terms.**
- Test: a group already at spread 2 in the baseline, and a displacement that
  leaves it at 2. The game is placed.
- Plant: compare absolute excess instead of grown excess.
- Meta-assertion: the baseline excess for that group is recorded as 1, and the
  test asserts it.

**W3. Growing an already-over group is refused.**
- Test: the baseline group is at 2 and the move would make it 3. Refused.
- Plant: compare presence (`> 0`) instead of count.

**W4. Groups come from the roster.**
- Test: a group where one team has no commitment on the date. Its 0 must count
  as the minimum.
- Plant: derive the group's teams from the commitments or games (the incident 4
  shape).

**W5. The gate and `verify` agree.**
- Test: for the W1 schedule placed by force, the gate's grown key and `verify`'s
  new `CONFLICT_SPREAD_EXCEEDED` instance both name `U10G`.
- Plant: build the gate's schedule without `projectCommitment()`.

**W6. A requested move that grows the spread warns even with `verify: false`.**
- Test: modelled on `tests/ruleGate.test.js:532-541`.
- Plant: emit only inside the rule-engine branch of `verify`.

**W7. The season fixture is unchanged.**
- Test: the existing no-op byte-identity plus `tests/ruleEngine.test.js:632`
  and `:651`.
- Plant: a strict gate (`maxSpread: 0`). The no-op output must change, which
  proves the gate is wired to the season data.

### #62: every-pair overlap

**W8. `evaluateCoachTravel()` reports the A→G overlap.**
- Test: the §2.3 table, in `tests/coachTravel*.test.js`. It reports two
  `TRAVEL_COMMITMENTS_OVERLAP`, including A+G.
- Plant: revert to the neighbour-only loop.
- Meta-assertion: `overlapPairsCompared === 3` for that day. A plant that
  bumps the counter per neighbour pair must give 2 and fail.

**W9. Gap floors stay neighbour-only.**
- Test: A 09:00-09:30 at V1, B 09:45-10:00 at V1, G 11:00 at V2. There is no
  A→G drive-floor finding.
- Plant: run the floor check over every pair.

**W10. Unknown end on a non-adjacent pair is "unjudged", not "clear".**
- Test: A has no end and is non-adjacent to G. Expect an unjudged finding.
- Plant: `continue` on a null end.

**W11. The coach rule and the fairness rule agree.**
- Test: the §2.3 schedule through `runRuleEngine`. The teams in coach-rule
  overlap subjects equal the conflicted teams in the fairness rule's `matched`.
- Plant: revert (a).

**W12. The season counters stay the same.**
- Test: `personPairsCompared` 137, and the existing overlap count unchanged.
- Plant: none needed. This is a pin, backed by the measured delta of 0.

### #62: waivers in the gate

**W13. A waiver on a waivable turnover record admits the slot in both the gate
and `verify`.**
- Test: a synthetic registry with turnover retyped `waivable: true`, plus a
  ledger waiver. The candidate is placed and `verify` shows it waived.
- Plant: the gate ignores the ledger. The game is refused and goes TIME TBD.

**W14. A waiver cannot override `waivable: false`.**
- Test: the same waiver against the season record (`:189`). Still refused.
- Plant: skip the `waivable` check (`apply.js:200`).

**W15. The overlap stays unwaivable.**
- Test: a waiver naming the travel constraint does not admit an overlap.
- Plant: link the overlap code to the travel constraint.

---

## 4. PR split and size

Order: A, B, C. A is independent. B depends on the gate shape, not on A.

| PR | Scope | Source lines | Test lines | Risk |
| --- | --- | --- | --- | --- |
| **A (#62a)** | every-pair overlap in `evaluateCoachTravel()` (§2.4a), W8-W12 | ~60-100 | ~150 | low: corpus delta measured 0 |
| **B (#60)** | spread instances in `ruleGate.js`, baseline excess in `baseline-ingest`, refusal reporting, requested-move warning (§1.3), W1-W7; re-run the displacement sweep and quote it | ~180-260 | ~300 | medium: changes sweep placements |
| **C (#62b)** | gate honours the waiver ledger via `applyWaivers()` (§2.4b), W13-W15 | ~60-100 | ~180 | low: no live case on the corpus |

All sizes are estimated. Each PR also:

- updates the `ruleGate.js` header, whose lines `:39-40` and `:185-186` become
  false;
- adds an entry to `docs/PHASE_8_PROGRESS.md`;
- runs `/code-review` before opening;
- passes the full Definition of Done.

---

## 5. Still declared, not enforced, after all three PRs

- **Practice repair** (`practice/repair.js`) consults no rule-engine rule. It
  handles coach overlaps through its own objective and warnings (header
  `:28-32`). Spread and turnover are not asked there.
- **`RESOLVE_VERIFY_NEW_VIOLATION` is compromise for every code**
  (`resolve/reasonCodes.js:433`). A blocking rule broken by an exempt requested
  move or by a non-placer stage still yields a run that reads `compromised`.
  Changing this would affect every blocking code, so it is out of scope and to
  be filed.
- **`scenario/run.js` `blockingByGame()`** drops violations with no game id
  (`:145-156`). A group-level spread breach is never attributed as a displaced
  game.
- **Non-placer stages.** `dislodge`, `local-search` and `pair-repair` do not
  read the gate, by design (`ruleGate.js:25-33`). They decide which games move,
  not where.
- **The `conflict-fairness` record** has `enforcement: DECLARED_ONLY` and
  `reasonCodes: []` (`season2026Constraints.js:413-414`). It is enforced only
  through the rule's claim (`rules.js:1543`). This is honest, but it should say
  so wherever it is listed.
- **Not examined in this plan:** whether the Deno twin
  (`supabase/functions/auto-scheduler/`) evaluates spread or pairwise overlap.

---

## 6. Open questions for the operator

**Q1. When a solver placement would push an age group's coach-conflict spread
above the permitted 1, should the placer refuse it (like turnover) or allow it
with a warning (like the coach overlap under #61)?**
*Recommended default: refuse it in both passes.* The fixture then falls through
to the next candidate, then to #53's cross-venue options, then to TIME TBD with
`CONFLICT_SPREAD_EXCEEDED` as the reason. Two reasons:
- The record is `HARD` and `waivable: false` (`season2026Constraints.js:399`,
  `:416`).
- #61 allowed the overlap on the grounds that a co-coach covers. This rule is
  what bounds how often one team leans on that cover.

**Q2. When an operator-requested move grows a group's spread, should it stay
allowed with a warning (as #61 decided for requested overlaps), or be
refused?**
*Recommended default: allow it, with a warning that surfaces whether or not
`verify` runs.* This names the group, the teams and the spread. It keeps
requested-move policy consistent with #61 and in the operator's hands.

**Q3. Should the `conflict-fairness` rule ever be waivable, so that a board
waiver could excuse a spread breach for one group?**
*Recommended default: no.* Keep `waivable: false`. With PR C the gate would
honour such a waiver automatically if the record were ever retyped. The
retyping should be a deliberate constraint change, not a waiver.

Not put to the operator, with reasons:

- **Should `evaluateCoachTravel()` go every-pair?** It is a correctness fix
  that adopts an existing sibling contract. Its corpus delta is measured at 0
  (§2.5), and any overlap it surfaces is already compromise under #61's ruling.
- **Should the gate honour waivers the way `runRuleEngine` does?** That is the
  sibling-contract rule in CLAUDE.md. The only policy choice in it is Q3.
