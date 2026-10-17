# Plan: the game evaluator reports a team missing from its roster (#576 follow-up)

Status: **PROPOSED, awaiting the owner's approval** (§9). A scoring change, so
plan first (`AGENTS.md` rule 14). Recorded by #576 (M4.4) under "Discovered
during execution" ("The Edge game evaluator still skips, without a word, a game
side whose team is missing from a non-empty roster"); resume queue, Wave 1. To
be built by one PR, `fix/game-evaluator-unknown-team`.

Evidence labels, per `AGENTS.md` rule 4: _read_ (statically reviewed),
_executed_ (run, output quoted), _test-verified_ (a committed test asserts it).
Everything is on `main` at `cab8ce1`.

---

## 0. Headline

The two game evaluators disagree, and the Edge one is the one the product
calls (`fairness-scoring`). Given a roster and a schedule:

- **Core** (`packages/core/src/gameMetrics.js:89`) warns `unknown-team` once per
  side it cannot find and counts three populations: teams rostered, teams a
  game names, and sides it does not know.
- **The Edge** (`_shared/engines/scoring-engine.ts:520`) drops an unknown side
  with `if (!team) return;` and says nothing; its `coveragePercent` is 100
  whenever there is at least one game (`:527`, commented "Simplified").

So a roster that matches **no** game scores `ok`, no issues, coverage 100, and
`fairness-scoring` turns that into a game fairness of 1. A team renamed between
roster and schedule plays nothing, and a coach clash through it is invisible.
#576 refused the empty case at the boundary (422 `EMPTY_GAME_ROSTER`); the
non-empty case is this plan.

Measured (_executed_, §2): on the season-2026 corpus's combined schedule (542
games with both sides named, 132 rostered teams) core reports **5 unknown
teams** (the visiting clubs) and 131 of 132 teams scheduled; the Edge reports
**0** and coverage 100. The same run also shows two sibling divergences the fix
has to settle: the Edge's coach check reads only the head coach (3 coach
conflicts in core, 2 at the Edge), and it reports a coach who coaches **both
sides of one game** as a clash with himself.

No page sends `gameData` today (`EvaluationPanel` is rendered only by the
practice page, with `practiceData`), so nothing persisted changes when this
ships. That is the moment to fix it, before a games page calls it.

The proposal (§3): the Edge adopts core's contract (the sibling rule): one
warning per unknown team, coverage from the roster, every coach on a team,
one fixture is one commitment. A game vector table and a corpus game extract,
read by core, the Node drift test and Deno, hold the two engines together; none
exists for games today.

---

## 1. What exists today (_read_)

|                                   | Core `evaluateGameSchedule`                                                                                                  | Edge `evaluateGameSchedule`                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Unknown side                      | `warnings[]` `{ type: 'unknown-team', details: { teamId, weekIndex, slotId } }`, once per team id (`gameMetrics.js:184-195`) | dropped, no output (`scoring-engine.ts:543`)                                |
| Coverage                          | `summary.teamsRostered`, `teamsScheduled`, `teamsReferencedUnknown`, each with a unit (`GAME_METRICS_COUNT_UNITS`)           | `coveragePercent: assignments.length > 0 ? 100 : 0`                         |
| Coaches checked                   | every coach (`listTeamCoachIds`, 8.2)                                                                                        | `team.coachId` only; the comment says "pending 8.2" (`:550`), which shipped |
| A coach on both sides of one game | one commitment (`sourceKey`, `:509-517`)                                                                                     | two entries for one game, reported as a clash                               |
| Field overlap                     | `field-overlap` warning                                                                                                      | not checked                                                                 |
| Output channel                    | `warnings[]` (no severity)                                                                                                   | `issues[]` with `severity`, and `status` from it                            |

The Edge's practice evaluator, in the same file, already has the contract for
an unknown team: it drops the row and pushes
`{ category: 'data-quality', severity: 'warning', message }` (`:188-193`,
`:263-265`). That is the sibling to adopt (§3.1).

Callers: `fairness-scoring/index.ts:178-204` only. `gameFairness =
coveragePercent / 100`, averaged with practice into the combined score, and
persisted with `persist: true`. There is **no** cross-arm test for games:
`tests/scoringEngineDrift.test.js` and the parity extract cover practice only
(_executed_: `grep evaluateGameSchedule` over `tests/` finds `gameMetrics`,
`coachModel` and `countUnits` tests, all core-only).

---

## 2. Measurement (_executed_)

