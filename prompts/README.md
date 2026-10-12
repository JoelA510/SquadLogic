# Prompts

The prompts in this folder are the process half of this repo. They're written to be handed to a
capable coding agent (Claude Code, Codex, Antigravity, Cursor, Copilot, or Gemini CLI) verbatim,
with the input placeholders filled in, or run through the skill that wires each one up.
Two take a project to a production-grade state, from opposite starting points:

| Prompt | Use when | What it produces |
| --- | --- | --- |
| [`new-project.md`](./new-project.md) | The repo is empty or nearly so. | A verified reference table, one justified stack proposal, the guardrail files (agent rules, contributing, first ADR, tooling/CI, typed env), and a phased plan whose milestone 1 ends in a deployable walking skeleton. |
| [`existing-project.md`](./existing-project.md) | Code exists and needs to reach production-grade. | A dated audit (`docs/audits/YYYY-MM-<slug>/audit.md`): a baseline run of every gate, then thirteen areas scored, the last whether each promised flow works end to end, with file-path evidence and severity, re-verified with refuted findings recorded; a remediation plan beside it that accounts for every finding; and executed milestone 1. Gap analysis, not a rewrite. |

Seven more cover the work that comes after, the day-to-day changes where most defects actually
enter:

| Prompt | Skill | Use when |
| --- | --- | --- |
| [`discovery.md`](./discovery.md) | `discovery` | Before the next piece of work. Stage 0 surveys the project for the open questions worth a discovery pass and stops at a grouped list of candidates; Stage 1 is the template for one pass, drafted for the candidate you pick and run in a fresh session. |
| [`plan-change.md`](./plan-change.md) | `plan-change` | A change is large enough to agree on before it's built: sizes it (a small one gets no plan), then writes a plan against `docs/product.md`, AGENTS.md, and the ADRs, with the behavior that must stay unchanged and tasks that each name their test. |
| [`investigate.md`](./investigate.md) | `root-cause` | Something is broken and the cause isn't known. Reproduce the reported case, confirm a baseline, test hypotheses one at a time, fix the root cause, find the siblings. |
| [`review.md`](./review.md) | `review-change` | A change needs a critical second look: an adversarial, evidence-cited review, including the failures that pass their own tests. (Not `review`, which is a Claude Code built-in.) |
| [`pre-pr.md`](./pre-pr.md) | `pre-pr` | A change is about to leave your hands: merge the base, run the full gate, prove new checks can fail, self-review, sweep the docs, draft the description. |
| [`template-update.md`](./template-update.md) | `template-update` | The repo should take a release of the template it was built from, or a fleet update's pull request needs finishing: read the CHANGELOG to the release, bring the files across, merge each parked `.template`, and do what the release asks. |
| [`verify.md`](./verify.md) | `verify` | A change is about to be committed: the repo's fast checks, scoped to the change, with generated files rebuilt. Claude Code runs a project skill named `verify` before each commit on its own. |

The two project prompts share the same spine, and it's worth understanding rather than skimming:

- **Verification before citation.** Every architectural reference gets checked for staleness
  before anything is borrowed from it, and the result is written down with a date. Patterns
  borrowed from something unverified are marked provisional.
- **Honest reporting.** Every finding is labeled *statically reviewed*, *executed*, or *fully
  validated*. Nothing claims a test passed unless it was run.
- **Minimal diffs.** Existing conventions beat generic best practice. A refactor beyond the
  immediate request gets flagged before it happens, not discovered in review.
- **A definition of done that includes the unglamorous parts** — validation at trust
  boundaries, surfaced failures, checks shown failing before they're trusted, server-side
  authz, careful data handling, observability from milestone 1, accessibility, and current
  docs. It's reproduced in the CONTRIBUTING skeleton, so once a
  project adopts it, it's in front of whoever is opening the pull request.

## How to run one

