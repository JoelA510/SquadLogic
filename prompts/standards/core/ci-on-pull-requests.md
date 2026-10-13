---
id: core.ci-on-pull-requests
title: CI runs on every pull request
severity: high
enforcement: check
audit-area: 7
---

**Requires:** a GitHub Actions workflow that runs on `pull_request`, and no workflow file GitHub
can't parse.

**Why:** a check that runs only on a laptop, or only after merge, can't stop a defect from merging.
What CI must run is each pack's job (`node.ci-runs-gate` for Node); this standard is that CI exists
at all.

**Meeting it:** add a workflow with `on: pull_request` that runs the repository's gate. On a plan
that allows it, make its jobs required checks (the ruleset skeleton,
`templates/project/.github/rulesets/main.json`).

**The check:** reads `.github/workflows/*.yml` and `*.yaml`. A workflow that fails to parse, or has no
jobs, fails this standard: GitHub doesn't run it either. Trigger filters (`branches`, `paths`) aren't
read. `skipped` when the repository has no Actions workflows
but another CI system's config, which this check doesn't read.
