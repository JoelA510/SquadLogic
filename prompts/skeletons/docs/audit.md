# Audit

<!-- GUIDANCE: Existing-project Phase 1 output. Instantiate in a dated folder —
     docs/audits/YYYY-MM-<slug>/audit.md, or a dated folder wherever the repo already keeps its
     plans — so the next audit doesn't overwrite this one and the two can be compared. Give every
     finding an ID, area.number (3.1, 3.2, …); the remediation plan cites findings by ID. Read the codebase before writing anything here. Every finding needs
     file-path evidence; a finding nobody can navigate to is an opinion. Label each finding with
     the same three levels the prompts use: *statically reviewed* (you read it), *executed* (you
     ran something and observed the result), or *fully validated* (you ran it and verified the
     outcome end to end). Anything short of executed is provisional. Where sources or code paths
     conflict, name the conflict and which one controls — don't merge silently. -->

Repo: **[REPO]** · Commit audited: `[HEAD SHA]` · Audited: [DATE] · Auditor: [WHO/WHAT]

Complete means: [COMPLETE_MEANS — restated from the project inputs]

<!-- GUIDANCE: Every gap below is a gap *against this*, not against perfection. -->

## Severity

<!-- GUIDANCE: Keep these definitions. The remediation plan uses the same ones; if it grades an
     item differently than this audit does, it says so and why, in the item. -->

- **Blocker:** cannot responsibly ship: data loss, a security hole, an authorization bypass, a
  broken core flow.
- **High:** will hurt users or the team soon: an unenforced guarantee, a silent failure path, a
  missing test on logic people depend on.
- **Medium:** real debt with a schedule.
- **Low:** polish.

## Baseline (run before reading for findings)

<!-- GUIDANCE: Install from a clean checkout and run every gate the repo claims to have, before
     anything else. Record the actual result, not the intended one. A baseline run is what
     exposes a gate that only passes with an undocumented flag, a test suite that silently
     skips, or a runtime mismatch between CI and production. Mark a gate *blocked (environment)*
     when it couldn't run here, and say what's missing. That's a finding in itself, not a pass. -->

| Gate | Command | Result | Notes (counts, skips, flags it needed, environment) |
| --- | --- | --- | --- |
| Install | `[INSTALL COMMAND]` | [PASS / FAIL / BLOCKED (ENVIRONMENT)] | [FILL IN] |
| Typecheck | `[COMMAND]` | [RESULT] | [FILL IN] |
| Lint | `[COMMAND]` | [RESULT] | [FILL IN] |
| Unit / integration tests | `[COMMAND]` | [RESULT] | [PASSED / FAILED / SKIPPED COUNTS] |
| E2E tests | `[COMMAND]` | [RESULT] | [FILL IN] |
| Build | `[COMMAND]` | [RESULT] | [FILL IN] |
| Dependency audit | `[COMMAND]` | [RESULT] | [COUNTS BY SEVERITY; WAIVED?] |
| Standards conformance | `[COMMAND]` | [RESULT] | [COUNTS BY STATUS; FAILING STANDARD IDS] |
| Repository settings | `[COMMAND]` | [RESULT] | [SCORED / SKIPPED FOR LACK OF ACCESS; FAILING STANDARD IDS] |
| Environment checks | `[COMMAND]` | [RESULT] | [FILL IN] |
| Agent instructions | `[COMMAND]` | [RESULT] | [FILL IN] |

Runtime: [VERSIONS — local, CI, and production, e.g. Node 22 / 20 / 24]

## Known issues going in

<!-- GUIDANCE: What users, testers, or the team already report: the bug tracker, playtest
     notes, support threads, a HARDENING or TODO file. These are often the highest-severity
     findings, and an audit that only reads code misses them. Link each one; say which audit
     section picks it up. -->

- [KNOWN ISSUE] — source: [LINK OR FILE] — see §[N]

## Summary

| # | Area | Severity of worst finding | One-line state |
| --- | --- | --- | --- |
| 1 | Architecture & boundaries | [SEVERITY] | [FILL IN] |
| 2 | Type safety | [SEVERITY] | [FILL IN] |
| 3 | Auth & authorization | [SEVERITY] | [FILL IN] |
| 4 | Data layer | [SEVERITY] | [FILL IN] |
| 5 | Error handling | [SEVERITY] | [FILL IN] |
| 6 | Testing | [SEVERITY] | [FILL IN] |
| 7 | CI/CD | [SEVERITY] | [FILL IN] |
| 8 | Security | [SEVERITY] | [FILL IN] |
| 9 | Observability | [SEVERITY] | [FILL IN] |
| 10 | Performance | [SEVERITY] | [FILL IN] |
| 11 | Accessibility & UX completeness | [SEVERITY] | [FILL IN] |
| 12 | Docs, operability & stated-rule conformance | [SEVERITY] | [FILL IN] |
| 13 | Core flows | [SEVERITY] | [FILL IN] |

<!-- GUIDANCE: Each failing standard in the conformance scorecard is a finding in the area the
     scorecard prints beside it, and carries the standard's ID, so the next audit's scorecard
     lines up with this one. A standard the scorecard passes still leaves the area's
     judgment-based review to do. -->

