# Test Timeouts

Vitest's default `testTimeout` is 5 s, and it stays the default for the suite.
Corpus tests (a whole-season re-solve, a sweep over every team or surface) can
sit close to that line on a developer machine and cross it under full-suite CI
load, in files the failing PR never touched. That is not a flake: the test has
outgrown the default. The fix is a timeout sized from measurement, never a
retry, a skip or a weaker assertion.

## When to set an explicit timeout

Set one when a test takes **over 1.5 s alone or over 3 s in a full run**.

- Size it at about **4x the worst duration measured**, across a run of the file
  alone and at least one full run. Round it up, with a **15 s floor**.
- Put it on the test (`it('…', () => { … }, 15_000);`), with a one-line comment
  giving the measured durations, so the next reader can tell whether it has
  drifted.
- A file-level `vi.setConfig({ testTimeout })` is for a file whose tests are
  nearly all corpus derivations (`scenarioBranching` uses 30 s). A test in such
  a file that needs more than the file's figure still gets its own timeout.
- Do not raise the global `testTimeout` in `vitest.config.js`. A real hang
  should still fail quickly everywhere else.
- If the test can be made cheaper without changing what it asserts (a shared
  module-level corpus, one computed result reused across assertions), do that
  first and measure again.

## How to measure

```bash
# Full load: every file, default parallelism.
npx vitest run --includeTaskLocation --reporter=json --outputFile=<scratch>/full.json

# Alone: the heavy files one at a time.
npx vitest run --no-file-parallelism --includeTaskLocation --reporter=json \
  --outputFile=<scratch>/alone.json tests/<file>.test.js …
```

Each entry of `testResults[].assertionResults[]` has `duration` (ms),
`fullName` and, with `--includeTaskLocation`, `location.line`. List every test
over the thresholds above, with both figures, and cite them in the comment.

Take more than one full run. In the first sizing (September 2026, 4,404 tests,
4 cores) the same suite took 380 s in one full run and 560 s in another, and the
slow run pushed three tests past 5 s that were under 4 s in the quiet ones.
Sizing from the quiet run alone would have left them at under 3x. That sizing
set 16 tests; the PR that set them holds the table.
