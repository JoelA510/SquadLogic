# Placeholder schedule (2026)

A league that arrives with an already generated schedule, and the CSV it would import (plan
`docs/changes/2026-11-03-schedule-expansion.md`, section 4.9; PR 4). **Every value is invented.** The only
inputs taken from the owner's example workbook are the **counts** in the table below; no name, venue, club,
coach or value came from it, and this repository has never held it. Keep it that way (AGENTS.md section 2):
`tests/realNameDenylist.test.js` scans these files, and `tests/scheduleFixture.test.js` holds every cell to a
placeholder shape and finds no `@` anywhere.

## Files

| File                   | Rows | Contents                                                                                                                                                                                                                                          |
| ---------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schedule.csv`         | 574  | The import format of plan 4.3 (`Game ID`, `Date`, `Start Time`, `End Time`, `Venue`, `Field`, `Division`, `Home Team`, `Away Team`, `Week`) plus a `Format` column the importer drops. Dates `YYYY-MM-DD`, times `HH:mm`.                         |
| `teams.csv`            | 132  | The league the schedule is over: `Team`, `Division`, and up to three placeholder coaches (`Coach 1` to `Coach 3`; a name is a person, there is no email column).                                                                                  |
| `venues.csv`           | 26   | `Venue`, `Field`: the seven venues and their fields.                                                                                                                                                                                              |
| `schedule-invalid.csv` | 24   | One row per refusal reason of plan 4.4 and 4.8, the accepted-and-flagged kinds and a few rows that must stay valid. `Notes` says what each is for (`expect: bad-date`); it is a column the importer drops, so the file also checks the allowlist. |

All four are **generated** by `scripts/build-schedule-fixture.mjs` and never edited by hand:

    node scripts/build-schedule-fixture.mjs            # rewrite the four files
    node scripts/build-schedule-fixture.mjs --check    # exit 1 if a file differs from a fresh build

`tests/scheduleFixture.test.js` runs `--check` for real, on this directory (exit 0) and on a copy with one cell
changed (exit 1). `schedule-invalid.csv` is judged by `tests/scheduleImportParse.test.js` (the importer's parse
and mapping, against the `Notes` of each row).

## The season they are judged against

`America/Los_Angeles`, starting Monday 2026-09-07, ending 2027-03-31 (`FIXTURE_SEASON` in the script). The
window is long on purpose: the fall-back Sunday (2026-11-01) and the spring-forward Sunday (2027-03-14) are both
in it, so `schedule-invalid.csv` reaches `time-ambiguous` and `time-in-dst-gap` with real dates. The nine
Saturdays of `schedule.csv` are 2026-09-12 to 2026-11-07, and `Week` is one plus the whole weeks since the Monday
of the week the season starts (plan 4.8), which the test recomputes on its own.

## Shape (the produced numbers, near the owner's example)

| Figure                                       | Produced                                            | Example (counts only, plan section 11) |
| -------------------------------------------- | --------------------------------------------------- | -------------------------------------- |
| Games; game days                             | 574; 9 Saturdays (59 to 65 a day)                   | 574; 9 Saturdays (59 to 67 a day)      |
| Venues; fields                               | 7; 26                                               | 7; 26                                  |
| Divisions; own teams                         | 20; 132 (6 x 8, 7 x 7, 7 x 5 per division)          | 20; 132                                |
| Coach seats; people; teams with a 2nd, a 3rd | 215; 196; 82, 1                                     | 215; 196; 82, 1 (`season-2026`)        |
| Games against an outside club                | 43, against 31 labels, one venue (G), six divisions | 43 fixed games; 31 labels              |
| Game lengths                                 | 60, 75 and 90 minutes (a venue's block)             | seven lengths from 35 to 105           |

Divisions are `U05 Boys` to `U19 Girls`, teams `U05B Team 01`, venues `Venue A` to `Venue G`, fields `Field 1`
to `Field 4`, outside clubs `Visiting Club A` to `Visiting Club AE`, coaches `CoachFirstN CoachLastN` numbered by
first appearance in `teams.csv` (the demo fixture's convention). 19 people hold two seats, on teams of different
divisions, so the generator has real coach constraints to respect.

**How it is made.** The pairings are the product's `buildDivisionRoundRobins` (a second cycle with every pair's
sides swapped fills the nine weeks); the placement is `scheduleGames`. The script throws if a game is left
unplaced or if the pre-plant schedule is not clean under `evaluateGameSchedule`, the Games page's own report.
The 43 outside fixtures are then added by the script (the generator does not schedule a club that is not a team):
each fills a week one of six five-team divisions has a bye, on Venue G, at a time none of that team's coaches is
on another field. The outside club hosts about half of them (21 of 43), because an outside club that only ever
visited would push a five-team division's hosting out of balance before any plant did. An outside label is
one outside team row per division at import (plan 4.6): no (division, label) pair is used twice.

## The plants

Named, counted, applied to a copy of the clean schedule. Each is tried over candidates until the Games page's
report moves by exactly that plant and nothing else (otherwise the script throws, so a plant is never silently
fewer). **The pre-plant copy is the control** (`buildScheduleFixture({ plants: false })`): the same sweep and the
same report find none.

| Plant               | Count | What it does                                                                                                                           |
| ------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `sameFieldOverlaps` | 3     | A second game moved to start 15 minutes into the first game on its field.                                                              |
| `coachClashes`      | 3     | A coach with two teams has one team's game moved to start with the other's. The moved team is the **away** side of its game each time. |
| `hostingImbalances` | 3     | One home game turned round, so its host hosts two fewer than it visits; the opponent stays within one.                                 |
| `blankTimes`        | 1     | One game with no start or end time (the importer's TIME TBD).                                                                          |

`tests/scheduleFixture.test.js` counts them **from the CSV**, with its own all-pairs sweep (not the generator's
bookkeeping and not the product's report), asks `evaluateGameSchedule` the same question, and requires the three
to agree and the games each plant names to be the games the sweep flags. The numbers are the product's checks,
never the workbook's: a plain overlap check on the workbook finds 0 of the 4 double-bookings its summary shows
(plan finding 9).

## What this does not claim

That the shape is the owner's beyond the counts above; the real workbook stays outside the repository. That
`schedule-invalid.csv` is judged as the production importer will judge it: until the Edge function and the SQL
exist (PR 5, PR 6) the reference is `packages/core/src/scheduleImport/`.
