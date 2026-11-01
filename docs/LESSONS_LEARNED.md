# Lessons Learned

Durable, hard-won knowledge consolidated from the project's build-out (epic plans,
wave audits, the execution progress log, and pre-production audit reports — all
since retired). Each lesson is stated generally so it stays true as the code
evolves. If you are about to make a decision one of these covers, read it first.

## Security & multi-tenancy

1. **Every `SECURITY DEFINER` function must lock its search path.** Definer
   functions in a multi-tenant schema are hijackable through the caller's
   `search_path` unless they `SET search_path = public`. The `check:advisors`
   CI gate enforces this; never waive it.
2. **Views bypass RLS unless told not to.** A view owned by a privileged role
   reads as that role. Mark reporting views `security_invoker = on` (Postgres 15+)
   or RLS silently stops applying to them.
3. **RLS is allow-by-membership, never deny-by-exception.** The gate is
   `is_org_member(organization_id)` (or an equivalent org check) on every
   policy. A `USING (true)` policy is a cross-tenant leak waiting to happen.
4. **CHECK constraints only exist in the real database.** The mock Supabase
   client enforces no constraints, so an RPC that inserts a value outside a
   CHECK whitelist passes every test and then aborts its whole transaction in
   production. When adding enum-like values, update the constraint in the same
   PR and verify with a SQL smoke script. Audit actions specifically are no
   longer a CHECK whitelist: `audit_log.action` is a foreign key to the
   `audit_actions` lookup table (migration `20260613000006`), so a new action
   is registered with a one-line
   `INSERT INTO public.audit_actions (action) VALUES ('x.y') ON CONFLICT (action) DO NOTHING;`
   instead of re-stating a 60-entry constraint.
5. **Revoke anon EXECUTE on definer functions.** Anonymous users can otherwise
   call privileged RPCs directly, regardless of UI gating. Since migration
   `20260614000000`, default privileges in `public` no longer grant EXECUTE to
   `PUBLIC`/`anon` on new functions (authenticated + service_role keep it), so
   an intentionally public function (e.g. `submit_registration`) needs an
   explicit `GRANT EXECUTE ... TO anon`.
6. **Free-tier Supabase pauses after ~7 days of inactivity** and caps pooled
   connections (~60). The weekly keepalive cron in CI is load-bearing — do not
   remove it. Long-running Edge Functions must not hold connections.

## Schema & data

7. **Denormalized columns need a single synchronization authority.** When a
   join table is the relational source of truth (e.g., rosters) and a
   denormalized pointer exists for convenience, sync them with a database
   trigger — not by hoping every writer remembers. Frontend-side hydration
   fixes one reader; a trigger fixes all of them.
8. **Stage, validate, then promote — never import directly.** CSV imports go
   into staging tables, validate there, and promote via an idempotent RPC keyed
   on the external registration id and `import_job_id`. This makes re-imports
   safe, interruptions recoverable, and rollbacks possible. Heartbeat columns
   (`last_heartbeat_at`, `processed_rows`) let stale jobs fail safely instead
   of wedging the UI.
9. **Canonicalize import headers before mapping.** Registration-platform CSVs
   have duplicated, misaligned, and long-question headers. Whitelist + dedup +
   alias-map first; only then derive fields. Re-import must COALESCE rather
   than overwrite fields the new file doesn't carry (tri-state, not boolean),
   or absent columns wipe real data.
10. **Scope uniqueness to the tenant from day one.** Globally-unique columns
    (e.g., a globally `UNIQUE` email) become multi-tenant bugs later; the
    natural keys here are per-organization or per-season (divisions are unique
    per `(season_settings_id, name)`, not per org).
11. **Migrations replace functions wholesale.** Patching fragments of a
    `CREATE OR REPLACE FUNCTION` across migrations causes drift; copy the
    latest full revision and edit that. Every migration ships with a revert
    and a smoke script under `docs/sql/`.

## Frontend patterns

12. **Side effects never live inside React state updaters.** StrictMode
    double-invokes updaters in development; a mutation fired inside
    `setState(prev => ...)` runs twice. Compute in the updater, act outside it.
13. **The mock client and the real schema drift apart silently.** A column or
    embed that exists only in the mock (or only in Postgres) passes all tests
    and fails in production. When writing a query, verify the column against
    `supabase/migrations/`, not against the mock seed.
14. **Optimistic UI needs a snapshot to roll back to.** Capture state before
    the mutation, apply eagerly, restore on RPC failure — and _check_ per-item
    results of batched mutations; a helper that resolves `{ success: false }`
    instead of throwing will make `Promise.all` look like success.
15. **Bound concurrency on per-row RPC fan-outs.** Strictly sequential loops
    are slow; unbounded `Promise.all` over hundreds of rows brown-outs the
    backend. Chunk (≈8 at a time).
16. **Drag-and-drop:** validate on `dragOver` (live feedback), persist on
    `dragEnd`; use `useDroppable` for fixed single-occupancy slots and
    `useSortable` only for reorderable lists; always provide a non-drag
    (menu/keyboard) alternative for accessibility.
