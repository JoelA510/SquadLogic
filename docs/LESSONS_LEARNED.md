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
    the mutation, apply eagerly, restore on RPC failure — and *check* per-item
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