A scratch Vitest file (copied into `tests/` only to run, then deleted; not
committed) ran both engines on the same inputs.

### 2.1 Witnesses

| Case         | Input                                                                    | Core                                  | Edge                                                        |
| ------------ | ------------------------------------------------------------------------ | ------------------------------------- | ----------------------------------------------------------- |
| G1           | roster A, B; one game X v Y                                              | `unknown-team` X, Y; scheduled 0 of 2 | `ok`, no issues, coverage 100                               |
| G2           | roster A, B; A v X, then B v A                                           | `unknown-team` X                      | `ok`, no issues, coverage 100                               |
| G3 (control) | roster A, B; A v B                                                       | no warnings                           | `ok`, coverage 100                                          |
| G4           | A and B share coach c1; A v C and B2 v D at the same time (B renamed B2) | `unknown-team` B2; scheduled 3 of 4   | `ok`, no issues: the c1 clash and the rename both invisible |
| S1 (sibling) | c1 heads A and assists B; A v C and B v D at the same time               | `coach-conflict` c1                   | `ok`: assistants not read                                   |
| S2 (sibling) | c1 heads both A and B; one game A v B                                    | no warnings                           | `action-required`, `coach-game-conflict` c1                 |

G4 is core's honest limit too: it reports the unknown B2 but cannot see the
clash, because it does not know B2's coach. The warning is what tells the
operator to look.

### 2.2 The corpus

