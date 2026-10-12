# Prompt run log

One row per run of a project prompt (`new-project.md`, `existing-project.md`), newest last. The
day-to-day prompts (`discovery.md`, `investigate.md`, `review.md`, `pre-pr.md`) aren't logged
here; the PR, issue, or discovery pass they lead to is their record. The point is
recoverability: six months after a stack was chosen or an audit was executed, this is the
fastest path back to what was actually asked, what came out of it, and which references were
current at the time.

Add a row when a run starts, and fill in the outcome columns when it finishes. If a run was
abandoned, say so and why — an abandoned run is often more informative than a clean one.

| Date | Prompt | Target | Inputs (summary) | Outputs | References verified? | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| _yyyy-mm-dd_ | new / existing | repo or app name | one line: what was asked for, key constraints | files or milestones produced | yes (date) / skipped — offline / partial | what changed in the prompt as a result, open items |
| 2026-10-12 | existing, plan-only (`/complete`, Phases 0-2) | SquadLogic | Inputs derived from README, CLAUDE.md and docs; visibility public (GitHub API), plan unreadable so Free assumed; constraints: plan-only, no change to source/config/deps/migrations/CI, no production or shared environment; template `00de8ae` (1.0.0-rc.3) | The delivery (`a63a9f8`, packs node, vite-spa, supabase) committed unmodified, the Claude Code skills force-added because `.claude/` is ignored; `docs/audits/2026-10-production-readiness/`: reference verification, the audit (baseline first, 13 areas, 43 findings: 1 blocker, 11 high, 25 medium, 6 low; the blocker a core flow, #364), the remediation plan (8 owner decisions with defaults; milestones 1, 2, 3, 4a, 4b, 5, 6; every finding placed once; Milestone 1 in three PRs); `docs/template-trial.md`. Milestone 1 not executed (plan-only) | Yes (2026-10-12), through git only: the GitHub API refused the reference repositories; none fits a Vite + Supabase SPA, so official docs and the repo's rules were the yardsticks | 10 template findings (F1-F10) in `docs/template-trial.md`, reported to the template, delivered copies left unedited. F1 (the delivery says merge rules into CLAUDE.md; `core.agent-rules` fails that) and F2 (`vite-spa.bundle-budget` fails a working budget gate) are of a never-acceptable kind (b). Scorecard: 27 of 29 verdicts match. Open: the owner's decisions D1-D8 and approval of Milestone 1. |

## Longer write-ups

When a run produces reasoning that won't fit in a row — a rejected stack, a migration that was
considered and declined, an audit finding that reshaped the plan — write it up as an ADR in this
repo's decision records (`docs/adr/` in the layout the skeletons use, or wherever the repo
already keeps them) and link the ADR from the row. Keep this table scannable.
