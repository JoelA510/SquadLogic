---
id: supabase.function-tests-in-ci
title: Edge Function tests run in CI
severity: medium
enforcement: check
audit-area: 6
---

**Requires:** when `supabase/functions/` has test files (`*.test.ts`, `*_test.ts`, and their
JavaScript forms), a `pull_request` workflow runs `deno test`.

**Why:** Edge Functions run on Deno, not Node, so the project's Node test runner never sees these
files. A Deno suite with no Deno step in CI is the usual case.

**Meeting it:** a CI step with `denoland/setup-deno` and `deno test` over `supabase/functions/`.

**The check:** lists the test files, then looks for `deno test` in the commands `pull_request`
workflows run, traced through scripts. `n/a` when there are no function tests.
