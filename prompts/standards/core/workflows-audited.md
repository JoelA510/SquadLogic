---
id: core.workflows-audited
title: CI audits its own workflows
severity: medium
enforcement: check
audit-area: 8
---

**Requires:** a `pull_request` workflow runs zizmor over the repository's workflows, where a finding
can fail the run.

**Why:** a workflow runs with the repository's token and secrets. An action pinned by tag runs
whatever its owner, or whoever took over their account, moves the tag to; a checkout that keeps
the token in `.git/config` hands it to every later step and artifact; an expression interpolated
into a `run:` script lets a branch name or an issue title run as shell. zizmor finds all three, and
none of them shows up in a code review of the change that introduced it.

**Meeting it:** `pipx run --spec 'zizmor==<version>' zizmor --format=github .` with
`GH_TOKEN: ${{ github.token }}` (its online audits then confirm each pinned SHA is a real commit of
its action), in the job that runs on pull requests. Pin actions by full commit SHA with the version
in a comment, set `persist-credentials: false` on checkouts, and fix or ignore each other finding
inline with its reason. The template's own CI is an example, and its ADR 0017 the reasoning.

**The check:** `n/a` with no workflows. Looks for `zizmor` in what `pull_request` workflows run,
traced through scripts, counted only where it can fail the run (not with `--no-exit-codes` or
`--format=sarif`, which suppress its finding exit codes), or `zizmorcore/zizmor-action` with
`advanced-security: false` (with code-scanning upload on, the default, the action doesn't fail on
findings).
