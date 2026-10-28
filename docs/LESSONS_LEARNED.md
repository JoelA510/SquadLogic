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
49. **A "read-only" rule that keys on the caller's session needs the jobs that have none, and the tests that leave a session behind.** Completed seasons are read-only for players and coaches (`20261109010000`), enforced by one trigger on each table rather than a check in every writer; a blanket refusal would also have stopped the retention job (`minimise_import_people_data`), the demo purge and the cascade of a deleted organization, so the trigger refuses only a signed-in caller (`auth.uid()` is set, whether the write came through an RPC or directly), and a delete whose organization is already gone passes. The cost showed up in the tests: a pgTAP file that sets a JWT and then `RESET role`s still has a session, so its set-up writes to a completed season are refused; clear the claim (`SET LOCAL "request.jwt.claims" TO '{}'`) before seeding. Also: a lock whose test can pass without the lock (the activation's row locks make a second session wait anyway) needs a probe that reads the lock itself (`pg_locks`, undone inside a savepoint) and a control that says no.
50. **A pgTAP count over a table a scheduled job also writes needs the transaction's own rows.** `demo_sessions.sql` counted `demo_purge_log` rows with no note and expected the two purges it runs itself; CI's local Supabase runs the real `purge-expired-demos` job every ten minutes, and the file ran at 07:20:00.6, on the tick, so the job's committed row made it three (PR #680; the stand-in `pg_cron` of the harness never ticks, so nothing local could show it). The suite's rows carry the transaction's `now()` as `ran_at`; filter on it. Reproduced by committing one such row before running the old file (3, want 2) and the new one (passes).
51. **A rule that freezes once rows exist must also freeze while rows are staged.** The age cutoff, the season year and the division windows were fixed "once the season has players", and an import stages each natural age first and promotes it at the apply; a rule change in between left staged ages counted under the old rule and promoted under no one's (Codex, #680). The helper asks the staging table, not the players table (`season_has_pending_player_import`), the guard triggers and the RPCs both ask it, and the refusal says what to do (finish or cancel the import). The test that proves it stages a row, is refused, cancels the job (fails it), and is allowed.
52. **A hot-path change is timed in the mode CI runs.** Counting a natural age by the division windows read each window's dates per player; the season fixture's play-up comparison counts ~600,000 ages, and the file went from ~2.3s to ~3.5s per test under `--coverage` (v8 prices every function call), past vitest's 5s in CI's parallel run, while passing in isolation without coverage (1.1s against 1.2s, which is why it was put down to load; the receipt was main passing the same file in CI). Compile once per roster (`compileDivisionWindows`), skip the lookup when no division has a window, and time the file with `--coverage` on the base and the branch.
53. **A column list is a second copy of the schema, and a test double that ignores it hides the omission.** The Teams page selected the division columns by name and left the new window columns out, so the rule worked in core, the Edge function and the unit tests and never in the page; the page's test double returned whole rows whatever the select asked for. The double now returns only the columns asked for, and the control (no window on the row) shows the same registrant seated where the cutoff alone puts them.
54. **A guard that asks "is anything in flight?" cannot see the moment before the first thing is.** The pending-import check refuses a rule change once rows are staged; the validation reads the rule first and stages after, so a change in that gap found nothing to refuse and the staged ages were counted under a rule the season no longer had (Codex, #680 round two). Close the whole window where the work is *finished*, not where it starts: stamp the work with what it was computed under, taken before the read so a late change can only make the stamp stale, and have the step that consumes it compare (`age_rule_changed`). A version counter would have needed every writer, present and future, to bump it; a digest of the inputs needs none. The test stamps, changes the rule, stages and applies, and then repeats with the file validated again.
