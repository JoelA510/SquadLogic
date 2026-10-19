# Remediation plan

Repo: **JoelA510/SquadLogic** · Plan drawn up: 2026-10-12 · Source audit: [`audit.md`](./audit.md) (commit `565e980`)

**Status:** DONE 2026-10-19, with the deferrals (M1.5's two acceptance legs among them) and the open
owner questions in "Close-out" below.
Approved by the owner on 2026-10-13 "as recommended": D1-D8 at their defaults, and finding 5.1
moved into Milestone 1 (PR 1-B, as M1.7). Paused by the owner on 2026-10-14 after Milestone 4;
resumed 2026-10-17. On 2026-10-18 the owner approved the five plans that followed (every
recommendation as written). Merged:
- M1: #551 (M1.1, M1.2), #552 (M1.3, M1.4, M1.7), #553 (M1.5), #545 (M1.6).
- M2: #556 (M2.4-M2.6), #558 (M2.2), #559 (M2.1, M2.3).
- M3: #573 (M3.2-M3.4), #574 (M3.1, M3.5), #575 (zizmor required).
- M4:
  - M4.1, M4.5: #578.
  - M4.2: #580.
  - M4.3, M4.6: #579.
  - M4.4: #576.
  - M4.7: plan #555, build #560, exceptions follow-up #590.
  - M4.8: #593. The #576 follow-up (Edge game evaluator, unknown teams): #594.
  - The Edge audit fix found during it: #577.
  - Free-tier budgets, the AA accent palette, and the real-backend E2E made required: #581.
- M5: #557.
- M6: #588.
- The resume queue's waves: Wave 0 #587 (mock ids); Wave 3 #589 (import Continue, team sync,
  abort check, game grid); Wave 4 #591 (accessibility follow-ups); Wave 2 #592 (exports bucket),
  #597 (`create_import_job` stops auditing the file name), #595 + #596 (RLS persona matrix, then
  the rewrite with both advisor waivers removed), #598 (schema drift), #600 (team and game saves
  audit in their transaction; the game save needs an admin), #599 (import telemetry stops
  sending the file name; merged as f561674).

Open in the plan: nothing that is not a stated deferral. The acceptance legs and deferrals, and to whom, are in "Close-out"; the work
that remains, in order, is [`resume-queue.md`](./resume-queue.md). Every agent reads
[`agent-brief.md`](./agent-brief.md).

End state: every audit area at "no blocker/high findings", E2E coverage of critical
journeys, staging deploy smoke-tested, docs current — measured against: an organization's
administrator can import a season's GotSport registrations, generate balanced teams, schedule
practices and games against real fields, publish the results to coaches and parents, and record
scores and standings, on the deployed Vercel + Supabase app, seeing only their own organization,
with every state change audited; coaches and parents see and do only what their role allows.

## Open decisions for the owner

Each has a default: if the owner says nothing, the plan proceeds on it. **All eight were decided
at their defaults by the owner on 2026-10-13**; each alternative is kept as the record of what was
declined.

- **D1. Where the agent rules live (12.1, 12.3, 12.4).** *Decided 2026-10-13: the default.* Default:
  move the rules from `CLAUDE.md` into a new root `AGENTS.md` and reduce `CLAUDE.md` to `@AGENTS.md`
  plus the Claude-specific notes, because other agents already work here (`.agents/skills/`, the
  Codex and Gemini review bots). Alternative: keep `CLAUDE.md` alone and waive `core.agent-rules`
  with a reason, accepting that Codex, Cursor, Copilot and Antigravity never see the rules.
- **D2. Type strictness (2.1).** *Decided 2026-10-13: the default.* Default: record
  `node.strict-types` in a conformance baseline (`docs/standards/conformance.json`), keep
  CLAUDE.md's `strict: false`, and schedule nothing; raising strictness is a flagged refactor the
  owner can request later, starting with the 29 TypeScript E2E files. Alternative: plan that
  refactor now as its own milestone.
- **D3. Is the practice page's fairness evaluation a core flow (13.1)?** *Decided 2026-10-13: the
  default.* Default: yes. README lists fairness metrics and conflict detection under "Core platform
  (v1.0)", so the false all-clear is a blocker in Milestone 1. Alternative: hide the panel until it
  is fixed (also Milestone 1, smaller).
- **D4. The duplicated engines (1.1).** *Decided 2026-10-13: the default.* Default: keep the
  JavaScript core and the Deno ports, and add a parity test over real inputs (Milestone 1, because
  13.1's fix widens it). Moving the Edge Functions onto the core package is a flagged refactor, not
  planned.
- **D5. Which checks the ruleset requires (7.1, 6.3).** *Decided 2026-10-13: the default.* Default:
  `Build & Test` and `Deno Mirror Tests` in Milestone 1; pgTAP joins once it runs on every pull
  request (Milestone 3). The repository is public, so standard-runner Actions minutes cost nothing;
  the `pgtap.yml` comment's minute budget applies to private repositories.
- **D6. Vulnerable dependencies (8.1).** *Decided 2026-10-13: the default.* Default: take the
  in-range refresh PR #332 already carries, upgrade what remains within the current majors, and
  waive with a reason and an expiry only what needs a major (for example a `react-router` advisory
  scoped to RSC mode, which this app doesn't use, if one remains). No major upgrades in this plan.
- **D7. Licence (12.6).** *Decided 2026-10-13: the default.* Default: add the ISC licence text the
  README and `package.json` already claim, with the owner as copyright holder. A legal choice, so
  the owner confirms.
- **D8. `project-hardening/` (12.4).** *Decided 2026-10-13: the default.* Default: merge any rule
  still worth keeping into AGENTS.md and delete the folder, as its own controller says it should
  never have been committed. Alternative: move it under `docs/archive/` with a note that it is
  history, not instructions.

## Rules for this plan

- **Traceability.** Every audit finding ID appears exactly once below: as an item, under
  "Deferred with reason", or as "resolved by" another item.
- **Severity** uses the audit's definitions. If an item is graded differently from its audit
  finding, the item says so and why.
- **Milestone size.** From Milestone 2 on, a milestone with more than about five items is two
  milestones. Milestone 1 takes every blocker however many there are, but ships them in PRs of
  about five items, so each can be rolled back on its own.
- **This repository's own rules apply to every item:** a feature branch per PR (`fix/…`,
  `docs/…`, `chore/…`); the CLAUDE.md verification sequence (`lint`, `typecheck`, `test`,
  `frontend:build`, `check:advisors`, `check:bundle`) before each commit; the season-2026 fixture
  suite after any change to domain types, constraints or solver stages; a plan shown and approved
  before any change to the solver, the domain model or persistence; `/code-review` before each PR;
  migrations with `docs/sql/<version>_revert.sql` and `_smoke.sql`, applied only by CI.
- **Do not do** (out of scope for this plan, even if tempting):
  no framework, router, Vite or TypeScript major upgrade; no move off Supabase or Vercel; no
  schema reset, and no edit or rename of an applied migration; no `supabase db push`, Supabase
  MCP `apply_migration`, or manual write to production; no change to the solver's behaviour
  (freeze-by-default and TIME TBD rules stand); no de-duplication of the Deno engines (D4); no
  `strict: true` (D2); nothing on the CLAUDE.md §2 hard-exclusion list (no payments, CMS, document
  storage, store, sponsors, AI assistant); no real personal data in any fixture.

## Item format

Every item carries the fields below; the test gate is shown failing with the fix reverted before
the item counts as done.

---

## Milestone 1 — Stop the bleeding

Three PRs: 1-A (the blocker and what it widens), 1-B (merge enforcement, the runtime it makes
binding, and the mock-mode guard that fails open on the production host, moved in at approval),
1-C (error reporting).

**PR 1-A — `fix/practice-fairness-evaluates-real-roster`**

Also in this PR, as its first commit: a root `.prettierignore` listing `prompts/`,
`.agents/skills/` and `.claude/skills/`. Reason: `npm run format` is `prettier --write .` and there
is no ignore file, so a repository-wide format would rewrite 30 files that `process:apply`
delivered (the template trial's rerun on `fa39ab3`:
`prettier --list-different prompts .agents/skills .claude/skills`, exit 1), and a later re-apply
would then treat them as locally edited and stop updating them. Until it lands, run Prettier only
on the paths a change touches, never `npm run format` across the repository. Acceptance:
`prettier --list-different .` names no file under those three folders (on the delivered tree it
names 30 today; on `main` the folders arrive with this plan's delivery commits), and lists the same
project files as before. Not tied to an audit finding (the trial's rerun found
it), so it carries no ID.

> **M1.1. The practice page's fairness evaluation reports a clean result after examining nothing** (audit finding 13.1, blocker)
> - **Status: merged as #551 (`73d98d0`), with M1.2.** The record is the PR and its entry under "Discovered during execution" (the panel rendered `issue.details` objects as a React child; fixed there). *Statically reviewed* here; the PR's own runs are the evidence.
> - **Fix approach:** pass the page's scheduler teams (the `normalizeTeam` output, which carries
>   `assistantCoachIds`) and slot list into `EvaluationPanel`, as issue #364 sketches; in
>   `EvaluationPanel`, render "Nothing to evaluate: 0 teams / 0 slots" instead of a score when
>   either list is empty, and never call `fairness-scoring` with an empty roster.
> - **Files touched:** `frontend/src/pages/PracticeSchedulingPage.jsx`,
>   `frontend/src/components/EvaluationPanel.jsx`, new `tests/practiceFairnessWiring.test.jsx`.
> - **Depends on:** none.
> - **Widens:** 1.1 — once the panel sends a real roster, the Deno `scoring-engine.ts` result
>   reaches every practice page, so any drift between it and the core evaluator becomes
>   user-visible; moved into this milestone as M1.2.
> - **Effort:** S
> - **Acceptance criteria:** on the practice page with a seeded season, the panel shows a
>   non-zero team count and flags a planted coach double-booking; with no teams it says so
>   instead of showing a score.
> - **Test gate:** `tests/practiceFairnessWiring.test.jsx` renders `PracticeSchedulingPage`
>   (without stubbing `EvaluationPanel`, which every current page test stubs) and asserts the
>   `fairness-scoring` request body carries the page's teams and slots; a second case asserts the
>   empty-state text. Reverting the page change makes the first case fail (the trial's scratch
>   probe already observed `teams: []` and `slots: []` in the body at `565e980`).
> - **Rollback:** revert the PR; the panel goes back to its current (wrong) output, no data
>   changes.
> - **Diff class:** minimal diff.
> - **Verification label:** statically reviewed (fix); the defect itself executed through a
>   scratch probe of the panel.

> **M1.2. The core evaluator and its Deno port can drift without a test noticing** (audit finding 1.1, medium; pulled into Milestone 1 because M1.1 widens it)
> - **Status: merged as #551 (`73d98d0`).** The parity tests have been widened since by the date-model work (#560, #590, #593) and the game evaluator (#594); see M4.7, M4.8 and the #576 follow-up. *Statically reviewed* here.
> - **Fix approach:** add a mirror test that runs `evaluatePracticeSchedule` (core) and
>   `scoring-engine.ts` (Deno) on the same non-empty inputs drawn from the season-2026 corpus and
>   compares coach conflicts, team counts and scores; and a Vitest twin for the core side. It runs
>   in the existing discovery-based `deno-mirror-tests` job. No engine code changes (D4).
> - **Files touched:** new `supabase/functions/_shared/tests/scoring-parity_test.ts`, a fixture
>   extract under `supabase/functions/_shared/tests/fixtures/` (pseudonymous corpus data only),
>   `scripts/deno-mirror-tests.sh` floor count if it changes.
> - **Depends on:** none (lands with M1.1).
> - **Widens:** none.
> - **Effort:** M
> - **Acceptance criteria:** CI's Deno job lists the parity test and passes; a planted difference
>   in either engine fails it.
> - **Test gate:** the parity test itself, shown failing by planting a one-line change in the
>   Deno engine's conflict rule.
> - **Rollback:** revert the PR (test-only).
> - **Diff class:** minimal diff.
> - **Verification label:** statically reviewed.

**PR 1-B — `chore/require-ci-on-main`**

> **M1.3. Nothing requires CI before a merge, and a push to `main` migrates production** (audit finding 7.1, high)
> - **Status (2026-10-13): live; merged as #552 (`33e68ab`).** The owner imported ruleset
>   `25015698` ("main: pull requests with green CI") from `.github/rulesets/main.json`: pull
>   requests only (0 approvals), `Build & Test` and `Deno Mirror Tests` required on an
>   up-to-date branch, no force pushes, no deletion. The live rules, read back through
>   `GET /repos/JoelA510/SquadLogic/rules/branches/main`, match the file (*executed*). The first
>   ruleset, `25014911`, required agent-ready-template's own job names and was deleted (see
>   "Discovered during execution"). Both checks report on every pull request, docs-only ones
>   included: `tests/rulesetRequiredChecks.test.js` reads `ci.yml` and fails on a context that
>   names no job, a trigger filter, a job condition, `needs` or a matrix (*executed*: shown failing
>   on a renamed context, a `paths-ignore` filter and a push-only `if`, each planted in the real
>   files). `docs/operations/ci-cd.md` corrected. Resolving review conversations is not required
>   (`required_review_thread_resolution: false`): the owner decided 2026-10-13 to keep it off.
>   **Remaining:** the acceptance criteria (a pull request with a failing `Build & Test` shows
>   "Merging is blocked"; a direct push is refused) and `check:settings`, which needs a token
>   with Administration: read (not available to the agent; it got 401).
>   **Owner decision 2026-10-13:** that remaining acceptance (the "Merging is blocked"
>   demonstration and `check:settings`) is waived; the ruleset is considered done. Re-read 2026-10-19 (public rules API, *executed*): the live
>   ruleset requires six checks, `Build & Test`, `Deno Mirror Tests`, `Run pgTAP against local
>   Supabase`, `npm audit (high and critical block)`, `Workflow audit (zizmor)` and `E2E against
>   local Supabase`, matching `.github/rulesets/main.json` (#573, #575, #581).
> - **Fix approach:** add `.github/rulesets/main.json` from the skeleton
>   (`prompts/skeletons/.github/rulesets/main.json`), requiring pull requests, the checks
>   `Build & Test` and `Deno Mirror Tests` (D5), and no force pushes or deletions on `main`; the
>   owner imports it in Settings → Rules → Rulesets (an agent can't). Correct
>   `docs/operations/ci-cd.md` §"Branch Protection" to name the checks that exist (there is no
>   CodeQL workflow).
> - **Files touched:** `.github/rulesets/main.json`, `docs/operations/ci-cd.md`.
> - **Depends on:** none.
> - **Widens:** 7.2 — once `Build & Test` is required, every merge relies on a gate that runs
>   Node 20, which is end of life and isn't what production builds on; moved into this
>   milestone as M1.4.
> - **Effort:** S
> - **Acceptance criteria:** a pull request with a failing `Build & Test` shows "Merging is
>   blocked"; a direct push to `main` is refused.
> - **Test gate:** `check:settings` from the template passes `core.settings-branch-protected`
>   (it fails today); proven by opening a throwaway PR with a planted lint error and seeing merge
>   blocked.
> - **Rollback:** disable the ruleset in Settings (one toggle); the file stays.
> - **Diff class:** minimal diff (plus a settings change by the owner).
> - **Verification label:** executed (the current state, through the API); the fix statically
>   reviewed.

> **M1.4. CI runs an end-of-life Node that production doesn't use, and nothing pins one** (audit finding 7.2, high)
> - **Status (2026-10-13): merged as #552 (`33e68ab`).** `.nvmrc` `24`, `engines.node` `^24.0.0`, and every
>   `setup-node` step reads `node-version-file: .nvmrc` (`ci.yml`'s two; `pgtap.yml` had none and
>   ran npm on the runner image's Node, so it gained one). #332's runtime half, credited; its
>   actions and dependency refresh stay with M2.1. Vercel builds on `24.x` (API), and `engines`
>   overrides the dashboard setting there; recorded in `ENVIRONMENT.md`. Test gate *executed*
>   with agent-ready-template 1.0.0's `check-conformance.mjs`: `node.runtime-pinned` fail -> pass,
>   `node.ci-uses-pin` pass; with `.nvmrc` removed both fail. `node.ci-uses-pin` also passed
>   before, because Node 20 was exactly the old `engines` floor (`>=20`). Acceptance *executed*:
>   #552's `Build & Test` log shows "Resolved .nvmrc as 24" and `node: v24.21.0`; pgTAP passed
>   on the pinned Node too.
> - **Fix approach:** land PR #332's runtime half (rebased): `.nvmrc` with `24`, `engines.node`
>   `^24.0.0` (or the floor the owner wants to support), `node-version-file: .nvmrc` in every
>   `setup-node` step in `ci.yml` and `pgtap.yml`, and Vercel's Node version set to 24 in the
>   dashboard, written down in `docs/operations/ENVIRONMENT.md`. The dependency-refresh half of
>   #332 moves to M2.1.
> - **Files touched:** `.nvmrc`, `package.json` (`engines`), `.github/workflows/ci.yml`,
>   `.github/workflows/pgtap.yml`, `docs/operations/ENVIRONMENT.md`, `README.md` prerequisites,
>   `CLAUDE.md` §11.
> - **Depends on:** none.
> - **Widens:** none.
> - **Effort:** S
> - **Acceptance criteria:** CI logs show Node 24.x; `node.runtime-pinned` and `node.ci-uses-pin`
>   pass with the pin present.
> - **Test gate:** the conformance scorecard's `node.runtime-pinned` (fails today); reverting the
>   `.nvmrc` fails it again.
> - **Rollback:** revert the PR; CI returns to Node 20.
> - **Diff class:** minimal diff.
> - **Verification label:** executed (the current state); the fix statically reviewed.

> **M1.7. A production build without Supabase configuration serves the mock on the production host** (audit finding 5.1, high; moved from M2.2 into Milestone 1 by the owner at approval, 2026-10-13; numbered after M1.6 so existing references stay valid)
> - **Status (2026-10-13): merged as #552 (`33e68ab`).** `config.js` refuses on every host; the host plays no
>   part, so the opt-in now also runs the mock on a custom domain, where the old guard refused it
>   (listed in the PR). Test gate *executed*: `tests/mockModeGuard.test.js`, 19 cases; against the
>   old `config.js` 9 fail, the `*.vercel.app`, `localhost` and `127.0.0.1` cases because the
>   import resolves instead of throwing. Acceptance *executed* locally: a build without the
>   variables, served on 127.0.0.1 with `squadlogic.vercel.app` (and a preview name, `localhost`,
>   a custom domain) mapped to it in Chromium, shows the Configuration Error and never fetches
>   the mock (the same reproduction on `main`'s build shows the sign-in page); the build with
>   `VITE_USE_MOCK_SUPABASE=true` loads the mock chunk and its sign-in page; the E2E suite passes
>   unchanged (94 of 94, mock mode, one worker). CI's `frontend:build` step has no Supabase
>   variables and still succeeds (the guard is runtime only). #552's Vercel preview has the
>   Supabase variables (real client, no mock chunk), so previews are unaffected; the owner
>   confirmed it on the preview, 2026-10-13.
> - **Fix approach:** fail closed. In a production build (`import.meta.env.PROD`), a missing
>   `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY` never selects the mock: the guard in
>   `frontend/src/config.js` shows its "Configuration Error" and throws on every host, with no
>   `localhost` or `*.vercel.app` exemption. The only way a production build runs the mock is the
>   existing explicit opt-in, `VITE_USE_MOCK_SUPABASE=true` (what Playwright and CI already set),
>   so no new variable is added. Development (the Vite dev server) keeps falling back to the mock
>   as today. `supabaseClient.js`'s `MOCK_CAPABLE_BUILD` and `loadMockClient` stay as they are;
>   M2.2 later turns the same rule into a build failure.
> - **Files touched:** `frontend/src/config.js`, `docs/operations/ENVIRONMENT.md` (the opt-in,
>   and what a preview without Supabase variables now shows), new `tests/mockModeGuard.test.js`.
> - **Depends on:** none.
> - **Widens:** none (a Vercel preview built without Supabase variables now shows the
>   Configuration Error unless it sets `VITE_USE_MOCK_SUPABASE=true`; that is the intended change
>   and is listed in the PR).
> - **Effort:** S
> - **Acceptance criteria:** the audit's reproduction, rerun locally (a `frontend:build` without
>   Supabase variables, served on 127.0.0.1 and opened in Chromium with `squadlogic.vercel.app`
>   mapped to it), shows the Configuration Error and never the sign-in page; the same build with
>   `VITE_USE_MOCK_SUPABASE=true` still loads the mock; the E2E suite (dev server, opt-in set)
>   passes unchanged. Production itself is not touched.
> - **Test gate:** `tests/mockModeGuard.test.js` evaluates the guard as a production build would
>   (`PROD` true, Supabase variables unset, no opt-in) under `squadlogic.vercel.app`, a preview
>   `*.vercel.app` host, `localhost` and a custom domain, and asserts it throws on each; a second
>   case asserts the opt-in still selects the mock; a third that development still falls back.
>   Shown failing first: with today's `config.js` the `*.vercel.app` and `localhost` cases don't
>   throw.
> - **Rollback:** revert the PR; the guard returns to its host-based exemption, no data changes.
> - **Diff class:** minimal diff.
> - **Verification label:** executed (the defect, reproduced locally by the audit); the fix
>   statically reviewed.

**PR 1-C — `fix/error-reports-carry-ids`**

> **M1.5. No error report says which user or organization it came from** (audit finding 9.1, high)
> - **Status: merged as #553 (`fd6cce4`).** `logger.setUser` passes only `id`,
>   `organization_id` and `role` to Sentry (plus an `organization_id` tag); `AuthContext` calls
>   it on sign-in and with null on sign-out, `OrganizationContext` on choosing and switching the
>   active organization. Every Edge Function serves through `withFailureLogging`
>   (`_shared/logtail.ts`): function name, a generated request ID and the verified organization
>   ID on every failure, messages redacted. Also in #553: the Sentry `environment` from Vercel's
>   `VERCEL_ENV` (previews report `preview`) and CSP `worker-src 'self' blob:` for Replay's
>   worker; the release tag stays `package.json`'s version (pinned by `tests/sentryConfig.test.js`
>   and `sentry-smoke.md`). Test gate met: `tests/loggerUserContext.test.jsx`, *executed*, 8 of 8
>   pass, and 5 fail with the `AuthContext` calls removed. `VITE_SENTRY_DSN` is set: the live
>   bundle carries the DSN (confirmed by the other session), so the owner question is closed.
>   Acceptance, *executed* on #553's preview, signed out: an induced error arrived with
>   `environment: preview` and `release: 1.0.1` (Sentry event `83c8fad3…`, SQUADLOGIC-2, then
>   resolved), the envelope POST returned 200 and the page logged no CSP refusal. **What
>   remains (owner):** the signed-in leg (an event tagged with user and organization IDs; it
>   needs a real account) and an Edge Function error in BetterStack with the organization ID
>   (after the merge deploys the functions).
>   **Closed out 2026-10-19:** both legs need a real signed-in account and are deferred to the
>   v1.1.0 release smoke, owner (see "Close-out"). A Sentry search for production issues with a
>   user id (30 days) found none; that is *unverified*, not a pass, since no signed-in error has
>   occurred to carry one.
> - **Fix approach:** call `logger.setUser({ id, organization_id, role })` from `AuthContext`
>   on sign-in and from `OrganizationContext` on organization switch, and `setUser(null)` on
>   sign-out (IDs only, never names or emails); route each Edge Function's top-level error path
>   through `_shared/logtail.ts` with the function name, organization ID and request ID; confirm
>   with the owner that `VITE_SENTRY_DSN` is set in Vercel Production and Preview.
> - **Files touched:** `frontend/src/contexts/AuthContext.jsx`,
>   `frontend/src/contexts/OrganizationContext.jsx`, `supabase/functions/*/index.ts` (error
>   paths), tests `tests/loggerUserContext.test.jsx`.
> - **Depends on:** M1.6 (or the induced error never arrives); met by #545, see M1.6's status.
>   #545 also set Sentry's `release` from `package.json` and an explicit
>   `sendDefaultPii: false`, which does not limit an explicit `setUser`; neither is the user or
>   organization context this item adds. At `28f1b98` nothing calls `logger.setUser` (its only
>   occurrences are its definition in `frontend/src/lib/logger.js`), so 9.1 stands unchanged.
> - **Widens:** none.
> - **Effort:** M
> - **Acceptance criteria:** the `sentry-smoke.md` procedure, run against a preview deploy, shows
>   an event tagged with a user ID and organization ID; an Edge Function error appears in
>   BetterStack with the same organization ID.
> - **Test gate:** `tests/loggerUserContext.test.jsx` asserts `Sentry.setUser` receives the
>   signed-in user's ID and organization ID and never an email; fails with the `AuthContext`
>   call removed.
> - **Rollback:** revert the PR.
> - **Diff class:** minimal diff.
> - **Verification label:** statically reviewed.

> **M1.6. The CSP may refuse Sentry's regional ingest host** (audit finding 9.2, medium; in Milestone 1 because M1.5's acceptance depends on it)
> - **Status: resolved by #545** (`7fa6b1b`, merged to `main` 2026-10-13, after the audit and
>   outside this plan). `vercel.json`'s `connect-src` now carries `https://*.ingest.us.sentry.io`
>   beside the kept `https://*.ingest.sentry.io`; `docs/security/csp.md` lists it;
>   `docs/operations/sentry-smoke.md` records that the Sentry organization is in the US region
>   (DSN host `o<org-id>.ingest.us.sentry.io`). A wildcard rather than the exact host the fix
>   approach below asked for, so the owner no longer has to supply the DSN host for this item.
>   The test gate is met by `tests/cspPolicy.test.js`: *executed* at `28f1b98`, 8 of 8 pass, and
>   with the US entry removed from `vercel.json` 3 fail ("admits Sentry ingest for US-region…",
>   "the old policy… refuses the US ingest host", and the vercel.json/csp.md agreement check).
>   **What remains:** only the acceptance criterion (the envelope POST returning 200 with no CSP
>   warning), which needs a deploy; it is checked in M1.5's `sentry-smoke.md` run, which already
>   does that step. No PR of this plan carries M1.6 any more. The original item text stays below
>   as the record.
> - **Fix approach:** read the production DSN's host (owner), and add that exact host (for
>   example `https://o<id>.ingest.us.sentry.io`) to `connect-src` in `vercel.json` and
>   `docs/security/csp.md`, keeping the existing entry.
> - **Files touched:** `vercel.json`, `docs/security/csp.md`, `docs/operations/sentry-smoke.md`.
> - **Depends on:** the owner supplying the DSN host.
> - **Widens:** none.
> - **Effort:** S
> - **Acceptance criteria:** the smoke's network tab shows the envelope POST returning 200 with
>   no CSP warning.
> - **Test gate:** a Vitest check over `vercel.json` that the CSP's `connect-src` matches the
>   DSN host named in `docs/operations/sentry-smoke.md`; fails with the host removed.
> - **Rollback:** revert the PR.
> - **Diff class:** minimal diff.
> - **Verification label:** statically reviewed.

