# Demo fall window: mid-August to the end of October, sunset flags accepted

Kind: FEATURE (an amendment) · Drawn up: 2026-11-02 against `origin/main` `93987ac` · Owner: the repository
owner · Status: **direction given** (owner decisions below, 2026-11-02); built the same day. Amends the fall
half of `docs/changes/2026-11-01-demo-season-selection.md`; the spring, the choice at entry, the expiry and
everything else in that plan stand. AGENTS.md rule 14 applies (the change replaces a function that decides
what a demo is dated in); the stop conditions it names (a table, a column, RLS, the expiry or the purge) are
not touched, as Design shows.

Every claim about the code is _statically reviewed_ unless marked _executed_. The sunset figures are
_executed_ with the repository's own helper (`packages/core/src/timing/solar.js`; the Edge twin agrees),
at the demo's three unlit venues, in `America/Los_Angeles`, on the seed's own grid.

## Why

The first season-selection build made the fall a six-week "early fall" (Monday on or after 2 August) so that
no unlit practice of the seeded grid could be near sunset on any day of it. The price was a fall that ends
in mid-September, which is summer to a league. The owner's answer (2026-11-02, verbatim):

> "Fall can go from mid-august, like August 17th 2026, through end of October (10/31/26)."

and, on the sunset flags that follow from it (a 19:00 end stops being before sunset on about 24 September):

> "Flag them, as coaches or orgs may be comfortable with extra conditions determined outside of the app ...
> A warning keeps room for that, refusal would break configs that users may otherwise stick with."

So the fall demo **may open with sunset flags on unlit evening practices, and that is the intent**: it shows
the product's sunset check doing what it is meant to do (warn, never block). Do not design the flags away.

## Behavior

- **Now:** Fall starts on the Monday on or after 2 August and runs six weeks (2026: 3 Aug to 13 Sep). The
  entry button reads "Aug 2 to Sep 12, 2027 · 6 weeks".
