[← Back to Documentation Index](../README.md)
---

# Bundle Budget — How To

> CI gate that prevents accidental bundle bloat.
> Source of truth: [`config/bundle-budget.json`](../../config/bundle-budget.json).
> Enforcer: [`scripts/check-bundle-size.js`](../../scripts/check-bundle-size.js).

## What runs when

| Trigger | Command | Effect |
| --- | --- | --- |
| Local pre-push smoke | `npm run check:bundle` | Runs after `npm run frontend:build`. Fails if any chunk exceeds the budget, a rule matches no file, or a first-paint file is unbudgeted. |
| CI full matrix | `npm run check:bundle` after `npm run frontend:build` | Same as local; PR cannot merge if budget is busted. Docs-only PRs intentionally skip the full matrix; see [`ci-cd.md`](./ci-cd.md). |

## Budget file shape

```json
{
  "rules": [
    {
      "match": "<regex against `assets/<path>`>",
      "label": "<human-readable name>",
      "firstPaint": true,               // optional; see below
      "maxGzipBytes": <number>,         // OR maxRawBytes
      "rationale": "<why this number>"
    }
  ],
  "totalFirstPaintGzipBytes": <number>,
  "totalFirstPaintRationale": "..."
}
```

Each `rules[]` entry must have either `maxGzipBytes` (preferred for JS/CSS) or
`maxRawBytes` (preferred for binary assets — gzip on already-compressed PNG is
noise).

A rule with neither cap, or with both, fails the gate (`[CONFIG]`) rather than
passing every file unchecked. So does a missing, misspelt, non-number or
non-positive `totalFirstPaintGzipBytes`, and a `rules` that is not a non-empty
array. A check with no cap is reported, never skipped.

**Every rule must match at least one built file.** A rule that matches none
fails the gate with `[NO MATCH] rule "<label>"`: a renamed chunk would
otherwise escape its budget while the gate stayed green. There is no per-rule
opt-out, because no current rule needs one. If a rule's chunk is deliberately
gone, delete the rule.

**First paint is read from `dist/index.html`, not from the rules.** The gate
parses the entry `<script type="module" src>`, every
`<link rel="modulepreload">` and every `<link rel="stylesheet">`, and:

- `totalFirstPaintGzipBytes` is the gzip sum of exactly those files. A chunk
  Vite starts preloading is counted whether or not a rule names it.
- Every one of those files must be matched by a rule with `"firstPaint": true`,
  or the gate fails with `[UNBUDGETED FIRST-PAINT]`. Today those rules are
  `main entry`, `main css`, `react vendor`, `lucide vendor` and
  `supabase vendor`.
- A `firstPaint` rule only matches files `index.html` loads. This is how
  `main entry` is told apart from the ~1 KB lazy shared chunk Rollup also names
  `index-*.js`: both are `index-<hash>.js`, so no regex can separate them.
  The lazy one is printed as `SKIP main entry (...)` and is neither checked
  against the main-entry cap nor counted in the total.

**Lazy files that match no rule are listed as a warning, not a failure.** Route
and shared chunks are lazy by design and were never budgeted one by one. The
`WARN <n> lazy file(s) match no rule` block keeps them visible without
requiring a rule per page. Each named vendor chunk (`manualChunks` in
`vite.config.js`) has a rule, lazy or not; add one when you add a vendor
chunk.

Sizes in the `check:bundle` output and in the rationale fields are KiB
(1024 B); the caps in the config are bytes, so a `250000` cap prints as
`244.14 KB`.

## Main entry and the mock client