<!-- GUIDANCE: Skipping an area requires a stated reason in its section. "No UI surface" is a
     reason; silence is not. Say what doesn't apply rather than inventing a finding for it: a
     static site with no backend has no server-side authz (§3), no database (§4), and nothing to
     answer "what failed for user X yesterday" (§9) beyond client error reporting; a library
     has no deploy (§7) or env module (§2). A missing typed env module is only a finding if the
     app reads environment variables. -->

## 1. Architecture & boundaries

<!-- GUIDANCE: Duplicate schemas, cross-layer imports, dead apps/packages, config drift, and the
     same value derived in more than one place (one of them will drift). -->

- **Current state:** [CURRENT STATE, WITH FILE PATHS]
- **Findings:**
  - **[ID — e.g. 1.1]** `[SEVERITY]` `[VERIFICATION LABEL]` [STANDARD ID, IF A STANDARD COVERS IT — e.g. `core.lf-line-endings` in §12] — [FINDING] (`path/to/evidence`)
- **Pattern that closes the gap:** [THE TARGET SHAPE, DESCRIBED CONCRETELY]

## 2. Type safety

<!-- GUIDANCE: Strictness at the strictest level the stack supports (TypeScript strict, or
     checkJs for a JS codebase, mypy/pyright strict, and so on), and whether it has regressed:
     a setting relaxed to unblock an emergency and never restored is a finding even when the
     code would now pass the strict setting. Any-leaks, unvalidated external data, a missing
     typed env module (only if the app reads env). -->

- **Current state:** [FILL IN]
- **Findings:** [FILL IN]
- **Pattern that closes the gap:** [FILL IN]

## 3. Auth & authorization

<!-- GUIDANCE: Server-side enforcement, session handling, tenancy on every multi-user table,
     privilege-escalation paths. This section and §8 justify the most audit time. -->

- **Current state:** [FILL IN]
- **Findings:** [FILL IN]
- **Pattern that closes the gap:** [FILL IN]

## 4. Data layer

<!-- GUIDANCE: Migration hygiene (does every migration have a revert, and has one been run?),
     N+1s, transactions around multi-step writes, identifier typing, blank-vs-zero handling,
     display precision vs stored precision. Client-persisted state counts too: localStorage,
     IndexedDB, saved files. Is it versioned, and is there a migration when its shape changes?
     A save format that silently drops fields on load is a data-loss finding. -->

- **Current state:** [FILL IN]
- **Findings:** [FILL IN]
- **Pattern that closes the gap:** [FILL IN]

## 5. Error handling

<!-- GUIDANCE: Swallowed exceptions, unhandled rejections, user-facing failure states,
     retry/timeout on external calls, and success reported for work that didn't happen (a job
     that logs "done" while the thing it feeds is empty; an import that reports success after
     a partial failure). -->

- **Current state:** [FILL IN]
- **Findings:** [FILL IN]
- **Pattern that closes the gap:** [FILL IN]

## 6. Testing

<!-- GUIDANCE: Unit coverage of core logic, edge cases, E2E of critical journeys. Then look for
     tests that can't fail, which count as findings, not coverage:
     - tests that assert nothing;
     - suites that never run in any gate (skipped by default, gated on fixtures CI doesn't
       have, an E2E suite with no recorded passing run);
     - coverage thresholds configured but not enforced in CI;
     - checks that report success after examining zero records;
     - test doubles (mock clients, in-memory DBs) that enforce none of the real backend's
       constraints. -->

- **Current state:** [FILL IN]
- **Findings:** [FILL IN]
- **Pattern that closes the gap:** [FILL IN]

## 7. CI/CD

<!-- GUIDANCE: Does CI run typecheck+lint+test+build, and is it a *required* check, so it blocks
     merge? Do scripts do what their names say (a `lint` script that only runs `tsc` means
     there's no linter)? Does CI run the same runtime version as production? Are there config
     keys that silently stopped working after a tool upgrade? Is the runtime pinned in one file
     that CI reads, and is that version still supported upstream (an end-of-life runtime in CI or
     production is a finding)? Also preview deploys, the
     rollback path, and whether the shipped artifact is ever checked, not just the config that
     produces it. Build settings that live only in a hosting dashboard (runtime version, build
     command, env var names) are a finding: nobody reviews or can restore them. The target
     shape is the release-runbook skeleton (docs/release-runbook.md). -->

- **Current state:** [FILL IN]
- **Findings:** [FILL IN]
- **Pattern that closes the gap:** [FILL IN]

## 8. Security

<!-- GUIDANCE: Secrets in code or git history, input sanitization, rate limiting on public
     endpoints, CORS/headers/CSP. A secret found in history is a blocker plus a rotation task, not
     just a deletion. Dependency audit: does one run in CI at all; does it block on
     high/critical (not `continue-on-error`, not runtime-only); does it also run on a schedule;
     are waivers reasoned, owned, and expiring, and is the register actually compared against the
     audit? The target shape is the dependency-policy skeleton (docs/dependency-policy.md). Also
     licensing: does the repo have a license, and do its dependencies' licenses permit the use?
     Client bundles: a secret behind a public prefix (VITE_, NEXT_PUBLIC_, EXPO_PUBLIC_, …), env
     reads the bundler doesn't inline, placeholder values, ${VAR} in eas.json (from a template
     checkout: npm run check:env -- --root <repo>). -->

