---
id: node.unused-code
title: CI finds unused files, exports, and dependencies
severity: low
enforcement: check
audit-area: 1
---

**Requires:** a `pull_request` workflow runs knip, in a step that can fail it.

**Why:** a file nothing imports, an export nothing uses, and a dependency nothing loads all look
alive in a review. Each one is code an agent reads and trusts, a dependency that has to be
patched when it's advised against, and installed code that can run. A refactor that orphans a
module passes every other check.

**Meeting it:** add `knip` as a dev dependency and a `"check:unused": "knip"` script, and run it
in the gate CI runs. Configure it in `knip.json`: name the entry points knip can't infer (a
library's public modules, a script a hook or a workflow calls), `ignore` generated files, and
`ignoreDependencies` only for a package loaded in a way it can't see (a `createRequire` call),
each with the reason in the pull request. The template's `knip.json` is an example.

**The check:** looks for `knip` in what `pull_request` workflows run, traced through scripts as
`node.ci-runs-gate` does, and counted only where it can fail the run (not with `--no-exit-code`,
or behind `|| true`).