- **After:**
  - **Fall starts on the Monday on or after 17 August and ends on 31 October of the same year.** The end is a
    date, not a count of weeks, so the length follows the calendar: 2026 is Monday 17 Aug to Saturday 31 Oct
    (76 days, 11 weeks counting the part week); 2027 is 23 Aug to Sunday 31 Oct (70 days, 10 weeks); 2028 is
    21 Aug to Tuesday 31 Oct (72 days).
  - The entry button reads "Aug 23 to Oct 31, 2027 · 10 weeks" (the weeks are the Monday-to-Sunday weeks
    the season touches), and carries **one short line**: evening practices that end after sunset are flagged,
    by design.
  - The instance rule is unchanged: the earliest whose last day is on or after today in the league's zone.
    The last day (31 October) still belongs to the fall; the day after (1 November) takes next year's.
  - Spring (Monday on or after 22 March, 12 weeks) and the default ("the window the date falls in, else the
    next to begin") are unchanged. Today, 2 Nov 2026, the default is still Spring 2027 and Fall 2027 is the
    other button.
- **Unchanged:** the 30-minute expiry (`c_minutes := 30`), the cap of 10, one demo per visitor, the purge, the
  people fences, the seeded league and its 132 practices.

## What a fall visitor sees (executed)

The grid's unlit slots end at 17:00, 18:00 and 19:00 on weekdays, and in the morning on Saturday (U4). The
lit ground is exempt. Sunset at the three unlit venues is the same to the minute. A practice is flagged when
it ends after `floor(sunset)` (`PRACTICE_SUNSET_MARGIN_MINUTES` is 0). Practice days of the fall window
(Monday to Friday) on which an unlit slot ends past sunset:

| Fall | Window           | Weekdays | 19:00 end flagged | 18:00 end | 17:00 end | Saturday mornings | First flagged day |
| ---- | ---------------- | -------- | ----------------- | --------- | --------- | ----------------- | ----------------- |
| 2026 | 17 Aug .. 31 Oct | 55       | 26                | 0         | 0         | 0                 | Fri 25 Sep        |
| 2027 | 23 Aug .. 31 Oct | 50       | 25                | 0         | 0         | 0                 | Mon 27 Sep        |
| 2028 | 21 Aug .. 31 Oct | 52       | 27                | 0         | 0         | 0                 | Mon 25 Sep        |

So the only flagged slot is the one that ends at 19:00, from the last week of September to the end of
October; the 17:00 and 18:00 slots are in daylight on every day of the window (clocks go back on the first
Sunday of November, after the window), and U4's Saturday sessions are over by noon. Of the 132 seeded
practices, 42 sit in a 19:00-ending unlit slot (40 at Orchard Park and 2 at Riverside Fields, counted from the
seed). Spring is unchanged and has none (proved to 2060 by `tests/demoSeasons.test.js`).

**Where the flag shows** (_statically reviewed_; the numbers above are _executed_):

- Nothing is flagged until the visitor asks: the seeded rows carry no flag of their own. When the visitor runs
  the auto-scheduler on Practice Scheduling, the Edge daylight post-pass judges the new placements and, since
  every saved assignment is a locked row, the seeded ones too. The page writes one `role="status"` line in
  the neutral glass-panel style (no alert role, no error colour): "N new practices run past sunset on unlit
  ground and are kept as placed, for you to decide: team ... from DATE (ends 19:00, the latest allowed is
  18:xx)" and "N assigned practices already run past sunset and stay unchanged (proposed, not applied)".
  _Executed_ on the seed (`describeDaylightReport` over the Edge pass's report for the fall of 2026): "42
  assigned practices already run past sunset and stay unchanged (proposed, not applied): team U05B03 from
  2026-09-28, end it 2026-09-27, team U05B03 from 2026-09-29, end it 2026-09-28, team U05B06 from
  2026-09-30, end it 2026-09-29 and 39 more". The 42 are the seeded practices in 19:00-ending slots, each
  reported from the first day its slot is past sunset (25 September to 1 October, 2026-2030).
- The run's record carries each as a finding with severity `warning`; **Apply** records no daylight TIME TBD
  and nothing is withdrawn or moved (`PracticeSchedulingPage.jsx`, owner 2026-10-27).
- The practice repair panel puts a `badge warning` "Past sunset" on a recommendation that would run past
  sunset, with "It is flagged, not blocked: check it before you enact it".

That is the owner's wording made visible: a warning, not a refusal.

## Out of scope

- A second grid, a shorter fall, or hiding the flags (the owner chose to keep them).
- The flag's own behaviour (the daylight pass, the repair panel): separate work covers practice repair, and
  nothing in this change touches practice repair code or the Edge daylight pass.
- The expiry, the cap, the purge, the table shapes.

## Against the rules

- **Rule 14 (persistence):** a function that dates the demo is replaced. No table, column, policy, grant,
  expiry or purge changes, and `start_demo_session` itself is not replaced (nothing in it assumes a length:
  its dates are the rule's `season_start` and `season_end`, and its practice rows run from a weekday's first
  date to `season_end`, which no longer has to be a Sunday).
- **Compute each derived value in one place:** the server still decides the dates; the browser's copy picks the
  default and describes the window, held equal by the shared vectors.
- **Lesson 70:** the new migration replaces `demo_seed.season_window`, which `20261114010000` created, so the
  plants anchored in that body are re-aimed here, and the new body is built on the _deployed_ one: its md5 was
  read from production on 2026-11-02 (read-only) and equals the migration file's.
- **Never leave a field parsed and unread:** `demo_seed.league.season_weeks` is still read (it is the
  spring's length); the fall no longer has a length to read.

## Design

**Server** (one migration, `20261115010000_demo_fall_window.sql`; the next free version, above the ledger's
latest, `20261114010000`, in production and on `main`):

- Checks the deployed `demo_seed.season_window(text, date)` against md5 `f295e02cdf5917c7ccbf012e356a8a8a`
  (carriage returns removed, as `20261114010000` does) and refuses to run on any other body.
- `CREATE OR REPLACE` of that function with the same signature, volatility (`STABLE`) and pinned
  `search_path` (the replace resets the `SET` clauses, lesson 40). A window is now a Monday anchor and **either
  a length in weeks or an end date**: spring is 22 March plus `season_weeks` weeks, fall is 17 August to
  31 October (`make_date(year, 10, 31)`). Everything else in the body is the deployed one, including the
  instance loop, the default and the `22023` / `demo_season_unknown` refusal.
- A comment on the function, and an end-state check with the new rule's vectors (the old fall rows would
  fail it). ACLs are not touched (a replace keeps them; the end state checks neither client role can run it).
- Revert (`docs/sql/20261115010000_revert.sql`): restores the deployed body behind its md5 and its comment.
  It cannot move a live demo's dates; a demo lives 30 minutes.

**Browser:**

- `frontend/src/lib/demoSeasons.js`: the same rule (fall anchored 17 Aug, ended 31 Oct; `weeks` is derived from
  the dates, not stored), still pure.
- `DemoStartPage`: the Fall option gains one line under its dates, linked to the radio as part of its
  description (the page already gives each option a description line, so this is a natural slot). Spring
  has none.
- `mockDemo.js` reads the same helper; nothing to change there.

**Tests** (all pass at the default 5 s): see Tasks.

## Risks and rollback

- **The fall demo opens with sunset flags** — intended (owner). The test now says exactly which days, from the
  seed and the real sunset helper, so a change to the grid or to a venue shows up as a changed set.
- **The page and the database disagree for the minutes between two deploys.** CI applies the migration on
  merge and Vercel deploys the app on the same push. If the app is first, the Fall button shows the new dates
  and the server dates the demo by the old rule until the migration lands (the page shows the server's dates
  once the demo starts, so nothing is hidden). Self-hosters apply the migration first
  (`docs/operations/self-hosting.md`).
- **A season that does not end on a Sunday.** The only readers of a demo season's end are the practice rows'
  date ranges (inclusive to `season_end`) and the calendar; none assumes whole weeks (checked in `smoke`:
  every seeded practice runs from its weekday's first date to `season_end`).
- **Rollback:** `docs/sql/20261115010000_revert.sql`, and revert the page with it (the old page's six-week
  copy matches the old rule).

## Tasks

Each names its test; the planted defects are listed in the build notes.

- [x] T1 The rule, JS: `tests/demoSeasons.test.js` — vectors (the table both implementations are held to),
      the properties over every day 2026-2062 (Monday start, 31 October end, earliest instance), the lengths.
- [x] T2 Spring keeps its proof: no unlit slot within ten minutes of sunset on any practice day, 2026-2060.
- [x] T3 Fall's new truth: the flagged practice days of every fall 2026-2060 are exactly the days the sunset
      helper (core, with the Edge arm agreeing minute for minute) puts the seed's unlit slot ends past sunset,
      derived from the seed's grid and venues; the product's own Edge post-pass reports the same first day for
      each of the seed's 132 practices, and a mutated input turns each comparison red.
- [x] T4 The mirror: the pgTAP file embeds the vectors the Vitest test checks.
- [x] T5 Server: pgTAP in `demo_sessions.sql` and `demo_practice_schedule.sql` (the vectors; a fall demo's
      season, divisions and practice rows carry the rule's dates), smoke and revert for `20261115010000`, and the
      harness plants (M64, R64; the two plants aimed at the replaced body re-aimed).
- [x] T6 Browser: `tests/demoStart.test.jsx` (the weeks, the Fall line and not the Spring one, its accessible
      description) and `tests/demoLib.test.js`; E2E on the mock reads the new copy.

## Decisions

1. **Fall window (owner, 2026-11-02).** Monday on or after 17 August through 31 October.
2. **Sunset flags (owner, 2026-11-02).** Flagged, not refused, and expected in the fall demo.
3. **Dependabot (owner, 2026-11-02).** An `ignore` for `@sentry/react` `>=11.10.0` rides in this PR; it is not
   part of the demo (see the PR).

## Build notes (2026-11-02)

- **Built as planned:** `demo_seed.season_window` replaced on its deployed body (`20261115010000_demo_fall_window.sql`),
  its revert and smoke, the JS twin, the weeks and the one Fall line on the entry page, 29 shared vectors (Vitest and
  pgTAP), the spring's ten-minute proof kept and the fall's replaced by the derivation above, the harness plants, the
  docs, lesson 83. No table, column, policy, grant, expiry or purge change, so none of the stop conditions arose.
- **Found while building:**
  1. **The harness caught two defects in this change's own files before the push.** The revert's comment was cut at
     a semicolon inside its string (`... on p_today; no choice ...`), so the revert did not apply; and the revert's
     verdict query joined a `"char"` with `||` and spelled `search_path=""` in a way the harness's two shell layers
     deleted (now `chr(34)`). The verdict block was then run through the harness's own quoting on a scratch
     database (`restored`) before the full run.
  2. **A smoke runs at head**, so `20261114010000`'s smoke, which still expected the six-week fall, was updated to the
     new dates; the pgTAP `42` / `84` day counts became "ends on 31 October" and "twelve weeks".
  3. **Plants.** The two M63 plants that mutated the rule's body (fall twelve weeks, default window ends last) were
     refused as superseded and re-aimed at M64 with the anchors that moved; M64 adds four (the fall's end, its anchor,
     the rule made callable, the pinned search path) and R64 two. `PLANT_ANCHORS_ONLY=1`: 435 of 435 anchors resolve
     exactly once, none inside a superseded statement. The catalogue snapshot read the same (the rule lives in
     `demo_seed`, which it does not cover), so the file is unchanged.
  4. **The status line the locked rows produce reads as advice** ("proposed, not applied ... end it 2026-09-27"). It
     is neutral and never an error, but a prospect may read "end it" as an instruction; the wording is in
     `daylightReport.js` and the Edge pass, which this change leaves alone.
- **Planted defects (three, each shown red, then reverted):** the Edge sunset rounded up instead of down
  (`Math.ceil` in `supabase/functions/_shared/timing/solar.ts`): 4 of the 54 tests in `demoSeasons.test.js` red (the
  Edge-vs-core flags, both Edge-pass comparisons, and the can-fail test whose baseline they break); the entry page
  not linking the Fall line to its radio: 1 of 16 in `demoStart.test.jsx` red; the migration's fall ending on 30
  October: the migration refuses to commit ("wrong window for 6 of 10 checked dates"). The other M64 and R64 plants
  are resolved by `PLANT_ANCHORS_ONLY=1` and were not run.
- **Verification** (_executed_ means run here and its output read; nothing here is _fully validated_ against the hosted
  project):
  - _Executed_ on the final tree: `npm run typecheck`, `lint` (no ESLint output), `check:unused`, `check:advisors`,
    `test:coverage` at the **default** timeout (exit 0), the whole Vitest suite (487 files, 7,778 tests, no timeout
    raised), the full mock E2E (213 passed, `--workers=1 --trace off`, 20.0 minutes, artefacts deleted), the production
    build with CI's stand-in variables and `check:bundle` (main entry 177.07 KB gz, first paint 278.73 of 289.06 KB),
    `git diff --check`.
  - _Executed_, the database: the migration harness (`HARNESS OK`: 171 migrations apply from scratch, every smoke
    including `20261114010000` and `20261115010000`, every revert including its own, the catalogue snapshot). pgTAP on a
    scratch PostgreSQL 16 with real pgTAP 1.3.2 in the `extensions` schema (the harness prelude stands in for Supabase's
    `auth` and `storage`, with `auth.uid()` and `auth.users` completed): `demo_practice_schedule.sql` 55 of 55;
    `demo_sessions.sql` 113 of 117, the four that fail being the storage-policy assertions 77 to 80, which fail
    identically on `main` `93987ac` (run on a detached worktree of it).
  - _Executed_, read-only against production on 2026-11-02: the deployed `demo_seed.season_window` has md5
    `f295e02cdf5917c7ccbf012e356a8a8a`, equal to the body in `20261114010000`, and the migration ledger ends at
    `20261114010000`.
  - _Not run_: the Deno mirror tests and `deno check` (nothing under `supabase/functions` or the Edge twins changed in
    the end); `supabase test db` (CI's pgTAP job, with the real `auth` and `storage`); the real-backend E2E scenario
    (`real_backend_demo.feature`; its entry step takes the preselected season: statically reviewed); `test:perf`;
    Turnstile against Cloudflare; a browser other than Chromium; the migration against production.
