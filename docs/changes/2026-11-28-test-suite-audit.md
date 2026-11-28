# C13 test-suite audit

Proposed November 28, 2026 for the owner’s approval. C13 examines what the test suites protect before the Windows build takes them as its baseline. The completion plan records approval and completion. [Completion gates](2026-11-23-completion.md#gates)

## Why

Administrators depend on the same registration, roster and scheduling behavior across builds. A green run can hide an unused test, an assertion that observes too early or coverage of a feature the product retired. The audit will identify each with evidence and preserve independent checks at the layers where a regression could occur. [Product brief](../product.md) · [Testing conventions](../agents-reference.md#8-testing)

## Starting evidence

Statically reviewed on `35a17d2c`:

- The game import focus test checks the active element immediately after reaching each step. The panel moves focus in a React effect. The scored-game grid test waits for a seeded assignment to render after opening Manual Override. The two scoped-settings cases exercise the hosted row limit and have their own 30-second budgets. These observations identify candidates for measurement. [Focus test](../../tests/gameImportPanel.test.jsx) · [Grid test](../../tests/gameGridScoredGuards.test.jsx) · [Pagination tests](../../tests/scopedSettingsSection.test.jsx)
- The permits scenario for a removed coach role checks that a stale membership is sent home. The coach schedule report tests an administrator’s current workflow. Both have product contracts. The standalone Playwright example opens the Playwright documentation. The two configured browser projects collect generated BDD specs. [Permits scenario](../../tests/e2e/features/permits_page.feature) · [Report tests](../../tests/reportsCoachSchedule.test.js) · [Browser configuration](../../playwright.config.ts)
- The coverage command excludes the performance benchmark and CI runs it separately. Vitest excludes the browser suites. Each runner needs its own inventory and result. [Commands](../../package.json) · [Vitest configuration](../../vitest.config.js)

## Design and tasks

1. **Inventory the suites.** Enumerate tracked candidates independently of each runner and reconcile them with Vitest collection, the benchmark, both Playwright projects, Deno and pgTAP. Record counts, intentional exclusions and orphaned sources. Search for the removed coach login, family and registration flows and retired flags. Trace each candidate to its current product contract or removal decision. For any proposed deletion, identify the assertion, its runner and any remaining coverage for that contract. Verify which jobs collect the Playwright example before considering removal.
2. **Check the named timing cases.** Run the three suites together on unchanged main and repeat the focused assertions. Record the exact command, result and elapsed time. In the focus test, check keyboard focus after both mapping and preview have finished. In the scored grid, compare the refusal with the control that moves an unscored game into the same cell. In the 1,001-division cases, check the last seeded identity, its setting and the expected population. Retain the pagination boundary. Record unreproduced failures as such. Change a timeout only where measurements and the observed readiness condition justify it.
3. **Repair proven problems.** Make test-only changes in a separate PR. Give each deletion or revision a named disposition and reason. Prove a revised check fails when its production behavior is deliberately removed in a disposable checkout, then passes on the restored source. Suitable controls include suppressing heading focus, omitting the scored-move guard or truncating a read to the first page. Preserve tests of current administrative coach workflows and protections for stale roles. Record possible product defects separately for review.
4. **Verify and report.** Reconcile collection counts before and after, run the changed cases, and record the full repository gates and required CI results on the reviewed head. Record findings, retained cases, removals and any unverified items here. Close C13 in the completion plan on the strength of those results. The owner’s O1 result and formal desktop approval remain separate entries in that plan.

## Risks and rollback

The main risk is deleting a regression guard because it mentions a retired feature. Trace both its input and its expected outcome before removing it. Several suites may exercise one operation legitimately through different boundaries. Preserve their distinct failure conditions. Use synthetic data and the existing thresholds, runner isolation and retry settings throughout. The proposed changes affect tests and documentation. Reverting a test change restores the earlier assertion without touching league data.

## Done when

The report accounts for the runner inventory, gives a disposition for every flagged candidate, records evidence for all three timing suites and lists the verification run for each change. Every repaired assertion has a failing control and the final gates are green. The audit follows the repository’s existing testing and privacy rules and introduces no dependency, public API or migration.