`loadSeason2026()`: the 132-team roster from `coach_roster.csv` and the 542
rows of `combined_schedule.csv` that name both sides (137 placeholder rows,
league reservations and TBD sides, left out). Times from the corpus's own
kickoff and end minutes (3 rows with no end took their format's duration),
read at a fixed -04:00, which shifts every instant equally within a day and so
moves no overlap. Two roster teams carry no division, which the team schema requires;
they were given a stand-in label, which no count here reads.

|                            | Core                                                                                                                                                               | Edge                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| Unknown teams              | **5**: "Visiting Club A - U14G North", "Visiting Club A - U14B South", "Visiting Club B - U14B (3)", "Visiting Club A - U14B East", "Visiting Club C - U14G Delta" | **0** reported             |
| Teams scheduled / rostered | 131 / 132                                                                                                                                                          | not counted                |
| Coach conflicts            | 3                                                                                                                                                                  | 2                          |
| Status, coverage           | n/a                                                                                                                                                                | `action-required`, **100** |

The five are the external league's sides, which the club does not roster. They
are expected unknowns, and the warning should say so rather than be suppressed
(Q3).

---

## 3. The design

### 3.1 Unknown teams (the defect)

The Edge reports each side it cannot find **once per team id**, in schedule
order, as its practice evaluator does in the same file:

```
{ category: 'data-quality', severity: 'warning',
  message: 'game references unknown team <id>',
  details: { teamId, weekIndex, slotId } }
```

`status` becomes `attention-needed` when only such warnings exist. The game
still counts in `totalAssignments` and the known side is still checked, as
both engines do today. Core is unchanged here: its `unknown-team` warning is
already the contract, and the parity projection maps one onto the other.

### 3.2 Coverage from the roster (Q1)

The Edge's summary gains core's three counts, `teamsRostered`,
`teamsScheduled` and `teamsReferencedUnknown`, computed the same way, and
`coveragePercent = round(100 × teamsScheduled / teamsRostered, 2)`, with an
empty roster refused before it gets here (#576's 422). G1 then scores 0, G2
100, G4 75. The corpus scores 131/132 = 99.24.

### 3.3 A schedule that names no rostered team (Q2)

`teamsScheduled = 0` with games present means nothing on the roster was
examined: G1. `fairness-scoring` refuses it at the input boundary, 422
`GAME_ROSTER_UNMATCHED`, before the season read, the engine and
`persist_evaluation_run`, as `refuseEmptyGameRoster` does; and the engine
alone reports it as `severity: 'error'` so a direct caller is never told "ok".

### 3.4 The two sibling divergences (Q4)

Fixed in the same PR, because the new parity test cannot pass over them and
listing them as permanent differences would be declaring a known wrong answer:

- the Edge checks **every coach** on a team, through `listTeamCoachIds`, which
  the same file already imports for practice (S1);
- the Edge treats the two entries of **one fixture** as one commitment (core's
  `sourceKey`), so S2 is clean.

`field-overlap` stays core-only and is listed in the drift test as a known,
declared difference (Q5).

### 3.5 Engine lockstep: the first game parity check

- **Vectors**: `_shared/tests/fixtures/game-scoring-vectors.json`, hand-written
  (G1-G4, S1, S2, G3 as the control, plus a team with two unknown opponents to
  pin "once per id"), each with its truth worked out by hand. Read by core
  (`tests/gameMetrics.test.js`), the Node drift test
  (`tests/scoringEngineDrift.test.js`, new `describe` running both arms) and
  Deno (`_shared/tests/scoring-engine_test.ts`).
- **Projection both arms are compared on**: the set of unknown team ids;
  `teamsRostered`, `teamsScheduled`, `teamsReferencedUnknown`; the set of
  coach ids in conflict; the set of team ids double-booked. Messages and
  severities are each arm's own and are not compared.
- **Corpus extract**: `scoring-parity-games.season-2026.json`, generated by
  `scripts/generate-scoring-parity.mjs` from §2.2's input, with core's answer
  and literal floors (542 games, 132 rostered, 131 scheduled, 5 unknown, 3 coach
  conflicts), so an empty or stale extract fails. Both arms read it, as the
  practice extract is read today.

---

## 4. Test gate, witnesses and plants

Every subject set comes from the roster or the vector's own `truth`, never from
an engine's output.

- G1-G4, S1, S2 and the control in all three runners, shown failing on today's
  Edge first (§2.1 measures it).
- `fairness-scoring`: the 422 for G1 with `persist` true and false, and a
  handler-order pin (refused before `persist_evaluation_run`), as #576's
  `fairness-empty-game-roster_test.ts` does.
- The corpus extract in Node and Deno.

**Plants**, each shown caught before the PR opens: P1 the Edge's unknown-team
warning removed (G1, G2, G4, corpus); P2 coverage back to "100 if any game"
(G1, G4); P3 head coach only (S1, corpus 2 ≠ 3); P4 the `sourceKey` rule
removed (S2); P5 a warning per game instead of per team (the two-unknowns
vector); P6 the 422 removed (handler test); P7 a change in one engine only
(drift and corpus).

---

## 5. Impact

- No persisted run changes: no page sends `gameData` (_read_:
  `EvaluationPanel` is rendered only by `PracticeSchedulingPage.jsx:1872`, with
  `practiceData`).
- The practice evaluator, its parity extract and the solver are untouched.
- An Edge deploy of `fairness-scoring` and `auto-scheduler` (which imports the
  same file; its practice path is unchanged).

## 6. Declared, not enforced

- `field-overlap` is core-only (Q5).
- `EvaluationPanel` has no client guard for a games block; unreachable while no
  page sends one (#576's note stands).
- A clash through an unknown team (G4) cannot be seen by either engine; the
  warning is the signal.

## 7. Size

About 80 lines in `scoring-engine.ts` and `schemas/scoring.ts`, 30 in
`fairness-scoring`, 60 in the generator; about 350 lines of tests and the
vector table; the extract (generated, about 1,500 lines). One PR. No
migration.

## 8. Rollback

Revert and redeploy `fairness-scoring` and `auto-scheduler`. No data.

---

## 9. Questions for the owner

**Q1. Edge game coverage from the roster (`teamsScheduled / teamsRostered`)
instead of "100 if any game"?**
_Recommendation:_ yes. It is core's number, it is what "coverage" says, and it
is the number that drops when a team is renamed out of the schedule (the
"played zero of nine" lesson). Nothing persisted changes today.

**Q2. A schedule that names no rostered team: 422 at `fairness-scoring`'s
boundary, and an error-level issue from the engine itself?**
_Recommendation:_ yes. It is #576's empty-roster refusal one step on: nothing
was examined, so no score should be saved.

**Q3. Unknown teams are warnings (`attention-needed`), not errors, and the
external league's sides are reported like any other?**
_Recommendation:_ yes. The corpus's five unknowns are real opponents the club
does not roster; an error would block every season with external fixtures, and
suppressing them by a name pattern is the "matches zero and calls it clean"
shape this item exists to remove. A later item can let the operator mark a
team as external.

**Q4. Fix the two sibling divergences (assistants unread; a coach on both sides
of one game reported as a clash) in the same PR?**
_Recommendation:_ yes. The first parity check for games cannot pass over them,
and both are core's settled 8.2 contract. Leaving them would make the new test
carry a list of known wrong answers.

**Q5. Leave `field-overlap` core-only, declared in the drift test?**
_Recommendation:_ yes, for this PR. The Edge has no field model in its game
input today (`fieldId` is optional and unread); adding the check is a feature,
not a fix.
