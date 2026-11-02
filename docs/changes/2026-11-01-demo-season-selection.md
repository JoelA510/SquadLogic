# Demo season selection: choose a fall or a spring season at demo entry

Kind: FEATURE · Drawn up: 2026-11-01 against `origin/main` `bced965` · Owner: the repository owner ·
Status: **direction approved** (owner: "demo selection", not a swap inside the demo); **built 2026-11-01**
(Build notes); the exact windows and the fall's length are the owner's to confirm (Decisions). AGENTS.md rule 14 applies because the
change touches persistence (`start_demo_session`); it adds a parameter and one pure helper and nothing
else on the session path (no table, no column, no RLS, no expiry or cleanup change; see Design).

Every claim about the code is _statically reviewed_ unless marked _executed_. The sunset figures are
_executed_ with the repository's own helper (`packages/core/src/timing/solar.js`, the module the daylight
pass and the Edge twin share), at the demo's three unlit venues, in `America/Los_Angeles`.

## Why

The practice grid is static clock times; sunset moves with the date. The demo's season is "the coming
twelve weeks" from whenever a visitor arrives, so what a visitor sees depends on the day they try it, and
for much of the year the demo opens full of sunset flags that say nothing about the product: it is the
calendar. The owner's direction: let the visitor choose, at entry, a fall or a spring league, the same
league dated differently, and make both choices free of those flags.

## Behavior

- **Now:** "Try the demo" starts a demo at once. Its season is the twelve weeks that begin on the Monday
  after the current week, whatever the date.
- **After:**
  - "Try the demo" opens a choice first: **Fall season** or **Spring season**, each with the dates it
    covers. The default is the window the date falls in, or else the next one to begin. **Start the
    demo** then signs in and starts as before.
  - Same league: 128 teams, the same people, the same seeded practices and the same U4 cohorts. Only the
    season's dates change (the season, its divisions, the practices' live-from dates, its name).
  - The header's demo banner names the season: "Demo league · Fall season · 22:14 left".
  - The choice cannot be swapped inside the demo (a visitor who wants the other leaves the demo and
    starts again).
- **Unchanged:** the 30-minute expiry (see "How a demo lives", not an hour), the cap of 10, one demo per
  visitor, the purge, the import notice, the people fences, and the production build never falling back
  to the mock (`tests/mockModeGuard.test.js`).

## Out of scope

- A swap inside the demo (owner chose selection at entry).
- A second practice grid for the fall (Options, below).
- Changing what any real league's dates do.

## What exists today

**What sets the demo's dates** (the whole list; _statically reviewed_):

- `start_demo_session()` (`20261110010000_demo_practices.sql:693-697`): `v_start := date_trunc('week', now()
AT TIME ZONE v_tz)::date + 7` (the Monday after this week), `v_end := v_start + v_weeks * 7 - 1`.
  `v_tz` and `v_weeks` are the one `demo_seed.league` row: `America/Los_Angeles` and 12
  (`scripts/build-demo-seed.mjs` `LEAGUE`, into the frozen `20261030010000`).
- They become `season_settings` (`name` and `season_label` are `<year> Season`, `season_year`,
  `season_start`, `season_end`), every division's `season_start` and `season_end`, and each seeded
  `practice_assignments.effective_date_range` (the weekday's first date from `v_start`, to `v_end`).
  `set_team_coaches(..., current_date, ...)` dates the coach assignments from today.
- The seeded practices themselves carry no date: `demo_seed.practice_schedule` is weekday and time
  (`scripts/build-demo-practice-seed.mjs`), which is why changing only the season's dates is enough.
- The mock twin (`frontend/src/lib/mockDemo.js`) computes its own Monday and twelve weeks from `now` and
  leaves `season_settings.season_start` and `season_end` unset.
- Those are the only two places that date a demo's season (a search of `supabase/`, `frontend/src` and
  `scripts/` for the season columns and `start_demo_session` found no other). `fixtures/demo-2026/README.md`
  and the Phase D plan (PR F) record the sunset problem and leave the anchor to the owner.

**How a demo lives** (the part this change must not disturb):

- A visitor signs in anonymously (Turnstile token when configured), then calls `start_demo_session()`. One
  advisory lock; the visitor's live demo is returned instead of a second; at 10 live demos `P0001`
  `demo_capacity`; a non-anonymous caller is refused `42501` `demo_requires_anonymous`.
