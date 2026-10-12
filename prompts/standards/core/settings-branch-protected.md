---
id: core.settings-branch-protected
title: Merging to the default branch requires CI to pass
severity: high
enforcement: settings
audit-area: 7
---

**Requires:** an active ruleset, or classic branch protection, on the default branch that requires
the CI job's status check.

**Why:** "merge only when CI is green" is the rule every other gate depends on. Without the setting
it holds only as long as everyone remembers it, including the agent that merges at the end of a
long session.

**Meeting it:** import the ruleset the template ships (`.github/rulesets/main.json`, its required
checks named after the CI jobs) in Settings -> Rules -> Rulesets.

**The check:** `GET /repos/{owner}/{repo}/rules/branches/{default branch}` for an active
`required_status_checks` rule, then classic protection. On a private repository under GitHub Free,
rules are stored but not enforced, and the API says so by refusing classic protection with
"Upgrade to GitHub Pro"; that's `n/a`, and the rule is kept as an operating rule instead, as the
prompts say.
