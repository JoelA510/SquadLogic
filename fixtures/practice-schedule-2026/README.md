# Placeholder practice schedule (2026)

A league that arrives with an already built practice schedule, and the flat CSV it would import (plan
`docs/changes/2026-11-03-schedule-expansion.md`, section 4.11.7; PR 9). **Every value is invented.** The only
inputs taken from the owner's practice workbook are the **counts** in the table below; no name, venue, club,
field, coach or value came from it, and this repository has never held it. Keep it that way (AGENTS.md section
2): `tests/realNameDenylist.test.js` scans these files, and `tests/practiceScheduleFixture.test.js` holds every
cell to a placeholder shape and finds no `@` anywhere.

## Files

| File                    | Rows | Contents                                                                                                                                                                                                                                                                      |
| ----------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `practice-schedule.csv` | 710  | The import format of plan 4.11.2 (`Team`, `Division`, `Day`, `Start`, `End`, `Location`, `Field`, `Subunit`, `Valid From`, `Valid Until`, `Capacity`, `Use`) plus a `Block` column the importer drops. One row per timed cell, used or open. Dates blank: the season's apply. |
| `practice-invalid.csv`  | 34   | One row per row-level refusal reason, the accepted-and-flagged kinds and a few rows that must stay valid. `Notes` says what each is for (`expect: bad-day`); it is a column the importer drops, so the file also checks the allowlist. Adds a `Length` column.                |
| `aliases.csv`           | 21   | `Alias`, `Location`, `Field`, `Subunit` (the last optional): 21 rows, 20 distinct targets, as plan finding 17 describes the example's alias tab. The format is a proposal until the owner says what theirs means.                                                             |
| `teams.csv`             | 132  | The league the schedule is over: `Team`, `Division`, and up to three placeholder coaches (a name is a person; there is no email column).                                                                                                                                      |
| `surfaces.csv`          | 58   | `Location`, `Field`, `Subunit`: the 8 venues, 29 fields and their two halves, as the organization holds them.                                                                                                                                                                 |
| `divisions.csv`         | 20   | `Division`, `Practices Per Week` (2 for all), `Practice Minutes` (45 for the three youngest, 60 for the rest): the stored settings the schedule is judged against.                                                                                                            |

All are **generated** by `scripts/build-practice-fixture.mjs` and never edited by hand:

    node scripts/build-practice-fixture.mjs            # rewrite the six files
    node scripts/build-practice-fixture.mjs --check    # exit 1 if a file differs from a fresh build

`tests/practiceScheduleFixture.test.js` runs `--check` for real, on this directory (exit 0), on a copy with one
cell changed (exit 1) and on a copy missing a file (exit 1). `practice-invalid.csv` is judged by
`tests/practiceImportParse.test.js` (the importer's parse and mapping, against the `Notes` of each row).

## The seasons they are judged against

`practice-schedule.csv`: starts Monday 2026-09-07, ends 2026-11-20 (`PRACTICE_FIXTURE_SEASON`). A practice row
holds a weekday and wall times and a date range; the import converts no instant, so there is no time zone here.
`practice-invalid.csv`: the same start and **no end date** (`PRACTICE_INVALID_SEASON`), which is what makes
`missing-dates` reachable from the file: every row that is not about dates carries both of its own dates; the one
row without a `Valid Until` is the `missing-dates` row.

## Shape (the produced numbers, near the owner's example)

| Figure                                       | Produced                                                                                  | Example (counts only, plan 4.11.1)                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Placements; at 45 and at 60 minutes          | 236; 37 and 199                                                                           | 235; 37 and 198                                               |
| Timed rows (open ones included)              | 710 (473 open, 1 hold)                                                                    | 726 timed cells (a merged cell is one row here, not two)      |
| Teams; with two practices, with one          | 132; 103 and 29                                                                           | 132; 103 and 29                                               |
| Two weekdays; both at one weekday and start  | 98; 5                                                                                     | 98; 5                                                         |
| Weekday pairs                                | Tue+Thu 49, Mon+Wed 38, Wed+Fri 8, Mon+Thu 3                                              | the same                                                      |
| Same field and start on both days            | 83 of the 98                                                                              | 83 of the 98                                                  |
| Venues; fields; labelled rows (halves); used | 8; 29; 58 (16 + 42); 49                                                                   | about 8; 58 labelled rows (16 + 42); 49                       |
| Whole-field placements                       | 20 (10 teams, both days)                                                                  | about 20 (merged over two rows)                               |
| Blocks                                       | 45 minutes on Tue and Thu at 16:00, 16:45, 17:30; 60 on Mon to Fri at 16:00, 17:00, 18:00 | the same, the 45-minute block with times on two weekdays only |

Venues are `Venue A` to `Venue H`, fields `Field 1`.., halves `A` and `B`, teams `U05B-01` (division code, number),
divisions `U05 Boys` to `U19 Girls`, coaches `CoachFirstN CoachLastN` numbered by first appearance in `teams.csv`.
19 people coach two teams, in different divisions. **Spellings:** 17 fields (Venues C to G) are written in an alias
spelling in the schedule (`Pitch C1`), Venue G as `Venue G Annex`, and the halves of `Venue H` `Field 1` as `H1 North` and
`H1 South`; `aliases.csv` resolves them, so the file reads only after the mapping step takes those proposals (plan
4.11.5). **A whole-field placement is one row with a blank `Subunit`** (the converted file's answer to the grid's
merged cell), and replaces the two half rows it covers. One cell (two teams, `Capacity` 2, on both days) is a control
for the capacity plant: it holds two teams and is not over capacity.

**How it is made.** The file is grid-shaped, not a solver's output (the product's solver has no pairing yet, plan
5.7). The script lays out every (half, weekday, start) as a cell, places each team's two practices as a twin pair
(the same half and start on two weekdays) except for 15 teams whose two practices differ, spreads teams over the
ground (the least used half first), and refuses a cell where a coach of the team already coaches another team at an
overlapping time. It throws if the pre-plant grid is not clean under its own measures, or if a plant cannot be placed.

