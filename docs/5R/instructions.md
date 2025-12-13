# Gemini 3 HR Execution Instructions -> SquadLogic Review Remediation

Location:
- Review report (authoritative findings and rationale): `docs/5R/Review.md`
- This runbook: `docs/5R/instructions.md`

## Assumptions

- You have the repo checked out locally with write access.
- Node and npm are installed (follow whatever versions the repo requires; validate via `README.md` / `package.json`).
- You can run the project locally (frontend) and run tests.
- You will implement changes directly in the repo (branch + commits), not just propose them.

## Ground rules

- Treat `docs/5R/Review.md` as the source of truth for *what* was identified and *why* it matters. Do not re-litigate it; implement it.
- Do not duplicate large chunks of the review into this file or other docs. If you need to reference rationale, link back to the relevant section heading in `docs/5R/Review.md` (ex: "See Review 3.1").
- If you discover new issues while implementing:
  - Fix if low-risk and directly adjacent to the current change.
  - Otherwise add a short addendum under `docs/5R/Review.md` -> "## Addendum (YYYY-MM-DD)" with: context, risk, and a proposed remediation.
- Prefer least-privilege + explicit authorization checks over convenience defaults.
- Maintain backward compatibility unless a breaking change is required for security (document any breaking change clearly).

## Plan

1. Read `docs/5R/Review.md` end-to-end, then extract the P0-P3 items into an execution checklist.
2. Establish a repeatable local validation loop (install, lint if present, unit tests, build).
3. Implement remediation in priority order:
   - P0 Security -> P1 Type safety -> P2 Architecture/workspaces -> P3 Deterministic seed feature
4. After each priority item:
   - Add/adjust tests that would have failed before the change and pass after.
   - Run the full validation loop.
   - Commit with a focused message.

## Validation loop (use actual scripts in package.json)

- Install deps:
  - `npm install`
- Frontend dev/build:
  - `npm run frontend:dev`
  - `npm run frontend:build`
- Tests:
  - `node --test`
- Typecheck (after P1):
  - `npm run typecheck` (requires setup in P1)

If any of the above scripts do not exist, do not guess -> inspect `package.json` and use the repo-defined commands.

---

## Work package P0 -> Security audit and hardening (must ship)

Reference: `docs/5R/Review.md` section 3.1 and Roadmap item #1.

### Objective

Ensure all write-capable Supabase Edge Functions enforce authentication + authorization correctly even when using elevated credentials. The database must not be the only line of defense (service role bypasses RLS).

### Steps

1. Inventory and classify endpoints
   - Enumerate `supabase/functions/*` that perform reads/writes.
   - For each function, note:
     - Does it use `SUPABASE_SERVICE_ROLE_KEY`?
     - Does it accept user-controlled inputs that influence DB writes?
     - Is it callable from the browser (CORS/open endpoint)?

2. Establish a single, shared auth/role-check helper (server-side)
   - Create (or refactor into) a helper like `assertAuthorized(request, { allowedRoles })`.
   - It must:
     - Require an `Authorization: Bearer <jwt>` header (no auth -> 401).
     - Validate token via Supabase auth (ex: `supabase.auth.getUser(jwt)`).
     - Derive roles from a trusted source:
       - Preferred: database lookup keyed by `user.id` (ex: `profiles.role`) using *service client*, then compare to `allowedRoles`.
       - Avoid trusting client-provided role claims unless you verify they are server-issued and immutable.
     - Fail closed: unknown role -> 403.

3. Eliminate "RLS trap" failure modes
   - If an endpoint currently uses the service role solely to "make RLS work easier":
     - Consider switching to an anon-key Supabase client that forwards the user JWT so RLS is enforced.
   - If the endpoint must stay service-role (admin-only writes):
     - Authorization must be explicit in code.
     - Validate payloads strictly (schema validation, whitelist fields, enforce invariants).

4. Input validation and invariants
   - Add explicit validation for request bodies:
     - Use a small schema validator (zod) or hand-rolled checks if dependency policy is strict.
     - Reject unknown fields (avoid silent persistence of extra data).
   - Enforce business invariants relevant to scheduling persistence (id formats, non-negative ints, array sizes, etc).

5. CORS and origin policy
   - If CORS is permissive, tighten:
     - Allow only known origins for production domains.
     - Always set `Vary: Origin`.
     - Do not allow credentials unless required.
   - Ensure preflight handling is correct and does not bypass auth.

6. Tests
   - Add unit tests for the auth helper:
     - Missing auth -> 401
     - Invalid auth -> 401
     - Valid auth but role not allowed -> 403
     - Allowed role -> proceeds
   - Add at least one integration-style test per critical function (mocking supabase client is OK):
     - Attempts to persist with missing/invalid role must not write.

### Acceptance criteria

- Any write-capable Edge Function returns 401 without a valid user token.
- Any write-capable Edge Function returns 403 for valid users lacking required roles.
- All authZ decisions are made server-side and are auditable in code.
- Tests cover the negative cases above.

---

## Work package P1 -> Type safety with @ts-check (must ship)

Reference: `docs/5R/Review.md` section 3.3 and Roadmap item #2.

### Objective