- **Current state:** [FILL IN]
- **Findings:** [FILL IN]
- **Pattern that closes the gap:** [FILL IN]

## 9. Observability

<!-- GUIDANCE: Structured logging, error reporting, and the concrete test: can you answer "what
     failed for user X yesterday"? Is the reporter actually receiving events (a CSP or an ad
     blocker can silently drop them)? -->

- **Current state:** [FILL IN]
- **Findings:** [FILL IN]
- **Pattern that closes the gap:** [FILL IN]

## 10. Performance

<!-- GUIDANCE: Bundle size, obvious render/query hot spots. Measure (executed) or label it
     statically reviewed — never guess numbers. -->

- **Current state:** [FILL IN]
- **Findings:** [FILL IN]
- **Pattern that closes the gap:** [FILL IN]

## 11. Accessibility & UX completeness

<!-- GUIDANCE: Labels, focus, keyboard operability, contrast, and loading/empty/error states for
     every screen. An empty state that was never designed is a finding. -->

- **Current state:** [FILL IN]
- **Findings:** [FILL IN]
- **Pattern that closes the gap:** [FILL IN]

## 12. Docs, operability & stated-rule conformance

<!-- GUIDANCE: README accuracy, .env.example currency, ADRs for past decisions (backfill only the
     consequential ones), a deploy runbook. Then:
     - Stale committed artifacts: build logs, generated output, leftovers from a scaffolding tool
       or an AI studio that no longer describe the project.
     - Docs drift: routes, RPCs, or features the docs don't know about, and claims the code no
       longer backs.
     - Stated-rule conformance: for each rule in CLAUDE.md/AGENTS.md/CONTRIBUTING (every write
       goes through an RPC, every migration has a revert, every change updates the docs), is it
       enforced, or only declared? A declared-but-unenforced rule is a finding.
     - User-facing claims nothing backs: numbers, comparisons, "secure", "compliant", "AI that
       understands", with no source, owner, or date (target shape: the claims register in
       docs/content-guide.md).
     - Agent instructions that contradict each other ("refactor first" vs "minimal diffs"),
       or that name paths, imports, or scripts that no longer exist, or carry characters a
       reviewer can't see (from a template checkout: npm run check:instructions -- --root <repo>).
     - Both a CLAUDE.md and an AGENTS.md, with no @AGENTS.md import in CLAUDE.md: Claude Code
       reads only CLAUDE.md, so the AGENTS.md rules never reach it. -->

- **Current state:** [FILL IN]
- **Findings:** [FILL IN]
- **Pattern that closes the gap:** [FILL IN]

## 13. Core flows

<!-- GUIDANCE: Whether the product does what it promises, which no other area asks: a repo can
     pass every gate and still ship a flow nobody can finish. List each flow the README, the
     spec, or "Complete means" promises, and exercise it end to end, by running the app or
     driving it through its real entry point in a test, in the configurations the docs offer,
     not only the default one. One that only a shared or production environment can exercise
     (a hosted database, staging, a live provider) isn't exercised unless the run's constraints
     allow it: record it as not exercised with the reason, and as a finding when no test covers
     it. A flow that doesn't work is a blocker; one that works but no test proves is a finding
     here as well as in §6. Keep the table even when every flow works: it's what the next audit
     compares against. -->

| Flow (as promised, with where) | How exercised | Result | Test that proves it |
| --- | --- | --- | --- |
| [FLOW — SOURCE] | [RAN THE APP / TEST THROUGH ENTRY POINT / NOT EXERCISED, WHY] | [WORKS / BROKEN / PARTIAL] | [TEST PATH OR NONE] |

- **Current state:** [FILL IN]
- **Findings:** [FILL IN]
- **Pattern that closes the gap:** [FILL IN]

## Conflicts

<!-- GUIDANCE: Where two sources of truth disagree (code vs. docs, schema vs. API, two configs) —
     name each conflict and which side controls. -->

- [CONFLICT] — controls: [WHICH, AND WHY]

## Refuted or corrected during verification

<!-- GUIDANCE: Before finalizing, re-verify every finding against the code, ideally in a separate,
     adversarial pass. Record here each finding that was dropped, and each whose evidence was
     corrected (a wrong line number, a narrower scope, a CVE that turned out not to be
     reachable). It stops the next audit re-deriving or re-litigating them. "None refuted" is a
     valid entry; an empty section is not. -->

- [FINDING ID] — [REFUTED / CORRECTED] — [WHAT THE VERIFICATION SHOWED]

## Coverage and limitations

<!-- GUIDANCE: What this pass did not do, so nobody reads it as a certified-complete audit: suites
     not run, tables not individually checked, areas covered only by static reading, anything
     assessed without running it. -->

- [WHAT WASN'T COVERED, AND WHY]
