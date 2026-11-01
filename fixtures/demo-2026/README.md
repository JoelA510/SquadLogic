# Demo league registrations (2026)

A complete recreational league's player and coach registrations, in the column layout of a GotSport
program-registration export, with every person replaced by a placeholder. It is the seed for demo
mode, a realistic import for tests, and something to show a prospective league. **No real person's
data is in these files**; keep it that way (AGENTS.md section 2).

## Files

| File          | Rows  | Contents                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `players.csv` | 1,259 | One player registration per row, the export's 37 columns verbatim.                                                                                                                                                                                                                                                                                                                        |
| `coaches.csv` | 251   | One coach registration per row, the export's 34 columns verbatim (two headers repeat, as in the export).                                                                                                                                                                                                                                                                                  |
| `fields.csv`  | 304   | The league's practice grid, in the fields import's own columns (not an export: **generated** for the demo by `scripts/build-demo-seed.mjs` from one grid definition, `DEMO_GRID`): Monday to Friday on ten grounds of two halves, 60-minute slots from 16:00 to 19:00 on the nine unlit ones, 90-minute slots from 16:00 to 20:30 on the one lit ground, and U4's four Saturday sessions. |

The two registration CSVs are the export's two sheets. `tests/demoFixture.test.js` holds the league shape, the
placeholder shapes and the cross-references below. `scripts/build-demo-seed.mjs` turns all three into the
`demo_seed` rows (the league's people, teams and rosters into the applied migration `20261030010000`, which is
frozen and tested to be; the practice facility, each division's practices and the venue lighting into
`20261110010000`), and `tests/demoSeed.test.js` holds them equal.

## The league

| Division                     | Teams                  | Players per team                | Format                  |
| ---------------------------- | ---------------------- | ------------------------------- | ----------------------- |
| U4 (coed)                    | 4 cohorts: `U4A`-`U4D` | 14, 14, 14, 13 (55; at most 15) | No games; practice only |
| U5, U6 boys and girls        | 8 each                 | 5                               | 4v4                     |
| U7, U8 boys and girls        | 8 each                 | 7                               | 5v5                     |
| U9, U10 boys and girls       | 8 each                 | 11                              | 7v7                     |
| U12 boys and girls           | 8 each                 | 15                              | 9v9                     |
| U14, U16, U19 boys and girls | 2 each                 | 19                              | 11v11                   |

128 teams. A team holds twice its on-field count less three; the formats are the season's
(`fixtures/season-2026/game_formats.csv`). U4 plays no games: each cohort meets once a week for a
30-minute session, one cohort at a time, at least 15 minutes apart so families can park.

## Practices (Phase D, F)

Each division says how many practices a week its teams get and how long each is (owner, 2026-10-27):
**U14 and older 2 x 90 minutes, U5 to U12 2 x 60, U4 1 x 30** (its Saturday session per cohort; "truly a
once weekly practice in the example program... an odd case", and it stays a practice so the field shows as
in use and is not offered to games). Two practices a week are on different weekdays, in a slot of exactly
their length.

**The grid** (`DEMO_GRID` in `scripts/build-demo-seed.mjs`, written to `fields.csv`): nine unlit grounds
of two halves (Orchard Park 4, Riverside Fields 3, Valley View Park 2) with 60-minute slots 16:00-17:00,
17:00-18:00 and 18:00-19:00, Monday to Friday (270), one lit ground (Eastgate Sports Complex, the demo's
only lit venue) with 90-minute slots 16:00, 17:30 and 19:00 (30), and U4's four reserved Saturday sessions.
The demand is 224 sixty-minute practices (112 teams) and 24 ninety-minute (12 teams): 83% and 80% of the
slots. `tests/demoSeed.test.js` counts both from the fixture.

**Sunset** (owner: practices fit before sunset, only one lit field may run past it, past sunset is flagged
and never blocked). Every unlit slot ends by 19:00. Sunset moves with the date and the grid does not
(_executed_, `sunsetOnDate`, the three unlit synthetic sites, 2027): a 19:00 end is before sunset on 53% of
days (late March to early September), an 18:00 end on 69%; the demo's first twelve weeks of a winter visit
(November to January: sunset 16:49 to 17:26) are past sunset on every unlit ground, and the daylight pass
flags them with the reason. The lit ground is exempt. `tests/demoSeed.test.js` holds that no unlit slot ends
after 19:00, that every unlit slot is before sunset from 1 April to 31 August, and that a grid ending at
20:30 or a December date is not.