**Milestone exit:** [x] CI is a required check and blocks merge on the gate (M1.3; the live
ruleset requires six checks, read back 2026-10-19) · [x] a production build without Supabase
configuration refuses to start on every host, the production host included (M1.7, #552; the build
itself fails since M2.2, #558) · [~] error reporting receives an induced error, tagged with user
and organization IDs (M1.5: the signed-out leg is done on #553's preview; the signed-in and
BetterStack legs are deferred to the owner's v1.1.0 release smoke; the CSP half, M1.6, is in
`main` through #545) · [x] zero open blockers (M1.1, #551) · [~] deployed and smoke-tested (merged
to `main`; the Manual QA script was not run end to end, deferred to the same smoke)

---

## Milestone 2 — Data integrity & security

> **M2.1. Eight high advisories, no waiver, no audit gate** (audit finding 8.1, high)
> - **Status (2026-10-13): merged as #559 (`acac2ed`).** #332's in-range refresh (`npm update` within the
>   current majors, taken under M2.3's 3-day release wait) cleared every vulnerable package `npm
>   audit` reported (15: 8 high, carrying 18 high advisories; 6 moderate; 1 low); floors raised for the direct ones (`react-router-dom`
>   `^7.18.4`, `vite` `^7.3.7`, `postcss` `^8.5.29`). No major upgrade and no waiver needed (D6).
>   The `esbuild` override (`^0.25.0`) is removed, which is what still applied of #331 (its Vite
>   8 major does not). #332's actions half lands too, at today's majors (`checkout`,
>   `setup-node`, `upload-artifact` v7; `setup-cli` v2), and its `eslint-plugin-react-hooks`
>   7.0.1 pin and Playwright `Page` type. Gate: the template's `check-audit.mjs` as
>   `npm run check:audit`, in its own `audit.yml` (every PR, pushes to `main`, Mondays 06:00 UTC)
>   rather than a step in `ci.yml`; `docs/security/audit-waivers.json` (empty) and
>   `dependency-policy.md` replace `dependabot-waivers.md`. Not a required check: recommended to
>   the owner. Test gate *executed*: the gate on `main`'s own lockfile report exits 1 (18
>   unwaived high in 8 packages); the same report with every advisory waived passes until the
>   waivers expire, then exits 1; `tests/checkAudit.test.js` (43 cases, two planted mutations of
>   the gate each caught); scorecard `node.audit-gate` fail -> pass (fails again with `audit.yml`
>   removed); `core.audit-waivers` is `n/a` with an empty register, and was shown failing on an
>   expired waiver and passing on a current one.
> - **Fix approach:** take PR #332's in-range refresh (rebased), then `npm audit fix` within
>   current majors; adopt the dependency-policy skeleton
>   (`prompts/skeletons/docs/dependency-policy.md`) with a JSON waiver register (reason, owner,
>   expiry within 90 days) replacing `docs/security/dependabot-waivers.md`; add an audit step that
>   fails on high/critical not waived to `ci.yml`, and a weekly scheduled run (D6).
> - **Files touched:** `package-lock.json`, `package.json` (in-range bumps only),
>   `docs/security/dependency-policy.md`, `docs/security/audit-waivers.json`,
>   `scripts/check-audit.mjs` (or equivalent), `.github/workflows/ci.yml`,
>   `.github/workflows/audit.yml`.
> - **Depends on:** M1.4.
> - **Widens:** none.
> - **Effort:** M
> - **Acceptance criteria:** `npm audit` reports no unwaived high/critical; the scheduled run is
>   visible in Actions.
> - **Test gate:** the audit step itself, shown failing on a branch that pins a known-vulnerable
>   version; scorecard `node.audit-gate` and `core.audit-waivers` pass.
> - **Rollback:** revert the PR (lockfile returns).
> - **Diff class:** minimal diff.
> - **Verification label:** executed (the current audit); the fix statically reviewed.

> **M2.2. A typed env module, and production decided by the build, not the hostname** (audit finding 2.2, medium)
> - **Status (2026-10-13): merged as #558 (`18ebc0e`).** `frontend/src/env.js` is the only reader of
>   `import.meta.env` (by name); the Zod rules are in `frontend/src/envRules.js`, run by a
>   `vite.config.js` plugin when a production build starts and again by `env.js` in the browser;
>   M1.7's guard moved into `env.js` unchanged. A production build without `VITE_SUPABASE_URL` /
>   `VITE_SUPABASE_ANON_KEY` (no opt-in) fails naming each, so it no longer emits the mock chunk or
>   goes READY behind a runtime Configuration Error. Also refused: a malformed URL, DSN or opt-in
>   value, and a Supabase secret key in `VITE_SUPABASE_ANON_KEY` (on the dev server a malformed
>   value is ignored with a warning, so an old `.env` copy still runs the mock). The persistence
>   base is derived from the Supabase URL only in a production build of the real client (mock
>   sessions keep `localhost:54321`, as before). The mock's password is a fixed
>   demo value; the `VITE_TEST_*` names are gone (`TEST_*` at the Node layer). CI's
>   `frontend:build` sets well-formed stand-ins, not the opt-in, so `check:bundle` measures
>   production's shape. Test gate *executed*: `tests/env.test.js` (34 cases), 8 red with `main`'s
>   `frontend/src` and `vite.config.js` restored; template `check-env` 0 findings (3 on `main`);
>   E2E (mock, one worker) 92 of 94 with 2 load flakes that pass on rerun (8 of 8).
>   Vercel preview: see the PR.
> - **Fix approach:** `frontend/src/env.js` reads each variable by name and validates with Zod:
>   Supabase URL and key required in a production build unless `VITE_USE_MOCK_SUPABASE=true`
>   (previews, E2E; M1.7's opt-in, so no second flag); Sentry DSN optional, off when unset,
>   rejected when malformed. `config.js` re-exports from it; M1.7's runtime guard moves into it
>   unchanged, and the build now fails before that guard could run. The mock's test password is
>   read from a non-`VITE_` variable at the Node layer, as `.env.test.example`'s comment plans.
> - **Files touched:** new `frontend/src/env.js`, `frontend/src/config.js`,
>   `frontend/src/lib/mockSupabaseClient.js` (password source), `.env.example`,
>   `.env.test.example`, `.github/workflows/ci.yml`
>   env, `docs/operations/ENVIRONMENT.md`, tests `tests/env.test.js`.
> - **Depends on:** M1.7.
> - **Widens:** none (Vercel preview builds without Supabase variables will now fail to build
>   unless they set `VITE_USE_MOCK_SUPABASE=true`; after M1.7 they already refuse to start, so
>   only the point of failure moves; listed in the PR).
> - **Effort:** M
> - **Acceptance criteria:** a production build with the Supabase variables unset fails with a
>   message naming them; `check:env` reports nothing.
> - **Test gate:** `tests/env.test.js` (missing required → throws; optional unset → off;
>   malformed DSN → throws) and the scorecard's `vite-spa.client-env`; both fail with the old
>   `config.js` restored.
> - **Rollback:** revert the PR.
> - **Diff class:** flagged refactor (it replaces `config.js`'s access pattern repo-wide; small,
>   but every env read moves).
> - **Verification label:** statically reviewed.
>
> 8.4 — resolved by M2.2 (no whole-object read; the test password leaves the `VITE_` prefix).

> **M2.3. Dependency updates and install guards** (audit finding 8.2, medium)
> - **Status (2026-10-13): merged as #559 (`acac2ed`), with M2.1.** `.github/dependabot.yml` (npm and
>   Actions, weekly, grouped, 3-day cooldown; holds `@types/node` below 25,
>   `eslint-plugin-react-hooks` below 7.1 and `@tanstack/react-virtual` below 3.14, each with its
>   reason); `.npmrc` with
>   `min-release-age=3`, `allow-git=none`, `allow-remote=none`; `packageManager` `npm@11.19.0`.
>   `@types/node` `^25` -> `^24` (PR 1-B's finding). `engine-strict` deliberately not set:
>   Dependabot runs npm on its own Node, and with it every update would fail on `engines`.
>   #331 triaged under M2.1 and closed. Test gate *executed*: `core.dependency-updates`,
>   `core.dependency-cooldown` and `node.install-guards` fail on `main` (cooldown `n/a`) and pass
>   here; each fails with its file removed (and cooldown with 1 day, install-guards without
>   `packageManager`). npm *executed* with the guards: a git and a tarball-URL dependency are
>   refused, and `typescript@next` resolves to 7.0.2 instead of that day's nightly. Dependabot
>   opening update PRs is visible only after merge.
> - **Fix approach:** `.github/dependabot.yml` for npm and GitHub Actions, weekly, grouped, with
>   a cooldown; `.npmrc` with `min-release-age=3`, `allow-git=none`, `allow-remote=none`;
>   `packageManager` pinned to the npm in use; triage open Dependabot PR #331.
> - **Files touched:** `.github/dependabot.yml`, `.npmrc`, `package.json`.
> - **Depends on:** M1.4.
> - **Widens:** none.
> - **Effort:** S
> - **Acceptance criteria:** Dependabot opens version-update PRs; `npm ci` honours the guards.
> - **Test gate:** scorecard `core.dependency-updates`, `core.dependency-cooldown`,
>   `node.install-guards` pass; each fails with its file removed.
> - **Rollback:** revert the PR.
> - **Diff class:** minimal diff.
> - **Verification label:** executed (current state).
>
> 8.3 — resolved by M2.3.

> **M2.4. Security policy and licence files** (audit finding 8.5, medium)
> - **Status: merged as #556 (`e1343fa`).** `SECURITY.md` names GitHub private
>   vulnerability reporting (the public API reports `enabled: true`, *executed* 2026-10-13), with
>   best-effort targets (acknowledge within 7 days; the owner confirms them), scope and supported
>   versions. `LICENSE` is choosealicense.com's ISC text verbatim, "Copyright (c) 2025-2026 Joel
>   Abraham" (D7; the owner confirms the holder and years). Test gate met, *executed*: scorecard
>   `core.security-policy` and `core.license` pass, and both fail with the two files removed.
>   GitHub's licence detection and the Security tab's policy link are checked after merge.
> - **Fix approach:** `SECURITY.md` from the skeleton, pointing at GitHub private vulnerability
>   reporting (already on) with response expectations; `LICENSE` with the ISC text (D7).
> - **Files touched:** `SECURITY.md`, `LICENSE`.
> - **Depends on:** D7.
> - **Widens:** none.
> - **Effort:** S
> - **Acceptance criteria:** GitHub's Security tab shows the policy; the licence is detected.
> - **Test gate:** scorecard `core.security-policy` and `core.license` pass; fail with the files
>   removed.
> - **Rollback:** revert.
> - **Diff class:** minimal diff.
> - **Verification label:** executed (current state).
>
> 12.6 — resolved by M2.4.

> **M2.5. Game and practice persistence calls can hang forever** (audit finding 5.2, medium)
> - **Status: merged as #556 (`e1343fa`).** New `frontend/src/lib/persistenceRequest.js`
>   gives every request the game and practice clients send (game save, practice save, repair save,
>   enact) the team panel's contract: an `AbortController` aborted at a deadline, and an error
>   with `code: 'PERSISTENCE_TIMEOUT'` whose message says the outcome is unknown. The deadline is
>   160 s, past Supabase's 150 s Edge request idle timeout (which answers 504), so it never calls
>   a slow save that is still committing a failure; it fires only for a lost connection or a
>   stalled body. A 2xx whose body is not a JSON object throws `PERSISTENCE_UNREADABLE_RESPONSE`;
>   a non-2xx keeps its `HTTP <status>` message. Test gate met, *executed*: never-resolving and
>   stalled-body cases in `tests/gamePersistenceClient.test.js` and the new
>   `tests/practicePersistenceClient.test.js` (fake timers; the sender list is checked against
>   the module's exports, and neither client may call `fetch` directly), red with the old
>   clients restored and with the timer removed. Apply
>   re-enabling after the error is the pages' existing catch path, *statically reviewed*.
> - **Fix approach:** reuse the team-persistence client's timeout (`AbortController`) in the game
>   and practice clients; treat an unparsable success body as an error.
> - **Files touched:** `frontend/src/utils/gamePersistenceClient.js`,
>   `frontend/src/utils/practicePersistenceClient.js`, `tests/gamePersistenceClient.test.js`,
>   `tests/practicePersistenceClient.test.js`.
> - **Depends on:** none.
> - **Widens:** none.
> - **Effort:** S
> - **Acceptance criteria:** with the Edge Function stalled, Apply shows a timeout error and
>   re-enables.
> - **Test gate:** new never-resolving-fetch cases in both client tests; fail with the timeout
>   removed.
> - **Rollback:** revert.
> - **Diff class:** minimal diff.
> - **Verification label:** statically reviewed.

> **M2.6. `fairness-scoring` records a 0-conflict run for an empty roster** (not an audit finding: found by PR 1-A, #551; medium; placed here by the supervisor, the owner may move it)
> - **Status: merged as #556 (`e1343fa`).** `refuseEmptyPracticeRoster`
>   (`_shared/schemas/scoring.ts`) answers 422 `EMPTY_PRACTICE_ROSTER`, naming the counts, for a
>   practice block with no teams or no slots; the handler calls it right after parsing, before the
>   season read, the engine and `persist_evaluation_run`, whatever `persist` says. Test gate met,
>   *executed*: `_shared/tests/fairness-empty-roster_test.ts` (the refusal with `persist` both
>   ways, and a source pin on the handler's order, since the handler module calls `serve()` on
>   import), red with the call removed, with the call moved after persistence and with the
>   refusal neutered; the mirror job's floor rises to 13. "Writes no `evaluation_runs` row" rests
>   on that order, *statically reviewed*; it is checkable on production after merge.
> - **Fix approach:** refuse at the Edge, before evaluating or persisting: a request whose
>   `practice` block has no teams or no slots gets a 422 with a named code (for example
>   `EMPTY_PRACTICE_ROSTER`), whether or not `persist` is set. #551 stopped the page sending one;
>   the server must not rely on that (validation and authorization are server-side).
> - **Files touched:** `supabase/functions/_shared/schemas/scoring.ts` (or the handler in
>   `supabase/functions/fairness-scoring/index.ts`), a test under
>   `supabase/functions/_shared/tests/`.
> - **Depends on:** none (M1.1 merged).
> - **Widens:** none.
> - **Effort:** S
> - **Acceptance criteria:** a request with `practice.teams: []` or `practice.slots: []`, with
>   `persist: true`, returns 422 and writes no `evaluation_runs` row.
> - **Test gate:** the new Deno test of the refusal, shown failing with the check removed; the
>   discovery-based `deno-mirror-tests` job runs it.
> - **Rollback:** revert the PR.
> - **Diff class:** minimal diff (input validation; no schema or persistence change).
> - **Verification label:** statically reviewed (the defect, read in #551's review).

**Milestone exit:** [x] no unwaived high/critical advisory and the audit gate runs on PRs and
weekly (#559; `npm audit (high and critical block)` passed on `main`'s head, read 2026-10-19) ·
[x] a production build without Supabase variables fails (#558) · [x] scorecard passes the
standards these items name (2026-10-19, see "Close-out") · [~] deployed and smoke-tested (merged;
smoke deferred to the owner's v1.1.0 release smoke)

---

## Milestone 3 — Testing & CI depth

> **M3.1. Coverage thresholds are configured but never enforced** (audit finding 6.1, high)
> - **Status (2026-10-13): merged as #574 (`ca6279c`).**
>   Build & Test's "Unit & Integration Tests" step runs `npm run test:coverage`. Measured with
>   CI's command on `main` at `9fba821` merged with this branch (*executed*): 93.08 / 84.37 / 95.21
>   / 94.07 overall, 65.32 / 55.54 / 67.81 / 69.37 for `frontend/src/hooks`. Thresholds raised
>   from 60 / 50 / 55 / 60 to about 3 points under each, rounded down: 90 / 81 / 92 / 91 overall
>   and a separate 62 / 52 / 64 / 66 for the hooks, reasons in `vitest.config.js`. The `.bin`
>   lookup table is excluded (v8 logged a PARSE_ERROR on it). `env.test.js`'s whole-tree
>   `import.meta.env` scan runs 4x slower under coverage (1.1 s to 4.5 s alone) and timed out once
>   at 5 s, so it has a measured 25 s timeout (`docs/testing/test-timeouts.md`).
>   `tests/workflowPins.test.js` fails if the step goes back to `npm run test` or can't fail.
>   The wall-clock benchmark (`tests/performance.test.js`) is left out of the coverage run, where
>   v8 slowed the engine about 9x and it failed #574's first CI run at 20,037 ms against 20 s; it
>   runs alone in its own step (`npm run test:perf`, 3 s budget, shown failing on a planted 3.5 s
>   slowdown). **Test gate, as measured:** no single test file can drop coverage past any threshold with
>   room in it: the suite covers most code several times over, and deleting the largest file
>   (`feasibilityApi.test.js`, 133 tests) moved the overall figures by 0.08 points. Deleting the
>   11 hook unit tests (`tests/use*.test.*`) is the gate shown instead: overall it moved to 91.27 /
>   82.61 / 93.40 / 92.17, which the overall thresholds alone pass, and the hooks' own fail it
>   (41.13 / 33.48 / 46.23 / 43.78 against 62 / 52 / 64 / 66; `npm run test:coverage` exits 1).
>   *Executed.*
> - **Fix approach:** run `npm run test:coverage` in CI in place of `npm run test`. Measured on
>   `565e980` it passes (93.07 / 84.23 / 95.19 / 94.04 against 60 / 50 / 55 / 60), so no test
>   work is needed first; the July audit's hooks shortfall no longer holds. Optionally raise the
>   thresholds toward the measured values, with the reason in `vitest.config.js`.
> - **Files touched:** `.github/workflows/ci.yml`, `vitest.config.js` (only if thresholds are
>   raised).
> - **Depends on:** none.
> - **Widens:** none.
> - **Effort:** S
> - **Acceptance criteria:** CI fails when coverage drops below the thresholds.
> - **Test gate:** a PR that deletes a covered test file fails CI's coverage step.
> - **Rollback:** revert to `npm run test`.
> - **Diff class:** minimal diff.
> - **Verification label:** statically reviewed.

> **M3.2. pgTAP runs only on some PRs, so it can't be required** (audit finding 6.3, medium)
> - **Status (2026-10-13): merged as #573 (`9fba821`);
>   the live ruleset requires the pgTAP check (read back 2026-10-19, *executed*).** `pgtap.yml` has no `paths` filter and
>   pins CLI `2.118.0`, the deploy jobs' version (kept over 2.95.4 because `migrationGuard.mjs`
>   parses 2.118.0's JSON; `supabaseCliPin.test.js` now holds every workflow to one version).
>   `supabase start` skips the services no suite uses, after an edge-runtime 502 failed a run.
>   `main.json` requires `Run pgTAP against local Supabase` and, with the owner's approval,
>   `npm audit (high and critical block)`; `rulesetRequiredChecks.test.js` reads every workflow.
>   Green on 2.118.0: 53 files, 662 assertions (*fully validated*, dispatch run 38484268374).
>   Test gate: a throwaway migration adding a permissive `USING (true)` SELECT policy on `teams`
>   failed `rls_cross_org_isolation.sql` tests 1 and 3 (*fully validated*, dispatch run
>   38484483751 on a throwaway branch, no PR). Merge blocking is live: the ruleset lists the check.
> - **Fix approach:** drop the `paths` filter from `pgtap.yml` (D5), use the one
>   `SUPABASE_CLI_VERSION`, and add it to the ruleset's required checks.
> - **Files touched:** `.github/workflows/pgtap.yml`, `.github/rulesets/main.json`.
> - **Depends on:** M1.3.
> - **Widens:** none.
> - **Effort:** S
> - **Acceptance criteria:** every PR shows the pgTAP check; merge blocks when it fails.
> - **Test gate:** a planted policy regression in a test migration on a throwaway branch fails
>   the job.
> - **Rollback:** restore the filter and remove the required check.
> - **Diff class:** minimal diff.
> - **Verification label:** statically reviewed.
>
> 3.1 — resolved by M3.2.

> **M3.3. Supabase's own advisors never run** (audit finding 8.6, medium)
> - **Status (2026-10-13): merged as #573 (`9fba821`).**
>   `supabase db advisors --local --type all --level info --fail-on none --output-format json`
>   (flags confirmed with `--help` on 2.118.0), read by `scripts/ci/supabaseAdvisors.mjs`
>   against `docs/security/supabase-advisor-waivers.json` (a waiver names each finding by its
>   `cacheKey`): unwaived WARN/ERROR, stale, expired or invalid waivers fail; unreadable or empty output exits 2. Triage of 176 findings (33 WARN): `min`
>   and `set_updated_at` search_path accepted; `auth_rls_initplan` (11 policies) and
>   `multiple_permissive_policies` (20 tables) waived as debt to 2027-01-11, not fixed (an RLS
>   rewrite is its own reviewed change). No migration. Test gate: a throwaway table without RLS
>   failed the step (`ERROR rls_disabled_in_public`), as did the planted policy
>   (`multiple_permissive_policies` on `teams`) (*fully validated*, run 38484483751).
> - **Fix approach:** in the pgTAP job, after `supabase start`, run `supabase db advisors
>   --fail-on warn` (confirm the flag with `--help` on the pinned CLI); triage what it reports,
>   waiving with reasons in the job.
> - **Files touched:** `.github/workflows/pgtap.yml`, possibly a migration for real findings
>   (with revert and smoke).
> - **Depends on:** M3.2.
> - **Widens:** none.
> - **Effort:** M
> - **Acceptance criteria:** the job fails on a new advisor warning.
> - **Test gate:** scorecard `supabase.advisors-in-ci`; a planted table without RLS in a
>   throwaway migration fails the job.
> - **Rollback:** remove the step.
> - **Diff class:** minimal diff.
> - **Verification label:** statically reviewed.

> **M3.4. The migration harness runs nowhere in CI, and needs an undocumented OS user** (audit finding 4.2, medium)
> - **Status (2026-10-13): merged as #573 (`9fba821`).**
>   `dbharness.yml` (job `Migration harness (PostgreSQL 16)`, ubuntu-24.04) runs on PRs touching
>   `supabase/`, `docs/sql/`, `scripts/dbharness/` or itself, creates `pgrunner`, runs the
>   harness as root and fails unless it exits 0 with `HARNESS OK`. Not required (path-filtered).
>   `ci-cd.md` has "Running the database harness" (`HARNESS_PGUSER`, `pgrunner`, `pgrunner2`);
>   `run.sh`'s header is corrected. Baseline here: HARNESS OK, 128 migrations, 145 s
>   (*executed*, `HARNESS_PGUSER=postgres`). Test gate: a smoke assertion planted in
>   `20261006000000_smoke.sql` gave `FAIL smoke 20261006000000`, HARNESS FAILED, exit 1
>   (*executed* here; CI: throwaway draft PR #572).
> - **Fix approach:** a CI job that runs `scripts/dbharness/run.sh` on PRs touching
>   `supabase/` or `docs/sql/`, creating the harness user (or setting `HARNESS_PGUSER`); a
>   "Running the database harness" section in `docs/operations/ci-cd.md`; the stale header
>   comment corrected.
> - **Files touched:** `.github/workflows/ci.yml` (or `dbharness.yml`),
>   `docs/operations/ci-cd.md`, `scripts/dbharness/run.sh` (comment only).
> - **Depends on:** none.
> - **Widens:** none.
> - **Effort:** S
> - **Acceptance criteria:** the job reports "HARNESS OK" on PRs that touch migrations.
> - **Test gate:** a planted failing assertion in a smoke script fails the job.
> - **Rollback:** remove the job.
> - **Diff class:** minimal diff.
> - **Verification label:** executed (the harness, here, with `HARNESS_PGUSER=postgres`).

> **M3.5. Workflows unaudited, actions pinned by tag** (audit finding 7.4, medium)
> - **Status (2026-10-13): merged as #574 (`ca6279c`).**
>   Every `uses:` is pinned by full commit SHA with a `# vX.Y.Z` comment, each resolved from the
>   action's tags with `git ls-remote` (the commit its moving major tag named that day, so no
>   action changed): checkout v7.0.1, setup-node v7.1.0, upload-artifact v7.0.2, setup-deno
>   v2.0.5, setup-cli v2.1.2 (#573's `dbharness.yml` included). New `workflow-audit.yml` runs
>   zizmor 1.30.1 (pinned, `pipx run`, online with the job's token) over `.github` (not the
>   template's skeletons under `prompts/`) on pull requests and pushes to `main`. On `18ebc0e` zizmor
>   reported 25 findings (18 tag pins, 5 checkouts persisting the token, 2 Dependabot cooldowns
>   under 7 days; exit 14); now none: pins, `persist-credentials: false`, and the 3-day cooldown
>   kept to match `.npmrc` and configured with its reason in `.github/zizmor.yml`. A planted
>   `pull_request_target` checkout fails it (`dangerous-triggers`, exit 14). Scorecard
>   `core.workflows-audited`: fail before, pass after. `tests/workflowPins.test.js` holds the pin
>   shape, one release per action, the zizmor run line (an allowlist) and `.github/zizmor.yml`
>   offline, each detector shown catching a plant. Not a required
>   check (owner settings). *Executed* (zizmor offline locally; online in the PR's CI).
> - **Fix approach:** zizmor in CI on PRs; pin every action by commit with a `# vN` comment;
>   Dependabot (M2.3) keeps the pins current.
> - **Files touched:** `.github/workflows/*.yml`.
> - **Depends on:** M2.3.
> - **Widens:** none.
> - **Effort:** S
> - **Acceptance criteria:** zizmor passes; no tag-pinned action remains.
> - **Test gate:** scorecard `core.workflows-audited`; zizmor fails on a planted
>   `pull_request_target` checkout.
> - **Rollback:** revert.
> - **Diff class:** minimal diff.
> - **Verification label:** executed (current state).

**Milestone exit:** [x] coverage, pgTAP, advisors and the harness fail CI on a planted defect
(each item's test gate, #573, #574) · [x] pgTAP required (live ruleset, 2026-10-19) · [~] deployed
and smoke-tested (merged; smoke deferred to the owner's v1.1.0 release smoke)

---

## Milestone 4a — Completeness vs. what "complete" means: the flows

> **M4.6. The E2E scenarios named for the engines never run them** (audit finding 13.3, high)
> - **Status (2026-10-14): merged as #579 (`3d26248`).** The three scenarios press Generate Teams, Run auto-scheduler and Generate Schedule
>   on seeded inputs and read the page: the team engine forms 10 teams where 5 were asked for
>   (100 players, at most 10 each); a planted coach clash leaves one of two teams unplaced and a
>   slot a locked practice fills gets nobody; 3 of 6 matchups are scheduled, with a coach clash,
>   a shared coach and a full week each reported by reason. The practice route is answered by
>   the auto-scheduler's own solver modules in the test runner (the function's HTTP and database
>   wrapper is not exercised there; M4.1 covers it). Each scenario fails with its engine stubbed
>   to return nothing, and the coach and capacity checks fail with the solver's constraint
>   removed (*executed*, locally, mock mode, `--workers=1`). The lint rule is in
>   `eslint.config.js`; the 15 existing reads it found in four other step files are waived line
>   by line (see "Discovered during execution").
> - **Fix approach:** rewrite the three Pillar 1 scenarios to drive the UI's own Generate / Run /
>   Generate-schedule controls on seeded inputs and assert what the page then shows (team count
>   from the engine, a planted coach clash reported, a planted over-capacity slot refused), with
>   no write to `__MOCK_DB__` standing in for the engine; delete the steps that assert a card is
>   merely visible.
> - **Files touched:** `tests/e2e/features/Pillar1_Engine.feature`,
>   `tests/e2e/steps/scheduling_and_overrides.ts`.
> - **Depends on:** M1.1 (the practice page's evaluation must see real data first).
> - **Widens:** none.
> - **Effort:** M
> - **Acceptance criteria:** each scenario fails when the engine call it names is stubbed to
>   return nothing.
> - **Test gate:** the rewritten scenarios themselves, shown failing with the engine call
>   replaced by an empty result on a throwaway branch.
> - **Rollback:** revert (tests only).
> - **Diff class:** minimal diff (tests only).
> - **Verification label:** executed (the current scenarios pass while forging the result).
>
> 6.6 — resolved by M4.6 (its rewrite removes the sessionStorage assertions from the scenarios
> it touches, and adds a lint rule, `no-restricted-syntax` on `__MOCK_DB__` inside `Then` steps,
> so CLAUDE.md's rule 2 is enforced rather than declared).


> **M4.1. No core flow is proven against the real backend** (audit finding 13.2, medium)
> - **Status (2026-10-14): merged as #578 (`39bebc6`).** `.github/workflows/e2e-real-backend.yml`, job **E2E against local Supabase**, runs
>   on every pull request (no `paths` filter, no job `if`) and is not required yet. It starts
>   `supabase start` with the edge runtime (its own job, so the required pgTAP job keeps
>   excluding it), seeds `tests/e2e/real-backend/seed.sql` (pseudonymous; `supabase/seed.sql`
>   fails on the migrated schema, as its header says) and runs the `real-backend` Playwright
>   project against a production build: a narrower re-import keeps the guardians the first
>   import recorded (the July TG-6 path, migration `20260726000300`); import, teams synced
>   through `team-persistence`, practices placed by `auto-scheduler` and applied through
>   `practice-persistence`, and a master CSV with a practice for every synced team, by name;
>   every function `supabase/config.toml` marks `verify_jwt` refusing, by its own `Unauthorized`
>   answer, a caller with no session, and `calendar-feed` answering without one. Green in runs
>   38502102302, 38516599353 (after merging `main` at `2a0425d`) and 38517235455 (after the
>   review round), each job under 3 minutes (*executed*). Test gate (*executed*, throwaway branch
>   `claude/vibrant-allen-hr7y7s-w3d-ci`): run 38502405552 applied
>   `docs/sql/20260726000300_revert.sql` after the seed and the re-import scenario failed at its
>   guardian check ("No guardians on file."), where the mock, which runs no migration, would
>   not; leaving one practice slot failed the season flow at the page's own warning (a team
>   with no practice). Run 38502798265 removed that warning check, and the export check failed
>   instead (practices for 1 team of 2); with `game-persistence` answering anonymous callers
>   (`verify_jwt` off and its own refusal skipped) its refusal scenario failed (500, not 401).
>   A function that cannot boot fails it too (503, run 38501076266, before the job gave the
>   local runtime its import map).
>   After the review round (each refusal read from `config.toml` and required to be the
>   function's own, the export compared by team name), run 38517555582 planted again: the
>   refusal scenario failed on `game-persistence` (500) and on `calendar-feed` put behind
>   `verify_jwt` (400, its own answer); the guardian check failed on the revert; the export
>   check failed with "U10 Team 02" missing.
>   `verify_jwt` off alone does not fail it: the function refuses a caller with no session
>   itself (run 38502405552). The features and steps are under `tests/e2e/real-backend/`, not
>   `tests/e2e/features/` and `tests/e2e/steps/`: the mock project's globs would load them.
>   Made a required check by #581 (the live ruleset lists it, read back 2026-10-19). The audit-log assertion after import is done (2026-10-17, branch
>   `claude/vibrant-allen-hr7y7s-exports`, entry below): each import in the re-import scenario
>   requires its import-validation and `finalize_import_job` audit rows, as the administrator
>   (*executed*, dispatched run 39008438365; red with the action renamed, run 39008441959).
> - **Fix approach:** a Playwright project that runs a small set of scenarios (sign in → import
>   players → generate teams → schedule practices → export) against a local Supabase stack
>   (`supabase start`, seeded from `supabase/seed.sql` with pseudonymous data), in the pgTAP job
>   or its own; start with the flows whose mock RPCs the July audit found divergent.
> - **Files touched:** `playwright.config.ts` (a second project), `tests/e2e/features/real_backend_*.feature`,
>   `tests/e2e/steps/`, `.github/workflows/pgtap.yml` (or a new workflow).
> - **Depends on:** M3.2.
> - **Widens:** none.
> - **Effort:** L
> - **Acceptance criteria:** the real-backend scenarios pass in CI on every PR.
> - **Test gate:** reverting migration `20260726000300`'s coalesce in a throwaway branch fails
>   the re-import scenario (the mock would not).
> - **Rollback:** remove the project and job.
> - **Diff class:** minimal diff (new tests only).
> - **Verification label:** statically reviewed.
>
> 6.4 — resolved by M4.1.

> **M4.7. Both scoring engines judge a weekly slot by its first occurrence and ignore assignment date ranges** (not an audit finding: found by PR 1-A, #551; medium) — **plan first: needs the owner's approval before any code**
> - **Status (2026-10-17): built and merged (#560); the exceptions follow-up (Q1) merged as #590
>   (`d5f74e5`).** Ranges and slot
>   validity are in both engines, held together by a dated parity extract (corpus cases C1
>   and C4) and 14 hand-written witnesses run by core, the cross-arm drift test and Deno; the
>   page sends each slot's dating and each row's range, the override panel counts from the
>   season's today on, and apply-time metrics are dated (Q9). The undated extract is
>   byte-identical, and the solver's outputs over a season-2026 sweep match `main` byte for
>   byte except the new `dateModel: 'undated'` on its evaluation (*executed*). Each of the
>   plan's plants (P1-P7, plus three more) turns a test red (*executed*).
>   **Exceptions (Q1, the follow-up):** both engines now apply the season's live
>   `practice_exceptions` through `applyPracticeExceptions` and its Edge twin: a `relocated`
>   date is compared and counted at its new slot and time, a `time_tbd` date is in neither
>   comparison and is reported (`timeTbd`, and a `time-tbd` warning on the Edge), and an
>   exception that cannot be applied is a data-quality line. The page reads and sends them (a
>   failed read withholds the evaluation and says why), and apply-time metrics apply them (an
>   unread list records no metrics and says why). Held together by 10 more witnesses in
>   the shared vector table (core, drift, Deno) and a dated parity case C5 (C4 with two
>   modelled exceptions); every witness fails on the engines before it, in both arms
>   (*executed*, Deno 2.9.6 locally). The override panel's "N free" does not read exceptions
>   (declared, a question in the PR). The solver is M4.8 (Q2).
>   The plan is [`docs/PLAN_SCORING_DATE_MODEL.md`](../../PLAN_SCORING_DATE_MODEL.md) (#555).
>   Measured (*executed*, scratch witness through the page's own slot builder and both engines):
>   the two arms agree, so the defect is shared, not drift; modelling the corpus's "Select OLD"
>   revision as closed series gives 11 reported coach conflicts where 1 is real (Edge fairness
>   score 0.68 -> 0), and re-creating one slot valid from a later date hides the plan's one real
>   conflict.
> - **Why here:** it decides whether the fairness evaluation, a core flow (D3), is right about
>   real schedules, which is what this milestone measures; and it is a domain-model change, so
>   it cannot ride in a fix-only milestone. It is the same gap as the other session's backlog
>   entry from #541: the override panel's per-slot count and `EvaluationPanel` have no date
>   model, so a closed series still counts against its slot.
> - **Fix approach (to be planned, not built):** give the evaluators a date model: compare two
>   assignments only where their date ranges (`validFrom`/`validUntil`, or the stored row's
>   range) overlap, and compare slot occurrences on the dates both are live rather than the
>   first occurrence's instant. Same change in `packages/core/src/practiceMetrics.js` (the
>   coach-conflict sweep) and `supabase/functions/_shared/engines/scoring-engine.ts`, held
>   together by M1.2's parity test, and in the per-slot counts that share the gap. The plan names
>   which inputs carry ranges today and what an open-ended range means.
> - **Files touched:** the two engines, the panel and override counts that read slot usage,
>   their tests, the parity fixture; the plan says which.
> - **Depends on:** M1.2 (parity test) and the owner's approval of the plan (CLAUDE.md: a
>   change to the domain model is planned and approved first).
> - **Widens:** the season-2026 fixture suite must be run (domain types change).
> - **Effort:** M
> - **Acceptance criteria:** two series on the same weekday slot whose date ranges do not
>   overlap report no coach conflict and do not count against each other's capacity; two that
>   overlap by one week report it; both engines agree.
> - **Test gate:** cases for disjoint, touching and overlapping ranges in core and Deno, shown
>   failing on today's engines; the parity test over the same inputs.
> - **Rollback:** revert the PR (no data changes).
> - **Diff class:** flagged change to the domain model (plan first).
> - **Verification label:** executed (witnesses, parity, plants and the solver sweep, locally);
>   merged through the required checks (#560, #590).

> **M4.8. The auto-scheduler's coach check compares first-occurrence instants, so it can double-book a coach** (not an audit finding: found by the M4.7 plan, Q2; medium) — **plan first: needs the owner's approval before any code**
> - **Status (2026-10-18): merged as #593 (`208ccc6`).** Plan `docs/PLAN_SOLVER_DATE_MODEL.md`, approved
>   by the owner on 2026-10-18 with every recommendation as written. The solver judges
>   dated occupancy from the store's slot dating; `scoreSchedule` scores dated; a slot it cannot
>   date refuses the run (422 `SLOT_DATING_UNREADABLE`); the response carries `liveFrom` and the
>   page dates new placements from it. On the season-2026 corpus sweep (lock shares 0 / 0.5 /
>   0.9, seeds 1 / 2 / 3, two todays) the placements are byte-identical to a golden generated on
>   `main` before the change (*executed*). No migration. The plan's §12 records how the build
>   settled what the text left open.
> - **Status (2026-10-13, history): open, not planned.** Proposed by the M4.7 plan (Q2, approved as
>   recommended) and left out of M4.7 because it is the solver, whose behaviour that item froze.
> - **Why here:** it is the same gap M4.7 closes in the evaluators, left open in the one place
>   that decides placements; after M4.7 the panel reports the clash the solver can create, but
>   nothing stops the solver creating it.
> - **Fix approach (to be planned, not built):** give `checkHardConstraints`
>   (`_shared/engines/practice-coaches.ts`) and the solver's occupancy the dated rule M4.7 put
>   in the evaluators (live dates of each slot's weekday inside its validity and each row's
>   range, a clash on a shared date with overlapping wall windows), so two slots on one weekday
>   and time whose `valid_from` differ (M4.7's W4 shape) are not both given to one coach, and a
>   locked row holds its slot only on its own dates (today: season-long, declared in
>   `auto-scheduler-solver.ts`). Decide whether `scoreSchedule` scores dated, which changes the
>   search. The plan must name the default-freeze contract (CLAUDE.md: maximum freeze, minimal
>   diff) under the new rule.
> - **Files touched:** `supabase/functions/_shared/engines/practice-coaches.ts`,
>   `auto-scheduler-solver.ts`, the page's auto-scheduler payload (slot dating), their tests; the
>   plan says which.
> - **Depends on:** M4.7 (the dated rule and its twins) and the owner's approval of the plan
>   (CLAUDE.md: plan before implementing any solver change).
> - **Widens:** the season-2026 fixture suite, and a solver sweep against `main` (M4.7's sweep,
>   lock shares 0 / 0.5 / 0.9 by three seeds, is the template) showing exactly which placements
>   move and why.
> - **Effort:** M
> - **Acceptance criteria:** in W4's shape the solver never places one coach on both slots; on
>   the undated corpus plan its placements are unchanged; a locked row whose series has ended
>   no longer blocks its slot from today on.
> - **Test gate:** a W4-shaped case in `tests/autoSchedulerLock.test.js` (and its Deno twin)
>   shown failing on today's solver; the sweep's placement diff reviewed and quoted in the PR.
> - **Rollback:** revert the PR and redeploy `auto-scheduler` (no data changes).
> - **Diff class:** flagged change to the solver (plan first).
> - **Verification label:** statically reviewed (the evaluator's version of the shape
>   *executed* by the M4.7 plan, §2.2 W4).

## Milestone 4b — Completeness: accessibility and validation

> **M4.2. No automated accessibility check** (audit finding 11.1, high)
> - **Fix approach:** `eslint-plugin-jsx-a11y` (recommended set) in `eslint.config.js`, fixing or
>   line-waiving with reasons what it reports; an axe step after each top-level route in the E2E
>   suite, asserting no serious or critical violations.
> - **Files touched:** `package.json`, `package-lock.json`, `eslint.config.js`,
>   `tests/e2e/features/accessibility.feature`, `tests/e2e/steps/accessibility.ts`, components the
>   scan flags.
> - **Depends on:** none.
> - **Widens:** none.
> - **Effort:** L
> - **Acceptance criteria:** lint and the axe scenario fail on a planted unlabeled button.
> - **Test gate:** the planted unlabeled button.
> - **Rollback:** revert.
> - **Diff class:** minimal diff for the tooling; fixes triaged separately.
> - **Verification label:** statically reviewed.
> - **Status: merged as #580 (`16e63eb`); its last waiver (the light accent palette) removed by #581.** Lint:
>   `eslint-plugin-jsx-a11y` recommended on `frontend/src`, plus `control-has-associated-label`
>   (off in that set, and the only rule that sees a nameless button). Its 26 findings: labels tied
>   to their controls, a heading button on each workflow step, sort headers as buttons, grid keys
>   kept off the controls inside it, redundant roles; the rest waived on their line with the
>   reason. E2E: `accessibility.feature` scans the sign-in page and 29 top-level routes, light
>   then dark, for serious or critical axe violations (WCAG 2.0-2.2 A/AA). Its first run failed every
>   route, mostly on `--text-muted` (3.1:1 light, 3.9:1 dark); fixed: that token in both themes,
>   primary-button and avatar text, status text on status fills, the analytics page's untokenised
>   colours, the audit log's unnamed filter, pager and scroll region. `tests/accessibilityRoutes.test.js` holds the
>   scan to `App.jsx`'s routes. Test gate, *executed*: a planted icon button with no name fails
>   lint (`control-has-associated-label`) and the `/` scenario (`button-name`, critical); reverted,
>   both green. A planted button whose icon is a React component (`<Sparkles />`) fails the scan
>   but not lint: the rule assumes a component child may render text. Open: two known
>   violations, listed in `KNOWN_VIOLATIONS` with their owners (below).

> **M4.3. The game grid is drag-only** (audit finding 11.2, high)
> - **Status (2026-10-14): merged as #579 (`3d26248`).** The grid uses the roster manager's sensor pattern with its own arrow-key rule
>   (`gridKeyboardCoordinates`: `sortableKeyboardCoordinates` moves only a droppable, and a game
>   card is not one), named announcements, a grip button as the keyboard activator, and a
>   "Move to…" list on each card of the empty game slots on their own field. A drop and a Move
>   both call `moveGameTo`, which now refuses a cell that already has a game and stages nothing
>   for a game put back where it was (behaviour change for a pointer drop too); focus follows the
>   moved game (cards are keyed by game, so dnd-kit's focus restore finds the right one). Tests in
>   `tests/GameCard.test.jsx` (keyboard drag over the real grid, the control) and
>   `tests/gameGridKeyboard.test.jsx` (the page), each shown failing with its piece removed
>   (*executed*); keyboard drag and Move to also checked in real Chromium on the mock app
>   (*executed*, a scratch scenario, not committed). Also fixes the By Team selector's orphaned
>   `<label>` that M4.2's jsx-a11y scan reported.
> - **Fix approach:** the roster manager's `KeyboardSensor` pattern on the game grid's
>   `DndContext`, and a "Move to…" control on `GameCard` that reuses the existing assignment
>   handler.
> - **Files touched:** `frontend/src/pages/GameSchedulingPage.jsx`,
>   `frontend/src/components/scheduling/GameCard.jsx`, `tests/GameCard.test.jsx`.
> - **Depends on:** none.
> - **Widens:** none.
> - **Effort:** M
> - **Acceptance criteria:** a game can be moved with the keyboard alone.
> - **Test gate:** a keyboard-move case in `tests/GameCard.test.jsx`; fails without the sensor
>   and control.
> - **Rollback:** revert.
> - **Diff class:** minimal diff.
> - **Verification label:** statically reviewed.

> **M4.4. Persistence payloads aren't validated before they leave the client** (audit finding 2.3, medium)
> - **Status: merged as #576 (`2a0425d`).** Each client
>   checks its body against core's copy of the `PersistencePayloadSchema` its Edge Function parses
>   it with, before the network call: `PersistencePayloadSchema` (team; it gains the Edge's
>   `lastRunId`/`runId`), and the new `GamePersistencePayloadSchema` and
>   `PracticePersistencePayloadSchema` (`packages/core/src/schemas/index.js`), judged on the body
>   as JSON will send it. A refusal names each Zod issue (`path: message`, the first five and a
>   count) and keeps each client's contract: the team client returns `{ status: 'error' }`, the
>   game and practice clients throw, both with `code: 'PERSISTENCE_INVALID_PAYLOAD'` and the
>   `issues`. Test gate met, *executed*: a malformed-payload case per client (and per practice
>   sender: save, repair, enact), each red with the parse neutered;
>   `tests/persistencePayloadSchemaDrift.test.js` evaluates each Edge schema from its source under
>   zod 3 and holds client and server to one verdict over a mutation product (red on three planted
>   drifts, and on `main`'s team schema, which lacked `lastRunId`). The three PR 2-C follow-ups
>   ride in the same PR (Discovered during execution, 2026-10-14).
> - **Fix approach:** `PersistencePayloadSchema.safeParse()` in `teamPersistenceClient.js` (and
>   the game and practice snapshot schemas in theirs) before the network call, rejecting with the
>   Zod issue list.
> - **Files touched:** `frontend/src/utils/*PersistenceClient.js`, their tests.
> - **Depends on:** M2.5.
> - **Widens:** none.
> - **Effort:** S
> - **Acceptance criteria:** a malformed payload is refused client-side with a readable error.
> - **Test gate:** a malformed-payload case per client; fails with the parse removed.
> - **Rollback:** revert.
> - **Diff class:** minimal diff (touches persistence, so the plan is shown first per CLAUDE.md).
> - **Verification label:** statically reviewed.

> **M4.5. The staging suite never runs** (audit finding 6.2, medium)
> - **Status (2026-10-14): deleted, merged as #578 (`39bebc6`), with M4.1.** Run against production with the publishable key on 2026-10-14 (*executed*: anon
>   reads, one anon insert RLS refused, unauthenticated Edge calls), its connectivity test
>   failed on a healthy project (`error` is null, so `toContain` throws), and in a probe copy a
>   table that does not exist passed its schema check: it could not fail where it mattered.
>   It targeted production (there is no staging project). Its schema and RLS checks are held by
>   the migrations CI applies from scratch and `supabase/tests/rls_anonymous_gate.sql`; its Edge
>   refusal checks moved to M4.1's `real_backend_edge_auth.feature`, now reading the functions
>   from `supabase/config.toml` and requiring each function's own refusal. Its CORS preflight
>   check was not kept: on the local stack a preflight still allowed `authorization` with the
>   function's own CORS headers stripped (run 38518016051), so it could not fail there.
> - **Fix approach:** move `tests/integration/staging.test.js` into a `workflow_dispatch`
>   workflow with staging secrets that records its result, or delete it if M4.1 covers it.
> - **Files touched:** `tests/integration/staging.test.js`, `.github/workflows/staging.yml`.
> - **Depends on:** M4.1.
> - **Widens:** none.
> - **Effort:** S
> - **Acceptance criteria:** the suite has a recorded passing run, or is gone.
> - **Test gate:** the workflow's run result.
> - **Rollback:** revert.
> - **Diff class:** minimal diff.
> - **Verification label:** executed (it skips today).

**Milestone exit (4a and 4b):** [x] real-backend E2E green on PRs and required (#578, #581) ·
[x] the engine scenarios fail when their engine is stubbed (#579) · [x] accessibility scan in E2E
(#580, widened by #591) · [~] deployed and smoke-tested (merged; smoke deferred to the owner's
v1.1.0 release smoke)

---

## Milestone 5 — Agent rules, docs and operability

> **M5.1. One AGENTS.md for every agent, without contradictions** (audit finding 12.1, high)
> - **Status (2026-10-13): merged as #557 (`b80e077`).** Root `AGENTS.md` (23,589 bytes when merged; since resized, #586) holds every rule, its
>   sections numbered as CLAUDE.md's were; `CLAUDE.md` is `@AGENTS.md` plus Claude Code's notes.
>   The contradictions and how each was resolved are listed in the PR. `project-hardening/` is
>   deleted after its durable rules were merged (one task per PR, merge only on the owner's say,
>   review-bot comments, call-site sweeps, backward compatibility, the incremental-teaming
>   invariants); its merge authority and model choice were not carried. The committed
>   `.features-gen/` spec is deleted. *Executed:* `core.agent-rules` and `check:instructions`
>   pass, and fail with `AGENTS.md` removed or a dead path planted.
> - **Fix approach:** per D1, move CLAUDE.md's shared rules into a root `AGENTS.md` (merging from
>   `prompts/skeletons/AGENTS.skeleton.md`, naming this repo's real paths), leave `CLAUDE.md` as
>   `@AGENTS.md` plus Claude-only notes; resolve the contradictions in 12.3 there ("Refactor
>   First" reworded to "flag the refactor first, then do it in its own PR"; `.env` is never
>   committed; `VITE_SUPABASE_PERSISTENCE_URL`); delete the committed
>   `.features-gen/tests/e2e/features/team_communication.feature.spec.js`; per D8, merge any
>   durable rule from `project-hardening/` and remove the folder.
> - **Files touched:** `AGENTS.md`, `CLAUDE.md`, `.features-gen/…` (deleted),
>   `project-hardening/` (deleted or archived).
> - **Depends on:** D1, D8.
> - **Widens:** none.
> - **Effort:** M
> - **Acceptance criteria:** Codex and Claude Code read the same rules; no rule contradicts
>   another.
> - **Test gate:** scorecard `core.agent-rules` and `check:instructions` pass; each fails with
>   `AGENTS.md` removed or a dead path planted.
> - **Rollback:** revert.
> - **Diff class:** flagged refactor (instruction files; no code).
> - **Verification label:** executed (current state).
>
> 12.3 — resolved by M5.1. 12.4 — resolved by M5.1.

> **M5.2. The three repository skills can't be loaded** (audit finding 12.2, medium)
> - **Status (2026-10-13): merged as #557 (`b80e077`).** Frontmatter on all three, their facts corrected
>   against the code (the evaluator registry is `EVALUATOR_REGISTRY` in
>   `packages/core/src/evaluators/index.js`, scores are 0-100; `ALL_FLAGS` is derived; the audit
>   rows carry `action` and `metadata.old`/`new`), and Claude Code copies in `.claude/skills/`.
>   *Executed:* `check:instructions` passes, and fails on a missing frontmatter or a drifted copy.
> - **Fix approach:** add `name` and `description` frontmatter to each `squadlogic-*` skill and
>   check its paths (for example the evaluator registry's location).
> - **Files touched:** `.agents/skills/squadlogic-*/SKILL.md`.
> - **Depends on:** none.
> - **Widens:** none.
> - **Effort:** S
> - **Acceptance criteria:** the skills appear in an agent's skill list.
> - **Test gate:** `check:instructions` (fails today on all three).
> - **Rollback:** revert.
> - **Diff class:** minimal diff.
> - **Verification label:** executed (current state).

> **M5.3. The July plan was never closed** (audit finding 12.5, medium)
> - **Status (2026-10-13): merged as #557 (`b80e077`).** The July plan is marked superseded, with a disposition
>   for each of its 37 items: 13 closed (with the PR), 11 open under an October finding, 13 open
>   and not carried by this audit (listed below, under "Discovered during execution").
>   *Statically reviewed.*
> - **Fix approach:** add a status line to the July plan marking it superseded by this one, with
>   a table mapping each July item to "closed in <PR>" or to this audit's ID.
> - **Files touched:** `docs/audits/2026-07-production-readiness/remediation-plan.md`.
> - **Depends on:** none.
> - **Widens:** none.
> - **Effort:** S
> - **Acceptance criteria:** every July item has a disposition.
> - **Test gate:** none automatable; reviewed in the PR (recorded as a manual check).
> - **Rollback:** revert.
> - **Diff class:** minimal diff.
> - **Verification label:** statically reviewed.

> **M5.4. Vercel's settings and the frontend rollback aren't written down** (audit finding 7.3, medium)
> - **Status (2026-10-13): merged as #557 (`b80e077`), except the test gate.** `vercel.json` sets `framework`,
>   `buildCommand` (`npm run frontend:build`) and `outputDirectory`, held by
>   `tests/vercelBuildSettings.test.js`; `ENVIRONMENT.md` lists what the Vercel project sets, by
>   name; `ci-cd.md` has the Vercel settings and a frontend rollback; the cutover runbook's mock
>   rollback now redeploys instead of promoting. **Gate partly met:** the PR's preview builds from
>   `vercel.json`, which takes precedence over the dashboard; the dashboard's own build-command
>   override (today's production build runs `npm run frontend:build`, not the preset's default) is
>   then redundant. Clearing it is the owner's call after the merge (until then `main`'s deploys
>   need it); the first deploy after that completes the gate.
> - **Fix approach:** put `buildCommand`, `outputDirectory` and `framework` in `vercel.json`
>   (Node comes from `engines`, M1.4), list the Vercel environment variables by name in
>   `docs/operations/ENVIRONMENT.md`, and add a frontend rollback section (Instant Rollback to
>   the previous production deployment) to `docs/operations/ci-cd.md`.
> - **Files touched:** `vercel.json`, `docs/operations/ENVIRONMENT.md`,
>   `docs/operations/ci-cd.md`.
> - **Depends on:** M1.4.
> - **Widens:** none.
> - **Effort:** S
> - **Acceptance criteria:** a fresh Vercel project imported from the repo builds without
>   dashboard edits beyond secrets.
> - **Test gate:** a preview deploy from the PR builds with the dashboard's build overrides
>   cleared.
> - **Rollback:** revert.
> - **Diff class:** minimal diff.
> - **Verification label:** statically reviewed.

> **M5.5. No unused-code check** (audit finding 1.2, low)
> - **Status (2026-10-13): merged as #557 (`b80e077`).** knip `~6.27.0` (later versions need zod `^4.4.3`, which
>   would move the app's zod) in CI's Build & Test as `npm run check:unused`; the core package's
>   exports count as public API, its files do not; `knip.jsonc` keeps a dated, reasoned baseline
>   (2 unused files; 12 files whose unused exports, one unused type and one duplicate export are
>   waived); three unused files deleted; the dead `frontend` workspace removed. *Executed:*
>   `node.unused-code` passes; knip fails on a planted unused file (frontend and core), export and
>   dependency.
> - **Fix approach:** knip in CI with the core package's exports as public API; remove the dead
>   `frontend` workspace entry.
> - **Files touched:** `knip.json`, `package.json`, `.github/workflows/ci.yml`.
> - **Depends on:** none.
> - **Widens:** none.
> - **Effort:** M
> - **Acceptance criteria:** knip passes in CI.
> - **Test gate:** scorecard `node.unused-code`; a planted unused export fails knip.
> - **Rollback:** remove the step.
> - **Diff class:** minimal diff.
> - **Verification label:** executed (current state).

**Milestone exit:** [x] `check:instructions` and the scorecard's §12 standards pass (#557; the
scorecard rerun 2026-10-19 passes every area-12 standard) · [~] deployed and smoke-tested
(merged; the Vercel dashboard's build-command override is still the owner's to clear, M5.4)

---

## Milestone 6 — Polish

> **M6.1. `npm run build` isn't a build** (audit finding 7.5, low)
> - **Status: merged as #588 (`6517d33`).** `build` runs
>   `frontend:build`, and Build & Test's build step runs `npm run build`, so CI runs the `build`
>   script (`node.ci-runs-gate`). One change from the fix approach: `scripts/build.js` (an import
>   check of seven core functions) is deleted, not renamed to `check:core-exports`. Every one of
>   those functions is imported by the test suite, which fails on a missing export, so a renamed
>   check CI never ran would guard nothing, and running it would repeat the tests. Acceptance,
>   *executed*: `npm run build` writes `dist/`. Test gate: `tests/workflowPins.test.js` holds the
>   step and the script (red before the change, and on three planted ci.yml defects). The same PR
>   takes Wave 4's other M6 polish items, from the entries under "Discovered during execution"
>   (2026-10-17, below).
> - **Fix approach:** rename `build` to `check:core-exports` and point `build` at
>   `frontend:build`, updating CLAUDE.md's command table.
> - **Files touched:** `package.json`, `CLAUDE.md` (or `AGENTS.md` after M5.1).
> - **Depends on:** M5.1.
> - **Widens:** none.
> - **Effort:** S
> - **Acceptance criteria:** `npm run build` produces `dist/`.
> - **Test gate:** scorecard `node.ci-runs-gate`.
> - **Rollback:** revert.
> - **Diff class:** minimal diff.
> - **Verification label:** executed (current state).

> **M6.2. CRLF and mixed line endings** (audit finding 12.7, low)
> - **Status: merged as #588 (`6517d33`).** The six applied
>   migrations committed with CRLF or mixed endings are marked `-text` in `.gitattributes`, each by
>   name, and the five other files are renormalized to LF (three architecture docs, two E2E
>   `.feature` files; `.gitignore` was done by PR M5). The diff is line endings only. Acceptance,
>   *executed*: `git ls-files --eol` shows `i/crlf` or `i/mixed` only for the six migrations, each
>   `attr/-text`. Test gate, *executed*: scorecard `core.lf-line-endings` fails on `main` (11
>   files) and passes on the branch, with no waiver needed, since the standard accepts a named
>   `-text`; `migrationVersions.mjs --base origin/main` passes, and fails ("an existing migration
>   was edited") on a local commit that renormalizes one of the six. New
>   `tests/lineEndings.test.js` runs the same check in `npm run test` (red on `main`, listing all
>   eleven), and refuses a `-text` rule that is a pattern or names a file that no longer needs it.
> - **Fix approach:** mark the six applied migrations `-text` in `.gitattributes` (they must not
>   be edited) and renormalize the other seven files.
> - **Files touched:** `.gitattributes`, the seven non-migration files.
> - **Depends on:** none.
> - **Widens:** none.
> - **Effort:** S
> - **Acceptance criteria:** `git ls-files --eol` shows no `i/crlf` or `i/mixed` outside the
>   six migrations.
> - **Test gate:** scorecard `core.lf-line-endings` (with a recorded waiver for the six) and
>   `migrationVersions.mjs` still passing.
> - **Rollback:** revert.
> - **Diff class:** minimal diff.
> - **Verification label:** executed (current state).

> **M6.3. Stale `test.todo` entries** (audit finding 6.5, low)
> - **Status: merged as #588 (`6517d33`).** The six todos in
>   `tests/teamGeneration.characterization.test.js` are deleted; a comment in their place names
>   the test that covers each (`tests/teamGenerationIncremental.test.js` and the numbered
>   scenarios in `tests/incrementalTeamingScenarios.test.js`). Test gate, *executed*: the file
>   reports 6 passed and 6 todo on `main`, 6 passed and none after; the full suite's summary on the
>   branch reports no todo.
> - **Fix approach:** delete the six todos, pointing to the tests that cover them.
> - **Files touched:** `tests/teamGeneration.characterization.test.js`.
> - **Depends on:** none.
> - **Widens:** none.
> - **Effort:** S
> - **Acceptance criteria:** Vitest reports 0 todo.
> - **Test gate:** the Vitest summary.
> - **Rollback:** revert.
> - **Diff class:** minimal diff.
> - **Verification label:** executed.

> **M6.4. README's release line is stale** (audit finding 12.9, low)
> - **Status: merged as #588 (`6517d33`).** Reconciled against the
>   three sources: `CHANGELOG.md`'s latest release is 1.0.1 (2026-04-23), `package.json` says
>   1.0.1, and the production bundle (`squadlogic.secureyour.tech`, fetched 2026-10-17) carries
>   `1.0.1` as Sentry's release alongside unreleased work (the heat forecast's chunk). *Executed.*
>   README now says that: the latest release is v1.0.1, and production, which deploys every merge
>   to `main`, also runs everything under "Unreleased", still as 1.0.1. `CHANGELOG.md` needed no
>   change: its "Unreleased" section already lists that work. New `tests/releaseLine.test.js`
>   holds the line to `package.json` and the CHANGELOG's latest release; it passes on `main`'s
>   wording too (the old line named v1.0.1), so the staleness itself was a manual check, and the
>   test guards the next release: a planted 1.1.0 entry fails it. Cutting that release is for the
>   owner.
> - **Fix approach:** reconcile README's status line with `CHANGELOG.md` and the deployed
>   version.
> - **Files touched:** `README.md`, `CHANGELOG.md`.
> - **Depends on:** none.
> - **Widens:** none.
> - **Effort:** S
> - **Acceptance criteria:** the README names the current release.
> - **Test gate:** none automatable (manual check in the PR).
> - **Rollback:** revert.
> - **Diff class:** minimal diff.
> - **Verification label:** statically reviewed.

**Milestone exit:** [x] scorecard shows only baselined or waived failures (2026-10-19: 0 fail,
2 baselined; `docs/standards/conformance.json`) · [~] deployed and smoke-tested (merged as #588;
smoke deferred to the owner's v1.1.0 release smoke)

---

## Manual QA script

1. On a preview deploy with real Supabase, sign in as an admin, open Practice Scheduling for a
   seeded season, and read the fairness panel — expect: a non-zero team count; with a coach
   double-booked on purpose, a conflict listed (automated by M1.1, and against the real backend
   by M4.1).
2. Force a render error on the preview as `docs/operations/sentry-smoke.md` describes (signed in,
   `localStorage.setItem('__FORCE_ERROR__', 'true')`, then load `/`; `__FORCE_ERROR__` is a flag,
   not a function) — expect: the error boundary renders and a Sentry event appears within a minute, tagged with your user ID and organization ID, and the
   network tab shows no CSP refusal (M1.5, M1.6).
3. Open a PR with a planted lint error — expect: "Merging is blocked" (M1.3).
4. On the game grid, move a game using only the keyboard — expect: possible after M4.3; today it
   isn't.
5. Build for production with `VITE_SUPABASE_URL` unset and serve it under a `*.vercel.app` name
   — expect: the Configuration Error, never the sign-in page (M1.7); after M2.2 the build itself
   fails naming the variable. Today it succeeds and serves the mock.

## Discovered during execution

- 2026-10-13: `main` moved from the audited `565e980` to `28f1b98` (seven merges: #539, #542,
  #543, #545, #546, #547, #548). Each was read against the files every item touches
  (*statically reviewed*, from `git show` of each merge):
  - **#545 resolves 9.2 (M1.6)**; evidence, *executed*, is in M1.6's status. It touches M1.5's
    area (Sentry options, release tag) without resolving 9.1; recorded under M1.5.
  - **#542** changes `frontend/src/utils/practicePersistenceClient.js` (the thrown error keeps
    the Edge's `code` and HTTP status). It adds no timeout, so 5.2 (M2.5) stands.
  - **#546 and #542** change `frontend/src/pages/PracticeSchedulingPage.jsx`; the
    `EvaluationPanel` call still passes only `assignments`, so 13.1 (M1.1) stands (reproduced on
    `28f1b98` by PR 1-A's test, see that PR). #546 also edits
    `tests/e2e/steps/scheduling_and_overrides.ts`, but not the forged steps "I trigger the team
    generation algorithm" and "the scheduler runs", so 13.3 (M4.6) stands.
  - **#539** adds smoke claims to `scripts/dbharness/run.sh`; no CI job runs it and its user
    still comes from `HARNESS_PGUSER` (default `pgrunner`), so 4.2 (M3.4) stands.
  - #543, #547 and #548 touch no file any item names. `main` then moved again (#549, #550, to
    `e1adbb2`) before PR 1-A was pushed; neither touches a file any item names.
- 2026-10-13, found by PR 1-A (#551):
  - `EvaluationPanel` rendered `issue.details` as a React child, but the engine's details are
    objects, so the first real coach conflict would have crashed the panel. Hidden while the panel
    evaluated an empty roster; fixed in #551 as part of M1.1 (*executed*: the new test goes red
    with the guard removed).
  - Both scoring engines compare each weekly slot by its first occurrence's instant and ignore an
    assignment's date range, so coach conflicts between series that start on different dates can
    be missed or reported falsely. Not fixed: a domain-model change, to be planned (and approved)
    before it is built. *Statically reviewed.*
  - `fairness-scoring` accepts practice assignments with no teams or slots and, with
    `persist: true`, would record a 0-conflict run; #551 guards only the client. Candidate for a
    follow-up item (an Edge 422). *Statically reviewed.*
  - Both now items: the Edge refusal as **M2.6**, and the first-occurrence defect as **M4.7**
    (plan first, owner approval before code), placed by PR 1-B (#552).
- 2026-10-13, found by PR 1-B (#552):
  - The first live ruleset, `25014911` (created 16:46 UTC), required agent-ready-template's own
    CI job names ("Build, lint, typecheck, test", "Tests on the oldest supported Node", "Stories
    in a real browser", "npm audit (high and critical block)"), which no SquadLogic workflow
    reports, so no pull request could merge. The owner deleted it and imported `25015698` from
    `.github/rulesets/main.json`. GitHub never reads that file, so nothing compares it with the
    live ruleset; `ci-cd.md` says to re-read the live rules after changing either. *Executed*
    (public rules API).
  - CodeQL does run on pull requests, through code scanning default setup (the `Analyze (...)`
    checks), not a workflow file; M1.3's "there is no CodeQL workflow" is right about the files
    only. Not required. *Executed* (#552's check runs).
  - `pgtap.yml` had no `setup-node` step, so `npm run test:db` ran on the runner image's Node;
    fixed in #552 (M1.4).
  - `supabaseClient.js`'s `MOCK_CAPABLE_BUILD` still counts a build without credentials as
    mock-capable, so that build still emits the now unreachable mock chunk; and the
    Configuration Error is a runtime throw that happens before `Sentry.init`, so a production
    deploy missing its variables goes READY and reports nothing. Both end with M2.2's build
    failure. *Statically reviewed* (the chunk: *executed*, a local build lists it).
  - `@types/node` is `^25` while the runtime is pinned to 24, and there is no `engine-strict`, so
    typecheck admits Node 25-only APIs and `npm ci` on another Node only warns. For M2.1/M2.3.
    *Statically reviewed.*
  - `docs/operations/production-cutover.md`'s rollback adds `VITE_USE_MOCK_SUPABASE` and then
    promotes an existing deployment "instant, no rebuild"; `VITE_` variables are build-time, so
    a promote without a rebuild does not pick it up. Not fixed. *Statically reviewed.*
  - #552's Vercel preview runs the real client against `mmwupqsjkikqzvmdvuzm.supabase.co`, the
    same project `squadlogic.vercel.app` uses (and the only one `vercel.json`'s CSP names), so
    previews of unmerged branches share production's database. For the owner (M4.1 and the
    staging question). *Executed* (each page's requests on load, read-only).
    **Owner decision 2026-10-13:** accepted as-is; previews keep sharing production's Supabase
    project, with no preview database.

- 2026-10-13, found by PR 1-C (#553):
  - `__FORCE_ERROR__` is a flag, not a function: `window.__FORCE_ERROR__()` (the step in
    `sentry-smoke.md` and in this plan's Manual QA script, step 2) throws a TypeError at the
    console and never reaches the error boundary. `DashboardPage` and `WorkflowPage` throw while
    `localStorage.__FORCE_ERROR__` is `'true'`, and both need a sign-in. `sentry-smoke.md` is
    corrected in #553; the Manual QA step is left for the plan's owner. *Statically reviewed.*
  - Not done in #553 and still open: auto-scheduler's other `edgeLogger.error` refusals and
    fairness-scoring's two season-read `console.error`s carry no request ID; the stand-in
    handler the persistence functions serve when their Supabase variables are missing is not
    wrapped; `flush()` is awaited before a failing response (BetterStack latency adds to it).
    *Statically reviewed.*

- 2026-10-13, found by the M4.7 plan (`docs/PLAN_SCORING_DATE_MODEL.md`):
  - The auto-scheduler's hard constraint (`checkHardConstraints`,
    `_shared/engines/practice-coaches.ts`) compares the same first-occurrence instants, so it
    can place one coach on two teams at the same weekday and time when the two slots'
    `valid_from` differ. It is the solver, which this plan freezes, so it is not in M4.7; the
    plan's Q2 proposes its own plan-first item. *Statically reviewed* (the evaluator's version
    of the shape *executed*).
  - Apply-time metrics (`buildPracticeRunResults`, persisted with the run) share M4.7's gap;
    the plan covers them (Q9). *Statically reviewed.*
  - Production holds no `practice_slots`, `practice_assignments` or `practice_exceptions` rows
    (*executed*, one read-only `SELECT` through the Supabase MCP), so M4.7 needs no backfill.

- 2026-10-13, found by PR 2-C (M2.4-M2.6):
  - Two other Edge calls have no deadline: `EvaluationPanel`'s Save (`functions.invoke`
    `fairness-scoring` with `persist: true`, so "Hardening results..." can spin forever) and
    `useAutoScheduler`'s `auto-scheduler` fetch (only a user abort). Not in M2.5's files; the
    first wants `invoke`'s `timeout` option and a message that does not say "Failed to send"
    for a request that was sent. *Statically reviewed.*
  - `EvaluationPanel`'s Save sends `practiceData` as it is, while its read sends `null` for a
    practice block with no teams or slots; with games alongside, the Save would now get M2.6's
    422. No page passes `gameData` today, so unreachable. *Statically reviewed.*
  - The Edge game evaluator scores a `games` block whose `teams` list is empty as clean (every
    game dropped as an unknown team, coverage 100), the M2.6 shape for games. Not refused.
    *Statically reviewed.*

- 2026-10-13, found by PR M5 (branch `claude/vibrant-allen-hr7y7s-m5`):
  - `.gitignore`'s CRLF blank lines made `git check-ignore` report every path with a trailing
    slash as ignored, so `check:instructions` passed every code-span path in the instruction files
    without checking it. PR M5 renormalizes `.gitignore` to LF (one of M6.2's files); the other 12
    CRLF or mixed files stay with M6.2. *Executed.*
  - Audit finding 4.1 says every migration since 2026-05-30 has a revert and a smoke script; four
    do not: `20260602010000`, `20260603190000`, `20260612000000` and `20260612000001` (July
    DS-1). *Executed* (a search of `docs/sql/` for each version).
  - Thirteen July items are still open and no October finding carries them: DS-4 (CSV formula
    injection), DS-5 (`submit_registration` throttle), DS-9 (impersonation failures swallowed),
    DS-14 (`dashboardCache` unused), DS-15 (serial dashboard queries), DD-1 to DD-5, DD-7, DD-9
    (docs drift) and TG-3 (three E2E journeys). For the owner to place; the July plan's table
    has the detail. *Statically reviewed.* **Placed 2026-10-19:** see "Close-out".
  - The production bundle embeds every `VITE_VERCEL_*` system variable Vercel exposes, the last
    commit's message and author among them, because `config.js` reads `import.meta.env` whole
    (8.4, M2.2). *Executed* (names checked in the deployed bundle, values not recorded).
  - Vercel installs with `npm install`, not `npm ci`, so its builds don't hold to the lockfile the
    way CI's do. Setting `installCommand` is a one-line change, left for M2.3. *Executed* (build
    log).
  - `packages/core/package.json` names `src/index.js` as its entry, which does not exist (knip's
    configuration hint). For M6.1. *Executed.*

- 2026-10-13, found by PR 2-A (#559; M2.1, M2.3):
  - The `esbuild` override (`^0.25.0`, added March 2026 for an esbuild advisory) was forcing
    0.25.12 under Vite 7.3.2, whose own range is `^0.27.0`: an override that outlived its reason
    and pinned a dependency below its declared range. Removed; *executed* (`npm ls esbuild`).
  - zod 4.6 types `ZodTypeAny`'s parse output as `unknown`, so the in-range refresh broke
    typecheck in `packages/core/src/fieldAdmin/serialise.js`; its schema map is now typed
    `ZodType<Record<string, unknown>>` (JSDoc only, no behaviour). zod moved 4.3.6 -> 4.6.5; the
    Edge Functions' zod is separate (Deno, `deno.land/x/zod@v3.22.4` in `import_map.json`) and
    unchanged. *Executed* (typecheck; Deno Mirror Tests green on #559).
  - Prettier 3.8+ formats some code differently from 3.7.4 (`for (...; cond; )` among others),
    and `prettier/prettier` then fails lint on files formatted the old way, in-flight PRs'
    included. **Deferred:** Prettier is pinned at 3.7.4 and held in Dependabot; upgrading it is
    its own PR, which reformats what it must in one go. *Executed* (lint, on 3.9.10).
  - Vercel installs with `npm install` (PR M5's finding, left for M2.3): `vercel.json` now sets
    `installCommand: npm ci`, so Vercel builds the lockfile as CI does. *Executed* (#559's
    Vercel preview build).
  - The in-range refresh took `@tanstack/virtual-core` 3.13.23 -> 3.18.0, which grows the lazy
    `virtual-vendor` chunk from 5.04 to 7.91 KB gzip, past its 7,000 B cap; `check:bundle`
    failed. No advisory touches it, so it is pinned at 3.13.23 and Dependabot holds it below
    3.14; whether the bytes are worth a budget bump is a separate call
    (`docs/operations/bundle-budget.md`). *Executed* (`check:bundle` fail, then pass).
  - npm 11 warns that `esbuild`'s postinstall is not covered by `allowScripts`; the template
    records each install script's review there. Not done (no plan item). *Executed* (`npm ci`).

- 2026-10-13, found by #558 (M2.2):
  - The bundle-budget gate measures a build without `VITE_SENTRY_DSN` (CI has none), where
    `main.jsx`'s `if (SENTRY_DSN)` folds away and `Sentry.init` with its tracing and replay
    integrations is not bundled. A build with a DSN, as production's error reporting needs (M1.5),
    has a main entry of 195.0 KB gzip against the 140,450 B cap (118.9 KB without). So the gate
    passes a shape production does not ship. Not fixed here (budget policy, and the replay
    integration could be lazy-loaded). *Executed* (local builds, same tree, with and without a
    well-formed DSN; `main` measures 194.4 vs 118.3).
  - `scripts/runViteWithPersistenceEndpoint.js` (behind `frontend:build`/`frontend:preview`)
    writes the derived persistence URL to `frontend/.env.local` on every run, but Vite's
    `envDir` is the repository root, so nothing reads that file; the value reaches the build
    through the child's environment. Harmless, not fixed; `env.js` now derives the same URL
    itself. *Executed* (the file appears after a build).
  - `process.env.NODE_ENV` is still read in `FeatureGuard.jsx` and `featureFlags.js` (dev-only
    warnings). Not `import.meta.env`, so outside M2.2's rule, and moving it to `IS_DEV` would turn
    the warnings on in Vitest (which sets `NODE_ENV=test` but `DEV=true`). Left. *Statically
    reviewed.*
  - `main`'s production bundle carries every `VITE_VERCEL_*` system variable Vercel exposes to a
    Vite build (19 names, the last commit's message and author among them), because
    `config.js` read `import.meta.env[key]`, which Vite fills with the whole `VITE_` object.
    #558's preview bundle carries none of them; `tests/env.test.js` now holds `packages/core/src`
    to the same single-reader rule. Fixed by M2.2. *Executed* (a local build with canary
    `VITE_VERCEL_GIT_COMMIT_*` values embeds them on `main` and not on #558; the deployed
    production bundle and #558's preview bundle, fetched and searched for the names). The same
    finding as PR M5's entry above.
- 2026-10-13, found by the M4.7 build:
  - The practice page builds its auto-scheduler review once per run id: a result that arrives
    before the page's slots are read is staged with the display fallback range `Full Season`
    and is not rebuilt when the slots land. Not reachable from the UI today (the scheduler is
    disabled until the slots are read), and since M4.7 the engines drop such a row as an
    unreadable range and report it rather than score it season-long. Not fixed.
    *Executed* (a test that set the result before the slots loaded saw it).
  - Both engines refused a second row for the same `team::slot` as a duplicate even when the
    two rows' ranges are disjoint, although the table's own key is (team, slot, range). Fixed in
    M4.7 for dated runs (its review round): a duplicate is the same range or one sharing a live
    date; undated runs keep the old rule. *Executed* (witnesses "two-series" and "duplicate").

- 2026-10-13, found by PR m3b (M3.2-M3.4):
  - `supabase start` failed at least one of the last 100 pgTAP runs on the edge runtime's
    health check (`Error status 502`, run 38462349853), a service no suite uses; as a required
    check that would block a merge. `pgtap.yml` now excludes it and the other unused services.
    *Executed* (run log).
  - CLI 2.118.0's advisors are a subset of the hosted ones: they lack lints 0028/0029
    (`SECURITY DEFINER` callable by `anon`/`authenticated`) and Auth's leaked-password
    protection. The hosted project reports 89 `authenticated` and 1 `anon` (`submit_registration`,
    intended) definer findings, and leaked-password protection off. The CI gate cannot see
    these; turning leaked-password protection on is an Auth setting for the owner. *Executed*
    (Supabase MCP `get_advisors`, read-only; CLI binary searched for the lint names).
  - `public.set_updated_at()` exists on a from-scratch build (`20251217000000`) but not in
    production: schema drift between what CI builds and what production has. Harmless here
    (waived); not investigated further. *Executed* (one read-only `pg_proc` SELECT through the
    Supabase MCP).
    **Investigated 2026-10-17** ([`schema-drift-2026-10.md`](../../operations/schema-drift-2026-10.md)):
    an orphan of `definitive_schema`'s fresh-replay reset, which also hid 17 production-only
    triggers (one deleting data) and a production-only `persist_evaluation_run` overload.
    **Merged 2026-10-18 as #598 (`b721397`)** (the plan approved
    by the owner as recommended): `20261018060000_reconcile_trigger_drift` and the catalogue drift
    check (`supabase/catalog-snapshot.json`, checked by the harness; the operator query in
    `ci-cd.md`). Production compared with the snapshot before deploy differs by exactly the 29
    objects the migration drops and the not-yet-deployed RLS rewrite's policies (*executed*,
    read-only). Applied by CI on merge: production's migration list includes
    `20261018060000` (read-only `list_migrations`, 2026-10-19, *executed*).
  - The `auth_rls_initplan` and `multiple_permissive_policies` waivers expire on 2027-01-11, after
    which pgTAP, a required check, fails every PR until the policies are rewritten or the waivers
    renewed. Wants a plan item (RLS policy rewrite, plan first). *Statically reviewed.*
    **Planned, 2026-10-18:** `docs/PLAN_RLS_ADVISOR_REWRITE.md`, approved with every
    recommendation; PR 1 lands the persona matrix (`supabase/tests/rls_policy_matrix.sql`),
    PR 2 the rewrite (see the 2026-10-18 entry below).
  - pgTAP run 38338431910 (branch `feat/grid-override-prompt`) failed
    `practice_grid_current_rows.sql` test 36 with the two series in the other order
    (`have: thu,fri`, `want: fri,thu`): if that assertion depends on row order, it is a flake that
    now blocks merges. Not reproduced; *unverified*. **Resolved, 2026-10-14:** that run was on
    #546's own branch, and #546 added the `ORDER BY lower(effective_date_range), day_of_week`
    these assertions now carry (the file's comments cite CI #546). The one `string_agg` left
    without an `ORDER BY` returns a single row. *Statically reviewed.*
  - `supabase stop` on 2.118.0 warns that `config.toml`'s `[inbucket]` section is deprecated
    (`[local_smtp]`). Not changed. *Executed* (run log).

- 2026-10-13, found by PR M3-A (M3.1, M3.5):
  - The suite covers most code several times over, so a coverage threshold cannot see one
    deleted test file: removing the largest (`feasibilityApi.test.js`, 133 tests) moved
    statements from 93.05 to 92.97. And the core outweighs the hooks about 14 to 1, so deleting
    every hook test left the overall figures above 90 / 81 / 92 / 91; hence the hooks' own
    thresholds (M3.1). *Executed.*
  - zizmor's `pedantic` persona adds two findings not fixed here: `audit.yml`'s
    `issues: write` has no comment beside it, and ci.yml's `keepalive` job has no `name`.
    *Executed.*
  - `docs/operations/ci-cd.md`'s Vercel settings table still says the install command is
    `npm install`, "not set anywhere"; #559 set `installCommand: npm ci` in `vercel.json`.
    *Statically reviewed.*
  - `tests/performance.test.js`'s strict 3 s "focused run" budget never applied: it looked for the
    file's name in `process.argv`, but the test runs in a Vitest worker whose argv names the
    worker, so every run got the 10 s budget. Now keyed on `npm run test:perf`. *Executed* (the
    budget printed from inside the worker, before and after).
  - Scorecard `node.ci-runs-gate` fails only because `package.json`'s `build` script never runs
    in CI (M6.1's `build`); the test runner is found through `test:coverage`. *Executed.*

- 2026-10-14, found by PR w3d (M4.1, M4.5):
  - **Every Edge Function audit write fails.** `recordAuditNow`
    (`supabase/functions/_shared/auth.ts`) calls `record_audit_event` through the service
    client, so `auth.uid()` is null and the insert breaks `audit_log.user_id NOT NULL`
    ("Audit log write failed"). Seen on the local stack (import-validation, team-persistence)
    and in production's function logs on 2026-10-13 (*executed*, read-only log query). Fixed
    by #577 (the RPC called with the user-scoped client); M4.1's import scenario should
    assert the audit row (follow-up). **Done 2026-10-17** (branch
    `claude/vibrant-allen-hr7y7s-exports`, entry below).
  - The local edge runtime (CLI 2.118.0) does not apply `config.toml`'s per-function
    `import_map`, also with `supabase functions serve --import-map`, so auto-scheduler and
    fairness-scoring fail to boot on their bare `zod` import (runs 38500511704, 38501076266).
    Production is unaffected (both deployed with `import_map: true`, Supabase MCP
    `list_edge_functions`). The real-backend job writes a `deno.json` beside each in its own
    checkout. *Executed.*
  - `useSchedulerRun` ignores an abort by `err.name === 'AbortError'`, but supabase-js returns
    a `PostgrestError` whose message is "AbortError: ...", so a cancelled read becomes the
    hook's error. On the dev server (StrictMode) the Exports page then refuses to build CSVs
    (run 38501618935); in production it can happen when the effect re-runs mid-read. The mock
    never honours `abortSignal`, so no mock scenario sees it. **Fixed by the Wave 3 UI PR**
    (`claude/vibrant-allen-hr7y7s-w3ui`, entry below). *Executed* (dev server), production path
    *statically reviewed*.
  - After "Sync to Supabase" the teams page drops its success line and shows the generate view
    until a reload (the dashboard's team summary is not re-read); the sync itself succeeds.
    **Fixed by the Wave 3 UI PR** (entry below); the scenario still reads the sync from its
    response and checks the teams after a reload, and now also the line. *Executed* (run
    38498654391).
  - The import page's "Continue" passes the import to `setImportedData` and then
    `resetImport('all')` clears it in the same handler, and nothing writes the `imports` table
    the context rehydrates from, so `/teams` opens without the import; the side navigation
    keeps it. **Fixed by the Wave 3 UI PR** (entry below). *Statically reviewed.*
  - A second import can be bounced back to "Import Applied": `ImportContext`'s Realtime handler
    applies any `import_jobs` UPDATE that arrives while no job is active
    (`activeJobIdRef.current === job.id || !activeJobIdRef.current`), so a late event for the
    previous job, after "Upload Another File" reset the panel, puts the completed view back over
    the file just chosen. The mock has no Realtime. **Fixed in #578**: the handler applies an
    UPDATE only to the active job (`tests/importContextRealtimeStaleJob.test.jsx`, red without
    the fix); the import step stays strict. *Executed* (PR run 38518949814, its trace: reset,
    file chosen, then the completed view at 0% progress).
  - The Exports page's "Upload to Storage" writes to an `exports` bucket no migration creates,
    and production has no `storage.objects` policy for it (only `raw-imports` has policies), so
    an administrator's upload would be refused. Not fixed; not in the scenarios. *Executed*
    (read-only SELECTs on `storage.buckets` and `pg_policies`); the refusal itself *statically
    reviewed*. **Fixed 2026-10-17** (branch `claude/vibrant-allen-hr7y7s-exports`, migration
    `20261017000000`, entry below); the real-backend season flow now uploads.

- 2026-10-14, found by #576 (M4.4, with PR 2-C's three follow-ups):
  - PR 2-C's follow-ups above are done in #576, *executed* (each test red without its change):
    `EvaluationPanel`'s Save and `useAutoScheduler`'s run are under the M2.5 deadline (its race is
    now `withPersistenceDeadline`, which also takes a caller's Cancel signal; the panel's timeout
    reads "It is not known whether the evaluation was saved", never "Failed to send", and the
    auto-scheduler's says the run may have finished and been recorded, since the function records
    it before answering (Codex review on #576)); after a
    `PERSISTENCE_TIMEOUT` or a `PERSISTENCE_UNREADABLE_RESPONSE` (both say the outcome is not
    known) the game page (Apply, Rollback) and the practice page (Apply, override confirm) read
    the saved schedule again (`refetch` on `useSchedulerRun` and `useCurrentPracticeSchedule`,
    through `useDashboardData`; the practice grid keeps its rows while the re-read is in flight),
    and the panel drops its cached reads; `fairness-scoring` answers 422 `EMPTY_GAME_ROSTER` for a
    games block with no teams or no games, at the input boundary as M2.6 does, with the engine
    unchanged. The re-read follow-up was recorded in PR 2-C's progress log, not in this section.
  - The practice repair panel already handled an unknown enact outcome (it halts and says to
    reopen the panel to see the season as saved). M4.4's pre-send refusal of an enact body would
    have reached it as one, since `enactPracticeRecommendation` marks the enact sent before
    calling the client; a `PERSISTENCE_INVALID_PAYLOAD` now reports `sent: false` ("Nothing was
    enacted"). *Executed* (found by this PR's review; red without the fix).
  - `TeamPersistencePanel`'s own 10 s timeout says "Supabase sync timed out. Please retry.": an
    unknown outcome presented as a failure to retry, the shape M2.5 fixed for games and practice.
    The team client is not on `postPersistenceRequest`. **Fixed by the Wave 3 UI PR** (entry
    below). *Statically reviewed.*
  - The Edge game evaluator still skips, without a word, a game side whose team is missing from a
    non-empty roster (core's `evaluateGameSchedule` warns `unknown-team`), so a roster that
    matches no game still scores clean. Reporting it is a scoring change, so it is not in this
    PR; `EvaluationPanel` has no client guard for games either, unreachable while no page passes
    `gameData`. *Statically reviewed.* **Status (2026-10-18): merged as #594 (`af3552f`)**, by plan
    `docs/PLAN_GAME_EVALUATOR_UNKNOWN_TEAM.md` (approved by the owner on 2026-10-18 with every
    recommendation as written), branch `claude/vibrant-allen-hr7y7s-gameeval`: the Edge reports
    each unknown side, counts coverage from the roster, checks every coach, treats one fixture as
    one commitment, and `fairness-scoring` refuses a schedule naming no rostered team (422
    `GAME_ROSTER_UNMATCHED`); the first game parity check holds both engines to one vector table
    and the season-2026 games. *Executed.*
- 2026-10-14, found by w3d (real-backend E2E), fixed by #577:
  - **Every Edge Function audit write failed.** `_shared/auth.ts`'s `recordAudit` /
    `recordAuditNow` called `record_audit_event` through the service-role client; the RPC writes
    `user_id = auth.uid()`, NULL under the service role, so `audit_log.user_id NOT NULL` refused
    every row and the error was only console-logged (production function logs, 2026-10-13). Fixed
    without a schema change: the helpers take a branded `UserClient` (the caller's JWT), every
    call site passes one, and a service-role client is a `deno check` error. *Executed* (Deno test
    red on `main`'s `auth.ts`; production confirmation after merge is the supervisor's read-only
    `audit_log` query).
  - **`scheduler.auto_refused` was never registered in `audit_actions`** (repository, and
    production by a read-only query), so the auto-scheduler's five refusal audits would have
    failed on the foreign key next. Registered by `20261014000000`; `tests/edgeAuditActions.test.js`
    now fails on any Edge audit action no migration registers. *Executed.*
  - Decided by the owner on 2026-10-14:
    - A failed audit write does not fail the request; it is logged and the request succeeds.
    - The Edge writes no `file_name` in import audit metadata and truncates error text to 200
      characters (#577).
    - `scheduler.auto_progress` volume is accepted (about 50 rows per run, 180-day retention).
    - Still open: the SQL-side `create_import_job` audit (`20260522130000`) stores `file_name`
      and needs its own migration. *Statically reviewed.* **Fixed 2026-10-18, merged as #597 (`149ed9c`)** (branch
      `claude/vibrant-allen-hr7y7s-importfilename`, migration `20261018050000`;
      `docs/PLAN_AUDIT_IN_TRANSACTION.md` §3.4, Q1, Q5): `create_import_job` is replaced wholesale
      without `file_name` in its `import.started` metadata (the name still forms `storage_path`),
      and `ImportContext` no longer sends `file_name` to `import-validation`. The production rows
      that carry a name are left to the 180-day retention. The smoke, a pgTAP assertion, a unit
      test and the real-backend import scenario each fail with the field put back. *Executed*
      (harness and unit test; pgTAP and the real-backend scenario by CI).
    - Discovered by that fix, not changed: the import panel's telemetry write-back
      (`ImportPanel.jsx`, `log_telemetry_event` `import.suggestions_applied`) still sends
      `file_name`, and `telemetry_log.payload` stores it: all 5 such production rows carry one
      (read-only count, 2026-10-18). The owner's 2026-10-14 decision named the audit log; whether
      it covers telemetry is a question for the owner. *Executed* (the count); the code path
      *statically reviewed*. **Decided 2026-10-18:** stop sending it. #599 (merged as f561674)
      removes `file_name` from the payload; the 5 existing rows age out
      under the 180-day retention, as #597's did.

- 2026-10-14, found by PR w3b (M4.6, M4.3):
  - The mock's organization id is `org-1`, not a UUID, and core's `SlotSchema` refuses an
    `organization_id` that is not one, so in mock mode every game slot is refused and Generate
    Schedule cannot succeed (the dev server's mock mode included). The forged Pillar 1 scenario
    hid it. The auto-scheduler's request schema refuses the mock's `org-1` and `season-1` the same
    way. Not fixed (a change to the mock's ids touches most of the E2E suite); the game scenario
    seeds a club with a UUID id. *Executed* (the page's own error, on a run of the scenario).
    **Fixed 2026-10-17** (Wave 0, #587, branch `claude/vibrant-allen-hr7y7s-mockids`): the ids are
    `MOCK_ORG_ID` and `MOCK_SEASON_ID` (`frontend/src/lib/mockSeedIds.js`), fixed UUIDs shared by
    the mock, the factories, the unit tests and the E2E steps; the E2E auto-scheduler route now
    validates the whole request schema. A Pillar 1 scenario runs Generate Schedule on the seed's
    own organization, and `tests/mockSeedIds.test.js` holds the seeded ids to both schemas; each
    fails with the old ids put back. *Executed.*
  - The game grid holds one game per cell (`GameScheduleGrid` keys by field and slot), so a drop
    onto an occupied cell staged two games in one slot and the grid showed only one of them. Fixed
    in this PR: the shared move handler refuses it. *Executed* (a page test, shown failing with
    the refusal removed).
  - The grid offers every game slot under every field, but a game slot is one field's booking, so
    a drop onto another field's column stages a game whose `fieldId` and `gameSlotId` disagree
    (and two such drops can share one capacity-1 booking). "Move to…" offers only each slot on its
    own field; the drop path still allows it. **Fixed by the Wave 3 UI PR** (entry below).
    *Statically reviewed.*
  - M4.6's lint rule found 15 `Then` steps in four other files reading `__MOCK_DB__`
    (`async_and_optimistic_ui.ts`, `data_and_output.ts`, `team_and_roster.ts`,
    `team_communication.ts`), each waived on its line with a reason. One, "the resulting teams
    summary should reflect the new constraints", writes a completed team run when none exists:
    the M4.6 shape, and Generate Teams now demonstrably runs in mock mode, so it can be rewritten
    on the page. Follow-up. *Executed* (lint). **Fixed 2026-10-17** (Wave 4 accessibility, branch
    `claude/vibrant-allen-hr7y7s-a11y`): no waiver is left. The teams summary step no longer
    writes a run: its scenario imports 25 players and the Then reads the engine's own result
    (`ceil(25 / Max Roster)` teams staged, all 25 assigned). The coach and field import steps
    read the Coaches and Fields pages in a window opened from the import page (it starts with a
    copy of the mock store and leaves the import page's Roll Back button in place); the buddy
    step reads the import log; two RSVP steps become one that reloads the portal and reads both
    children's answers; the chat step reads the message back after a reload. Two unused
    `team_and_roster.ts` steps are deleted. The rule still fails a planted read in each of its
    three forms (string, template, identifier), and the teams, buddy, coach and field steps each
    fail on a planted defect (Max Roster not typed; a one-way buddy request; a rollback not
    done). *Executed.*

- 2026-10-14, found by PR w3a (M4.2):
  - `GameSchedulingPage.jsx` (M4.3's file): the "Select Team" `<label>` labels nothing (lint, off
    for that one rule and file in `eslint.config.js`) and "Full Schedule" is `text-blue-400`
    (2.45:1, a `KNOWN_VIOLATIONS` entry). The M4.3 PR fixes them; whichever of the two PRs merges
    second deletes the override and the entry. *Executed* (lint, axe).
  - Avatar initials on light's `--accent-teal`, `--accent-amber` and `--accent-green` fall below
    4.5:1 with white text (4.18, 2.99, 4.37), and dark text does no better on teal or green: a
    decision on the light accent palette (darken the three, or a different avatar treatment).
    `KNOWN_VIOLATIONS` carries the green one, the only one the mock seed renders. The same white
    on `--success` is the setup checklist's done-step number (4.38:1). Dark-theme avatars, step
    numbers, badges and danger buttons now take `--text-inverse` and pass. *Executed* (axe;
    ratios computed).
  - 29 files still use Tailwind's `-400` palette shades for text (`text-blue-400`,
    `text-green-400`, `text-brand-400`, ...), which fall short of 4.5:1 on light surfaces; this PR
    moved only the elements the scan rendered. A sweep onto the tokens (now including
    `text-status-{success,warning,error}-text`) is a follow-up. *Executed* (a search).
    **Fixed 2026-10-17** (Wave 4 accessibility, branch `claude/vibrant-allen-hr7y7s-a11y`): every
    palette text shade, not only `-400` (176 classes in 36 files; the `-100` to `-300` and `-500`
    shades fail the same way), moved to the tokens by family: blue-like to `text-text-accent`,
    green to `text-status-success-text`, amber to `-warning-text`, red to `-error-text`.
    `tests/paletteTextShades.test.js` refuses a palette text class outside one commented
    exception (red on the old code, 176 findings); `tests/themeTextContrast.test.js` computes
    each text token on each surface, and on each tint in the same class string, from
    `index.css` in both themes (fails with light `--warning-text` set to `--warning`, and with
    the old `bg-blue-900/20` chip behind accent text, 4.43:1, which this sweep moved to
    `bg-blue-500/10`). *Executed.*
  - The scan sees only what the mock seed renders: record pages (`/players/:id`, `/team/:id`),
    registration forms, closed overlays and empty-state branches are not scanned. *Statically
    reviewed* (`tests/accessibilityRoutes.test.js` lists the routes left out and why). **Partly fixed
    2026-10-17** (Wave 4 accessibility, branch `claude/vibrant-allen-hr7y7s-a11y`): every route
    row names text the scan must see rendered (a route showing only its shell fails before axe
    runs; shown failing with `/players`' text swapped for absent text); the record pages are
    scanned on seeded records (`/players/player-1`, `/team/t1`, `/register/f1`), with
    `tests/accessibilityRoutes.test.js` matching a record path to its route; and six routes the
    seed leaves empty are scanned again with content, both themes, the theme switched on the page
    so in-memory content survives: a blackout, a heat forecast, lighting requests and overrides,
    evaluation runs, a new invite, a staged game schedule. The scan now waits for entrance
    animations, which had read as low contrast mid-fade on the new invite. New finding, fixed:
    `--text-muted` labels on the auto-scheduler's emerald result card were 4.42:1 in dark (now
    `--text-secondary`). `KNOWN_VIOLATIONS` stays empty. *Executed.* Still unscanned with content:
    `/exports` with a published baseline, `/coaches/practice-preferences` with a pending request,
    `/fields` with seasonal availability, `/admin/reports` past its 3-player masking threshold,
    `/invite/:code`, and every overlay that opens on a click (dialogs, menus, drawers).
    Recommendation: one follow-up that adds those four content scenarios and an "open each
    route's primary dialog" scan.
    **Done 2026-10-19** (Wave 4 accessibility follow-up, branch `claude/vibrant-allen-hr7y7s-a11y2`):
    - New scenarios in `accessibility.feature`, each seeding its content through the page and
      scanning both themes: `/exports` with a published baseline and a parity report;
      `/coaches/practice-preferences` with a pending request and one in force; `/fields` with
      seasonal availability (profile, blackout window, equipment); `/admin/reports` with six
      players and a custom attribute, so the chart is drawn instead of the privacy mask;
      `/invite/:code` signed out (the sign-in form under the invite banner) and signed in with a
      code that cannot be redeemed. `/invite/:code` left `NOT_SCANNED` in
      `tests/accessibilityRoutes.test.js` (only `*` remains there, a redirect).
    - One main dialog per route that has one, open, with the dark scan taken behind it: "Add a
      blackout window" (`/scheduling/blackouts`), "Teams —" (`/coaches`), "Add New Field"
      (`/fields`), "Switch to co-ed divisions" (`/settings`), "Calendar Subscription"
      (`/team/t1`), "Approve with change" (`/coaches/practice-preferences`), and "Override a
      saved practice" (`/schedule/practice`).
    - Violations found: "Upload to Storage" was white on `bg-orange-500`, 2.88:1 (now
      `btn btn-primary`); the reports page's attribute `<select>` had no name (`select-name`,
      critical; now labelled "Attribute to chart"); the Calendar Subscription dialog's notices
      were `text-status-warning` on the sunken surface, 3.39:1 (now `-text`). Folded in from the
      close-out: the other 9 uses of bare `text-status-warning` as text (3.84:1 on the light
      surface) take `text-status-warning-text`, two tints drop from /20 to /10 so the pair keeps
      4.5:1, and `tests/paletteTextShades.test.js` now refuses the bare class.
      `KNOWN_VIOLATIONS` stays empty.
    - Each fix has a unit test red without it (`tests/enterpriseDashboardSelectLabel.test.jsx`,
      `TeamPortalCalendarModal.test.jsx`, `OutputGenerationPanel.test.jsx`,
      `paletteTextShades.test.js`), and each of the three scenarios that found a violation was
      red with its fix reverted. The masking scenario was red with its seed step removed.
      *Executed.*
    - Review round (Codex): the dialog step now asserts a named `role="dialog"` and focus inside
      it, not just a visible heading. "Add New Field" and "Calendar Subscription" were plain
      `<div>` overlays (no role, no `aria-modal`, no focus move or containment; axe cannot see
      that) and now use the shared `Modal`. `Modal` keeps `onClose` in a ref, so a parent that
      re-renders on every keystroke (the field form) no longer pulls focus back to the first
      control. Not fixed here: the field form's "Sub-fields" and "Status" toggles are
      `display: none` checkboxes, so a keyboard cannot reach them (WCAG 2.1.1; a scan cannot see
      it either). *Statically reviewed*; its own item.
    - Still unscanned, with reason (all *statically reviewed*): `PracticeEnactDialog` (opens from
      the practice repair panel, which needs a repair plan) and `RetireEstateNodeDialog` (opens
      from `/fields` on a retirable estate node) each need seeded state of their own;
      `OfflineGuard`'s dialog needs the browser offline; the mobile `SideNav` drawer, the row and
      header `Dropdown` menus other than the coaches one, `IngestionOverlay`, and the game
      grid's per-card dialogs have no scenario. A route with several dialogs has the most used
      create or edit one scanned; the rest share `Modal`.
  - `WorkflowStep`'s card-wide click ran for every click inside an open step, so its "Confirm
    Teams & Proceed" button (step 2 to 3) was undone by the card re-selecting step 2 (both state
    updates batch; the last wins). Fixed here: an open card takes no click of its own, and its
    collapsed content is `inert`. *Executed* (unit test red before the fix).
  - `DataGrid` is one `role="application"` widget whose wrapper takes Tab (`useGridKeyboard`
    moves the active cell on Tab, so focus cannot leave the grid by keyboard once a cell is
    active: WCAG 2.1.2). Moving it to `role="grid"` with a focusable cell is its own item.
    *Statically reviewed.* **Fixed 2026-10-17** (Wave 4 accessibility, branch
    `claude/vibrant-allen-hr7y7s-a11y`): the table is a `role="grid"` with one tab stop, a roving
    tabindex over every cell (header row, selection and row-actions columns included) or the one
    widget a cell holds; arrows, Home and End move focus, Left and Right step through a cell's
    several widgets, and Tab is never the grid's (an open editor still commits on Tab). An editor
    left by moving focus elsewhere commits without pulling focus back. `tests/dataGrid.test.jsx`
    and a keyboard scenario in `accessibility.feature` (real Tab in Chromium on `/players`) each
    fail with the old Tab handler planted back. *Executed.* Review round (#591, Codex): a row's
    actions menu mounted its items as tab stops after the grid had set the tab order, so Tab from
    an open row-actions cell walked into the menu. `Dropdown` items are now never tab stops and
    Tab closes the menu, moving on from the trigger (APG menu button); the grid keeps its stop
    off menu items and leaves an open trigger's arrows to the menu. A unit test and a Chromium
    scenario each fail on the previous head. *Executed.*
  - Recharts axes and gridlines on the analytics page keep hard-coded slate colours, which do
    not re-theme. *Statically reviewed.* **Fixed 2026-10-17** (Wave 4 accessibility, branch
    `claude/vibrant-allen-hr7y7s-a11y`): the charts on `/admin/analytics` and `/admin/reports`
    take their axes, gridlines, tooltips, cursor and series from
    `frontend/src/constants/chartTheme.js`, all `var(--token)`. In dark, the old tick labels were
    `#475569` on the dark card (about 2.2:1) under near-white gridlines. A scenario in
    `accessibility.feature` seeds evaluation runs and checks each tick label's and gridline's
    computed colour against `--text-secondary` and `--border` in both themes (red on the old page:
    `rgb(71, 85, 105)`), and `tests/chartColorTokens.test.js` refuses a literal colour in any file
    that imports Recharts (red on the old page). Light and dark screenshots compared. *Executed.*

- 2026-10-17, PR M6 (#588, branch `claude/vibrant-allen-hr7y7s-m6`): Wave 4's M6 polish. The resume
  queue lists six items as "M6.1-M6.4"; only the `build` script is plan item M6.1. The other five
  are entries above. The plan's own M6.2 (CRLF), M6.3 (`test.todo`) and M6.4 (README release
  line) were added to the same PR afterwards; their status lines are above.
  - **The core package's entry** (PR M5's entry): `packages/core/package.json` declares no `main`
    now. Nothing imports the package bare; everything goes through the `@squadlogic/core/<module>`
    alias. An index barrel or a wildcard `exports` map would make an entry true, but knip treats
    entries as used: with `"exports": {"./*": "./src/*"}` a planted unused core file went
    unreported. `tests/corePackageEntry.test.js` (red on `main`, naming `src/index.js`): every
    entry the manifest names exists, with no root entry no bare import, and every core module
    (287) loads in plain Node, without the aliases, which replaces what `scripts/build.js`
    checked for seven of them (a planted `@/` import fails it). *Executed.*
  - **`frontend/.env.local`** (#558's entry): the build wrapper no longer writes it; the derived
    URL still reaches Vite through the child's environment. Nothing read the file: Vite's
    `envDir` is the root, Playwright's `dotenv.config()` reads the root `.env`, and no script or
    workflow names it (searched). *Executed*: a build no longer creates it, and
    `tests/configurePersistenceEndpoint.test.js` failed before with one `writeFileSync` call.
  - **`process.env.NODE_ENV`** (#558's entry): `FeatureGuard.jsx` and `featureFlags.js` read
    env.js's new `IS_DEV_SERVER` (`DEV`, and `MODE` not `test`): the dev server in any mode, as
    `NODE_ENV === 'development'` was, and not Vitest, where `DEV` is true but `MODE` is `test`.
    `tests/env.test.js` now forbids a `process.env` read in frontend and core sources (red before,
    naming the two files); `tests/devModeWarnings.test.jsx` checks each warning on the dev server
    (default and custom mode), in Vitest and in a build (the dev-server cases red before).
    *Executed.*
  - **The bundle budget's shape** (#558's entry): Session Replay loads as its own chunk after
    `Sentry.init` (`lib/sentryReplay.js`, `Sentry.addIntegration`; `lazyLoadIntegration` loads
    from Sentry's CDN, which the CSP refuses). CI builds with a stand-in `VITE_SENTRY_DSN`, and a
    budget rule for the replay chunk fails a build without one. Main entry with a DSN: 213.62 KB
    before, 174.22 KB now (134.19 KB without a DSN); caps re-baselined to 190,000 B (main) and
    296,000 B (first paint), rationale in `config/bundle-budget.json`. *Executed*: the gate passes
    the DSN build and fails a no-DSN build and one with Replay eager; in Chromium against
    `vite preview`, the client carries Replay and BrowserTracing and a 404 on the chunk is logged.
  - **esbuild's postinstall** (#559's entry): reviewed and approved in `package.json`'s
    `allowScripts` by name, as the template does. `npm ci` no longer warns.
    `tests/allowScripts.test.js` holds the record to the lockfile's `hasInstallScript` packages
    (red before, naming esbuild). *Executed.* The audit's install row says the postinstall "did
    not run"; it did: `node_modules/esbuild/bin/esbuild` is a hard link to the platform binary
    (link count 2), which only `install.js` makes. *Executed.*
  - **Open for the owner:** `fsevents` 2.3.3 (macOS only) also has an install script
    (`node-gyp rebuild`); the template denies the same version. Listed as awaiting a decision in
    `tests/allowScripts.test.js`. *Statically reviewed.* **Decided 2026-10-18:** it stays denied;
    recorded in the close-out PR (`allowScripts` `fsevents: false`, the test, `dependency-policy.md`).
  - Without a DSN the main entry is 134.19 KB against the old 137.16 KB cap: about 3 KB was left
    before this PR's re-baseline. *Executed.*

- 2026-10-17, found by the Wave 0 mock-ids PR:
  - The mock seed's other ids are still not UUIDs: locations (`loc-1`), fields (`v1`, `v2`), game
    and practice slots (`gs-1`..`gs-4`, `ps-1`), teams (`t1`, `t2`), divisions (`u8-div-id`) and
    profiles (`mock-admin-id`, ...). Real ones are. The practice repair adapter already refuses
    the seed's `loc-1`, which is why `practice_repair_panel.ts` runs in a fresh organization, and
    any other check that reads one of these as a UUID will refuse the seed the same way. Not
    changed (the item was the organization and season ids). *Statically reviewed.*
  - The seed's game slots (`gs-1`..`gs-4`) are at 08:00 and 09:30 UTC on 2026-04-04, which on the
    seeded season's Los Angeles clock is 1:00 and 2:30 AM, and they fall outside that season's
    dates (2025-01-01 to 2025-12-31). Generate Schedule on the seed stages a 1:00 AM kickoff, and
    did not refuse the slot for lying outside the season. Seed data; not changed. *Executed*
    (the staged game on the new scenario's page reads "Sat, 4/4/2026 · 1:00 AM").
- 2026-10-17, the Wave 3 UI PR (#589, `claude/vibrant-allen-hr7y7s-w3ui`), the product bugs that don't
  touch the engines. Each test below was run red with its fix reverted (*executed*):
  - **Import "Continue"** keeps the import and moves on: it calls only `onImport()`; the import
    stays in `ImportContext`, `ImportPage` goes to `/teams`, the dashboard goes to step 2, and
    neither copies the raw preview over the context any more. It also moves on after a reload,
    when the panel holds no preview. Tests: `tests/importContinue.test.jsx`, two
    `ImportPanel.test.jsx` cases, and the `ingestion_hardening` scenario "Continuing from an
    applied player import keeps it for teaming". *Executed.*
  - **Teams page after "Sync to Supabase":** `useTeamSummary` gains `refetch()` (as
    `useSchedulerRun` has), exposed as `team.refetch`; after a sync the page re-reads the synced
    run, and the review status section sits above the page's views, so "Team review applied. N
    teams and M players synced to Supabase." survives. Tests:
    `tests/teamSyncKeepsStatus.test.jsx`, a `useTeamSummary` case, the mock scenario "A synced
    team review keeps its success line"; the real-backend sync step now asserts the line (CI
    only, *statically reviewed* here). *Executed.*
  - **`TeamPersistencePanel`'s 10 s timeout** is an `unknown` state, "Outcome unknown": "Supabase
    sync timed out, so it is not known whether the teams were saved. Reload the page to see the
    saved teams before syncing again." The E2E "Persistence Sync Timeout Handling" scenario now
    leaves the POST unanswered so the panel's own deadline runs; it used to answer a 408 whose
    body carried the panel's text. *Executed.*
  - **`useSchedulerRun`'s abort check** is `isAbortError` (`frontend/src/lib/abortError.js`): the
    caller's aborted signal, the `AbortError` name or `ABORT_ERR` code, or the PostgREST shape
    (message `AbortError: ...`, hint `Request was aborted ...`, read from the installed
    `@supabase/postgrest-js` 2.117.3). `tests/abortError.test.js` takes the shape from the real
    supabase-js client. No E2E: the mock ignores `abortSignal` and the real-backend run is a
    production build. *Executed.*
  - **Game grid view tabs** are the `Tabs` primitive: a tablist, `aria-selected`, the
    `.page-tab.active` underline, arrow keys, and a tabpanel. axe on `/schedule/game` passes in
    both themes. *Executed.*
  - **"By Team" in Manual Override** is disabled with a visible reason ("By Team is off during
    Manual Override: games are moved on the field grid."): the override's only surface is the
    field grid, and a team's list has no cells to move a game to. The view chosen before the
    override comes back after it. The `Tabs` primitive gains disabled tabs. *Executed.*
  - **Game grid drops** are held to "Move to"'s rule, now one function, `isSlotOnField`
    (`frontend/src/utils/gameGridCells.js`): the move handler refuses another field's slot with a
    status line, the announcements agree, and the grid marks those cells "Other field" with the
    invalid-target reason while a game is over one. No mock E2E (the mock seed has no games);
    the page test drives the real dnd-kit keyboard sensor. *Executed.*
  - From this PR's review: `importedData` is the player import only (`startImport` wrote it for
    every type, so after "Continue" a coach import reached the teams page as players;
    `tests/importedDataIsPlayers.test.jsx`), and after a sync times out "Sync to Supabase" stays
    off until a reload. *Executed.*
  - Not in this PR: "Upload to Storage" (Wave 2's bucket).
  - Flagged, not done: the grid draws every slot under every field, so with N fields (N-1)/N of
    its cells now read "Other field". Drawing only each field's own slots would remove them; a
    layout change, so its own item (recommended). *Statically reviewed.*
  - Flagged, not done: the import panel's `importStatus` lives in `localStorage`, with no expiry
    and not per organization, so a "completed" import shows on `/import` after a reload or an
    organization switch. Pre-existing on the side-navigation path; "Continue" now matches it
    rather than resetting. *Statically reviewed.*
- 2026-10-17, triage of "the issues with teams added through the UI" (Wave 3 UI PR). The
  report names no symptom, so this is what a mock run of Generate Teams, an unanswered sync, Team
  Builder and Game Scheduling showed (*executed*, a scratch scenario, not committed), plus
  reading. None is fixed here:
  - In mock mode a team sync cannot succeed (no `team-persistence`; "Sync failed", "Failed to
    fetch"), so teams generated in the UI never reach the `teams` table there, and Team Builder
    and Game Scheduling ("No generated teams are available for game scheduling.") never see them.
    Expected of the mock, but no mock scenario covers a generated-then-synced team downstream.
  - Before any sync, the persistence panel's "Recent Supabase Syncs" lists the staged review's run
    as `REVIEW`, "Updated 3 teams": a sync that has not happened, worded as one that has.
    *Executed* (the triage run).
  - A sync that fails at the network ("Failed to fetch") reads "Sync failed", but a dropped
    connection can follow a request the server received and committed: the same unknown outcome
    as the timeout above. The game and practice clients treat only their deadline and an
    unreadable 2xx as unknown, so this is a question for all three, not this PR. *Statically
    reviewed.*
  - Team Builder ignores a refused `teams` read (`if (!error) setTeams(...)`) and shows its empty
    "generate teams first" state over it, with nothing logged. *Statically reviewed.*
  - Ruled out: a synced team's players do get `players.team_id` (the `team_players` trigger,
    `20260611000400_players_team_id_sync.sql`), so Team Builder places them. *Statically
    reviewed.*

- 2026-10-17, the exports PR (#592, branch `claude/vibrant-allen-hr7y7s-exports`): the `exports`
  bucket and its policies (migration `20261017000000`), "Upload to Storage" wired to it, and the
  real-backend import scenario's audit assertion. CI evidence below is from `workflow_dispatch`
  runs on the branch and on the throwaway `claude/vibrant-allen-hr7y7s-exports-plant`:
  - **Production already has an `exports` bucket**, made by hand on 2025-12-06: private, empty,
    no `storage.objects` policy. The migration's insert is `ON CONFLICT (id) DO UPDATE SET
    public = false`, so it adopts that bucket. *Executed* (read-only SELECTs on
    `storage.buckets`, `storage.objects` counts and `pg_policies`, 2026-10-17).
  - **Production also has an `uploads` bucket** (private, empty, created 2026-04-01) that no
    migration creates and nothing in the repository names (searched `frontend/src`,
    `packages/core/src`, `supabase/`). Not touched. *Executed* (the same SELECTs).
  - **Supabase refuses every SQL `DELETE` on `storage.objects`** (`storage.protect_delete()`,
    "Use the Storage API instead"), whatever the policies say, so neither pgTAP nor the smoke
    can try a delete; both assert that no DELETE or UPDATE policy exists. *Executed* (pgTAP run
    39007939141).
  - **`finalize_import_job` writes one `import.completed` row per stage**: its own, and one with
    `metadata.stage = 'buddy_pairs'`, both for the same job. A reader counting completed imports
    by action counts each import twice. Not changed. *Executed* (real-backend run 39007937255).
  - `create_import_job`'s `import.started` row still stores `file_name` (the open Wave 2 item);
    seen in the same run's rows. *Executed.* **Fixed 2026-10-18** by `20261018050000` (the
    2026-10-14 entry above).
  - The real-backend runs' Edge logs show the auto-scheduler's own run record refused ("Persistence
    failed: Not authorized: User is not a member of organization ..."), and the run completes with
    `runId: null`; the scenario passes. Not investigated; whether `main` shows it too is
    *unverified*.
  - The Audit Explorer page (`/admin/audit-logs`) offers no import action in its filter
    (`data.imported` is listed; nothing writes it), so the import audit rows are reachable there
    only unfiltered. The scenario reads them with the administrator's own session instead.
    *Statically reviewed.*
  - `uploadScheduleExport` still defaults to `upsert: true`, which the `exports` bucket refuses
    (no UPDATE policy); its one caller now passes `false`. Kept for backward compatibility.
    *Statically reviewed.*
  - **Decided 2026-10-17 (coordinator, in this PR):** uploads are for organization
    administrators only (INSERT through `is_org_admin`), reads for any member (SELECT through
    `is_org_member`), matching the administrator-only Exports page (`MANAGE_ORGANIZATION`) and
    the admin RPC that records the publication baseline. Changed in `20261017000000` itself,
    which had not reached production. A coach's upload is refused 42501 in the smoke and the
    pgTAP suite; putting the INSERT back on `is_org_member` fails the smoke (*executed*); pgTAP
    *statically reviewed* until the PR's CI runs it.
  - **Codex on #592:** a publish with one file refused left the others in the bucket, readable to
    members, with no baseline or audit row saying what went out, and no DELETE policy to clean
    them up. Decided (coordinator): a publish is all or nothing. `20261017000000` gains
    `exports org-admin delete` (`is_org_admin`, the insert's folder check; still no UPDATE), and
    the panel removes what a failed publish uploaded through the Storage API, records no
    baseline, and names any file it could not remove (each logged). Unit tests red on the
    previous panel and with the cleanup result ignored; the smoke catches a member DELETE, an
    unscoped DELETE and a missing one (*executed*); the real-backend season flow refuses one
    team file through a Playwright route and lists the bucket empty afterwards (*statically
    reviewed* until the PR's CI runs it).

- 2026-10-17, found by the M4.7 exceptions follow-up (Q1, #590):
  - The override panel's per-slot "N free" (`overrideSlotLoad`, Q5) counts series only: a
    relocated week still holds its original slot and not its target, and a TIME TBD week still
    counts. Not changed; a question for the owner in the PR. *Statically reviewed.*
  - The exceptions a save is about to write (the daylight TIME TBD rows the Apply path builds
    for new placements, `buildDaylightExceptions`) are not in the panel's evaluation before the
    save: a staged placement has no stored id, so no exception can name it. Its timed range
    already ends at the daylight cut (`newPlacementRange`), so nothing is miscounted; the TIME
    TBD tail is just not listed before the save. Not changed. *Statically reviewed.* Two gaps
    after it, found by Codex on #590, are fixed there: the saved run's metrics now apply the
    same-save exceptions (`buildPracticeRunResults` `sameSaveExceptions`), and the page re-reads
    its rows after a save, so the next evaluation names the new row by its id. *Executed* (two
    page tests that fail on 450fd65).
  - A relocation onto a slot is counted on its date even when that date is outside the target
    slot's validity (`applyPracticeExceptions` knows the row's range, not the target's
    validity); the portal and the feed show it the same way. Not changed. *Statically
    reviewed.*
  - The auto-scheduler's own score (`scoreSchedule`) stays undated and reads no exception
    (Q2, M4.8); its lock load already holds slots for live `time_tbd` and `relocated` rows
    (`practice-lock.ts`). *Statically reviewed.*

- 2026-10-17, found by the Wave 4 accessibility PR (#591, branch `claude/vibrant-allen-hr7y7s-a11y`):
  - The import page's "Roll Back Coach Import" button is gone once you leave the page and come
    back in the app (the Coaches link, then Import): the import shows as applied, with no way to
    roll it back from there. *Executed* (the button list before and after, mock mode).
  - Nothing on screen reads `player_buddies`: the only sign a buddy pair was stored is the import
    log's line, which repeats what `materialize_import_buddy_pairs` answered. *Statically
    reviewed* (a search of `frontend/src` and `packages/core/src` for `player_buddies`).
  - The team portal shows no RSVP time, so "the RSVP timestamps should align with the league's
    official timezone" had nothing on the page to assert; its old check matched only the shape of
    an ISO string. The step is removed, not replaced. *Statically reviewed.*
  - `text-status-warning` (the bare `--warning`, `#b5740b`) is still used as text in 11 places,
    `TeamOverviewPanel`'s amber card among them: 3.84:1 on the light surface, 3.39:1 on
    `--bg-app`. `--success` and `--danger` pass. Not changed (not a palette shade); the `-text`
    tokens are the fix. *Executed* (ratios computed the way `tests/themeTextContrast.test.js`
    does).

- 2026-10-18, the RLS advisor rewrite, PR 1 (#595, branch `claude/vibrant-allen-hr7y7s-rlsmatrix`,
  `docs/PLAN_RLS_ADVISOR_REWRITE.md` §4.2): the persona matrix only, no migration.
  `supabase/tests/rls_policy_matrix.sql` records SELECT, INSERT, UPDATE, a move to an
  organization nobody belongs to (an UPDATE's WITH CHECK) and DELETE for seven personas on the 26 tables the two
  waived lints name (910 cells), against a literal expected table generated on `a31ddde` and
  checked row by row against the policy text. Green against today's policies; five planted
  policy changes and seven planted test defects each turn it red (the PR lists them).
  *Executed* on a local build of all 130 migrations with pgTAP 1.3.3 and Supabase's default
  grants and `auth.uid()`; CI's run is the PR's.
  - **A `tenant_admin` is narrower than `is_org_admin` in four places, not two.** The plan's Q5
    names `season_settings` and `registration_forms` (writes need `role = 'admin'`); the matrix
    shows the same inline test on two SELECT policies: a `tenant_admin` reads no `audit_log`
    row and no `organization_schema_history` row of its own organization, while it reads
    `telemetry_log` (which admits `tenant_admin` by name). Not changed (the rewrite changes no
    access); belongs with Q5's product question. *Executed.*
  - `profile_players` has no INSERT, UPDATE or DELETE policy, and `profiles` no INSERT or
    DELETE policy: no persona writes them through the table, admins included. Their writes go
    through definer functions (`handle_new_user`, the registration RPCs, *statically reviewed*).
    *Executed* (the matrix).
  - Any member of an organization, a coach or a parent included, can INSERT `telemetry_log`
    rows for it; only its admins read them. *Executed.*

- 2026-10-18, the RLS advisor rewrite, PR 2 (#596, branch `claude/vibrant-allen-hr7y7s-rlsrewrite`,
  stacked on PR 1): migration `20261018030000_rls_advisor_rewrite.sql` with its revert and smoke,
  `reconcile_prod_rls_drift()` and the `20260928000000` smoke on the new spec, and the
  `auth_rls_initplan` and `multiple_permissive_policies` waivers removed. 82 policies on `public`
  become 119; the persona matrix passes unchanged; the revert restores a catalogue identical to
  the one before (every policy's command, roles and deparsed clauses compared, and the reconcile
  function's body by hash). *Executed* locally (all suites, the harness, plants listed in the
  PR); CI's runs are the PR's.
  - **Production matches the build exactly, today.** Its 82 `public` policies hash to the same
    digest as a fresh build's before the rewrite (`89d6a1d4...`, over table, name, command,
    permissive, roles and both clauses), and its advisors still report 11 `auth_rls_initplan`
    and 20 `multiple_permissive_policies`. *Executed* (read-only SELECT and `get_advisors`,
    2026-10-18). After deploy, the same digest should read `a9380ecab8c4...` on 119 policies, if
    production's Postgres deparses the new clauses as the harness's does.
  - **An UPDATE that names its row also checks the new row against the SELECT policies.** So a
    matrix probe moving the subject row to another organization (`... WHERE id = ...`) was
    refused by the member SELECT policy and could not see an UPDATE policy's `WITH CHECK
    (true)`; the probe now has no WHERE (PR 1). The same masking protects the app's own
    filtered PATCHes; an unfiltered one reaches only the UPDATE policy. *Executed.*
  - `scripts/dbharness/prove.sh`'s five `20260928000000` plants targeted a function body this
    migration replaces (its anchor pre-flight refused them); they are re-aimed at
    `20261018030000`, and each was run once by hand against the `20260928000000` smoke and
    turned it red. The full prover (about 5.4 hours) was not run. *Executed* (the five).
  - Comments that name the replaced policies were left as they are: the practice-persistence
    Edge Function's (`practice_assignments_write_admin`; changing it would redeploy the
    function) and those in earlier migrations. `docs/security/rls-policies.md`'s example of the
    usual policy shape (a member `FOR ALL`) is out of date with every table this rewrite
    touched; a note on the new shape is added, the example is not rewritten. *Statically
    reviewed.*
  - `coach_team_requests` keeps its single admin `FOR ALL` policy: it has no member SELECT beside
    it, so it is not a finding. *Executed* (the migration's closing check).

- 2026-10-18, found by the schema drift PR (#598, branch `claude/vibrant-allen-hr7y7s-drift`):
  - **The field import relied on the dropped trigger for sub-surfaces, in production only.**
    `finalize_field_import_job` (`20260503070000`) writes `supports_halves`, and in production
    `trigger_manage_field_subunits` then created `A` and `B` (and `rollback_field_import_job`,
    `20260909000000`, restoring `supports_halves = false`, deleted them). After `20261018060000`
    a field imported with halves has no sub-surfaces until an admin saves it on the Fields page,
    which is what a fresh build (CI) has always done. Production holds 0 fields, so nothing
    changes for existing data. Not changed: the import RPC is its own change. *Statically reviewed.*
  - **The mock's direct-table `fields` paths still imitate the dropped trigger** (insert and
    update of `fields` through `from('fields')` create, and with halves off delete, sub-surfaces;
    `tests/mockDeleteTombstones.test.js` pins the delete). No app code writes `fields` directly
    (RLS gives members SELECT only); the mock's RPC paths, which the app uses, are insert-only
    now. Not changed. *Statically reviewed* (a search of `frontend/src` for `from('fields')`).
  - **The production-only `persist_evaluation_run(jsonb, jsonb[], jsonb[])` checked no
    organization membership**: any authenticated caller could write an evaluation run into any
    organization through it (its body, read back). Dropped by `20261018060000`; production holds
    0 `evaluation_runs`. *Executed* (read-only `pg_get_functiondef`).
  - **The mock E2E "Reverting a field to no longer support halves" never edited the field it
    seeded.** Its field was called "Field 2", as is one in the mock seed, and "Edit" opened the
    seed's; its checks passed on that field's card. Renamed ("Halves Pitch") and inverted to the
    new behaviour; it now fails with the old delete planted in the mock. *Executed* (mock E2E,
    sandbox Chromium).
  - **Function bodies drift too, and the catalogue check does not compare them.** Production's
    `persist_evaluation_run(jsonb, jsonb, jsonb)` body differs from the repository's
    (`md5(prosrc)` `9184eba3...` against `77228dda...`; production's has no comments), and the
    `propagate_org_id_from_*` bodies differed only by line endings (`20260324000000` has CRLF).
    Whether any body differs in behaviour is *unverified*; comparing normalised bodies is a
    possible extension of `catalog_snapshot.sql`. *Executed* (read-only `md5(prosrc)` on both
    sides).
- 2026-10-18, the audit-in-transaction PR (#600, branch `claude/vibrant-allen-hr7y7s-audittxn`, migration
  `20261018070000`; `docs/PLAN_AUDIT_IN_TRANSACTION.md`, approved by the owner on 2026-10-18 with
  every recommendation as written). Wave 2's "write each audit row in the same transaction as its
  save" is done: `persist_team_schedule` and `persist_game_schedule` write `team.saved` /
  `game.saved` on `scheduler_run` with the run id, inside the save, and a failed audit write rolls
  the save back (SLA01, answered 500 `AUDIT_WRITE_FAILED` "Nothing was saved" and logged through
  `logFailure`); both refuse a caller with no user; `team-persistence` and `game-persistence` call
  them with the caller's client; the after-the-fact audits (`recordAuditNow`) report a failure
  through `logFailure` with the handler's context, which the type now requires. *Executed*
  (harness, a local pgTAP stand-in, Deno and unit tests); pgTAP and the real-backend scenario by
  CI.
  - **Security: any member could save the game schedule.** `game-persistence` had no admin check
    and `persist_game_schedule` checked only membership, so a coach (or a parent) of the
    organization could overwrite the season's games by calling the RPC directly (plan section 1.1,
    on a scratch build). Both now require an organization admin (Q6). The smoke and pgTAP both hold
    a coach's game save refused 42501 with nothing written; putting the RPC back on
    `is_org_member` fails the smoke. *Executed.*
  - Found by this PR's review: the game page offered Apply and Rollback to anyone with
    `MANAGE_SCHEDULE` (coaches and staff), who would now always be refused 403. Both are now
    offered only to an organization admin, with a note saying why, as the practice page's Apply
    is (#64). *Executed* (a page test, red with the old gate).
  - Not changed: an RPC refusal on the user-client path (an admin demoted between the Edge
    check and the RPC) still answers 500 with the RPC's message, as every non-audit error did
    before (plan section 3.2); and `teamReviewPersistence.js` still sends `runMetadata.createdBy`,
    which nothing reads now that the run's creator is always `auth.uid()`. *Statically reviewed.*
  - Found while rewriting the pgTAP suites: with the service role refused, every refusal case in
    `team_persistence_rpc.sql` and `game_persistence_rpc.sql` that ran as `service_role` with no
    message pinned would have kept passing on the new 42501 (team's run-type case aside), and the
    team suite's last case ("derive organization from season settings") would have errored. Each now
    runs as an admin and pins its message. *Executed* (against a local pgTAP stand-in on a scratch
    build; the real pgTAP run is CI's).
  - `_shared/logtail.ts` read its environment at import, which `deno test` refuses without
    `--allow-env`; `auth.ts` now imports it, so it reads through a helper that treats only a
    permission refusal as "no token". *Executed* (the Deno suite, red before the helper).
  - Not changed: `packages/core/src/teamPersistenceHandler.js` and `gamePersistenceHandler.js` still
    send `created_by` and call the RPCs with whatever client they are given; nothing outside
    `tests/` imports them, and a service-role client would now be refused 42501. *Statically
    reviewed.*

- 2026-10-19, found by B5 (branch `claude/vibrant-allen-hr7y7s-b5-tests`, PR #607):
  - **A weekly practice series that crosses a spring-forward date is handled in one surface and not
    the others.** For a Sunday 02:30 series over `[2026-03-01,2026-03-29)` in `America/Los_Angeles`:
    the calendar feed (`buildFeedEvents`) places 03-01, 03-15 and 03-22 and reports 03-08 as TIME
    TBD (`WALL_TIME_NONEXISTENT`); the team portal (`expandPractices` in `useTeamPortal.js`) shows
    03-08 at 02:30 like any other Sunday, a time that does not exist (its comment says the season
    timezone "is not needed"); and `PracticeSchedulingPage`/the auto-scheduler date a slot by its
    first occurrence only (`normalizePracticeSlot`, `anchorWallTimes`), so the crossing date draws
    no finding there. Families see two different answers for the same practice. *Executed* (the
    feed and `expandPractices` run on that series). No test asserts the wrong portal behaviour;
    the feed's right behaviour is pinned in `tests/calendarFeed.test.js`. For the owner to place
    (the fix is a portal change, and possibly a scheduler finding per crossing date).
    **Portal half fixed 2026-10-19** (owner: "Fix the portal DST bug"), branch
    `claude/vibrant-allen-hr7y7s-portal-dst` (PR number to be filled in by the coordinator):
    `expandPractices` now takes the season timezone (the team's division's `season_settings.timezone`,
    added to the team read) and places each date with core `placePracticeTime`, built on
    `resolveZonedInstant`, the function the feed's Deno twin is pinned to. A date whose wall time
    does not exist is a dated TIME TBD with the feed's reason; the fall-back hour is shown at its wall
    time with the feed's note; a season with no timezone shows TIME TBD, as the feed does.
    `tests/teamPortalPracticeDst.test.js` holds the two readers to each other date by date; one E2E
    scenario covers the gap date. *Executed.* **Still open:** the scheduling page and the auto-scheduler
    dating a slot by its first occurrence only (a scheduler finding per crossing date), not changed.
  - **Team locking has no product writer.** The team-generation engine honours `team.locked` (a
    locked team takes no late players), but `teams` and `team_players` have no `locked` column,
    `admin_update_team` patches only `name` and `notes`, `buildTeamRows` and the team-persistence
    handler never write it, and no page sets it (a search of `supabase/migrations`,
    `supabase/functions`, `packages/core/src/teamSupabase.js` and `frontend/src` finds `locked`
    only as practice-assignment locks and as `source: 'locked'`, which `normalizeSource` turns into
    `manual`). A locked-roster scenario would test a state no user can create, so B5 has none. A
    manual (hand-moved) assignment is the lock a user can create. Flagged for the owner: add a team
    lock (a plan first), or remove the engine's `locked` handling. *Statically reviewed.*

- 2026-10-19, found by B2 (branch `claude/vibrant-allen-hr7y7s-b2-hardening`, PR #609, Codex review):
  - **`timezone('utc', now())` is a zone-less timestamp that the session time zone reinterprets,
    and a PostgREST caller sets the session time zone** (`Prefer: timezone=...`). It is the
    default of `created_at` columns (`registrations.created_at` among them) and is used 239 times
    across `supabase/migrations`. Under `+14` a row defaulted this way is dated 14 hours in the
    past, under `-12` in the future, so any window, ordering or retention rule that compares those
    columns against the clock can be skewed by the caller. B2's throttle does not rely on it (its
    window is `now() - interval` and the RPC sets `created_at` to `now()` itself), and a smoke and
    pgTAP case run under `+14` and `-12`. The table defaults and the other 238 uses are **not**
    changed here (a repo-wide idiom; a flagged refactor). For the owner to place: audit which of
    them feed a comparison a caller can influence (`prune_old_audit_logs`, heartbeat and staleness
    checks), and move the column defaults to `now()` in a plan of their own. *Statically
    reviewed* for the count and the idiom; *executed* for the `+14` and `-12` behaviour of the
    throttle.

## Deferred with reason

- 2.1 (strict types) — D2's default: the repository's stated rule is `strict: false`; raising it
  is a flagged refactor across 867 files. Recorded in the conformance baseline
  (`docs/standards/conformance.json`, 2026-10-19). Reopen if the
  owner asks for strictness, or a null-handling defect reaches production that `strict` would
  have caught.
- 4.1 (81 early migrations without revert or smoke scripts) — they are applied and stable, and
  every migration since 2026-05-30 has both; writing reverts nobody will run is waste. Reopen if
  one of them must be reverted.
- 12.8 (process not delivered) — resolved by this run's process delivery commit `a63a9f8`, before
  the plan; listed here so the ID appears once.

## Close-out

Written 2026-10-19 by the close-out PR. Evidence labels as everywhere in this plan: *executed* is a
command or query run for this PR (the conformance scorecard, read-only queries on production and
the public GitHub API); everything else cites the merged PR that holds its evidence.

### Owner decisions recorded (2026-10-18)

- The five plans were approved with every recommendation as written, and all are merged: M4.8
  (#593), the #576 follow-up (#594), the RLS advisor rewrite (#595 persona matrix, #596 rewrite),
  the schema drift fix (#598), and audit-in-transaction with the game save's admin check (#600).
  Also merged: the file-name audit fix (#597). Import telemetry stops sending the file name
  (#599, merged as f561674).
- M6 questions: `fsevents`' install script stays denied (recorded here: `allowScripts`
  `fsevents: false`, `tests/allowScripts.test.js`, `dependency-policy.md`; the test fails with the
  entry removed, *executed*); `esbuild` stays approved by name; v1.1.0 is cut in its own PR after
  this close-out (not here).
- #590's behaviour questions: keep as built.
- The production `uploads` bucket (found in the exports PR's entry, #592) was deleted by the owner
  on 2026-10-18; only `exports` and `raw-imports` remain (verified read-only by the coordinator).
- The GitGuardian incident on the revert files' md5 digests was marked a false positive by the
  owner.
- RLS plan Q5 (a `tenant_admin` is narrower than `is_org_admin` on four tables: writes to
  `season_settings` and `registration_forms`, reads of `audit_log` and
  `organization_schema_history`) and Q6 (any signed-in user reads open registration forms) were
  kept as they are. Each is a separate product question, recorded below as open, not as a defect.

### The M1 tails

| Tail | Disposition |
| --- | --- |
| M1.1 and M1.2 carried no status line | Done here: both say merged as #551. |
| M1.3's remaining acceptance (a blocked merge shown, `check:settings`) | Waived by the owner 2026-10-13 (unchanged). The live ruleset was read back 2026-10-19 and requires six checks (*executed*). |
| M1.5, signed-in leg: a Sentry event tagged with user and organization ids | Deferred, owner, to the v1.1.0 release smoke: it needs a real signed-in account and a real error, which no agent has. A Sentry search of production (30 days) for issues with a user id found none (*executed*; says nothing either way, since no signed-in error has occurred). |
| M1.5, Edge leg: a BetterStack error carrying the organization id | Deferred, same owner and smoke. The code is #553's `withFailureLogging`, Deno-tested there. |
| Edge logging residuals (the auto-scheduler's other refusals and fairness-scoring's two season-read `console.error`s carry no request id; the persistence stand-in handler is not wrapped; `flush()` is awaited before a failing response) | **Done**, B3 (branch `claude/vibrant-allen-hr7y7s-b3-tails`; needs the Edge redeploy): `logRequest` in `_shared/logtail.ts` gives the auto-scheduler's refusals and fairness-scoring's two reads the function name, request id and organization; the three persistence stand-in handlers are wrapped; `flush()` is bounded to 2 s. *Executed* (Deno 2.9.6 check and mirror suite, vitest). |
| Milestone exit boxes | Ticked where the evidence is cited; "deployed and smoke-tested" is `[~]` throughout, because merging is not a smoke test (below). |

Nothing in M1 was left that was small enough to finish without an Edge change.

### D2: the conformance baseline

`docs/standards/conformance.json` did not exist. The template's own scorer wrote it:
`node <template checkout>/scripts/check-conformance.mjs --root . --visibility public --write-baseline`
(template 1.0.0, `6f5e572`; no score was written by hand; `visibility: public` was added to the
file by hand so a rerun needs no flag). It records two failures:

- `node.strict-types`: D2's recorded decision. `strict` stays off for the 34 TypeScript files
  (`checkJs` covers the 907 JavaScript ones).
- `supabase.advisors-in-ci`: the scorer reads `--fail-on none` in `pgtap.yml` as "reports and
  never fails". The step does fail: `scripts/ci/supabaseAdvisors.mjs` reads the JSON against
  `docs/security/supabase-advisor-waivers.json` and blocks an unwaived WARN or ERROR (M3.3, with
  planted defects shown red; `tests/supabaseAdvisors.test.js` holds the gate). The probe cannot
  see that. The baseline entry would also mask a future weakening of that gate, so that test, not
  the entry, is what guards it. Recorded as a baseline entry, not a
  waiver, and for the template (an issue or pull request there, per AGENTS.md).

Rerun with the file: exit 0, `2 baseline, 25 pass, 2 n/a, 8 audit` (*executed*). The 8 `audit`
standards are the ones a person or `check:settings` scores (repository settings and the deployed
headers); they were not scored. The audit's own run was `17 fail, 9 pass, 3 n/a, 8 audit` on
`565e980` with template 1.0.0-rc.3; the catalogue has changed since, so the two are comparable by
area but not row by row.

### The thirteen July-plan items

Every one is placed. "B1"-"B5" are the backlog groups in [`resume-queue.md`](./resume-queue.md);
their owner is the repository owner, who schedules them, and every one that touches persistence,
the solver or a filed figure starts as a plan (AGENTS.md rule 14). The check column is what was
looked at on `main` (`1fe2265`) for this PR (*statically reviewed* unless stated).

| Item | Placement | Check |
| --- | --- | --- |
| DS-4 CSV formula injection | Moved to B2 (plan first: it changes what an export contains, including negative numbers). **Built 2026-10-19** on branch `claude/vibrant-allen-hr7y7s-b2-hardening` (plan `docs/changes/2026-10-19-b2-hardening.md`): `escapeCsvCell` in `packages/core/src/csv.js` | `escapeCsvValue` in `packages/core/src/outputGeneration.js` quotes only `"`, `,`, CR, LF |
| DS-5 `submit_registration` throttle | Moved to B2 (plan first: schema). **Built 2026-10-19** on the same branch: migration `20261019010000`, ten registrations per caller per form per 60 seconds, PT429 | no throttle in the RPC's migrations |
| DS-9 impersonation failures swallowed | **Done**, B3 (branch `claude/vibrant-allen-hr7y7s-b3-tails`) | `TopBar.jsx` still ended `impersonateUser(profile).catch(() => {})` (July: toasts added on both call sites; and `impersonateUser` now rejects when its audit row comes back as an error, which supabase-js returns rather than throws, so the July fix alone would never have fired) |
| DS-14 `dashboardCache` unused | **Done**, B3: the instance is deleted, not wired in | `frontend/src/lib/cache.js` was imported only by `tests/cache.test.js`. Deleted rather than wired in: the dashboard hooks poll a running run and refetch after a save, so a 30 s cache would show a schedule from before the save |
| DS-15 serial dashboard queries | **Done**, B3 | `AdminReportingDashboard` (four reads, and the discarded fifth removed) and `EnterpriseDashboard` (three) now use `Promise.all` |
| DD-1 route table in `frontend-architecture.md` | **Done** in PR #605 (branch `claude/vibrant-allen-hr7y7s-b4-docs`) | *Statically reviewed* on `main` after #605: the 33 route rows of `frontend-architecture.md`'s "Current Routes" table equal the 33 `path=` values in `App.jsx` (compared by script, no difference either way), including `/admin/compliance`, `/register/:formId` and `/coaches`; `/compliance`, `/reporting` and `/registration/:formId` are gone. `AdminReportingDashboard.jsx` is still unrouted (baselined in `knip.jsonc`) and the doc no longer mentions it; deleting it stays an owner decision |
| DD-2 roadmap lists team-size configuration as backlog | **Done** in PR #605 (branch `claude/vibrant-allen-hr7y7s-b4-docs`) | *Statically reviewed* on `main` after #605: `docs/expansion/03_ROADMAP.md` line 47 lists division team-size configuration as "v1.1 Area B (Completed)", naming the five `divisions` columns, `admin_upsert_division_settings` and `rosterSizing.js`; `v1.1-planning.md` line 90 carries "Status: landed" for Area B |
| DD-3 `data-modeling.md` and `team-generation.md` omit shipped subsystems | **Done** in PR #605 (branch `claude/vibrant-allen-hr7y7s-b4-docs`) | *Statically reviewed* on `main` after #605: `data-modeling.md` lists `min_roster_size`, `target_team_size`, `team_count_override`, `min_teams`, `max_teams` and their CHECKs (lines 75-86) and `coach_interested_programs` (lines 53-60, 212); `team-generation.md` states the bounds (lines 20, 30) and the count rule from `targetTeamSize` or `teamCountOverride` (line 43) |
| DD-4 `persistence-rpc-layer.md` lacks the `20260613*` RPCs | **Done** in PR #605 (branch `claude/vibrant-allen-hr7y7s-b4-docs`) | *Statically reviewed* on `main` after #605: `persistence-rpc-layer.md` rows at lines 205-214 cover `admin_delete_coaches`, `admin_update_registration_form`, `admin_delete_registration_form`, `admin_remove_member`, `admin_change_member_role`, `get_organization_members`, `admin_cancel_game_assignment`, `admin_cancel_practice_assignment`, `admin_delete_team` and `admin_update_team`, each with its migration; Known Gaps (line 301) now marks the audit-action CHECK lag "Resolved" by `20260613000006` (`audit_actions` lookup) |
| DD-5 `v1.1-planning.md` quotes old M2.2 wording | **Done** in PR #605 (branch `claude/vibrant-allen-hr7y7s-b4-docs`) | *Statically reviewed* on `main` after #605: `v1.1-planning.md` line 36 quotes M2.2 as "Shipped CSV validation, import-job tracking, and error recovery. Durable staged promotion ... has since shipped", the wording `03_ROADMAP.md` lines 33-34 carries now, and line 141 marks the M2.2 row Landed; the Area A gap statement (team-import promotion pending) is unchanged |
| DD-7 `ENVIRONMENT.md` omits the `TEST_*` variables | **Done**, by #558 | `ENVIRONMENT.md` lines 193-198 now list `TEST_ADMIN_EMAIL`, `TEST_COACH_EMAIL`, `TEST_PARENT_EMAIL`, `TEST_PASSWORD` and say which layer reads them |
| DD-9 `playwright.config.ts` loads only `.env` | **Done** in B5 (branch `claude/vibrant-allen-hr7y7s-b5-tests`) | the config now loads the shell, then `.env.test`, then `.env` through `tests/e2e/loadTestEnv.js`; `tests/loadTestEnv.test.js` fails with `.env.test` dropped from the list or the order swapped (*executed*) |
| TG-3 three E2E journeys (DST-boundary splitting, rainout acknowledgement, late registrant on a locked roster) | **Two journeys partly covered, one not buildable** in B5 (branch `claude/vibrant-allen-hr7y7s-b5-tests`). Covered exactly: (1) a practice slot whose first occurrence falls in the spring-forward gap is shown as TIME TBD while other slots are scheduled (`Pillar1_Engine.feature`, E2E); the calendar feed expands a weekly series across the gap, refusing only the gap date and keeping the rest (`tests/calendarFeed.test.js`, unit); (2) a late registrant is seated on a reviewed roster without moving anyone, team ids kept (`late_registrant_reviewed_roster.feature`, E2E). Not covered: a series that crosses the gap on the scheduling page, the team portal or the solver (a defect, below); a locked roster (no product writer, below); rainout acknowledgement (no feature) | DST, late registrant: as above. Rainout: the product has no rainout or alert-acknowledgement feature (a search of `frontend/src`, `packages/core/src`, `supabase/functions` and `supabase/migrations` for `rain-?out` finds two code comments, both on core's practice-exception `cancelled` kind, which no page creates or shows; the only `acknowledged` flags are in core's `resolve` and `freeze` modules, which no page calls), so there is nothing to drive; `docs/testing/e2e_master_plan.md` lists a journey the app does not have. Weather closures are covered by the blackout and heat-forecast features. |

None was dropped. The deferral reason for the lot: each is a behaviour or contract change, or
needs a test run the plan's own rules require (plan-first, a planted defect shown red), and none
blocks the end state the plan measures against.

### Final scorecard

The audit's own areas and scale (the severity of the worst finding in the area; "none open" when
every finding in it is closed or deferred as stated). *Before* is the audit's summary table
(2026-10-12, `565e980`). *After* is what the merged PRs close; it was not re-audited area by
area, so read "None open" as "no finding the audit raised is still open"; the "Not measured" list
below says what no one re-ran. CI evidence is each PR's own
required checks (the live ruleset requires six; the audit's baseline had none required).

| # | Area | Before | After (the audit's findings still open; residuals named in the row) | Evidence |
| --- | --- | --- | --- | --- |
| 1 | Architecture & boundaries | Medium (1.1, 1.2) | None open | 1.1: parity tests #551, widened by #560, #590, #593, #594; the two engines stay by D4. 1.2: knip in CI, #557. |
| 2 | Type safety | High (2.1) | **High (2.1), deferred by D2** | 2.1 is baselined, not fixed (`conformance.json`). 2.2 typed env module #558; 2.3 client-side payload validation #576. |
| 3 | Auth & authorization | Medium (3.1) | None open | pgTAP on every PR and required #573; 26-table persona matrix #595 and rewrite #596 (waivers removed; production's performance advisors report no `auth_rls_initplan` or `multiple_permissive_policies`, read 2026-10-19, *executed*). Found and fixed on the way: any member could save the game schedule (#600), and an org-unchecked `persist_evaluation_run` overload (#598). Open product questions: RLS Q5, Q6. |
| 4 | Data layer | Medium (4.2) | Low (4.1, deferred with reason) | Harness in CI #573; trigger drift reconciled and a catalogue check added #598 (production's migration list includes `20261018060000`, *executed*). 4.1: the 81 early migrations, and four later ones, still lack revert and smoke scripts. |
| 5 | Error handling | High (5.1, 5.2) | None open | 5.1 #552, then a build failure #558; 5.2 #556; unknown-outcome handling #576, #589. Flagged, not done: a dropped connection can follow a committed save (all three persistence clients). |
| 6 | Testing | High (6.1) | None open | Coverage enforced #574; pgTAP required #573; real-backend E2E #578, required #581; engine scenarios drive the engines #579; 6.5 `test.todo` removed #588. 6.2: the staging suite was deleted (#578), its checks moved. |
| 7 | CI/CD | High (7.1, 7.2) | None open | Ruleset live with six checks (read 2026-10-19, *executed*); Node 24 pinned #552; Vercel settings and rollback written down #557; actions pinned and zizmor #574; `build` is a build #588. Owner: clear the dashboard's build-command override (M5.4). |
| 8 | Security | High (8.1) | None open | Audit gate #559 (`npm audit (high and critical block)` passed on `main`'s head, *executed*); install guards, Dependabot #559; env #558; SECURITY.md, LICENSE #556; advisors gate #573 with both waivers gone #596. `fsevents` denied, `esbuild` approved. Not measured here: hosted-only lints (definer functions callable by signed-in users, leaked-password protection off, per the 2026-10-13 m3b entry). |
| 9 | Observability | High (9.1) | **Closed in code; acceptance not measured** | 9.1 #553, 9.2 #545; signed-out event received (preview). The signed-in and BetterStack legs are deferred to the v1.1.0 release smoke (owner). A search for a production event with a user id found none. |
| 10 | Performance | Low | Low | Bundle gate now measures the shipped shape (Replay lazy, caps re-baselined) #588. Triaged in B3, no change: production reports 90 `unindexed_foreign_keys` and 19 `unused_index` at INFO (read 2026-10-19, *executed*), over 1,703 live rows in all of `public` (largest table 1,153); deferred with a re-check trigger, `docs/changes/2026-10-19-b3-fk-index-triage.md`. |
| 11 | Accessibility & UX completeness | High (11.1, 11.2) | None open for the audited findings | Lint + axe on every route in both themes #580 (zero known violations after #581); keyboard game grid #579; `DataGrid` tab stop, token text, chart theme #591. Content the seed leaves out, scanned 2026-10-19 (the #591 follow-up); the few overlays still unscanned are listed in that entry. |
| 12 | Docs, operability & stated-rule conformance | High (12.1) | None open | One `AGENTS.md`, loadable skills, July plan closed, knip #557; LICENSE #556; LF endings and release line #588. Scorecard: all area-12 standards pass (2026-10-19, *executed*). |
| 13 | Core flows | Blocker (13.1) | None open | 13.1 #551; 13.2 real-backend E2E #578 (and its audit-row assertion #592); 13.3 #579. Beyond the audit: dated scoring #560, #590, dated solver #593, game evaluator #594, audited saves #600. |

**Conformance scorecard** (template standards, *executed* 2026-10-19): 17 fail before; 0 fail and
2 baselined now (`node.strict-types` by D2; `supabase.advisors-in-ci`, a probe that cannot read
this repository's gate). See D2 above for the template-version caveat.

**Not measured for this scorecard** (nothing here re-ran them, so no number is claimed): the unit,
E2E, coverage and pgTAP totals after the work (each PR ran them; the audit's baseline figures are
stale); the migration harness count; the hosted *security* advisors; the deployed response headers
(`vite-spa.security-headers`) and repository settings other than the ruleset
(`core.settings-*`, which need an admin token); a signed-in Sentry event and a BetterStack Edge
error with an organization id; `main`'s own CI run at its head (`Build & Test` was still running
when read); and the Manual QA script, end to end, on the deployed app.

### Open owner questions (not defects)

- RLS Q5: a `tenant_admin` is narrower than `is_org_admin` on `season_settings` and
  `registration_forms` (writes) and `audit_log` and `organization_schema_history` (reads), while
  it reads `telemetry_log`. Kept as is. Whether `tenant_admin` should match `is_org_admin` is a
  product question.
- RLS Q6: any signed-in user reads open registration forms. Kept as is; a product question.
- The v1.1.0 release: cut in its own PR after this one, then the release smoke (the Manual QA
  script above, a signed-in Sentry event, a BetterStack Edge error with an organization id).
- Settings only the owner can change: clear the Vercel dashboard's build-command override (M5.4),
  turn on leaked-password protection (Auth), `check:settings` with an admin-read token, merge the
  Dependabot minor/patch group when green (the majors inventory PR is a draft, never merged, D6),
  delete `claude/vibrant-allen-hr7y7s-notes` and the other agent branches.

### Major upgrades (D6 held them out of this plan)

Dependabot's grouped majors PR #584 was closed on 2026-10-19: its install fails, because
`eslint-plugin-jsx-a11y@6.10.2` peers on `eslint ^3` to `^9` and `eslint@10` cannot resolve
(Build & Test run 38600851700). `.github/dependabot.yml` now ignores `eslint` and `@eslint/js` at
`>= 10` until a jsx-a11y release supports ESLint 10. The other majors in that group are not taken
here and not together: each is a planned upgrade of its own, one PR at a time, in the resume
queue after the accessibility follow-up: `typescript` 7, `vite` 8, `vitest` 5, `jsdom` 30,
`@sentry/react` 11, `lucide-react` 1, `dotenv` 18, `globals` 17, `@vitejs/plugin-react` 6, and
`@testing-library/jest-dom` 7. None was attempted. *Statically reviewed* (the ignore entries are
read, not exercised: whether Dependabot honours them shows on its next monthly run).

### Is the plan done?

Yes. Every item is done, or deferred with a reason and an owner: M1.5's two legs (owner, the
v1.1.0 release smoke); the thirteen July items (B2-B5; DD-7 and, with B3, DS-9, DS-14 and DS-15 done); the ten planned major upgrades (resume queue, one PR each); 2.1 (D2, baselined); 4.1 (deferred with reason, above). No item is blocked.

## When this plan is done

Mark the status line DONE with the date, move the lessons worth keeping into
`docs/LESSONS_LEARNED.md`, and leave this plan in its dated folder as the record.

Done 2026-10-19: the status line is DONE, and lessons 32-35 in `docs/LESSONS_LEARNED.md` carry
what is worth keeping.

B3 (2026-10-19, branch `claude/vibrant-allen-hr7y7s-b3-tails`): DS-9, DS-14, DS-15 and the Edge
logging residuals are done above; the FK index triage is deferred with its trigger
(`docs/changes/2026-10-19-b3-fk-index-triage.md`). Found on the way: `impersonateUser` ignored the
`{ error }` that `supabase.rpc('record_audit_event')` returns, so a preview started with no
`impersonation.started` row; it now refuses. `stopImpersonation` has the same shape and is left
best-effort on purpose (an admin whose end-audit fails must still be able to leave the preview).
The auto-scheduler's `console.error('Persistence failed:', persistError)` is a swallowed
persistence failure that reaches only the console; not in B3's list, not changed.
`AdminReportingDashboard` is routed nowhere (the knip `ignoreFiles` entry said so; B3's test now
imports it, so the entry is removed): DS-15's change to it has no user-visible effect until it is
routed or deleted, which is the owner's call. Both dashboards still drop the `error` of some reads
(the reporting page's standings read, all three of the enterprise page's); unchanged, as before.
Owner's call, 2026-10-19: `AdminReportingDashboard` is deleted (branch
`claude/vibrant-allen-hr7y7s-cleanup`), with its two DS-15 test cases; nothing imported it, and
knip reports nothing newly unused. The rainout journey is dropped from
`docs/testing/e2e_master_plan.md` in the same branch, so TG-3 has no third journey to build.
