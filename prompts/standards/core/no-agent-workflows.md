---
id: core.no-agent-workflows
title: No Antigravity workflows left to retire
severity: high
enforcement: check
audit-area: 12
---

**Requires:** no files under `.agent/workflows/` or `.agents/workflows/`.

**Why:** Antigravity's workflows stop working on 2026-10-19, replaced by Agent Skills, which every
other agent reads too (Antigravity's "Migrating workflows to skills" guide, read 2026-10-07). After
that date a workflow there is an instruction nothing runs.

**Meeting it:** Antigravity's `/migrate-workflows` command converts them to skill directories.
Move the result to `.agents/skills/<name>/SKILL.md`, check it with the template's instruction lint
(`core.instructions-resolve`), and delete the old directory.

**The check:** lists the files in those two directories.