17. **Token-based theming pays for itself.** All colors flow from CSS variables
    on `:root` with theme overrides via `data-theme`; legacy alias variables
    let old components re-theme without edits. Roll out design changes phased
    (brand → tokens → chrome → pages) so each commit stays shippable.
18. **Grid layouts should mirror the operator's mental model.** For field
    scheduling that meant columns = fields, rows = time slots (the "Saturday
    on paper" view), with composite droppable keys (`fieldId:slotKey`).

## Testing & CI

19. **E2E worker isolation is mandatory.** The mock client lives in
    sessionStorage; parallel Playwright workers cross-contaminate it. Run
    `--workers=1` in CI, and regenerate specs (`bddgen`) after every `.feature`
    change.
20. **Most E2E flakiness is seed-data, not timing.** Hooks filter by the active
    organization — mock rows missing `organization_id` render empty states and
    fail selectors. Assert on DOM, never on mock internals; wait for hydration
    before interacting.
21. **Tests run in UTC.** Timezone-sensitive logic needs fixtures with explicit
    offsets, not local-time parsing.
22. **Don't pin platform-specific binaries.** npm/rollup resolve them via
    `optionalDependencies`; hand-pinning one platform's binary breaks CI on the
    other.
23. **Vitest hygiene:** reset mock chains between tests, flush fake timers
    explicitly, and watch for early returns on empty data that vacuously pass
    assertions.
24. **Agent/audit output is a lead, not a finding.** Generated audits have
    fabricated issues (e.g., "unused imports" that were vitest globals).
    Verify every reported finding against the file before acting — and budget
    gates (`check:bundle`, `check:advisors`) beat report-reading.
25. **A guard that only runs inside an expensive sweep does not run.** The
    database harness's mutation prover carries a census pairing every health
    claim `run.sh` prints with the plant that proves the check can fail. It
    was correct, both-directional, and unreachable: its universe is a green
    baseline transcript, so reaching it costs a multi-hour sweep — and a
    pre-flight refusal had made that sweep unstartable outright. Eight hollow
    `(checked)` claims accumulated behind it. Split such a check: answer the
    half that can be read off the source (what a script prints, diffed
    against what a registry declares) in CI on every PR, keep the runtime
    half for what only it can see, and state in both which is which. A guard
    someone has to remember to run is the defect it was written to catch, one
    level up.
26. **"Enforced elsewhere" is not "checked here", and the wording has to say
    which.** One harness claim turned out to be unfalsifiable by
    construction: every defect that would break it aborts the migration build
    three stages earlier, so the check it advertises can never be the thing
    that fails. A claim nothing can falsify either loses the word that says
    it was verified or keeps it dishonestly — there is no third option, and
    the demotion belongs in the line itself, with its reason, rather than in
    a comment beside it.

## Process & rationale

27. **CI first, features second, live backend last.** The pipeline protects
    everything downstream; features iterate fastest against the mock; the
    risky backend cutover happens once, with the full suite green.
28. **Staged review → apply beats direct writes.** Generated schedules and
    rosters go through a review state ("ghost" runs with no DB writes) and an
    explicit audited apply RPC. Users get dry-runs; the audit log gets intent.
29. **Honest UX over aspirational UX.** A button must describe what the code
    does today ("move players, clear rosters"), not what a future iteration
    might do ("regenerate"). Surface mutation results; never report success
    that wasn't checked.
30. **Prototype before building big.** A throwaway prototype validated the
    grid/locking UX before production work, and the hi-fi design prototype
    drove the redesign. Cheap iteration first, then commit.
31. **Keep historical records out of living docs.** Point-in-time audits,
    progress logs, and completed plans rot into misinformation. Living docs
    describe the present; durable knowledge goes here; everything else is
    recoverable from git history.
32. **A helper that runs as the wrong principal fails everywhere and says nothing.** Every Edge
    audit write ran through the service client, where `auth.uid()` is NULL, so
    `audit_log.user_id NOT NULL` refused each row and the error was only logged (#577). The fixes
    that held: the audit row is written in the same transaction as the save, so a failed write
    rolls the save back (#600), and the helper takes a branded user client, so the wrong client is
    a type error. The same sweep found a game-schedule save any member could call (#600, migration
    `20261018070000`).
33. **A gate nobody runs or requires is not a gate.** Coverage thresholds were configured and never
    enforced, pgTAP ran on some PRs, and the staging suite skipped itself (M3.1, M3.2, M4.5). The
    fix was to run each in the required CI, hold the required list to the workflows' real job names
    with a test (`tests/rulesetRequiredChecks.test.js`), and delete the one test that could not
    fail where it mattered (`tests/integration/staging.test.js`).
34. **A mock that cannot refuse hides the defect.** The mock's non-UUID ids made every game slot
    unschedulable and the forged E2E steps hid it; the real-backend E2E (#578) found audit writes
    failing and a stale-event bounce that the mock cannot have. Keep a small
    real-backend suite beside the mock, and make a step read what the page shows, not the store.
35. **Pin behaviour before changing it.** The solver's date model (#593) was held to a golden
    generated on `main` first and merged byte-identical on the undated corpus; the RLS rewrite
    (#596) was preceded by a persona matrix of 910 cells on today's policies (#595) and a revert
    that restores the catalogue exactly. A change you cannot diff against a recorded baseline is
    only reviewed, not proven.
36. **A CSV a person opens neutralises formula cells through one helper.** A team, coach or note
    that starts `=`, `+`, `-` or `@` (after any mix of leading whitespace, or a tab or CR) runs as a formula in Excel, LibreOffice and
    Sheets. Every export writes its cells through `escapeCsvCell` (`packages/core/src/csv.js`):
    an apostrophe prefix, except a plain signed number, so `-5` and `+15551234567` survive. Two
    paths deliberately do not use it, because a prefix would corrupt data that is read back:
    `ColumnMapper.serializeCanonicalCsv` (our own re-packaging of an upload for the importer) and
    `fieldAdmin`'s `toCsv` (a lossless round trip). Escape where data meets a spreadsheet, not
    where it is stored (B2, DS-4).
37. **A throttle on a public RPC counts the caller's own rows, under a lock, in absolute time.**
    `submit_registration` is open to `anon`, and the Edge rate limiter cannot reach a PostgREST
    RPC. The throttle counts the caller's recent `registrations` rows (no log table; a refused call
    inserts nothing) under `pg_advisory_xact_lock`, so concurrent calls cannot both read nine. The
    window is `now() - interval`, and the insert sets `created_at` to `now()` itself: the column
    default `timezone('utc', now())` is a zone-less timestamp that the session time zone
    reinterprets, and a PostgREST caller sets that zone (`Prefer: timezone=`). Under `+14` the
    default dates a row 14 hours back, outside every window. Never build a security window on
    `timezone('utc', now())` (B2, DS-5; the repo-wide idiom is logged in the remediation plan).
38. **What a throttle counts must be immutable to the caller.** The first DS-5 throttle counted the
    caller's `registrations` rows while the FOR ALL policy `registrations_user_own_or_admin` let
    the same caller UPDATE or DELETE them: back-date ten rows and the eleventh call passes. Before
    building a limit, an audit or a window on rows, read every policy on that table for the
    caller's role, not only the function's own SQL. The fix kept members to SELECT and their
    writes to the SECURITY DEFINER RPC (B2, DS-5; Codex review on the PR).
39. **An axe-core minor can add a rule.** axe-core 4.14 (via `@axe-core/playwright` 4.14.0, a
    Dependabot minor) enabled `label-content-name-mismatch` (WCAG 2.5.3 Label in Name), which
    4.13 shipped as experimental and off. 45 E2E scans failed on buttons whose `aria-label` left
    out their visible text: the org and season switchers (no space between the label and value
    spans, so the visible text read "SeasonFall 2026"), the avatar's initials, `InlineField`'s
    "Edit Team" over the value, and the Auto-Generate button. A name must contain what a speech
    user sees; `aria-hidden` on the visible text does not satisfy axe, and neither do brackets
    around it. Run the axe E2E scans on any axe bump, and pin label-in-name with
    `tests/helpers/labelInName.js`, which jsdom can check without axe.
40. **Pin a function's zone after redefining it, and fix an argument default at its source.**
    `timezone('utc', now())` was fixed by pinning 42 functions `SET timezone = 'UTC'` rather than
    rewriting their bodies (`20261021040000`). Two traps: `CREATE OR REPLACE FUNCTION` resets the
    function's `SET` clauses, so a pin placed before a redefinition of the same function is lost;
    and an omitted argument's default is evaluated in the caller's query, in the caller's session,
    before the function's own `SET` applies, so `fail_stale_import_jobs`' default had to become
    `now() - interval` itself. Posture checks that compare `proconfig` to one exact array break on
    any added setting; check the settings you require, and refuse the ones you forbid.
41. **A policy's helper is executed with the caller's privileges, so a narrowed read needs a client-callable definer that asks only about the caller.** The permit tables' coach read (`20261102010000`) is "a field where a team I currently coach has a game or a practice". The helper that finds those fields (`coach_field_ids_of`) is internal, as `coached_team_ids_of` is, and a policy cannot call it; three thin definers (`coach_covers_permit_scope`, `coach_reads_facility_permit`, `coach_reads_facility_permit_file`) read `auth.uid()` themselves, so they leak nothing about anyone else and are safe to grant. Each client-callable function must also be named on `demo_sessions.sql`'s anonymous lists, and a new table that hangs off `fields` or `locations` meets the two smokes that derive their cascade closures from the catalogue (`20260907000000`, `20260909000000`): declare it a booking or not, with the reason, rather than loosening them. A storage policy whose casts could raise (`::uuid` on a folder) puts every cast in the `THEN` of a `CASE` whose `WHEN` tested the whole name's shape.
42. **An Edge Function request has 2 s of CPU in all, and awaiting does not reset it.** The practice optimiser yielded every 100 iterations "to avoid the 2 s CPU limit" and guarded only a 140 s wall clock, so a 128-team league could be killed with nothing returned. The platform counts CPU per request on every plan (150 s of wall clock on Free): a yield spends none of it and gives none back. `runPracticeOptimizer` now stops at `CPU_CAP_MS` (1.5 s, measured from when the handler started, since the greedy seed, scoring and post-passes are CPU too; wall clock stands in for it because the search is synchronous), returns its best schedule and says `cpu-cap`. Test it with an injected clock, not a wait. A fixed seed means a re-run repeats the same search, so the page does not promise that running again improves a capped result.
43. **Name the active organization, never `profiles.organization_id`.** Account and Season settings addressed their audit rows by the profile's organization, which is null on every production profile, so those rows were skipped without an error; and the password change's fallback read the caller's memberships with `.single()`, which fails for an admin of two organizations. The server has no "active organization" (every policy and RPC takes the row's or the argument's), so the app must always send the one it is working in: `currentOrganization.id`, passed into `updatePassword`, and `refetchOrgs(orgId)` so a redeemed invite lands in the redeemed organization instead of the stored one (`tests/organizationSwitch.test.jsx`, `tests/authUpdatePasswordAudit.test.jsx`; `docs/changes/2026-10-27-admin-only.md`, F5). A check that an admin of two organizations can switch needs two memberships for one profile; with one, the old code passes it.
44. **Balance a round robin by where a team sits in the rotation, and keep the placement order keyed on the pair.** The generator made the smaller id host every game of a pair, so the smallest id hosted all n - 1 (a spread of n - 1 for every n). The rules that look right balance only part-way: alternating by round leaves a spread of 2 to 3, a circulant leaves runs of up to 7 games on one side, and "the team with fewer home games hosts" fails at odd n. Orienting by rotation index (the team at the odd index hosts; the fixed team by week parity, or for odd n by whether its opponent's bye fell at an odd index) gives a spread of at most 1, exactly (n - 1) / 2 at odd n, and runs of at most 2, with every pairing and bye unchanged. The sort that decides which game is placed first must stay on the alphabetised pair: sorting by the new host moved pairs to other weeks and slots in 10 of 15 sizes of a tight grid, and a test that places both orders and compares (week, slot, field, pair) sets is what catches it. A saved pair is kept, never rebalanced (`keepSides`, from the latest saved run), so a regenerate moves no side the league has seen; `home-away-imbalance` says when a team is more than one game off, and a dropped game can make a balanced orientation read two apart, so the warning names the team's unscheduled matchups (`docs/changes/2026-10-27-phase-d-scheduling.md`, A).
45. **Removing a role turns every "member, not admin" distinction into a no-op, and the checks that
    drew it go quiet without failing.** With the `coach` role gone (`20261104010000`) every member is
    an admin, so `is_org_member` is an admin test by construction; a plant that swapped
    `is_org_admin` for `is_org_member` can no longer turn any smoke red, and a pgTAP persona that was
    "a member who is not an admin" is now a non-member. Re-aim such a check at what still differs (no
    check at all, or `USING (true)`), keep a catalogue test that pins the role list, and let the
    harness's pre-flight name the plants whose target function was dropped or replaced; it cannot see
    a policy altered in place, so those were found by reading. Also: drop a column with a foreign key
    to a table you do not own in its own migration, with a revert that adds it back empty and a smoke
    that proves nothing else read it (`20261104020000`).
46. **A count per team makes every "per team" report a lie; count from the roster and the requirement.** Practices per division turned "one practice per team" into "N units per team", and four things keyed by team quietly broke: the run's unassigned list (a team given 1 of 2 vanished from the report), the metrics that counted teams without a practice, the writer (nothing stopped two rows of a team on one weekday, or a third row for a division of two), and the page's apply summary. The subject set is the roster crossed with each division's count (`practices.teams`), never the solver's output; the writer re-checks the rules SQL can check on new auto rows, because a client that bypasses the solver is a client the solver's rules do not bind. Keep a one-a-week run byte-identical to the old one (the unit id is the team id then) and test it, since that is the case every league is in.
47. **A rule that blocks on a judgement call is a flag waiting to be asked for.** The daylight pass cut a placement at its first date past sunset and the repair refused such a re-home; the owner's answer was "flag, but don't block". Where an unknown (no coordinates, no table row) cannot be judged, keep refusing: unknown is not past, and it must never be read as legal. Test both directions (past is kept and flagged with its reason; unknown is refused; in daylight is neither), or one will silently become the other.
48. **Make a new NOT NULL column that every writer must fill default itself, in a trigger, and then
    expect the old fixtures to need a parent row.** `players.season_settings_id` and
    `coaches.season_settings_id` (`20261108010000`) are NOT NULL, filled on insert by a trigger
    (the division's season, else the active one), so the hundred-odd writers and fixtures that name
    no season kept working; the fifteen smokes that build an organization with no season, or only a
    draft one, were the ones that failed, and each needed the one thing production always has (an
    active season). Also: a trigger that backstops an RPC's check makes the RPC's test pass for the
    wrong reason. The roster-across-seasons test passed with the roster trigger removed, because the
    `team_id` sync trigger on `players` refused it first; the test pins the roster trigger's own
    message to tell them apart. And a backfill that updates rows fires every trigger on them (a
    demo league's read-only fence, `updated_at`, custom-attribute validation): switch off exactly
    those for the backfill and prove the end state has them on.
49. **A "not scheduled" row that lives in the schedule table is read as scheduled by every reader you forgot.** The plan wanted TIME TBD rows in the schedule itself; PR B found that a `practice_assignments` row with no slot or dates would be a locked occupant to the lock loader, a key to the writer's prune, a practice to `teams_without_practice` and a team to the metrics, and any reader missed counts a missing practice as held. Keep the list in a table only the export and the roster check read (`schedule_tbd`), and build it from the roster and the requirement under the writer's lock, so it cannot go stale across saves. Two traps on the way: a new table that cascades from `teams` fails the catalogue walk in `admin_delete_team`'s pgTAP and smoke until the delete counts it (the same migration replaces the function), a table the app only reads should have no write policy at all (an admin-insert policy checks the row's own organization, not the organization of the team id it carries; Codex found a cross-tenant name leak through the definer read that way), with a trigger that refuses any row naming another organization's parent so the definer writers stay honest; and every plant that aimed at a body you replace again must be re-aimed (the harness's pre-flight refuses a dead one, and said so for 16 plants). A derived list needs a writer that does not depend on the save it is derived beside: the list was rebuilt only by the practice save, which refuses an empty review, so a run that placed nothing left the export silent about every practice owed (Codex); it is now also rebuilt by an admin refresh the export calls first. And a definer that takes labels is a hole if a client can call it: the first refresh function could be called directly to reset every saved reason with no audit row (Codex). Split it: the labels-taking function checks its own call stack (`PG_CONTEXT`; an invoker caller cannot be told from a client by a role grant) and the client-callable one takes no labels, keeps what was saved and audits only a change. A smoke or pgTAP that fixes a live date range, with a function that compares it to `CURRENT_DATE`, goes red on a day nobody changed anything: derive live ranges from `CURRENT_DATE`.
50. **A comparison that cannot read a time is not the same as a time declared TBD.** The baseline parity read `TIME TBD` as a missing time, so one TBD row in a published export made every comparison "unreadable as a verdict" (`PARITY_FIELD_ABSENT`), and two TBD rows of one team shared a key (`PARITY_KEY_AMBIGUOUS`). The baseline now treats the declared token as the value on both sides and numbers the TBD rows (the ordinal); the generic reader still refuses to certify an unreadable time, which its own test holds.
51. **A demo's seeded schedule is the product's own answer, or it is a picture of one.** The demo's first practice schedule was a hand-written greedy fill; the owner's spec (two practices a week on different weekdays, in slots of the division's length, one coach never in two places, U9 and older left for the visitor) is exactly what the auto-scheduler decides, and a hand-written fill can pass every rule its own test knows and still differ from what the visitor's next click produces. The generator now runs the Edge function's own solver (`runPracticeOptimizer`, fixed seed, the CPU cap off so the answer depends on the seed, never the machine) and throws when a practice is unplaced; the test reads its rules from the fixture and the owner's spec, regenerates for drift, runs the solver again over the teams left with the seeded rows held (all 120 placed, none TIME TBD, and the 252 together break no rule), and shows each rule failing in a copy. A generated fixture file (`fields.csv`) comes from one grid definition, so the CSV cannot drift from the shape the seed and the tests assume. And an applied migration's generated region is frozen: the league rows stay in `20261030010000`, the test requires them to start with what the generator builds, and the facility that changed is a new region in the new migration, behind `DELETE`s of what the old one seeded.
52. **Sunset moves with the date; a grid does not.** "Practices fit before sunset, one lit field may run past it" cannot be a property of a static grid: at the demo's latitude a 19:00 end is before sunset on about 53% of days of the year (April to mid September) and a 17:00 end on far fewer, so for the demo's first twelve weeks of a winter visit every unlit practice is past sunset. What a seed can do is choose which ground is lit and where the slots end, measure that against the solar twin over the months, say the rest is flagged (never blocked), and plant the case that makes the measurement fail (a grid ending at 20:30 names April). The demo also gains a per-venue lighting flag in its seed: it used to light every ground, so no flag could ever show.
53. **A client's answer is a proposal; the server's check is its own reload, a rule at a time, and a digest only says the two sides saw the same thing.** The browser optimizer (Phase D PR D) searches with inputs the server handed it (`prepare`) and sends back placements; `verify` loads every input again itself, refuses 409 when the digest of what it loaded is not the digest the browser claims, and seats each placement through the search's own admissibility check, in sorted order, so a schedule that is legal as a whole passes in any order and one that is not loses the same placements every time. A refused placement comes back as its practice unplaced (`verify-refused`, with the rule), because the subject set is the roster's practice units, never the proposal. Three things made it checkable: one rule function that returns the rule it broke (`hardConstraintRefusal`) with the boolean the search uses defined as that function compared with `null`; a canonical encoding (sorted keys, map entries and set members; array order kept because it is the greedy seed's order) so two reads of the same data digest the same; and a test that claims the digest of a tampered copy and is still refused, because the server compares with its own reload and never with the body.
54. **A worker is its own bundle, so what a plan assumes the page already ships, the worker ships again.** The plan sized the worker at 16.1 KB gzip "without zod" because "zod is already in the frontend"; the first build of the real worker was 40.9 KB gzip, 25 KB of it zod, which the scoring engine had pulled in through two plain functions that lived beside the request schemas. They moved to a module with no zod in it (`schemas/scoring-issues.ts`, re-exported where they were) and the worker is 15.5 KB, as the plan said. The rule's 40,000 B cap is the plan's, and it is also what catches zod coming back (by 944 B). Measure the real chunk before trusting an estimate made with a library left out, and keep a worker's graph free of schema files.
55. **Moving a request's inputs into one object lets three modes share them, and every test that pinned the old call site by its text has to follow.** `auto-scheduler` now builds the run's whole input once (`solverInput`) and `solve`, `prepare` and `verify` each use it; six source-pin tests that sliced `index.ts` after `await runPracticeOptimizer(` to find the arguments went red for the move, not for a defect, and were re-aimed at the object. Pins on text are the price of a serving module no test can import; keep them few and aimed at the object a decision is made on.
56. **A "read-only" rule that keys on the caller's session needs the jobs that have none, and the tests that leave a session behind.** Completed seasons are read-only for players and coaches (`20261111010000`), enforced by one trigger on each table rather than a check in every writer; a blanket refusal would also have stopped the retention job (`minimise_import_people_data`), the demo purge and the cascade of a deleted organization, so the trigger refuses only a signed-in caller (`auth.uid()` is set, whether the write came through an RPC or directly), and a delete whose organization is already gone passes. The cost showed up in the tests: a pgTAP file that sets a JWT and then `RESET role`s still has a session, so its set-up writes to a completed season are refused; clear the claim (`SET LOCAL "request.jwt.claims" TO '{}'`) before seeding. Also: a lock whose test can pass without the lock (the activation's row locks make a second session wait anyway) needs a probe that reads the lock itself (`pg_locks`, undone inside a savepoint) and a control that says no.
57. **A pgTAP count over a table a scheduled job also writes needs the transaction's own rows.** `demo_sessions.sql` counted `demo_purge_log` rows with no note and expected the two purges it runs itself; CI's local Supabase runs the real `purge-expired-demos` job every ten minutes, and the file ran at 07:20:00.6, on the tick, so the job's committed row made it three (PR #680; the stand-in `pg_cron` of the harness never ticks, so nothing local could show it). The suite's rows carry the transaction's `now()` as `ran_at`; filter on it. Reproduced by committing one such row before running the old file (3, want 2) and the new one (passes).
58. **A rule that freezes once rows exist must also freeze while rows are staged.** The age cutoff, the season year and the division windows were fixed "once the season has players", and an import stages each natural age first and promotes it at the apply; a rule change in between left staged ages counted under the old rule and promoted under no one's (Codex, #680). The helper asks the staging table, not the players table (`season_has_pending_player_import`), the guard triggers and the RPCs both ask it, and the refusal says what to do (finish or cancel the import). The test that proves it stages a row, is refused, cancels the job (fails it), and is allowed.
59. **A hot-path change is timed in the mode CI runs.** Counting a natural age by the division windows read each window's dates per player; the season fixture's play-up comparison counts ~600,000 ages, and the file went from ~2.3s to ~3.5s per test under `--coverage` (v8 prices every function call), past vitest's 5s in CI's parallel run, while passing in isolation without coverage (1.1s against 1.2s, which is why it was put down to load; the receipt was main passing the same file in CI). Compile once per roster (`compileDivisionWindows`), skip the lookup when no division has a window, and time the file with `--coverage` on the base and the branch.
60. **A column list is a second copy of the schema, and a test double that ignores it hides the omission.** The Teams page selected the division columns by name and left the new window columns out, so the rule worked in core, the Edge function and the unit tests and never in the page; the page's test double returned whole rows whatever the select asked for. The double now returns only the columns asked for, and the control (no window on the row) shows the same registrant seated where the cutoff alone puts them.
61. **A guard that asks "is anything in flight?" cannot see the moment before the first thing is.** The pending-import check refuses a rule change once rows are staged; the validation reads the rule first and stages after, so a change in that gap found nothing to refuse and the staged ages were counted under a rule the season no longer had (Codex, #680 round two). Close the whole window where the work is *finished*: stamp the work with what it was computed under, and have the step that consumes it compare (`age_rule_changed`).
62. **A stamp is only as good as what it is compared by, and where it was read.** The first stamp was a digest of the rule's values, taken in one request before the rule was read in another. A change and its reversal (A, B, A) left the same digest over ages counted under B, and the second read could see a state the stamp had not (round three). What holds: a number that only goes up, bumped by a trigger on every change that moves an age (the cutoff, the year, a window-bearing division's window, band and, where the name is the band, name); one statement that returns the rule *with* its revision, so the stamp is the revision of exactly the data used; and the consumer counts from what that statement returned, with a test that fails if the handler reads a table itself. The pgTAP case is A, B, A with the values equal and the revision two higher.
63. **A rule that is frozen is frozen in every part of it.** "The cutoff, the year and the windows cannot change" left the age band beside the window free: `upsert_division_for_import` moves `min_age`/`max_age` on a division that keeps its window, and the window guard returned early because the window was unchanged. A band matters only on a division that bears a window, so the guard now covers exactly that, and a name where it supplies the band. The page that counts ages must also see every part: the Teams page built its descriptors from the file's programs only, so a window on a division with no registrants was ignored.
64. **A lock that only some writers take is not a lock.** The finalizer and the rollover RPCs took the season lock; `upsert_division_for_import` and a direct write did not, so an uncommitted band change could race a finalization that had read the revision (Codex, round four). Put the lock where every path passes (the guard triggers), take it before the check it protects, and show it in a test that cannot be fooled by an earlier statement: `pg_locks` for an organization nothing else in the transaction has touched, with the control that it is not held before the write. A real two-session race does not fit one pgTAP transaction; say so rather than imply it. And check the order: a lock taken after a row lock can deadlock with one taken before it.
65. **"Read-only" is a list, and a column is on it too.** A completed season's players, coaches, schedules and TIME TBD list were read-only; its `timezone` was not, and the calendar feed reads that column to expand every occurrence. Walk the readers of a "history" row, not only its children, and give the control the same note.
66. **The table that holds the results is on the read-only list too.** Completed seasons were read-only for people, schedules, the TIME TBD list and the clock; `games`, where the scores live and which the standings view reads, was not, and `update_game_score` wrote it with no season check (Codex, #680). Walk every table a "history" screen shows, and give the grid the same rule (a row-level read-only, not only the database's refusal). The check that lets an organization's cascade through has to cover an UPDATE too: the `SET NULL` a deleted season makes of `games.season_id` is one.
67. **A migration over an empty table proves only that it parses: plant the old shape and apply it onto that.** Production held no preference rows, so a build from scratch, every smoke and every pgTAP file ran `20261112010000`'s backfill over nothing. The harness now builds to the migration before it, plants eight old scalar rows (a `dont_care`, a pending request, a superseded and a rejected one, a coach of two teams, a coach with no team) and applies the migration onto them, so copying a `dont_care` row, or one rule per row instead of per team, prints a different number. The migration also counts its own result against an independent recount and refuses to commit on a mismatch.
68. **A CHECK test names the constraint it expects, or it passes for the wrong reason.** The first "a must nobody accepted is refused" tests inserted a row that broke two CHECKs (an undecided must and a must in force), so removing the one under test changed nothing. Insert the row that breaks only the constraint under test, assert its name in the error, and plant the constraint's removal. The same holds for a canonical form: two arrays that mean the same rule in a different order are one rule only if the signature sorts them first.
69. **When a verdict gains a field, every reader of the verdict is a call site, including the one that decides "nothing happened".** The preference gate's answer grew from two booleans to the ids of the rules a candidate breaks. The solver-input digest skips a verdict it calls default, so its default test had to learn the new field or a verdict carrying only that field would have been skipped and the digest would not have moved when a rule started to bite; the unplaced reason, `prepare` and `verify`, the scoring and the repair adapter each read it too. Search the old name, list the readers, and make the drift test enumerate the product of inputs (22,053 cases here) through both twins rather than sample it, with a meta-check that each kind of case it claims to examine (a refusal, a conflict, a keep with nothing to keep) really occurs.
70. **Replacing a function wholesale moves every mutation plant aimed at its old body, and the harness refuses the run until they follow.** `20261112010000` replaced `create_import_job`, `import_allowed_keys` and `admin_delete_team`; eleven plants anchored in the earlier definitions were refused by the pre-flight (the installed body was not the one they mutate). Re-aim each at the new migration in the same PR and run `PLANT_ANCHORS_ONLY=1`; retire a plant whose claim the migration retired (four: two on the old decide RPC, the read policy, the one-approved index) together with its registry row, rather than leaving a claim nothing prints.
71. **A revert converts a row by what it is now, not by what it once asked for.** The preference revert wrote every rule with `requested_level = 'must'` back as an enforced must, including one an admin had kept as a prefer, so rolling back would have turned a declined request into a hard constraint. Convert by the effective level; restore the asked-for level only for a request still pending; and make the de-duplication key and the "would have to guess" guard use the written level and status, or two rows that differ only in what they come back as collapse into one. Extend the revert stage's seed with each state the lifecycle has (pending, accepted, kept as prefer) and prove it by running the old conversion in a scratch copy.
72. **A lock on the job's own row does not serialize two jobs that write the same data.** Two preference files naming one team each replaced the imported rules they could see before either inserted its own, so both files' rules stayed in force. Lock what is shared (here a transaction-scoped advisory lock per team, taken in id order and as a statement of its own so the replacement reads what the first file committed), and test it deterministically where a two-session race cannot be reproduced: the backend holds exactly the named teams' locks after the call and none before, and the source takes them before the replacement; show the test red against the function without the lock.
73. **A new member of a pipeline is a member of every list the pipeline keeps, and the repo's censuses find the lists you forgot.** The evaluations import (`20261113010000`) was five lines of intent and eight lists: the job-type and staged-row CHECKs, `create_import_job`'s type list, the deferred-apply pair's, the allowlist's three copies plus `import_allowed_keys`, the demo fence's census of functions that write players (`demo_sessions.sql` failed twice until the finalizer was declared there), the retention jobs, and the harness's plants (its pre-flight refused a plant that still aimed at the `import_allowed_keys` body this migration replaces). None of the eight was in the plan; each was found by a test that enumerates its subject set from the catalogue, not from the change. Walk the pipeline's lists before writing, and re-aim every plant at a body you replace.
74. **A preview that is a second implementation drifts; make it the same statement with its writes off.** The confirm step needed the counts an apply would produce. `finalize_evaluation_import_job(job, errors, dry_run)` is one `WITH` statement whose `UPDATE`s carry `AND NOT v_dry`, so the plan and the writes cannot disagree, and a meta-assertion raises if an apply writes a different number of players than it planned (a dry run must write none). The tests compare the dry run's result with the apply's to the last key, and read every player back to the last column after the dry run. Also: PL/pgSQL ends an expression at the first `THEN`, so `IF a <> CASE WHEN b THEN 0 ELSE c END THEN` is a syntax error; compute the case into a variable.
75. **Check that a field an import writes is read before the plan says it moves teams, read it on every path that reads its siblings, and ask whether it is an option.** The plan said teaming "uses whichever fields are present". It did for `years_played` and `rating`, which the Teams page reads from the player record; it did not for `skill_tier`, which only the registration file held in the browser ever carried to the generator, so an evaluations file of tiers updated a column nothing read. The first build said so and left it to the owner; review called that a P1, rightly: an import whose values reach nothing is a hollow guarantee. The owner's answer made it an organization option (Skill Tier, off unless turned on), and wiring it exposed a second, older hole: the page had always handed the generator the registration file's tier whatever the league's options, so "off" had to switch an existing behaviour off, not just hide a new one. A new option is therefore three things at once: the gate on every place that shows it, the gate on every place that uses it (including the old ones), and tests that fail with each gate removed. Whether the new input is safe for finished work is a separate question to answer with a test, not a sentence: here, changing every existing player's tier moves no one in a review, published or locked re-run.
76. **A failure that only a test's own transaction shows may be the test's, not the product's: reproduce it on committed rows before fixing it.** "Deleting a season that has games fails" was carried through two pull requests as a defect (`games.season_id` is `SET NULL` after the cascade has removed the game's teams, and the team foreign key refuses). Built from the migrations and run with the game committed first, the delete is clean: the season's own teams take their games with them, and a game whose teams are in another season is kept with its season unset. It fails only when one transaction inserts the game and deletes the season, because Postgres re-checks a foreign key on an update of a row its own transaction inserted. Every pgTAP file is one transaction, so a defect that needs committed rows, to be real or to be absent, cannot be shown in one; commit the fixture in one transaction and run the statement in the next. Ask who can reach the path too: since `20261101010000` no policy or RPC lets a signed-in caller delete a season. The notes were corrected and the schema left alone (follow-ups F1, `docs/changes/2026-11-01-followups-f1.md`, item 1).
77. **Advice computed from the file must ask the generator's question of the generator's source.** The Teams page advised a team count over every registered row while generation seats only the others, so with the Waitlist option on it recommended teams generation would not make. The obvious fix, the file's waitlist column, would have been wrong the other way after a save: a coach's child's buddy taken off the waitlist is active in the record while the file still marks them, and generation lets the record win. One predicate (`isWaitlistedRow`) now serves both, and the page reads the stored status once while the option is on. Choose test counts from the real rule, not from the obvious one (the maximum roster's capacity floor and the minimum roster's ceiling put the boundary between 28 and 29 players for 2 and 3 teams, not at 24 and 25; the first draft of the tests was wrong for that reason), so that one or two players change the advised count and each plant (the stored status ignored, the option not gating the read) turns a test red (follow-ups F1, item 3).