- It writes the organization unflagged, copies `demo_seed` (programs, divisions, teams, coaches, players,
  the one lit venue and the grid, the team run, the applied practice run), then flags it
  (`demo_expires_at = now() + 30 minutes`, `demo_owner`) and adds the visitor as admin, last, so the fences
  see a demo. **The expiry is 30 minutes (`c_minutes := 30`, decision 8 of the demo plan), not an hour**;
  the "hour" in the code is the purge's rule for an anonymous user with no membership.
- `is_org_member` and `is_org_admin` return false from the expiry on, whatever the browser does.
  `purge_expired_demos()` (service role; `pg_cron` every 10 minutes) deletes expired organizations, then
  their anonymous users, and logs to `demo_purge_log`; `demo_health()` and an hourly workflow watch it.
- The browser counts down from the `expires_at` the RPC returned (`DemoTimer`) and, at zero, signs out and
  opens `/demo/ended`.

**Sunset at the seeded times** (_executed_, `sunsetOnDate`, then `floor`; an unlit practice must end at or
before it, `practice/daylight.js`). The grid's unlit slots end at 17:00, 18:00 and 19:00 (the lit ground
runs to 20:30 and is exempt). The three unlit venues sit within 0.04 degrees of each other and give the same
answer to the minute, so one column stands for them.

| Unlit slot ends | 2027: days with no flag | First .. last flag-free day (2027) |
| --------------- | ----------------------- | ---------------------------------- |
| 17:00           | 313 of 365 (85.8%)      | 2 Jan .. 10 Nov                    |
| 18:00           | 251 of 365 (68.8%)      | 1 Mar .. 6 Nov                     |
| 19:00           | 195 of 365 (53.4%)      | 14 Mar .. 24 Sep                   |

The earlier finding holds: a 19:00 end is before sunset on 53% of days (55.1%, 53.4%, 53.6% and 54.0% in
2026-2029), an 18:00 end on 69%. It was slightly overstated in one place: it is not "every unlit practice"
from November to January. Clocks go back on the first Sunday of November and sunset drops to 17:02, so from
then the 18:00 and 19:00 slots are all flagged, and the 17:00 slots are flagged from 11 Nov to 1 Jan (2027).

What the **current rule** gives, by the day a demo is started (practice days with an unlit slot past sunset,
of the season's 60 weekdays; the three columns are the 19:00, 18:00 and 17:00 slots):

| Started             | Season                       | Past sunset  |
| ------------------- | ---------------------------- | ------------ |
| 1 Nov 2026 (today)  | 2 Nov .. 24 Jan              | 60 / 60 / 39 |
| 1 Dec 2026          | 7 Dec .. 28 Feb              | 60 / 60 / 20 |
| 1 Jan 2027          | 4 Jan .. 28 Mar              | 50 / 40 / 0  |
| 1 Mar 2027          | 8 Mar .. 30 May              | 5 / 0 / 0    |
| 1 Apr .. 1 Jul 2027 | (all within 5 Apr .. 26 Sep) | 0 / 0 / 0    |
| 1 Aug 2027          | 2 Aug .. 24 Oct              | 20 / 0 / 0   |
| 1 Sep 2027          | 6 Sep .. 28 Nov              | 45 / 15 / 12 |
| 1 Oct 2027          | 4 Oct .. 26 Dec              | 60 / 35 / 32 |

So a demo opened today is flagged on every 19:00 and 18:00 slot of its whole season.

## Options

**How to carry the choice** (all server-side: the season rows are what the Edge auto-scheduler's daylight
pass, the calendar and the exports read, so a browser-side date shift cannot work):

|     | What                                             | Cost                                                                                                                                                                                                                 |
| --- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | A parameter on `start_demo_session`              | One function signature; the season row already stores the result. **Chosen.**                                                                                                                                        |
| B   | A `demo_season` column on `organizations`        | The org row arrives with the banner's data for free, but "Organizations: admins update" lets the demo's admin write it, so the immutable-expiry trigger would have to grow with it: a change to the fence. Rejected. |
| C   | A `demo_sessions` table                          | A new table, its RLS and its purge: beyond a parameter. Rejected.                                                                                                                                                    |
| D   | Frontend-only date shift in the mock or the seed | Real demos run on the server's rows; only the mock could be shifted. Rejected.                                                                                                                                       |

**The fall.** No 12-week fall can be free of sunset flags at the seeded times: the latest start of a
12-week season with no 19:00 slot past sunset is Monday 29 Jun 2026, 5 Jul 2027 or 3 Jul 2028, which ends
in the third week of September and is summer by any league's calendar. A conventional 12-week fall (23 Aug
to 14 Nov 2027) has 35 of its 60 practice days flagged at 19:00, from 27 Sep. What can be offered:

