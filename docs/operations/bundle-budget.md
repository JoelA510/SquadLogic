[← Back to Documentation Index](../README.md)
---

# Bundle Budget — How To

> CI gate that prevents accidental bundle bloat.
> Source of truth: [`config/bundle-budget.json`](../../config/bundle-budget.json).
> Enforcer: [`scripts/check-bundle-size.js`](../../scripts/check-bundle-size.js).

## What runs when

| Trigger | Command | Effect |
| --- | --- | --- |
| Local pre-push smoke | `npm run check:bundle` | Runs after a build made as CI makes it (stand-in Supabase and Sentry variables; see "What is measured"). Fails if any chunk exceeds the budget, a rule matches no file, or a first-paint file is unbudgeted. |
| CI full matrix | `npm run check:bundle` after `npm run build` | Same as local; PR cannot merge if budget is busted. Docs-only PRs intentionally skip the full matrix; see [`ci-cd.md`](./ci-cd.md). |

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
  `main entry` is told apart from the ~1 KB lazy shared chunk the bundler also names
  `index-*.js`: both are `index-<hash>.js`, so no regex can separate them.
  The lazy one is printed as `SKIP main entry (...)` and is neither checked
  against the main-entry cap nor counted in the total.

**Lazy files that match no rule are listed as a warning, not a failure.** Route
and shared chunks are lazy by design and were never budgeted one by one. The
`WARN <n> lazy file(s) match no rule` block keeps them visible without
requiring a rule per page. Each named vendor chunk (a `codeSplitting` group in
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

Measured on a build with no credentials (as CI built then, without Sentry), 2026-09-28:

| File | Before | After |
| --- | --- | --- |
| main entry | 137.16 KB (140,447 B) | 114.38 KB (117,125 B) |
| total first paint (5 files) | 231.21 KB (236,757 B) | 208.43 KB (213,435 B) |
| `mockSupabaseClient-*.js` (lazy) | in main entry | 22.69 KB (23,239 B), fetched only in mock mode |

The caps were unchanged by that split, which left the main-entry cap ~23 KB of
headroom at the time.

`@sentry/react` 10.76.2 to 11.8.0 (2026-10-19), measured on the build CI makes
(Sentry on): main entry 174.34 to 179.75 KB gz (+5.41 KB). The main-entry cap is
190,000 B (185.55 KB), so about **5.8 KB of headroom is left today**, not the
~23 KB above; the next growth in the entry needs a look. `sentryReplay-*.js`
40.19 to 40.30 KB; total first-paint 276.85 to 282.25 KB of 289.06 KB. No
budget was raised.

Vite 7 to 8 (Rolldown and Oxc replace Rollup and esbuild, 2026-10-19), same build,
gzip as `check:bundle` prints it:

| File | Vite 7 | Vite 8 |
| --- | --- | --- |
| main entry | 179.77 KB | 173.01 KB |
| main css | 20.06 KB | 20.09 KB |
| react vendor | 17.52 KB | 17.46 KB |
| supabase vendor | 57.13 KB | 53.35 KB |
| lucide vendor | 9.33 KB | 9.32 KB |
| rolldown runtime (new, first paint) | not emitted | 0.42 KB |
| total first paint | 283.80 KB (5 files) | 273.65 KB (6 files) |
| chart vendor (lazy) | 118.40 KB | 112.89 KB |
| `sentryReplay-*.js` (lazy) | 40.30 KB | 39.00 KB |
| dnd vendor (lazy) | 16.08 KB | 15.28 KB |
| virtual vendor (lazy) | 5.04 KB | 4.87 KB |

Rolldown has no object-form `manualChunks`; `vite.config.js` declares the vendor
chunks as `codeSplitting` groups, plus an `index` group that keeps the entry's
own static graph (the Sentry core, `AuthContext`) in the entry. Without it
Rolldown moved those into content-named common chunks that `index.html` preloads
(`exports-*.js`, `logger-*.js`), which no `firstPaint` rule can name stably. The
one file it still emits that Rollup did not is `rolldown-runtime-*.js`, the
helpers the chunks share; it has its own rule. No cap was raised.

## What is measured: the build production ships, Sentry on

CI builds with stand-in Supabase variables and a stand-in `VITE_SENTRY_DSN`
(`.invalid` hosts; `.github/workflows/ci.yml`, "Build Frontend"), so the gate
measures what production ships. Until plan M6 (2026-10-17) CI built without a
DSN: `main.jsx`'s `if (SENTRY_DSN)` folded away, `Sentry.init` and its
integrations were never bundled, and the gate passed a main entry 79 KB gzip
smaller than production's.

Session Replay is not in the main entry: `main.jsx` imports
`frontend/src/lib/sentryReplay.js` after `Sentry.init` and adds the
integration with `Sentry.addIntegration`, so Replay is a lazy
`sentryReplay-*.js` chunk with its own rule. A build without a DSN emits no
such chunk, so the gate fails it with `[NO MATCH] rule "sentry replay ..."`.
To measure locally what CI measures:

```bash
VITE_SUPABASE_URL=https://ci-build.invalid VITE_SUPABASE_ANON_KEY=sb_publishable_ci-build-stand-in VITE_SENTRY_DSN=https://00000000000000000000000000000000@sentry-ci-build.invalid/0 npm run build && npm run check:bundle
```

Measured 2026-10-17, same tree:

| File | No DSN (what CI measured) | DSN, Replay in the entry | DSN, Replay lazy (now) |
| --- | --- | --- | --- |
| main entry | 134.19 KB | 213.62 KB | 174.22 KB (178,399 B) |
| `sentryReplay-*.js` (lazy) | not emitted | in main entry | 40.19 KB (41,159 B) |
| total first paint (5 files) | 237.41 KB | 316.84 KB | 277.44 KB (284,101 B) |

The main-entry cap moved from 140,450 B to 190,000 B and the first-paint
total from 250,000 B to 296,000 B: bytes production already shipped, now
counted. The rest of the SDK (core and `browserTracingIntegration`, ~40 KB)
stays in the entry so the pageload is traced from the start.

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
| `[NO MATCH] rule "..."` | Rule's regex matches no built file (for a `firstPaint` rule: no file `index.html` loads). Fails the gate. | Fix the regex (a chunk was renamed) or remove the rule (the chunk was deleted). For `sentry replay`: the build had no `VITE_SENTRY_DSN`; build as CI does (above). |
| `[UNBUDGETED FIRST-PAINT] assets/...` | `index.html` now loads a file no `firstPaint` rule matches (new `codeSplitting` group, renamed vendor). Fails the gate. | Add or fix a `firstPaint` rule; see "Adding a new rule". |
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
# Build + check, as CI does (stand-ins; see "What is measured").
VITE_SUPABASE_URL=https://ci-build.invalid VITE_SUPABASE_ANON_KEY=sb_publishable_ci-build-stand-in VITE_SENTRY_DSN=https://00000000000000000000000000000000@sentry-ci-build.invalid/0 npm run build && npm run check:bundle

# Custom dist path (e.g., post-Vite-test):
node scripts/check-bundle-size.js --dist=./other-dist

# Custom budget (e.g., a stricter "v1.1 target" file):
node scripts/check-bundle-size.js --budget=./config/bundle-budget-v11.json
```