Catch contract and data-shape errors in JS now, without a full TS rewrite.

### Steps

1. Enable JS typechecking incrementally
   - Add `// @ts-check` to the highest-risk JS modules first (those shared between frontend/backend and persistence logic).
   - Then expand to the rest of `src/*.js` as the review recommends.

2. Tighten JSDoc where needed
   - Add/repair JSDoc typedefs for key domain objects (Player, Team, PracticeSlot, GameSlot, Override, PersistPayload).
   - Replace "any-ish" shapes with explicit records and discriminated unions where feasible.

3. Introduce a typecheck command
   - Create a `tsconfig.json` or `jsconfig.json` with `checkJs: true`, `allowJs: true`, and `noEmit: true`.
   - Add a script to `package.json`: `"typecheck": "tsc --noEmit"` (or similar).

4. Fix the surfaced issues
   - Do not suppress errors with broad `// @ts-ignore` unless there is a documented reason.
   - Prefer refining types and adding runtime validation for untrusted inputs.

5. Tests
   - Add a CI-friendly check (if CI exists) so type regressions fail early.

### Acceptance criteria

- Typecheck passes cleanly (or with a documented, minimal allowlist of known false positives).
- The highest-risk shared modules have accurate typedefs and no implicit-any holes.

---

## Work package P2 -> Architecture hardening (NPM workspaces + shared package)

Reference: `docs/5R/Review.md` section 3.2 and Roadmap item #3.

### Objective

Remove brittle relative imports crossing package boundaries (ex: `../../../src/...`) and create a stable shared module boundary.

### Steps

1. Create a shared package
   - Add `packages/shared` (or similar) with its own `package.json`.
   - Move cross-runtime logic that is currently imported by both frontend and edge functions into this shared package.
   - Keep shared package runtime-neutral:
     - No DOM-only APIs.
     - No Node-only APIs unless clearly split by entrypoints.

2. Configure workspaces at repo root
   - Add `workspaces` to root `package.json` to include:
     - `frontend`
     - `packages/*`
     - (Optionally) `supabase/functions/*` only if it is npm-managed in this repo.
   - Ensure dependency resolution works for both dev and build.

3. Update imports
   - Replace brittle paths with package imports:
     - `import { ... } from "@squadlogic/shared"` (name as appropriate)
   - Remove duplicated copies of the same logic across layers.

4. Build/deploy compatibility
   - Ensure Supabase functions can resolve the shared package in the build step.
   - If Supabase deploy bundling cannot follow workspace symlinks:
     - Add a function build step that bundles dependencies (esbuild/deno bundle) and includes the shared code.
     - Document the constraint in `docs/`.

5. Tests
   - Add a smoke test ensuring imports resolve in both frontend and functions build contexts.

### Acceptance criteria

- No Edge Function imports code via multi-level `../../..` paths into `src/`.
- Shared logic has a stable package boundary and clear ownership.
- Builds still work locally and in deploy tooling.

---

## Work package P3 -> Deterministic seed feature (should ship)

Reference: `docs/5R/Review.md` section 3.4 and Roadmap item #4.

### Objective

Make team/schedule generation reproducible for debugging and audits by allowing a deterministic seed.

### Steps

1. Add a deterministic RNG abstraction
   - Create a small interface:
     - `rng.nextFloat() -> number in [0,1)`
     - `rng.nextInt(maxExclusive) -> int`
   - Default implementation uses `Math.random`.
   - Seeded implementation uses a stable PRNG (prefer a minimal dependency or a small, well-reviewed implementation).

2. Thread RNG through generation code
   - Replace direct `Math.random` calls with `rng`.
   - Ensure the seed is included in any persisted payloads and exported reports (if applicable).

3. UI/UX
   - Add an optional seed input in the admin UI:
     - Empty -> random seed generated and displayed after run.
     - Provided -> used as-is.
   - Show the seed used in results so the run can be reproduced.

4. Tests
   - Add a test asserting identical inputs + same seed -> identical outputs (teams, schedules).
   - Add a test asserting different seeds -> different outputs (probabilistic but choose a stable assertion, e.g., compare one key ordering or hash).

### Acceptance criteria

- A run can be reproduced exactly by reusing the same seed and inputs.
- Seed is visible in the UI and captured in outputs/persistence.

---

## Opportunistic improvements (only if they fall out naturally)

Reference: `docs/5R/Review.md` section 3.4.

- Reduce unnecessary `structuredClone` in hot loops:
  - Replace with shallow copies or targeted cloning where safe.
  - Add a micro-benchmark or at least a regression test around correctness.
- Add defensive guards around large inputs (upload size, max players, max slots) to avoid UI lockups and runaway memory.
- Improve error UX:
  - Central error boundary + user-friendly error surfaces for persistence failures.
  - Ensure errors include a correlation id (simple timestamp+random is fine) for logs.

---

## Deliverable: what to report back after implementation

When you finish, output a short implementation report (in the PR description or a summary comment) containing:

- Changes by priority item (P0-P3) -> file list and key behaviors changed.
- Security notes -> what is now enforced, and where.
- How to run -> exact commands you used to validate.
- Any known follow-ups -> small backlog list (if you added an addendum to Review.md, link it).

