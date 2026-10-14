# Remediation plan

Repo: **JoelA510/SquadLogic** · Plan drawn up: 2026-10-12 · Source audit: [`audit.md`](./audit.md) (commit `565e980`)

**Status:** IN PROGRESS as of 2026-10-13 — approved by the owner on 2026-10-13 "as recommended":
D1-D8 at their defaults, and finding 5.1 moved into Milestone 1 (PR 1-B, as M1.7). Milestone 1 is
in progress: PR 1-A merged as #551 (`73d98d0`); PR 1-B (M1.3, M1.4, M1.7) merged as #552
(`33e68ab`); PR 1-C (M1.5) is open as #553; M1.6 was resolved on `main` by #545.

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
> - **Status (2026-10-13): live; the record is in #552 (open).** The owner imported ruleset
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
>   demonstration and `check:settings`) is waived; the ruleset is considered done.
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
> - **Status (2026-10-13): in #552 (open).** `.nvmrc` `24`, `engines.node` `^24.0.0`, and every
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
> - **Status (2026-10-13): in #552 (open).** `config.js` refuses on every host; the host plays no
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
> - **Status: in review, PR 1-C (#553); not merged.** `logger.setUser` passes only `id`,
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

**Milestone exit:** [ ] CI is a required check and blocks merge on the gate (M1.3; the owner
imports the ruleset) · [ ] a production build without Supabase configuration refuses to start on
every host, the production host included (M1.7) · [ ] error reporting receives an induced error,
tagged with user and organization IDs (M1.5; the CSP half, M1.6, is in `main` through #545) ·
[ ] zero open blockers (M1.1) · [ ] deployed
and smoke-tested

---

## Milestone 2 — Data integrity & security

> **M2.1. Eight high advisories, no waiver, no audit gate** (audit finding 8.1, high)
> - **Status (2026-10-13): in #559 (open).** #332's in-range refresh (`npm update` within the
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
> - **Status (2026-10-13): in #558 (open).** `frontend/src/env.js` is the only reader of
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
> - **Status (2026-10-13): in #559 (open), with M2.1.** `.github/dependabot.yml` (npm and
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
> - **Status: in review, PR 2-C (`claude/vibrant-allen-hr7y7s-m2c`); not merged.** `SECURITY.md` names GitHub private
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
> - **Status: in review, PR 2-C (`claude/vibrant-allen-hr7y7s-m2c`); not merged.** New `frontend/src/lib/persistenceRequest.js`
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
> - **Status: in review, PR 2-C (`claude/vibrant-allen-hr7y7s-m2c`); not merged.** `refuseEmptyPracticeRoster`
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

**Milestone exit:** [ ] no unwaived high/critical advisory and the audit gate runs on PRs and
weekly · [ ] a production build without Supabase variables fails · [ ] scorecard passes the
standards these items name · [ ] deployed and smoke-tested

---

## Milestone 3 — Testing & CI depth

> **M3.1. Coverage thresholds are configured but never enforced** (audit finding 6.1, high)
> - **Status (2026-10-13): done in PR M3-A (branch `claude/vibrant-allen-hr7y7s-m3a`; open).**
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
> - **Status (2026-10-13): done in PR m3b (branch `claude/vibrant-allen-hr7y7s-m3b`; open);
>   the live ruleset is the owner's step after merge.** `pgtap.yml` has no `paths` filter and
>   pins CLI `2.118.0`, the deploy jobs' version (kept over 2.95.4 because `migrationGuard.mjs`
>   parses 2.118.0's JSON; `supabaseCliPin.test.js` now holds every workflow to one version).
>   `supabase start` skips the services no suite uses, after an edge-runtime 502 failed a run.
>   `main.json` requires `Run pgTAP against local Supabase` and, with the owner's approval,
>   `npm audit (high and critical block)`; `rulesetRequiredChecks.test.js` reads every workflow.
>   Green on 2.118.0: 53 files, 662 assertions (*fully validated*, dispatch run 38484268374).
>   Test gate: a throwaway migration adding a permissive `USING (true)` SELECT policy on `teams`
>   failed `rls_cross_org_isolation.sql` tests 1 and 3 (*fully validated*, dispatch run
>   38484483751 on a throwaway branch, no PR). Merge blocking awaits the live ruleset.
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
> - **Status (2026-10-13): done in PR m3b (branch `claude/vibrant-allen-hr7y7s-m3b`; open).**
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
> - **Status (2026-10-13): done in PR m3b (branch `claude/vibrant-allen-hr7y7s-m3b`; open).**
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
> - **Status (2026-10-13): done in PR M3-A (branch `claude/vibrant-allen-hr7y7s-m3a`; open).**
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

**Milestone exit:** [ ] coverage, pgTAP, advisors and the harness fail CI on a planted defect ·
[ ] pgTAP required · [ ] deployed and smoke-tested

---

## Milestone 4a — Completeness vs. what "complete" means: the flows

> **M4.6. The E2E scenarios named for the engines never run them** (audit finding 13.3, high)
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
> - **Status (2026-10-14): built, in review** (branch `claude/vibrant-allen-hr7y7s-w3d`, not
>   merged). `.github/workflows/e2e-real-backend.yml`, job **E2E against local Supabase**, runs
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
>   Recommended as a required check after several green pull-request runs (a ruleset change,
>   so another owner import). The audit-log assertion after import waits for w3e's fix (below).
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
> - **Status (2026-10-13): built as planned, in review** (branch
>   `claude/vibrant-allen-hr7y7s-m47`, not merged). Ranges and slot validity are in both
>   engines, held together by a dated parity extract (corpus cases C1 and C4) and 14
>   hand-written witnesses run by core, the cross-arm drift test and Deno; the page sends each
>   slot's dating and each row's range, the override panel counts from the season's today on,
>   and apply-time metrics are dated (Q9). The undated extract is byte-identical, and the
>   solver's outputs over a season-2026 sweep match `main` byte for byte except the new
>   `dateModel: 'undated'` on its evaluation (*executed*). Each of the plan's plants (P1-P7,
>   plus three more) turns a test red (*executed*). **Remaining scope:** practice exceptions
>   (`relocated`, `time_tbd`) are not read by either engine yet; that is its own PR (Q1),
>   through `applyPracticeExceptions` and its Edge twin. The solver is M4.8 (Q2).
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
>   CI pending.

> **M4.8. The auto-scheduler's coach check compares first-occurrence instants, so it can double-book a coach** (not an audit finding: found by the M4.7 plan, Q2; medium) — **plan first: needs the owner's approval before any code**
> - **Status (2026-10-13): open, not planned.** Proposed by the M4.7 plan (Q2, approved as
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

> **M4.3. The game grid is drag-only** (audit finding 11.2, high)
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
> - **Status: in review, #576 (`claude/vibrant-allen-hr7y7s-w3c`); not merged.** Each client
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
> - **Status (2026-10-14): deleted, in review** (branch `claude/vibrant-allen-hr7y7s-w3d`, with
>   M4.1). Run against production with the publishable key on 2026-10-14 (*executed*: anon
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

**Milestone exit (4a and 4b):** [ ] real-backend E2E green on PRs · [ ] the engine scenarios
fail when their engine is stubbed · [ ] accessibility scan in E2E · [ ] deployed and
smoke-tested

---

## Milestone 5 — Agent rules, docs and operability

> **M5.1. One AGENTS.md for every agent, without contradictions** (audit finding 12.1, high)
> - **Status (2026-10-13): done in PR M5 (branch `claude/vibrant-allen-hr7y7s-m5`; open).** Root `AGENTS.md` (23,589 bytes) holds every rule, its
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
> - **Status (2026-10-13): done in PR M5 (branch `claude/vibrant-allen-hr7y7s-m5`; open).** Frontmatter on all three, their facts corrected
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
> - **Status (2026-10-13): done in PR M5 (branch `claude/vibrant-allen-hr7y7s-m5`; open).** The July plan is marked superseded, with a disposition
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
> - **Status (2026-10-13): done in PR M5 (branch `claude/vibrant-allen-hr7y7s-m5`; open), except the test gate.** `vercel.json` sets `framework`,
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
> - **Status (2026-10-13): done in PR M5 (branch `claude/vibrant-allen-hr7y7s-m5`; open).** knip `~6.27.0` (later versions need zod `^4.4.3`, which
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

**Milestone exit:** [ ] `check:instructions` and the scorecard's §12 standards pass · [ ] deployed
and smoke-tested

---

## Milestone 6 — Polish

> **M6.1. `npm run build` isn't a build** (audit finding 7.5, low)
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

**Milestone exit:** [ ] scorecard shows only baselined or waived failures · [ ] deployed and
smoke-tested

---

## Manual QA script

1. On a preview deploy with real Supabase, sign in as an admin, open Practice Scheduling for a
   seeded season, and read the fairness panel — expect: a non-zero team count; with a coach
   double-booked on purpose, a conflict listed (automated by M1.1, and against the real backend
   by M4.1).
2. Trigger `window.__FORCE_ERROR__()` on the preview — expect: the error boundary renders and a
   Sentry event appears within a minute, tagged with your user ID and organization ID, and the
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
    has the detail. *Statically reviewed.*
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
  - The `auth_rls_initplan` and `multiple_permissive_policies` waivers expire on 2027-01-11, after
    which pgTAP, a required check, fails every PR until the policies are rewritten or the waivers
    renewed. Wants a plan item (RLS policy rewrite, plan first). *Statically reviewed.*
  - pgTAP run 38338431910 (branch `feat/grid-override-prompt`) failed
    `practice_grid_current_rows.sql` test 36 with the two series in the other order
    (`have: thu,fri`, `want: fri,thu`): if that assertion depends on row order, it is a flake that
    now blocks merges. Not reproduced; *unverified*.
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
    by w3e's PR (the RPC called with the user-scoped client); M4.1's import scenario should
    assert the audit row once that lands.
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
    never honours `abortSignal`, so no mock scenario sees it. Not fixed; the real-backend
    scenarios use a production build. *Executed* (dev server), production path *statically
    reviewed*.
  - After "Sync to Supabase" the teams page drops its success line and shows the generate view
    until a reload (the dashboard's team summary is not re-read); the sync itself succeeds.
    Not fixed; the scenario reads the sync from its response and checks the teams after a
    reload. *Executed* (run 38498654391).
  - The import page's "Continue" passes the import to `setImportedData` and then
    `resetImport('all')` clears it in the same handler, and nothing writes the `imports` table
    the context rehydrates from, so `/teams` opens without the import; the side navigation
    keeps it. Not fixed. *Statically reviewed.*
  - The Exports page's "Upload to Storage" writes to an `exports` bucket no migration creates,
    and production has no `storage.objects` policy for it (only `raw-imports` has policies), so
    an administrator's upload would be refused. Not fixed; not in the scenarios. *Executed*
    (read-only SELECTs on `storage.buckets` and `pg_policies`); the refusal itself *statically
    reviewed*.

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
    The team client is not on `postPersistenceRequest`. Not fixed. *Statically reviewed.*
  - The Edge game evaluator still skips, without a word, a game side whose team is missing from a
    non-empty roster (core's `evaluateGameSchedule` warns `unknown-team`), so a roster that
    matches no game still scores clean. Reporting it is a scoring change, so it is not in this
    PR; `EvaluationPanel` has no client guard for games either, unreachable while no page passes
    `gameData`. *Statically reviewed.*

## Deferred with reason

- 2.1 (strict types) — D2's default: the repository's stated rule is `strict: false`; raising it
  is a flagged refactor across 867 files. Recorded in the conformance baseline. Reopen if the
  owner asks for strictness, or a null-handling defect reaches production that `strict` would
  have caught.
- 4.1 (81 early migrations without revert or smoke scripts) — they are applied and stable, and
  every migration since 2026-05-30 has both; writing reverts nobody will run is waste. Reopen if
  one of them must be reverted.
- 12.8 (process not delivered) — resolved by this run's process delivery commit `a63a9f8`, before
  the plan; listed here so the ID appears once.

## When this plan is done

Mark the status line DONE with the date, move the lessons worth keeping into
`docs/LESSONS_LEARNED.md`, and leave this plan in its dated folder as the record.
