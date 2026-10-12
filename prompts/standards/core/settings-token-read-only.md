---
id: core.settings-token-read-only
title: Workflows get a read-only token by default, and can't approve pull requests
severity: high
enforcement: settings
audit-area: 8
---

**Requires:** the repository's default `GITHUB_TOKEN` permission is read-only, and "Allow GitHub
Actions to create and approve pull requests" is off.

**Why:** every workflow, including one a dependency update or a pull request edits, runs with the
default token. A write token lets a compromised step push to branches, tag releases, or change
issues; a token that can approve pull requests lets a workflow satisfy its own review rule. Each
workflow can still ask for the write permissions it needs in its `permissions:` block.

**Meeting it:** Settings -> Actions -> General -> Workflow permissions: "Read repository contents
and packages permissions", and leave the approval box unchecked. New personal repositories start
this way.

**The check:** `GET /repos/{owner}/{repo}/actions/permissions/workflow`, which needs admin read;
`skipped` without it.
