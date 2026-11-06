@AGENTS.md

## Claude Code

Everything above is shared with every other agent (`AGENTS.md`); this section is Claude Code's
own. The numbered sections that older docs and comments cite as "CLAUDE.md §N" are AGENTS.md's.

- **Review:** the adversarial review AGENTS.md §3 asks for (every PR but documentation and very
  minor ones) is one `/code-review` in Claude Code, after Codex's findings are addressed; fix its
  findings in that same PR.
- **Skills:** the workflow skills in `.claude/skills/` (Claude Code's copies of `.agents/skills/`;
  AGENTS.md §3 says where they come from and how a gap in one is fixed): `/discovery`,
  `/plan-change`, `/root-cause`, `/review-change`, `/pre-pr`, `/verify` (Claude Code runs it
  before each commit) and `/template-update`, plus this repo's own `/squadlogic-evaluator-designer`,
  `/squadlogic-feature-guardians` and `/squadlogic-audit-trail-inspector`.
