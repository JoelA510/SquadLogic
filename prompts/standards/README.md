# Standards

The standards this repository is held to, delivered by the template's `process:apply` from its
`standards/` catalog: `core/` applies to every repository, and each other directory is a pack for
one stack. Each file is one standard with a stable ID (`node.strict-types`), a severity, and what
it requires, why, how to meet it, and what its check reads.

Don't edit these files: a re-apply updates the ones you haven't touched, and parks an update
beside one you have. Record this repository's own decisions in `docs/standards/conformance.json`
instead (below).

## Scoring this repository

From a checkout of the template, nothing installed here:

```bash
node <template checkout>/scripts/check-conformance.mjs --root .
```

Each standard gets `pass`, `fail`, `n/a`, `skipped` (an input is missing; it says which), `audit`
(a person checks it), `waived`, `baseline`, or `error` (the check couldn't run). It exits 0 when
nothing fails, 1 on a failure, and 2 when something couldn't be checked.

## This repository's record

`docs/standards/conformance.json`, every field optional:

- `visibility`: `public` or `private`, which decides `core.license`.
- `packs`: the packs to score. Without it, packs are detected from markers at the root; a pack
  whose project lives below the root is declared with its path,
  `{ "pack": "node", "path": "mobile-app" }`. A declared list replaces detection.
- `baseline`: the failures recorded when this repository adopted the standards. They don't fail a
  run; new ones do. `--write-baseline` records it, and afterwards only removes what's fixed.
- `waivers`: a failure that's acceptable for now, each with a reason of at least 40 characters, an
  owner, and an expiry no more than 90 days out. An expired or stale waiver fails the run.
