---
id: node.ci-runs-gate
title: CI runs lint, typecheck, tests, and the build on every pull request
severity: high
enforcement: check
audit-area: 7
---

**Requires:** on every pull request, CI runs a linter, a type checker (when the project uses
TypeScript or a `tsconfig.json`), a test runner, and the project's `build` script if it has one, in
steps that can fail the run.

**Why:** these are the four gates the definition of done assumes. One that runs only locally, or in
a step marked `continue-on-error`, guards nothing.

**Meeting it:** one aggregate script (`npm run check`) that runs them all, called from a
`pull_request` workflow, is the simplest shape, and it keeps local and CI runs identical.

**The check:** collects every command that `pull_request` workflows run (and local reusable
workflows they call, one level deep), follows `npm`, `yarn`, `pnpm`, `bun`, and `npm-run-all`
script calls through `package.json` (with `pre` and `post` scripts), and looks for the tools
themselves: `eslint`, `oxlint`, `biome`, `next lint`, `xo`, or `standard` for lint; `tsc`,
`vue-tsc`, `svelte-check`, or `astro check` for types; `vitest`, `jest`, `mocha`, `ava`,
`playwright test`, `cypress run`, or `node --test` for tests. Matching the tools, not script names,
is deliberate: a `lint` script that only runs `tsc` doesn't lint. A tool counts wherever it's the
program, behind any wrapper (`cross-env NODE_ENV=test jest`, `pnpm --filter web exec tsc`,
`timeout 20m npm test`), but not after a package manager's install or lookup verb
(`npm install eslint`, `npm ls eslint`), a lookup (`command -v eslint`, `echo`), an option that
takes a value (`npx -p eslint prettier`), or as an argument to a file or text tool
(`grep -q vitest package.json`, `git commit -m "fix eslint"`).

A command that can't fail the run doesn't count, read the way bash runs it (quotes, comments, and
heredocs respected):
- in a step or job marked `continue-on-error` or `if: false`;
- one whose failure goes to `|| true`, `|| echo`, or `|| :` (`|| exit 1` keeps it);
- one piped into another command without `pipefail`: GitHub's default `bash -e` has none, while
  `shell: bash` and a `set -o pipefail` line add it;
- one that isn't the last of its `&&` list on a line before the last: `bash -e` carries on after
  `npm run lint && npm run typecheck` fails at the lint;
- one before the last command of a package script, which npm runs with `sh -c`, or of a step in a
  shell without errexit (a Windows runner's default PowerShell, or from a `set +e` line on).

A shell script's commands count as if it ran with `set -e` throughout, since one may check each
status itself (`if ! deno test; then exit 1; fi`, or `set +e` and collect them); a command in an
`if` condition, or in the background before a `wait`, counts for the same reason. The check can't see turbo or nx task graphs, or composite actions.
