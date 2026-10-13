---
id: core.instructions-resolve
title: Agent instruction files point only at things that exist
severity: medium
enforcement: check
audit-area: 12
---

**Requires:** every link, `@` import, code-span path, and `npm run` script named in the repository's
agent instruction files and skills resolves; no hidden characters; no `CLAUDE.md` that hides
`AGENTS.md`; skills that meet the Agent Skills specification; no `AGENTS.md` or `GEMINI.md` over
24,000 bytes.

**Why:** an instruction that names a path or script that no longer exists still reads fine, so an
agent follows it into a dead end, or invents what was meant.

**Meeting it:** fix what the check names. It's the template's instruction lint, so its own header
(`scripts/check-instructions.mjs`) describes every finding.

**The check:** runs `scripts/check-instructions.mjs --root <repo>` and reports its findings. `n/a`
when the repository has no instruction files at all (that's `core.agent-rules`).
