---
id: node.test-suites-in-ci
title: Every test runner the project installs runs in CI
severity: high
enforcement: check
audit-area: 6
---

**Requires:** each test runner in the project's dependencies (Vitest, Jest, Playwright Test,
playwright-bdd, Cypress) runs in a `pull_request` workflow.

**Why:** a suite nobody's gate runs rots silently: it passes on the day it's written, then the code
moves and nobody sees it fail. An installed E2E runner with no CI step is the usual case.

**Meeting it:** add the suite's script to the CI gate, or, if it can't run in CI yet (it needs a
service CI doesn't have), waive this standard with that reason and an expiry.

**The check:** finds runners in `dependencies` and `devDependencies` (and a `playwright.config.*`
file), then looks for each one's command in the commands CI runs, traced the same way as
`node.ci-runs-gate`, and counted only where it can fail the run. `n/a` when no runner is installed (`node.ci-runs-gate` reports missing tests).
