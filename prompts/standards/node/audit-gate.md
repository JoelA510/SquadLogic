---
id: node.audit-gate
title: A dependency audit blocks pull requests and runs on a schedule
severity: high
enforcement: check
audit-area: 8
---

**Requires:** a dependency audit runs in a `pull_request` workflow in a step that can fail it, and in
a workflow with a `schedule` trigger.

**Why:** advisories are published against code that has already merged, so a repository with no
open pull requests never hears about them without the schedule. An audit step with
`continue-on-error` reports and blocks nothing.

**Meeting it:** the template's gate (`scripts/check-audit.mjs`, its `audit.yml` workflow, and the
dependency-policy skeleton) blocks on high and critical advisories and honors only reasoned,
expiring waivers.

**The check:** looks for `npm audit`, `yarn audit`, `pnpm audit`, `bun audit`, `audit-ci`,
`osv-scanner`, `better-npm-audit`, or the template's `check-audit` in the commands each kind of
workflow runs, traced through scripts as `node.ci-runs-gate` does, and counted only where it can
fail the run (`npm audit || true` can't). A report-only audit beside one that can fail is fine. It
can't tell which severities block; read the step.
