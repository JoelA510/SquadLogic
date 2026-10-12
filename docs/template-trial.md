# Template trial: agent-ready-template 1.0.0-rc.3 on SquadLogic (existing repository, Phases 0-2)

A release-bar rerun of the template's existing-repository trial. The template's process was
delivered into this repository and its `complete` skill run as written, through Phase 2 (audit
and remediation plan). Phase 3 waits for the owner's approval of the plan. Findings below are
about the **template**; findings about SquadLogic are in
[`docs/audits/2026-10-production-readiness/`](./audits/2026-10-production-readiness/audit.md).

## Setup

- **Date:** 2026-10-12.
- **Template:** agent-ready-template at `00de8ae40e522f4644978393ba5f21883030e34c` ("Release
  1.0.0-rc.3 (#20)"), a separate checkout with its `node_modules`; not edited.
- **Target:** JoelA510/SquadLogic, public, branch `claude/vibrant-allen-hr7y7s` reset to
  `origin/main` `565e980`. The audited commit is `565e980`; the delivery commit is `a63a9f8`.
  The clone was shallow and was deepened to 2026-07-20 (`git fetch --shallow-since`).
- **Environment:** Claude Code (Opus 5.5) in a Linux sandbox, 4 cores; Node 24.21.0 and npm
  11.19.0 (`/opt/nvm/versions/node/v24.21.0/bin`, with `env -u NODE_PATH`); PostgreSQL 16
  binaries present; no Docker daemon, no Supabase CLI, no Deno. The sandbox's Chromium
  (revision 1194) didn't match SquadLogic's Playwright 1.58 (revision 1208), so 1208 was
  installed into a scratch `PLAYWRIGHT_BROWSERS_PATH`. The GitHub API reached JoelA510/SquadLogic
  but refused every other repository ("not enabled for this session").
- **Owner constraints:** plan-only (no change to application source, config, dependencies,
  migrations or CI); no production or shared environment (no Supabase MCP, no `db push`, no
  deploys, no paid services, no fetch of the deployed site); no real personal data.
- **Packs:** `--pack node --pack vite-spa --pack supabase`. Reasoning: `standards/README.md`
  detects `node` from a root `package.json`, `vite-spa` from `vite.config.*` or a `vite`
  dependency, and `supabase` from `supabase/config.toml` or `supabase/migrations/`; SquadLogic
  has all four markers. The scorecard's detection agreed ("Packs (detected): core, node,
  supabase, vite-spa"), so no `--pack` was needed for scoring.

## Commands (trimmed output)

```text
$ npm run process:apply -- --target /home/user/SquadLogic --pack node --pack vite-spa --pack supabase
Standards delivered: core, node, supabase, vite-spa (prompts/standards/).
The target's .gitignore covers 9 delivered file(s), so they'd never be committed:
  ! .claude/skills/bootstrap/SKILL.md … and 4 more
Add exceptions to .gitignore (for an ignored .claude/: `.claude/*` then `!.claude/skills/`), and re-run to confirm.
The target already has agent instructions: CLAUDE.md.
Don't add a second set of rules. An existing project (/complete) merges the rules from
prompts/skeletons/AGENTS.skeleton.md into CLAUDE.md; a new one (/bootstrap) folds CLAUDE.md into a new AGENTS.md.
Next steps: 1. … exclude prompts/, .agents/skills/, .claude/skills/ from the formatter (.prettierignore) …
            2. Commit this delivery as it is, with prompts/.apply-manifest.json …
# committed as a63a9f8: 95 files; the nine .claude/skills files force-added (git add -f),
# because editing .gitignore or adding .prettierignore is a config change the owner ruled out.

$ node scripts/apply-process.mjs --target /home/user/SquadLogic --check
✓ Current with this template.          (exit 0)

# Baseline, in a clean clone of 565e980 (scratch), npm ci first:
typecheck PASS (37 s) · lint PASS, 0 errors, 1 warning (78 s) · test PASS, 306 files (1 skipped),
5,108 tests passed, 34 skipped, 6 todo (284 s) · frontend:build PASS (15 s) · check:bundle PASS ·
check:advisors PASS (127 migrations) · migrationVersions PASS (127 files) ·
test:e2e (CI=true, mock env from ci.yml, --workers=1) PASS, 92 passed (9.1 min) ·
dbharness (HARNESS_PGUSER=postgres) HARNESS OK: 127 migrations, 46 smokes, 23 reverts (168 s) ·
npm audit FAIL: 15 (8 high, 6 moderate, 1 low) · pgTAP, Deno tests: blocked (environment)

$ node scripts/check-conformance.mjs --root <clean clone of 565e980> --visibility public
Packs (detected): core, node, supabase, vite-spa
17 fail, 9 pass, 3 n/a, 8 audit. Template 1.0.0-rc.3 (00de8ae40e52), 2026-10-12.   (exit 1)
# on the delivery commit a63a9f8: 16 fail, 10 pass (only core.process-delivered changes)

$ GITHUB_TOKEN=$(gh auth token) NODE_USE_ENV_PROXY=1 node scripts/check-settings.mjs --repo JoelA510/SquadLogic
✗ fail     core.settings-branch-protected … import the ruleset from .github/rulesets/ …
? skipped  core.settings-dependabot-alerts … needs a token with admin read
? skipped  core.settings-token-read-only … needs a token with admin read
✓ pass     core.settings-private-reporting
✓ pass     core.settings-secret-scanning
1 fail, 2 skipped, 2 pass.   (exit 1)

$ node scripts/check-env.mjs --root <clean clone>
✗ 3 finding(s) in 22 variable name(s) from 3 env file(s) and source (82 read(s)).   (exit 1)

$ node scripts/check-instructions.mjs --root <clean clone>
.agents/skills/squadlogic-*/SKILL.md:1: skill: no YAML frontmatter between --- lines   (×3)
✗ 3 finding(s) in 4 file(s) …   (exit 1)
```

## Findings

### F1. The delivery tells an existing project to merge its rules into CLAUDE.md; the scorecard fails that as high

- **Where:** `scripts/apply-process.mjs` output ("An existing project (/complete) merges the
  rules from prompts/skeletons/AGENTS.skeleton.md into CLAUDE.md"); `complete` skill step 4
  ("Where it already has its own … merge from the skeleton rather than adding a parallel file");
  `standards/core/agent-rules.md`; `prompts/existing-project.md` §12.
- **What happened:** *executed.* SquadLogic keeps its rules in CLAUDE.md alone. The delivery's
  printed next step and the skill both say to merge the AGENTS skeleton into that CLAUDE.md. The
  scorecard then fails `core.agent-rules` (high): "no AGENTS.md at the root; rules kept only in:
  CLAUDE.md". The prompt's §12 makes a tool-specific rule file a finding only "when the team uses
  more than one agent"; the standard fails it unconditionally.
- **Expected:** one answer. Either the delivery says to create `AGENTS.md` and reduce `CLAUDE.md`
  to `@AGENTS.md` (what the skeletons and the standard assume), or the standard accepts a lone
  CLAUDE.md where only Claude Code is used.
- **Cause:** template.
- **Impact:** an agent following the delivery literally produces the shape the scorecard rejects
  at high severity, and an audit has to pick a side. Here it became owner decision D1.
- **Suggested fix:** change the apply message and skill step 4 to "move the shared rules into a
  root AGENTS.md and make CLAUDE.md import it", matching `core.agent-rules`; or give the
  standard the prompt's "more than one agent" condition.

### F2. `vite-spa.bundle-budget` fails a repository whose CI enforces a bundle budget

- **Where:** `standards/vite-spa/bundle-budget.md` ("The check") and its probe in
  `scripts/check-conformance.mjs`.
- **What happened:** *executed.* SquadLogic's `ci.yml` step "Bundle-budget gate (Wave 6a)" runs
  `npm run check:bundle | tee bundle-budget-report.txt` under `set -o pipefail`; the script is
  `scripts/check-bundle-size.js` reading `config/bundle-budget.json`, and it fails the run when a
  chunk is over budget (it printed "PASS — all chunks within budget" here). The scorecard
  reported "no pull_request workflow checks the bundle against a size budget where it can fail the
  run". The probe recognizes only `size-limit`, `bundlesize`, `bundlewatch` or a file named
  `check-bundle-size.mjs`.
- **Expected:** pass, since the standard's **Requires** line ("a pull_request workflow checks what
  the build ships against a size budget, in a step that can fail the run") is met; or at least
  `skipped` naming the unrecognized script.
- **Cause:** template.
- **Impact:** a false failure that the audit had to refute by hand; an auditor who trusted the
  scorecard would plan work that exists already.
- **Suggested fix:** recognize a script whose name or package-script key matches
  `bundle|size` and that reads a budget file, or report `skipped` with the command it couldn't
  classify instead of `fail`.

### F3. `node.ci-uses-pin` passes a repository with no pin and an end-of-life CI runtime

- **Where:** `standards/node/ci-uses-pin.md` (the floor-job exception).
- **What happened:** *executed.* SquadLogic has no `.nvmrc` or other pin (`node.runtime-pinned`
  fails), `engines.node` is `>=20`, and its only `setup-node` step says `node-version: 20` (end of
  life since 2026-04-30; production builds on 24). `node.ci-uses-pin` passed, because `20` equals
  the `engines` floor and the standard exempts "a job that deliberately tests the oldest supported
  version".
- **Expected:** fail (or `n/a` pointing at `node.runtime-pinned`): the exemption is for a floor
  job beside jobs that read the pin, and here there is no pin to read and no other job.
- **Cause:** template.
- **Impact:** a misleading pass on the title "CI takes its Node version from the pin" in the
  exact repository where CI and production run different Node majors.
- **Suggested fix:** apply the floor exemption only when a pin exists and at least one other
  `setup-node` reads it.

### F4. `process:apply --check` reports "Current" on a clone that never received the Claude Code skills

- **Where:** `scripts/apply-process.mjs` (`--check`; "target deleted a delivered file → left
  deleted"), and its ignored-files warning.
- **What happened:** *executed.* SquadLogic ignores `.claude/` (agent worktrees). Applied in a
  scratch clone and committed with `git add -A`, the nine `.claude/skills/` files stayed
  untracked; a fresh clone of that commit has no `.claude/` at all, and `--check` on it printed
  "✓ Current with this template" (exit 0), the same as on the original. The only signal is the
  one-time warning at apply time. Its remedy (edit `.gitignore`) is a config change, so under
  this run's plan-only constraint the skills were force-added (`git add -f`) instead, which the
  message doesn't mention.
- **Expected:** `--check` (and the fleet report's Process column) to flag delivered files that
  are missing because they're ignored, not deleted by choice; the warning to offer `git add -f`
  as the no-config alternative.
- **Cause:** template (the target's ignore rule is legitimate).
- **Impact:** Claude Code users in every other clone silently lack `/complete`, `/verify` and the
  rest, while drift checks say all is well.
- **Suggested fix:** in `--check`, report a delivered path that `git check-ignore` matches and
  `git ls-files` doesn't list as "ignored, not committed"; mention `git add -f` in the apply
  warning.

### F5. The delivery's next steps need config edits a plan-only run can't make

- **Where:** `scripts/apply-process.mjs` next step 1 (`.prettierignore`) and the ignored-files
  remedy (`.gitignore`); `prompts/README.md` "Keep formatters off the delivered files".
- **What happened:** *statically reviewed.* Both remedies edit configuration. The owner's
  constraint for this run forbade config changes, and neither the prompt nor the delivery says
  what to do when the delivery's own steps are out of bounds. SquadLogic runs Prettier only by
  hand (`npm run format`, no pre-commit hook), so no `.prettierignore` was added; a later
  `npm run format` will reformat `prompts/` and the skills and make every re-apply park
  `.template` files.
- **Expected:** the steps to say which are needed now (an ignored skills folder) and which can
  wait for the first remediation PR (a formatter run by hand), and to offer the no-config
  alternative.
- **Cause:** template.
- **Impact:** low here; the agent had to judge it, and the formatter risk is recorded as an open
  item rather than closed.
- **Suggested fix:** split next step 1 into "a pre-commit formatter: before the delivery commit"
  and "a formatter run by hand: in the first remediation PR"; see F4 for the ignored skills.

### F6. `core.lf-line-endings`'s fix would edit applied migrations

- **Where:** `standards/core/lf-line-endings.md` ("Meeting it": `git add --renormalize .`); the
  supabase pack says nothing.
- **What happened:** *executed.* 13 files fail; six are applied Supabase migrations. Renormalizing
  them edits applied migrations, which the Supabase CLI never re-runs and which SquadLogic's CI
  (`scripts/ci/migrationVersions.mjs`) rejects on a pull request.
- **Expected:** the standard to exclude, or say how to exclude (`-text` in `.gitattributes` plus a
  waiver), files that must not change once applied.
- **Cause:** template.
- **Impact:** a literal fix fails the target's CI; recorded as a conflict and planned as
  M6.2 with an exclusion.
- **Suggested fix:** add to "Meeting it": "files that must stay byte-identical once shipped
  (applied migrations) get `-text` in `.gitattributes` and a waiver, not a renormalize".

### F7. Scorecard and settings evidence that overstates what was examined

- **Where:** `core.audit-waivers`, `node.install-guards`, `node.ci-runs-gate` evidence strings;
  `scripts/check-settings.mjs` remedy for `core.settings-branch-protected`.
- **What happened:** *executed.* (a) `core.audit-waivers`: "no advisory is waived anywhere",
  after reading only JSON and TOML registers; SquadLogic's register is Markdown
  (`docs/security/dependabot-waivers.md`), unread. Correct today only because it is empty. (b)
  `node.install-guards`: ".npmrc lets a dependency bring in a git dependency (allow-git=all)" when
  there is no `.npmrc`. (c) `node.ci-runs-gate`: "the project may live below the root (frontend)"
  for a workspace folder that has no `package.json`. (d) `check:settings`: "import the ruleset
  from .github/rulesets/", a path that doesn't exist in a target; the skeleton is at
  `prompts/skeletons/.github/rulesets/main.json`.
- **Expected:** evidence that says what was read ("no waiver in the registers this check reads:
  …"), "no .npmrc, so npm's defaults apply", no hint without a `package.json` below, and the
  delivered skeleton's path.
- **Cause:** template.
- **Impact:** low each; together, evidence an auditor has to re-derive before citing it, against
  the template's own "evidence needs receipts" rule.
- **Suggested fix:** as expected, one line each.

### F8. Scoring the commit before the delivery always yields a finding the delivery itself resolves, and nothing says where it goes

- **Where:** `prompts/existing-project.md` Phase 1 (score the commit before the delivery; "if you
  score [the delivery commit], say so"); the remediation-plan skeleton's traceability rule.
- **What happened:** *executed.* `core.process-delivered` necessarily fails on `565e980`; every
  finding must appear exactly once in the plan, but there is no item to give it. It went under
  "Deferred with reason" as "resolved by the delivery commit", which is not a deferral.
- **Expected:** the prompt to say: record it as resolved by the delivery commit (or to drop
  `core.process-delivered` from the pre-delivery scorecard).
- **Cause:** template.
- **Impact:** low; an improvised entry in every existing-repository plan.
- **Suggested fix:** one sentence in Phase 1 and a "Resolved before the plan" line in the plan
  skeleton.

### F9. §13 asks for every configuration the docs offer, but the shared-environment skip rule lives only in the baseline

- **Where:** `prompts/existing-project.md` §13 ("Try the configurations the docs offer"), Phase 1
  baseline bullet ("Skip gates that cost money or touch shared environments … record them as
  skipped").
- **What happened:** *statically reviewed.* SquadLogic offers two configurations: mock mode and
  real Supabase. The real one can only be exercised against production (out of bounds) or a local
  Supabase stack (Docker, absent here). §13 doesn't say what to do with a configuration that
  needs a shared environment; the agent applied the baseline's rule by analogy and added a
  "not exercised, why" row and a finding (13.2).
- **Expected:** §13 to repeat the rule: a configuration that needs a shared environment or a
  missing tool is recorded as not exercised with the reason, and gets a finding if no test
  covers it.
- **Cause:** template.
- **Impact:** low; another run could have touched production to satisfy §13.
- **Suggested fix:** add that sentence to §13 and to the audit skeleton's §13 guidance.

### F10. The plan skeleton's test-gate field has no form for an item no check can cover

- **Where:** `templates/project/docs/remediation-plan.md` ("The gate has to be shown failing
  with the fix reverted").
- **What happened:** *statically reviewed.* Two items are pure documentation (closing the July
  plan, the README's release line) and one is a settings change made by the owner. The agent
  wrote "none automatable (manual check in the PR)" for the first two and used `check:settings`
  for the third.
- **Expected:** the skeleton to allow "no automatable gate: <the manual check>" explicitly, or to
  point such items at the manual QA script.
- **Cause:** template.
- **Impact:** low.
- **Suggested fix:** one line in the item-format guidance.

### Environment and target notes (not template findings)

- The GitHub API refused the reference repositories; the prompt's git-only fallback worked as
  written (environment).
- The sandbox's Chromium revision didn't match the target's Playwright (environment).
- The target's migration harness needs an OS user `pgrunner`; recorded as SquadLogic finding 4.2
  (target).

## Scorecard accuracy

Each verdict the scorecard gave on `565e980` was checked against the files it names.

| Status | Standards | Matches | Mismatches |
| --- | --- | --- | --- |
| fail (17) | core.agent-rules, core.dependency-updates, core.instructions-resolve, core.lf-line-endings, core.license, core.process-delivered, core.security-policy, core.workflows-audited, node.audit-gate, node.ci-runs-gate, node.install-guards, node.runtime-pinned, node.strict-types, node.unused-code, supabase.advisors-in-ci, vite-spa.bundle-budget, vite-spa.client-env | 16 | 1: `vite-spa.bundle-budget` (false fail, F2) |
| pass (9) | core.ci-on-pull-requests, core.no-agent-workflows, core.workflow-caches, node.ci-uses-pin, node.test-suites-in-ci, supabase.db-tests-in-ci, supabase.function-tests-in-ci, supabase.migration-names, supabase.rls-on-every-table | 8 | 1: `node.ci-uses-pin` (pass on the letter of an exemption, wrong in substance, F3) |
| n/a (3) | core.audit-waivers, core.dependency-cooldown, supabase.explicit-grants | 3 | 0 (the `core.audit-waivers` evidence overclaims, F7) |

**27 of 29 scored verdicts match; 2 mismatch.** Three matching verdicts carry inaccurate evidence
text (`node.ci-runs-gate`, `node.install-guards`, `core.audit-waivers`; F7). Notes on the
matches: `supabase.rls-on-every-table` was confirmed by an independent grep (57 tables, each with
an `enable row level security` statement); `node.strict-types` is right, and conflicts with
CLAUDE.md's declared `strict: false` (an owner decision, not a scorecard error);
`supabase.db-tests-in-ci` passes on the letter although pgTAP runs only on path-filtered PRs.
`vite-spa.client-env`'s findings are real; the audit regraded its severity from high to medium
(no secret in a `VITE_` variable today).

`check:settings`: 3 scored, 3 match (branch protection off, confirmed with
`GET /repos/…/branches/main` and `/rulesets`; secret scanning and push protection on, and private
reporting on, confirmed with `GET /repos/…` `security_and_analysis` and
`/private-vulnerability-reporting`); 2 skipped for lack of admin read, recorded as skipped.

The 8 `audit` standards were answered by reading: `core.error-reporting` fails (audit 9.1),
`supabase.secret-keys-server-only` is met, `vite-spa.security-headers` is met in the repository
(the deployed response wasn't fetched), and the five settings standards are above.

## Worked well

- **Area 13 (core flows) found the worst finding and a class of hollow tests.** Listing every
  README flow and asking how each is proven turned issue #364 into an executed blocker (a scratch
  probe captured the empty `fairness-scoring` request), and showed that the three E2E scenarios
  named for the engines write the engine's output into the mock and assert it back (13.3). The
  baseline was green throughout: without §13 neither would be in the audit.
- **Scoring the commit before the delivery** kept `core.process-delivered` and
  `core.instructions-resolve` honest; the delivery commit's scorecard differed only in
  `core.process-delivered`, as the prompt predicts.
- **"Agent rules kept in ordinary docs"** found `project-hardening/`, a committed prompt bundle
  that grants merge authority, which neither the scorecard nor `check:instructions` reads (12.4).
- **The "Widens" question changed the plan.** Fixing #364 makes the Deno scoring engine's output
  user-visible, so its parity test moved into Milestone 1; requiring CI makes the end-of-life
  Node gate binding, so the Node 24 pin moved in too.
- **The supabase pack** applied cleanly: RLS presence matched an independent grep,
  `supabase.explicit-grants` correctly reports `n/a` until the 2026-10-30 grant change bites,
  and `supabase.advisors-in-ci` correctly refuses the repository's regex approximation.
- **The audit folder convention** (`docs/audits/YYYY-MM-<slug>/`) matched the repository's July
  audit, so the two sit side by side.
- **`check:settings`** worked with the session's token and recorded what it couldn't read as
  skipped.
- **Pack detection** found all three packs, and delivering them up front meant the scorecard had
  no "packs scored without their standards" note.

## Skipped

- **Phase 3** (milestone 1): owner constraint, plan-only.
- **pgTAP and Supabase advisors:** no Supabase CLI or Docker in the sandbox (environment).
- **Deno mirror tests and `deno check`:** no Deno (environment); CI runs them.
- **Staging integration suite:** needs staging credentials and a shared environment (constraint).
- **Fetching the deployed site** (`curl -sI`, the Sentry bundle check): production is out of
  bounds (constraint).
- **`core.settings-dependabot-alerts`, `core.settings-token-read-only`:** the token has no admin
  read (environment); recorded as skipped, not passed.
- **Reference issue activity:** the GitHub API refused the reference repositories; git alone gives
  no issues (environment).

## Final checks

All run from the template checkout against the target's working tree after the run's edits
(*executed*):

- `node /tmp/claude-0/tpl-trialB/scripts/check-placeholders.mjs` on
  `docs/audits/2026-10-production-readiness/{audit,remediation-plan,reference-verification}.md`,
  `docs/template-trial.md` and `prompts/run-log.md`: "✓ No placeholders or guidance comments in
  5 file(s)"; the prompt's `grep -nE` one-liner on the same files printed nothing (exit 1).
- `node scripts/check-instructions.mjs --root /home/user/SquadLogic`: 3 findings in 22 files, all
  three the repository's own frontmatter-less `squadlogic-*` skills (audit 12.2, plan M5.2); the
  18 delivered skill files raise nothing.
- `node scripts/apply-process.mjs --target /home/user/SquadLogic --check`: "✓ Current with this
  template" (exit 0). The delivered files are unedited.
- Traceability: a script over both files found all 43 audit finding IDs exactly once in the plan
  (as an item, a "resolved by", or under "Deferred with reason").
- Coverage, measured for the plan: `npm run test:coverage` PASS, statements 93.07%, branches
  84.23%, functions 95.19%, lines 94.04%, above every configured threshold.

## Against the release bar

CONTRIBUTING.md §8 step 5: a candidate becomes the release when the latest trial of each kind
leaves no template-caused finding open except ones accepted with a reason, and none of three
never-acceptable kinds: (a) a run, followed literally, that stops or writes a wrong or unsafe
artifact; (b) a check or gate that passes without examining anything, or rejects what the docs
call valid; (c) `process:apply` losing or overwriting a target's edit.

| Finding | Cause | Never-acceptable kind? | Classification |
| --- | --- | --- | --- |
| F1 agent rules: delivery says CLAUDE.md, standard demands AGENTS.md | template | **Yes, (b)**: `core.agent-rules` rejects the shape the delivery's own next step calls right for an existing project | open; blocks the release until fixed or the delivery text changes |
| F2 `vite-spa.bundle-budget` false fail | template | **Yes, (b)**: it rejects a budget gate that meets the standard's own Requires line | open; blocks the release |
| F3 `node.ci-uses-pin` passes with no pin | template | No: it examined the step and followed its stated exemption | open; fix before release or accept with a reason |
| F4 `--check` says Current when ignored skills were never committed | template | No by the letter of (b) or (c): nothing is lost or overwritten, and it does examine the files; it misreads an ignored file as a deliberate deletion | open; should be fixed (it hides a broken delivery) |
| F5 next steps need config edits | template | No | open, low |
| F6 LF standard's fix edits applied migrations | template | No | open, low |
| F7 evidence wording overstates what was read | template | No (the verdicts are right) | open, low |
| F8 pre-delivery finding has no home in the plan | template | No | open, low |
| F9 §13 lacks the shared-environment skip rule | template | No, though a literal reading could lead a run toward production | open, low |
| F10 no test-gate form for unautomatable items | template | No | open, low |

**Verdict:** rc.3 does not meet the release bar on this trial: two findings are of a
never-acceptable kind (F1 and F2, both kind (b)), and eight others are open. None is kind (a)
(the run, followed literally, completed and wrote no wrong or unsafe artifact) or kind (c)
(`process:apply` lost no edit). Classifying F1 as (b) is a judgment: the "docs" in question are
the delivery's printed instructions and the `complete` skill, which call a merged CLAUDE.md the
existing-project shape.
