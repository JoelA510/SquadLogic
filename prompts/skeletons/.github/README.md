# Activate optional agent checks

Use this guide from the staged `prompts/skeletons/.github/` directory. Choose each workflow
independently and review any existing target-owned files at the proposed live paths. Keep the
guide and unused workflows in staging. Each optional workflow sets up Node 24 for its own
runner. A Go, Python or other application can use one without a package.json, npm install or
.nvmrc. SkillEvaluator also uses Docker on the GitHub-hosted Linux runner.

| Workflow to copy into `.github/workflows/` | Helper to copy from `prompts/skeletons/scripts/ci/` into `scripts/ci/` | Inputs to verify |
| --- | --- | --- |
| `continuity.yml` | The delivered `continuity/gate.mjs` already runs at its live path. | A reviewed genesis and a held receipt committed to the protected base. |
| `agentshield.yml` | `agent-config-canary.mjs` | At least one tracked, nonempty `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/settings.json`, `.codex/config.toml` or `.mcp.json`. |
| `skill-eval-ci.yml` | `skill-tier1.mjs` | One real skill directory per child of the scanned root, each with a regular `SKILL.md`. Review the staged scan argument against the target's authoring directory. |

1. Determine the default branch from the repository's settings. Fill `[DEFAULT BRANCH]` in
   the workflow branch filters and the ruleset name. Keep quotes around the YAML branch
   value. Double any apostrophe in a single-quoted YAML value. For branches containing
   Actions pattern characters, escape those characters in the branch filter as GitHub
   requires. The scheduled continuity job reads the default branch directly from the event.
2. For continuity, first land the reader and this repository's first decision under existing
   CI. Stage the decision's evidence, run `node continuity/gate.mjs append`, and pass the
   printed ID to `node continuity/gate.mjs revalidate` after performing the check. The
   options and receipt format are in `continuity/README.md`. Commit the emitted records
   with the reader. Confirm `node continuity/gate.mjs verify --tree HEAD` and
   `node continuity/gate.mjs is-current "$id" --tree HEAD` succeed. Install the workflow in
   a subsequent change so its check can use the protected base's reader and ledger.
3. For AgentShield, review the tracked scan inputs. A root `CLAUDE.md` can own its content
   or import a tracked `AGENTS.md`. The scan copy expands a standalone `@AGENTS.md` or
   `@./AGENTS.md` line. A present npm lockfile goes through the established scan-copy
   handling. A v1 npm lockfile is scanned unchanged. Review the separate, offline
   package-indicator verdict in the run alongside the configuration check.
4. For SkillEvaluator, verify the committed source skill root before copying the workflow.
   A target with only the Claude skill home uses `.claude/skills`. A target with both
   homes uses the canonical `.agents/skills`. If the target has a different authoring
   directory, set the workflow's scan argument to that directory. The scan fails when no
   skills were evaluated. The job publishes a structural summary and keeps raw findings
   inside the runner.
5. Open a rehearsal PR using the target's existing branch protection. Confirm the clean
   jobs pass and the controls identify their planted findings. For continuity, rehearse a
   changed record and a self-consistent rewrite against the protected base in disposable
   fixtures. Verify the actual job names with `gh pr checks` or the Checks tab. Keep the
   gate in STALE-warning mode during rollout.
6. In the staged `rulesets/main.json`, move only the entries for qualified workflows from
   the optional group object into `rules[].parameters.required_status_checks` of the
   `required_status_checks` rule. Preserve their exact context names and integration ID
   15368. Delete the optional group object and all guidance keys. Retain `End-to-end`
   only when the corresponding job is enabled. Fill the audit context from the target's
   actual audit workflow. Merge the changes with any target-owned rules and import the
   reviewed ruleset through repository settings. A committed JSON file alone cannot
   enforce a check. When retiring a gate, remove its live required context before removing
   the workflow that reports it.