## The plants

Named, counted, applied to a copy of the clean grid. Each is tried over candidates until the measures move by
exactly that plant and nothing else (otherwise the script throws, so a plant is never silently fewer).
**The pre-plant copy is the control** (`buildPracticeFixture({ plants: false })`): every team has two practices
and the same sweep finds none.

| Plant                | Count | Measure (counted from the CSV)                                                                                                                                                                              |
| -------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shortTeams`         | 29    | Roster teams with fewer placement rows than their division's practices a week (the division is set to two a week, `divisions.csv`).                                                                         |
| `doublePlaced`       | 5     | Teams with two rows on one weekday at one start on **different fields** (a team in two places at once).                                                                                                     |
| `coachClashes`       | 1     | Coaches of two teams whose placements overlap in time on one weekday.                                                                                                                                       |
| `trailingWhitespace` | 2     | `Team` cells whose text differs from its trim (the parser must fold them to one team).                                                                                                                      |
| `teamOnBothHalves`   | 1     | Teams with rows on **two halves of one field** at one weekday and start (a merged cell converted wrongly; the hint is "leave Subunit blank for the whole field"). That team has 3 rows, one over its count. |
| `overCapacity`       | 1     | Cells (one half, weekday, start) holding more placement rows than their `Capacity`.                                                                                                                         |
| `overlappingSlots`   | 1     | Pairs of distinct cells on one ground, one weekday, overlapping in time (back to back and different halves are not). Here: a half starting at 18:30 over the 18:00 cell.                                    |
| `holds`              | 1     | Rows whose `Use` is `hold`: a non-team activity (makes no slot; listed).                                                                                                                                    |

`tests/practiceScheduleFixture.test.js` counts them **from the CSV**, with its own sweep
(`tests/helpers/practiceSweep.js`, which imports neither the generator nor the product, and takes the roster from
`teams.csv` and `divisions.csv`, not from the schedule), and requires its count, the generator's record and the
named teams, coaches and rows to agree. The sweep is itself shown able to fail on small hand-made files. PR 10's
pgTAP then requires the product's flags for the same file to equal these counts. A team double-placed is also a
`weekday` case for the writer's gate, and the half-pair team is too; the two are counted apart here.

## What this does not claim

That the shape is the owner's beyond the counts above; the real workbook stays outside the repository. That
`practice-invalid.csv` is judged as the production importer will judge it: until the Edge function and the SQL
exist (PR 10, PR 11) the reference is `packages/core/src/practiceImport/`. That the owner's spreadsheet can emit
this flat shape in one step (plan 4.11.2: not tried).
