---
id: vite-spa.bundle-budget
title: CI holds the bundle to a size budget
severity: low
enforcement: check
audit-area: 10
---

**Requires:** a `pull_request` workflow checks what the build ships against a size budget, in a step
that can fail the run.

**Why:** every user downloads the bundle, and it grows one reasonable import at a time: a date
library for one format, an icon set imported whole. Nobody sees the total in a diff. A budget turns
the total into a number a pull request has to answer for, and raising it into a decision someone
states.

**Meeting it:** the template's `scripts/check-bundle-size.mjs` reads `bundle-budget.json` (globs
under the build's output directory, each with a gzipped limit and the reason for it) and runs in
the gate after `npm run build`. Copy both, set each budget a little above what ships today, and
run it after the build in CI. `size-limit` (with `@size-limit/file` or a preset), `bundlesize`,
and `bundlewatch` meet it too.

**The check:** looks for `size-limit`, `bundlesize`, `bundlewatch`, or `check-bundle-size.mjs` in
what `pull_request` workflows run, traced through scripts as `node.ci-runs-gate` does, counted
only where it can fail the run. `andresz1/size-limit-action` alone is `skipped`: it reports on the
pull request, and this check can't tell whether it fails the run.
