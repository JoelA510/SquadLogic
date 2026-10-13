# Prompt: Before Opening (or Updating) a Pull Request

You are preparing a change to leave your hands. A red CI run, or a reviewer
finding what you could have found, costs more than the checks below. Work
through the steps in order.

## Inputs (fill in before running)

- The change and its intent, in one sentence: [CHANGE]
- Base branch: [BASE BRANCH]

## Steps

1. **Bring in the base.** Merge or rebase onto the latest base branch, following
   the repo's convention, and resolve conflicts before anything else. Tests run
   on a stale base prove nothing about the merge.
2. **Run the full gate** named in the agent instructions (AGENTS.md or
   CLAUDE.md) or CONTRIBUTING.md, the same command CI runs. If a check fails,
   fix it or say exactly why it isn't this change's. Reproduce it on the base
   branch before calling it pre-existing.
3. **Prove the new checks can fail.** For every test, validator, lint rule, or CI
   gate this change adds, show it failing against the defect it guards (a planted
   defect, or the fix reverted).
4. **Review your own diff adversarially**, using prompts/review.md as the
   checklist. Ask what would make CI or a reviewer reject this, and fix what you
   find.
5. **Sweep the docs against the diff:** the command tables in README and the
   agent instructions (AGENTS.md, CLAUDE.md), CONTRIBUTING, `.env.example`,
   the CHANGELOG, an ADR if a consequential decision was made, and any
   user-facing text that describes a check or rule this change touched.
6. **Commit, then run the committed-tree checks.** One logical change per commit
   where the history isn't squash-merged; no secrets, no generated or binary
   files the repo doesn't track, and no `.template` or scratch files. Then run
   the checks that compare against the last commit or need the network
   (generated files current, dependency audit).
7. **Re-run the gate on the final tree** if anything changed after step 2. The
   results you report are from the tree you're handing off, not an earlier one.
8. **Write the description:** what changed and why, how it was verified (with
   statically reviewed / executed / fully validated labels), how to roll it
   back, and what's still unknown.

## Output of this prompt

1. The gate results from the final tree, with commands and counts.
2. What the self-review found and changed.
3. The PR description, ready to paste.
4. Status: ready / ready with concerns (list them) / blocked (on what).
5. The lesson, if the change taught one, kept as prompts/README.md says
   ("Keeping a lesson"), or "none".