**The seeded schedule** (`demo_seed.practice_schedule`, built by `scripts/build-demo-practice-seed.mjs`
with the product's own solver, fixed seed): the four U4 cohorts once and the 64 teams of U5 to U8 twice,
132 practices; U9 and older are left for the visitor. `tests/demoPracticeSeed.test.js` regenerates it,
judges it from this fixture, and runs the solver again on the 60 teams left with these rows held: all 120
practices are placed, none TIME TBD, and the whole league's 252 break no rule.

Divisions follow the export, not every age: U12 takes 11- and 12-year-olds, U14 13-14, U16 15-16,
U19 17-19. Age groups use an **August 1 cutoff** (`Age Group` is the natural age: a child born
2019-08-01 to 2020-07-31 is age group 7). The program and division a family registered for is in
`Payment Plan` (`2026 U07B Junior Registration`: program Junior, division U7 boys); `Team Name`,
`Team Age` and `Team Gender` are where the player is placed: usually the registered division, older
for the 50 players playing up, and younger for one, as in the export. Programs span divisions:
Minis is U4, Micro U5-U6, Junior U7-U8, Select U14-U19, and U9, U10 and U12 carry no program name.
These are the pseudonyms `fixtures/season-2026/` already uses; its schedule books the Minis program
as 30-minute slots (`game_formats.csv` calls the format "Minis (U5 intro)"), which are these cohort
sessions, not games.

## Placeholders

| Who                              | Name                                                       | Notes                                                                                                                       |
| -------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Player number N                  | `FirstN LastN`                                             | Numbered in file order.                                                                                                     |
| Their guardians                  | `Parent1FirstN Parent1LastN`, `Parent2FirstN Parent2LastN` | A parent of siblings is named after the first child, everywhere they appear; a child's two guardians are always two people. |
| A coach who is a guardian        | that guardian's name                                       | Contacts are the ones the coach registered with, usually the same as on the child's row.                                    |
| Any other coach                  | `CoachFirstK CoachLastK`                                   |                                                                                                                             |
| Another adult on a coach's row   | `AdultFirstK AdultLastK`                                   |                                                                                                                             |
| Someone named but not registered | `UnregisteredFirstK UnregisteredLastK`                     | One name per person, wherever they are named.                                                                               |

Emails are `emailK@example.com` and phones `555-100-KKKK`, numbered by first appearance; one real
address shared by a family stays one placeholder. Registration and team ids are new.
Registration times (`Created`, `Submitted At`) are synthetic, spread over March to August 2026, and
adult coaches' birthdates are synthetic (1970-1996): neither is derived from the source.

Free-text answers (buddy requests, a coach's player, preferred co-coach) were rebuilt from the
people they name, so no original text survives: a name becomes that person's placeholder, and an
answer naming nobody becomes `N/A` or `No preference`. A coach's "player's birth date" and gender
match that player's row.

## What it keeps from the real season

- **Buddy requests.** 231 mutual pairs: the 219 within one division each share a team; 12 straddle
  divisions (different age groups or genders, or one child plays up) and cannot. 131 one-way
  requests, and 101 that name someone not registered.
- **Coaches.** One to three per team, each on their own child's team; 23 have no team, as some
  did in the export. Three were added for teams that had none, as a parent of a player on it.
- **Coach registrations filed under a child's profile.** Eight rows in the export carry a child's
  name and birthdate with the coaching parent in Guardian 1; they are kept, named as the player (or
  as an unregistered child), because an import has to cope with them.

## How it was made

From one real 2026 rec export, outside the repository; the source and the generator stay with the
owner (the generator names the source club in order to replace it). Real players were dropped where
a division had more than it needed (unplaced and unreferenced first) and synthetic ones added where
it had fewer, from that division's own answers. Players' birthdates moved 1 to 30 days at random,
inside the player's August-1 window, so no one changes age group; adults' birthdates and every
registration time were replaced outright. A verifier then checked the output
against the source: no source email, phone, id or full name anywhere in it, every name column a
placeholder, every carried column taken only from the source's low-cardinality answers. It
caught a planted real email, a real name, a missing player and an out-of-window birthdate.

## Import gaps it exposed

_Executed_ through the real header path (`tests/demoFixture.test.js`):

- **`Payment Plan` is dropped** by the import's sensitive-column filter (it matches `payment`), and
  `Photo Consent` with it. The registered program and division live only in that column, so a
  GotSport import loses them. Open until Phase E reads it.
- **Fixed (D1): one of two email columns was lost.** `Email/UserID` and `Contact Email` both
  resolve to `email`, and the import kept the last one even when it was blank, so 62 coach rows
  with a login email arrived with none. A blank now never replaces a value; where both are filled
  the later column, `Contact Email`, is kept.
- **Fixed (D1): a coach export failed the coach import's header check**, which required one
  full-name column where the export has `First Name` and `Last Name`. The import now composes it.
