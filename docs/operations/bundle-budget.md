[← Back to Documentation Index](../README.md)
---

# Bundle Budget — How To

> CI gate that prevents accidental bundle bloat.
> Source of truth: [`config/bundle-budget.json`](../../config/bundle-budget.json).
> Enforcer: [`scripts/check-bundle-size.js`](../../scripts/check-bundle-size.js).

## What runs when

| Trigger | Command | Effect |
| --- | --- | --- |
| Local pre-push smoke | `npm run check:bundle` | Runs after `npm run frontend:build`. Fails if any chunk exceeds the budget. |
| CI full matrix | `npm run check:bundle` after `npm run frontend:build` | Same as local; PR cannot merge if budget is busted. Docs-only PRs intentionally skip the full matrix; see [`ci-cd.md`](./ci-cd.md). |

## Budget file shape

```json
{
  "rules": [
    {
      "match": "<regex against `assets/<path>`>",
      "label": "<human-readable name>",
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

`totalFirstPaintGzipBytes` is summed over every file matching the `main entry`,
`main css`, `react vendor`, and `supabase vendor` rules — meant as the assets the
browser must download before any UI paints. Two gaps against that intent, as
of the current build: the `main entry` regex (`^assets/index-.*\.js$`) also
matches a ~1 KB lazy shared chunk that Rollup names `index-*.js`, which is
therefore checked as "main entry" and counted in the total; and
`lucide-vendor-*.js`, which `index.html` modulepreloads, matches no rule, so it
is neither budgeted nor counted. `virtual-vendor-*.js` (lazy) also matches no
rule.

Sizes in the `check:bundle` output and in the rationale fields are KiB
(1024 B); the caps in the config are bytes, so a `250000` cap prints as
`244.14 KB`.

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
| `no files matched (rule ...)` | Rule's regex doesn't match any built file. The line is printed among the passing lines and does **not** fail the gate, so read the output rather than the exit code. | Either fix the regex or remove the rule (e.g., we deleted a chunk). |

## Adding a new rule

If you ship a new vendor chunk (e.g., a new `analytics-vendor`):

1. Run `npm run frontend:build` and note the new chunk's gzip size.
2. Add a rule to `config/bundle-budget.json` with `maxGzipBytes` set to
   `actual_size * 1.20` (20% headroom) rounded up to the nearest 1 KB.
3. Add a rationale explaining what the chunk contains and why the headroom is
   what it is.
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
