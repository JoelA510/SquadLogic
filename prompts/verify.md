# Prompt: Verify a Change Before Committing

You are about to commit. Run the repo's fast checks against the change and say
what they found, so no commit carries a failure a minute of checking would have
shown. This is the per-commit subset; prompts/pre-pr.md is the full gate before
a pull request.

## Inputs (fill in before running)

- The change: [THE STAGED AND UNSTAGED DIFF, OR WHAT TO VERIFY INSTEAD]

## Steps

1. **Find the fast checks.** Use what the agent instructions (AGENTS.md or
   CLAUDE.md) or CONTRIBUTING.md name for this: a before-each-commit list if
   there is one, else their lint, typecheck, and test commands. If they name
   none, take the quick steps CI runs on pull requests (format, lint,
   typecheck, unit tests), and say that's where they came from.
2. **Scope them to the change.** Lint and typecheck cover the whole project
   when they're quick; tests cover what the change touches and the tests it
   adds. A change only to docs runs what checks docs (a link or markdown
   check, an instruction lint); a change only to tests runs those tests. Name
   whatever is left out, and why.
3. **Rebuild generated files.** If the change touches the source of a
   generated file, run its build and stage the regenerated output, so it goes
   into the same commit. A hand-edit to a generated file is undone, not
   committed.
4. **Run them on the tree being committed.** A failure in the change's own
   code is fixed and the check run again. A failure elsewhere is reproduced on
   the last commit, in a separate worktree (`git worktree add <dir> HEAD`,
   with the repo's dependencies installed there first, and removed
   afterwards), before it's called pre-existing, then reported, not fixed
   here. Don't stash to get there: a plain stash leaves untracked files in
   place, and popping it puts staged changes back as unstaged.
5. **Don't weaken a check to commit.** No skipped test, disabled rule, or
   `--no-verify`. If a check is wrong, say so, and fix it in its own change.

## Output of this prompt

1. Each check: the command, pass or fail, and its counts where it prints them.
2. What was left out, and why.
3. Status: clear to commit / clear, with failures that predate the change
   (each reproduced on the last commit) / not clear (what the change breaks).