`frontend/src/lib/supabaseClient.js` loads `mockSupabaseClient.js` with a
dynamic `import()`, so the mock is never in the main entry. It is a lazy
`mockSupabaseClient-*.js` chunk, and a build made with both
`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (and without
`VITE_USE_MOCK_SUPABASE=true`) does not emit it at all.
`tests/mockNotInMainBundle.test.js` fails on a static import of the mock or a
top-level `await` in the switcher. A top-level `await` deadlocks the built app
in mock mode, because the mock chunk imports shared modules back from the main
entry chunk.

Measured on a build with no credentials (as CI builds), 2026-09-28:

| File | Before | After |
| --- | --- | --- |
| main entry | 137.16 KB (140,447 B) | 114.26 KB (116,999 B) |
| total first paint (5 files) | 231.21 KB (236,757 B) | 208.31 KB (213,309 B) |
| `mockSupabaseClient-*.js` (lazy) | in main entry | 22.69 KB (23,239 B), fetched only in mock mode |

The caps are unchanged. The main-entry cap now has ~23 KB of headroom and can
be tightened per the policy below.

## Updating the budget — the policy

1. **Loosening is the LAST option.** Default ordering of responses to a violation:
   - **Find the cause.** A new dependency? Inadvertent eager import? Missed `React.lazy()`?
   - **Lazy-load.** Move the heavy code behind a route or interaction.
   - **Replace.** Find a smaller alternative (lucide-react → minimum imports; Chart.js → uPlot).
   - **THEN bump the budget.** Only after the above options have been ruled out OR the bytes are genuinely worth it (e.g., an a11y library that closes WCAG gaps).

2. **Every bump is a PR with a rationale.** The rationale belongs in BOTH:
   - The `rationale` field on the rule in `config/bundle-budget.json`.
   - The PR description (so reviewers can challenge it).

3. **Tighten budgets opportunistically.** When you ship a code change that
   reduces a chunk size, take the win — tighten the budget by the savings minus
   ~10% headroom. This prevents the budget from drifting permanently slack.

## Failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| `cannot read dist at .../dist/assets` | Forgot `npm run frontend:build` | `npm run frontend:build && npm run check:bundle` |
| `[GZIP] main entry ... exceeds budget` | Bundle grew | Diagnose with `npm run frontend:build -- --debug` + Vite's chunk analysis. |
| `total first-paint exceeds budget` but per-chunk OK | Multiple small growths summed | Tighten one of the large vendors first; first-paint cap is the global gate. |
| `[NO MATCH] rule "..."` | Rule's regex matches no built file (for a `firstPaint` rule: no file `index.html` loads). Fails the gate. | Fix the regex (a chunk was renamed) or remove the rule (the chunk was deleted). |
| `[UNBUDGETED FIRST-PAINT] assets/...` | `index.html` now loads a file no `firstPaint` rule matches (new `manualChunks` entry, renamed vendor). Fails the gate. | Add or fix a `firstPaint` rule; see "Adding a new rule". |
| `[CONFIG] ...` | A rule without exactly one cap, a missing or non-number `totalFirstPaintGzipBytes`, or no `rules` array. Fails the gate. | Fix `config/bundle-budget.json`. |
| `[FIRST-PAINT] index.html ...` | `dist/index.html` has no module entry, or references a file missing from `dist/assets`. Fails the gate. | Rebuild; if it persists, the build is broken. |
| `WARN <n> lazy file(s) match no rule` | Informational. Lazy chunks are not budgeted one by one. | None required; add a rule if a lazy chunk deserves its own cap. |

## Adding a new rule

If you ship a new vendor chunk (e.g., a new `analytics-vendor`):

1. Run `npm run frontend:build` and note the new chunk's gzip size.
2. Add a rule to `config/bundle-budget.json` with `maxGzipBytes` set to
   `actual_size * 1.20` (20% headroom) rounded up to the nearest 1 KB.
3. Add a rationale explaining what the chunk contains and why the headroom is
   what it is. If `index.html` loads it (modulepreload or stylesheet), set
   `"firstPaint": true`; the gate fails until you do.
4. Re-run `npm run check:bundle` to confirm the rule passes.

## Re-running outside CI

```bash
# Build + check.
npm run frontend:build && npm run check:bundle

# Custom dist path (e.g., post-Vite-test):
node scripts/check-bundle-size.js --dist=./other-dist

# Custom budget (e.g., a stricter "v1.1 target" file):
node scripts/check-bundle-size.js --budget=./config/bundle-budget-v11.json
```
