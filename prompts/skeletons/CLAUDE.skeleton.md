@AGENTS.md

<!-- GUIDANCE: Claude Code reads CLAUDE.md and, when one exists, ignores AGENTS.md unless it's
     imported. The import on the first line is what makes Claude read the shared rules, on every
     Claude Code version and setting. Keep the rules in AGENTS.md; put only Claude-Code-specific
     notes below. If there are none, delete this comment and the section and keep the import.
     Don't replace this file with a symlink to AGENTS.md: Windows checkouts without
     core.symlinks get a one-line text file instead. -->

## Claude Code

- The workflow skills in `.claude/skills/` (Claude Code's copies of `.agents/skills/`; the
  Workflows section of AGENTS.md says where they come from and how a gap in one is fixed):
  `/discovery` before the next piece of work, `/plan-change` for a large change, `/root-cause`
  for a defect, `/review-change` for a review, `/pre-pr` before a pull request, `/verify`, which
  Claude Code runs before each commit, and `/template-update` to take a template release.
- [CLAUDE-CODE-SPECIFIC NOTE — e.g. use plan mode for changes under a billing module]