1. **An early-fall window of 6 weeks (built).** Monday on or after 2 Aug, six weeks. Same grid, same seeded
   schedule, no flags in any year to 2060, at the price of a shorter season than the spring's 12 weeks.
2. A 12-week fall that shows its flags. Honest, and a showcase for the sunset rule, but it is the thing the
   owner asked to avoid.
3. A second, fall-only grid ending by 17:00 or 18:00 plus its own seeded schedule. 18:00 gives a fall to
   about 1 Nov, still short of a 12-week one; either grid cannot hold 224 sixty-minute practices (the
   league needs the 19:00 hour).
4. Move the whole grid earlier for both seasons: same capacity problem.

## Against the rules

- **Rule 14 (persistence):** this plan, with the direction already approved. Nothing beyond a function
  parameter and a pure helper is added.
- **Compute each derived value in one place:** the server decides the dates; the browser mirrors the rule to
  show the window and pick the default, held equal by shared test vectors (Design).
- **Never leave a field parsed and unread:** `demo_seed.league.season_weeks` stays read (it is the spring
  season's length).
- **Backward compatible by default:** `start_demo_session()` with no argument keeps working (a stale
  browser tab, the existing smokes and pgTAP).
- **Secrets, PII, scope exclusions, mock guarantee:** untouched.

## Design

**The rule** (one definition per language, equal by test; weeks in brackets). Each window is a Monday anchor
and a length: **Spring** starts on the Monday on or after 22 March and runs `demo_seed.league.season_weeks`
(12) weeks, to the Sunday ending 13 to 19 June; **Fall** starts on the Monday on or after 2 August and runs
6 weeks, to the Sunday ending 12 to 18 September. An instance of a window is dated by the year of its start.

- **Which instance:** the earliest whose last day is on or after _today_ (the date in the league's zone).
  So a date inside a window gets that window's current instance, and fall chosen in spring gets this year's
  fall, chosen in October the next year's. The last day of a window still belongs to it; the day after
  does not.
- **Default** (no choice given, and the entry page's preselected button): the choice whose instance ends
  first, i.e. the window the date falls in, or else the next one to begin ("nearest before" the date).
  Today, 1 Nov 2026, that is Spring 2027 (22 Mar .. 13 Jun), with Fall 2027 (2 Aug .. 12 Sep) offered.

**Server** (one migration, `20261114010000_demo_season_choice.sql`, guarded by the md5 of the body it
replaces, `md5(replace(p.prosrc, E'\r', ''))`):

- `demo_seed.season_window(p_choice text, p_today date)`: the rule above, `STABLE`, in the unexposed
  `demo_seed` schema. Returns `season`, `season_start`, `season_end`; a `NULL` choice is the default; any
  other value but `'fall'` and `'spring'` raises `22023`, detail `demo_season_unknown`.
- `start_demo_session(p_season text)`: the whole body of today's function, with `v_start`/`v_end` from the
  helper and the season named `Fall 2027` / `Spring 2027` (label `Fall` / `Spring`, so the team page's
  `label year` reads "Fall 2027"). It returns the old three keys plus `season`, `season_start`,
  `season_end`. Granted as the zero-argument one is (`authenticated` only).
- `start_demo_session()` becomes `RETURN public.start_demo_session(NULL)`, so the public shape, the
  existing smokes and every `regprocedure` literal stay as they are. The text overload has no default, so
  PostgREST never sees an ambiguous call.
- A visitor who already has a live demo gets it back (`existing: true`) with its own `season`, whatever they
  asked for now; the entry page says which.
- No table, column, policy, expiry or purge change. The revert restores the 20261110010000 bodies behind
  their md5 and drops the helper and the overload.

**Browser:**

- `frontend/src/lib/demoSeasons.js`: the same rule in JS (pure; `demoSeasonWindow`, `defaultDemoSeason`,
  `demoToday` in the league's zone, the labels), used by the entry page, the mock and the tests.
- `DemoStartPage`: before anything starts, a fieldset of two native radios (keyboard: arrows and Tab;
  legend and per-option description), the preselected default, the Turnstile widget (when configured) and a
  **Start the demo** button that waits for the token. Then the existing sequence runs with the choice
  (`supabase.rpc('start_demo_session', { p_season })`); a failure returns to the same page with the reason
  announced and the choice kept. Styles are tokens in `chrome.css`.
- `DemoTimer`: reads the demo's season row once and names it in the label.
- `mockDemo.js`: dates the season from the same helper, sets `season_start`/`season_end`, honours
  `p_season`, and refuses an unknown value as the server does.

**Why this is "one place":** the server computes the dates and returns them; the browser's copy only
describes the windows and picks the default, and cannot change what is stored. Both are held to one table
of vectors (below), and the pgTAP file embeds exactly the vectors the Vitest test checks.

## Sunset evidence for the two windows

Per year, every Monday to Friday of the instance against the earliest sunset of the three unlit venues
(`floor`, as enforced), for a 19:00 slot end:

| Year | Spring           | Tightest day, margin | Fall            | Tightest day, margin |
| ---- | ---------------- | -------------------- | --------------- | -------------------- |
| 2026 | 23 Mar .. 14 Jun | 23 Mar, 21 min       | 3 Aug .. 13 Sep | 11 Sep, 19 min       |
| 2027 | 22 Mar .. 13 Jun | 22 Mar, 20 min       | 2 Aug .. 12 Sep | 10 Sep, 21 min       |
| 2028 | 27 Mar .. 18 Jun | 27 Mar, 25 min       | 7 Aug .. 17 Sep | 15 Sep, 13 min       |
| 2029 | 26 Mar .. 17 Jun | 26 Mar, 24 min       | 6 Aug .. 16 Sep | 14 Sep, 14 min       |
| 2030 | 25 Mar .. 16 Jun | 25 Mar, 23 min       | 5 Aug .. 15 Sep | 13 Sep, 16 min       |

Over every year from 2026 to 2060 the smallest margin is **20 minutes (spring, 22 Mar 2027)** and **11
minutes (fall, 16 Sep 2033)**; no unlit slot (17:00, 18:00 or 19:00 end) is past sunset on any practice day
of any instance. The proof is a test (below), not this table. Why these anchors: spring cannot start before
the clocks go forward (second Sunday of March, 8 to 14 Mar; sunset jumps from 18:11 to 19:12), and 22 March
leaves a week and a half; fall must end by about 20 September (sunset 19:00 on 24 Sep 2027, 23 Sep 2028)
and 2 August plus six weeks ends 12 to 18 September, with at least 10 minutes in hand.

## Risks and rollback

- **The fall is shorter than the spring.** — watch: the Decisions below. — if the owner wants more: Options
  1 to 4; changing the fall's length is a change to the helper, the vectors and the proof's constant.
- **The browser's date and the server's disagree** at a window's last midnight (a visitor far from Pacific
  time). — the browser computes "today" in the league's zone, the same constant (held equal to the seed's
  by a test); the page shows the server's own dates once started.
- **A stale tab calls the old RPC.** — covered: the zero-argument function remains.
- **Replacing both bodies moves mutation plants and the catalogue snapshot.** — re-aimed in the same PR
  (lesson 70); the snapshot regenerated and reviewed.
- **The app deploys before the migration** (CI applies migrations on merge, a self-hosted project when its
  operator does). — the choosing call finds no `start_demo_session(p_season)` (`PGRST202`) and the visitor is
  told the demo could not be started, until the migration lands. There is deliberately no fall back to the
  zero-argument call: it would date the demo in a season the visitor did not choose and say nothing.
  `docs/operations/self-hosting.md` says to apply the migration first.
- **The banner's own query.** — `useDemoSeason` reads the demo's first season row (by creation) for its label,
  one request per mount of the timer. The choice could instead ride on the organization row, which the page
  already loads, but that is a column an admin can write (Options B).
- **Rollback:** `docs/sql/20261114010000_revert.sql`, then redeploy the previous frontend (the old page
  calls the zero-argument RPC, which the revert restores).

## Tasks

Each names its test; every test is shown failing first (planted defects below) and must pass at the repo's
default 5 s timeout.

- [x] T1 The rule, JS: `tests/demoSeasons.test.js` — vectors (a date inside each window, the day before a
      start, a window's last day and the day after, 29 Feb, year end, a leap-year start), the default for
      each, an unknown choice, fall chosen in spring takes this year's, in October next year's.
- [x] T2 The proof: the same file reads the unlit slot ends from `fixtures/demo-2026/fields.csv`, walks
      every practice weekday of every instance 2026-2060 and requires each end at least 10 minutes before
      the real `sunsetOnDate` at the seed's venues; it fails on a fall lengthened by two weeks.
- [x] T3 The mirror: the pgTAP file's vectors equal T1's (parsed by the test).
- [x] T4 Server: pgTAP in `demo_sessions.sql` (the vectors; fall and spring each date the season, divisions
      and practice rows; the default; an unknown value is refused; the zero-argument call; an existing demo
      is returned with its own season; `season_weeks` is read) and `demo_practice_schedule.sql` (the seeded
      rows live from the choice's season), all against `CURRENT_DATE`-relative dates.
- [x] T5 Smoke and revert for `20261114010000`; harness plant M63.
- [x] T6 Browser: `tests/demoLib.test.js` (the RPC call, the result's season, the unknown-season failure,
      the mock's twin), `tests/demoStart.test.jsx` (choose, then start; the choice reaches the RPC; the
      default; focus and keyboard), `tests/demoTimer.test.jsx` (the banner names the season).
- [x] T7 E2E on the mock: a scenario per choice (the demo opens with that season named and its dates), and
      axe on the entry choice in both themes.

## Decisions

1. **Fall length (owner).** Built: 6 weeks (2 Aug .. 12-18 Sep). Alternatives: Options 2 to 4.
2. **Anchors (owner).** Spring from the Monday on or after 22 March, fall from the Monday on or after 2
   August. The proof allows both to move by a few days.
3. **Default** is the window containing the date, else the next to begin (the owner's wording: "falls in or
   is nearest before").
4. **Season name and label** become `Fall 2027` and `Fall`, where they were `2027 Season` twice.
5. **The expiry is 30 minutes**, as built since D3; the brief's "one hour" is the purge's rule for stray
   anonymous users. Nothing here changes it.

## Build notes (2026-11-01)

- **Built as planned:** `demo_seed.season_window()`, `start_demo_session(p_season text)`, the kept
  `start_demo_session()`, the entry choice, the banner, the mock twin, and the tests below. No table, column,
  policy, expiry or purge change, so nothing needed the stop rule 14 asks for beyond this plan.
- **Departures found while building:**
  1. **The zero-argument function stays a definer with `search_path=public`** and is PL/pgSQL defined before
     the overload: `docs/sql/20261030010000_smoke.sql` requires every `start_demo_session` to be a pinned
     definer closed to `anon`, and `tests/practiceReaderCensus.test.js` reads the latest definition of a name
     in the file, which has to be the real body, not the wrapper. (A first draft was a SQL-language,
     invoker wrapper; the posture smoke refused it.)
  2. **The three `M60` plants were re-aimed at `M63`** (lesson 70): they mutate the body this migration
     replaces, and the harness pre-flight refuses a plant aimed at a superseded body. Anchors unchanged.
  3. **An anonymous visitor who already has a live demo is not asked again**: the entry opens it (the server
     would return that demo in its own season whatever was asked).
  4. **`tests/demoTimer.test.jsx` and `demoStart.test.jsx` reset the mock's `window.__MOCK_DB__`** per test:
     its demos counted toward the mock's cap of ten across the whole file, which the new tests would have
     exceeded.
  5. **`tests/unwiredLayerImporters.test.js` pins `tests/demoSeasons.test.js`** as an importer and consumer
     of both arms of the sunset helper, as it pins `demoSeed.test.js`.
  6. **The expiry is 30 minutes**, not an hour (Decisions 5): the brief's "one hour" is the purge's rule for a
     stray anonymous user. Nothing here touches it.
- **Planted defects (three, each shown red, then reverted):** the choice not reaching the rule (the smoke and 5
  of the 52 assertions in `demo_practice_schedule.sql` red); a fall of nine weeks (the sunset proof red,
  8,088 slot-days too near sunset); the entry page not sending the choice (5 Vitest tests red, and the
  fall E2E scenario, which read "Spring season"). The other `M63` and `R63` plants are resolved by
  `PLANT_ANCHORS_ONLY=1` and were not run.
- **Review of the change** (`/code-review`, medium; eight findings, six answered in the same PR, the fixes each with a test
  that fails with its fix reverted): the banner read an arbitrary season row (now the first by creation); the
  server's season and dates were parsed and unread (the page now says them once it has them); an ended demo
  bounced the visitor away from the choice (now compared with the clock); `''` was treated as no choice (only
  `null` is); the wrapper sets no TimeZone (a comment says why). Not changed, with the reasons above: no
  fall back when the migration is missing; the banner's extra query.