1. Copy the prompt's text.
2. Fill in the inputs block at the top (**Project inputs** in the project prompts, **Inputs** in
   the day-to-day ones; discovery's inputs are its `{{PLACEHOLDERS}}` instead). Vague inputs
   produce vague plans; the `[COMPLETE_MEANS]` field in the existing-project prompt is the
   highest-leverage one, because everything downstream is ordered against it.
3. Hand it to the agent in a session that has repo access, and let it work through the phases
   or steps in order. In the project prompts, the verification phase is not optional and not a
   formality — it's what keeps the architectural references from silently aging into bad
   advice.
4. For a project prompt, record the run in [`run-log.md`](./run-log.md). The day-to-day prompts
   aren't logged there; the PR, issue, or discovery pass they lead to is their record.

Steps 1–3 are wired up as Agent Skills in `.agents/skills/`, which travel with the repo:
`bootstrap` runs the new-project prompt, `complete` the existing-project one, and `discovery`,
`plan-change`, `root-cause`, `review-change`, `pre-pr`, `verify`, and `template-update` the
day-to-day ones, each taking its inputs
with the request.
Codex, Antigravity, Gemini CLI, Cursor, and Copilot read skills from `.agents/skills/`; Claude
Code reads the copies in `.claude/skills/`. Invoke one as `/complete` in Claude Code or
Antigravity, `$complete` in Codex, or ask for it by name in any other agent.

## Artifact skeletons

Every file the prompts require — AGENTS.md and the CLAUDE.md that imports it, CONTRIBUTING.md,
the verification table, the stack ADR, dev plan, audit, remediation plan, `.env.example`, the
typed-env pattern, the dependency policy, the release runbook, a postmortem — has a ready shape
in the **skeletons directory**, placeholder-marked and commented:

- `prompts/skeletons/` in a repo that received the process through `process:apply`;
- `templates/project/` in the template repo itself.

Skeletons are staged, not live: a prompt run copies each one it needs to its real path and fills
it in. Using them keeps artifacts comparable across runs and makes "finished" checkable.

## Applying this to a project that isn't a fork

The interface half of the template is fork-and-rebrand, but the process half travels anywhere.
From a checkout of the template repo:

```bash
npm run process:apply -- --target ../my-app
```

This delivers the prompts (with this README and a fresh run log) into `<target>/prompts/`, the
skeletons into `<target>/prompts/skeletons/`, the standards the target is held to into
`<target>/prompts/standards/`, and the skills into `<target>/.agents/skills/` and
`<target>/.claude/skills/`, plus `prompts/.apply-manifest.json` recording what was delivered
and from which template commit. Nothing but the skills lands at a live path, so nothing in the
target is overwritten or shadowed. `--list` previews without writing.

The `core` standards always come along. `--pack <name>` (`node`, `supabase`, and the rest of the
catalog's packs) adds a stack's standards, and the manifest remembers it for later runs;
`--drop-pack <name>` stops delivering one. `--check` writes nothing and exits 1 when the target
has drifted: a re-apply would change a file, or a parked `.template` or a conflict marker is
still there. A CI job in the target, or a fleet report, can ask it.

`process:apply` and `scripts/check-placeholders.mjs` need no install. `check:instructions` and
`check:env` need the template's dependencies (`yaml` and `typescript`); for process-only use,
`npm ci --ignore-scripts` in the template checkout installs them without running its lifecycle
scripts, which would otherwise set up the template's own git hooks in that checkout.

Then, in the target:

- **Keep formatters off the delivered files** (`prompts/`, `.agents/skills/`,
  `.claude/skills/`), for example in `.prettierignore`, before the first commit: a pre-commit
  formatter would otherwise rewrite them as they're committed. A reformat makes every one of
  them look edited, and a re-apply then parks the template's updates beside them instead of
  applying them.
- **Then commit the delivery, unmodified, manifest included**, before any prompt run: the
  run's own diff stays reviewable, and the manifest travels with the repo so a later re-apply
  can tell your edits from old deliveries.

Re-running later is how the target picks up template improvements, and it's safe: a file the
template hasn't changed is left alone however much the target edited it; a file the target
never touched is updated in place; only a file *both* sides changed gets an update parked
alongside as `<name>.template` (don't commit those). Where the version last delivered is still
in the template checkout's history, that `.template` is a merge proposal: your edits and the
template's combined, with any conflict marked, to read and then move over the file. Otherwise
it's the new version, for hand-merging. Files the target deleted stay deleted, and the target's
run log is never touched. From there the target is
self-sufficient: run the prompts against local files, log runs locally, and let its artifacts
evolve with it.

## Keeping the prompts current

Treat these files as source, not as a historical artifact. A run that surfaces a gap (a
question the prompt should have asked, an audit area it should have covered, a failure mode it
didn't anticipate) is how they improve. Note the gap in the run log entry that found it. A
prompt that never changes is a prompt nobody is reading closely.

- **In the template repo,** edit the prompt in the same change, and say so in that row.
- **In a repo that received the prompts through `process:apply`,** report the gap to the
  template instead (an issue or a pull request where it's maintained) and leave your copy
  unedited. A re-apply only updates files you haven't edited, so the fix reaches you with the
  next template release. If you can't wait, edit the copy, knowing that from then on a re-apply
  that brings a template change to that file parks it beside your copy as `<name>.template` (a
  merge proposal, where the version last delivered is still in the template's history) for you to
  merge, once per change.

The reference lists inside the prompts are the one place in this repo where naming outside
projects is expected and useful: they're yardsticks to measure against, deliberately paired
with instructions to verify each one before trusting it. Everywhere else, describe the pattern
rather than pointing at someone else's repo — patterns keep, links rot.

## Keeping a lesson

A run that taught something keeps it, once, in the narrowest place that will hold it. Keep a
lesson only when it's non-obvious (the next person wouldn't find it in a minute), durable (it
outlives this change), and material (missing it costs a defect or an hour). Its home, in order of
preference:

1. **A check:** a test, lint rule, or CI gate that fails the next time. A check enforces itself;
   everything below relies on being read.
2. **A comment** at the code it's about, when the lesson is about that code.
3. **The lessons-learned file** (skeleton: `docs/lessons-learned.md`, or the file the repo already
   keeps), for what neither holds: a process trap, a vendor's behavior, a dead end not to retry.

A lesson whose check would hold in other repositories goes upstream as well: propose it to the
template as a standard (an issue where the template is maintained, naming the check, what it
caught, and where it runs). There, the harvest prompt turns a proven check into a standard every
repository is scored against. The two project prompts, investigate, review, and pre-PR ask for
the lesson in their output.
