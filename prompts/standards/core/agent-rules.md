---
id: core.agent-rules
title: Agent rules live in one AGENTS.md at the root
severity: high
enforcement: check
audit-area: 12
---

**Requires:** an `AGENTS.md` at the repository root holding the rules every coding agent follows.

**Why:** Codex, Antigravity, Cursor, and Copilot read `AGENTS.md` directly, Claude Code reads it
(natively, or through an `@AGENTS.md` import in `CLAUDE.md`), and Gemini CLI reads it when
`.gemini/settings.json` names it. Rules kept only in one tool's format (`.cursor/rules`,
`.agent/rules`, a lone `CLAUDE.md`) reach one agent and silently skip the rest.

**Meeting it:** copy the AGENTS skeleton (`templates/project/AGENTS.skeleton.md` in the template,
`prompts/skeletons/AGENTS.skeleton.md` after `process:apply`), and merge any tool-specific rules
into it.

**The check:** whether `AGENTS.md` exists at the root, and which tool-specific rule locations exist
beside it. Whether the files resolve is `core.instructions-resolve`; whether `CLAUDE.md` hides
`AGENTS.md` from Claude Code is reported there too. Rules kept in ordinary docs (a handoff file,
prompt packets) aren't looked for: no agent reads them by default, so the audit finds them by
reading (existing-project §12).
