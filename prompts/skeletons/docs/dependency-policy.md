# Dependency policy

<!-- GUIDANCE: Tooling companion (new-project Phase 2.5; existing-project audit §8). Fill the [BRACKETED]
     placeholders and delete these comments. The shape is stack-agnostic: swap the audit
     command for your ecosystem's (npm/pnpm/yarn audit, pip-audit, cargo audit, govulncheck,
     dotnet list package --vulnerable, osv-scanner). For npm, the template has a working gate
     that enforces this page as written: `scripts/check-audit.mjs` (Node builtins only), its
     workflow `.github/workflows/audit.yml`, and its tests,
     `scripts/__tests__/check-audit.test.ts`. process:apply doesn't deliver them; copy them
     from a template checkout and adapt them: the workflow runs a `check:audit` script (add it
     to package.json, as `node scripts/check-audit.mjs`) and pins npm from package.json's
     `packageManager` field (add it, or drop that step); the script reads its register from
     docs/security/audit-waivers.json unless given `--waivers <path>`; and the tests run on
     Vitest. Reformat both files to this repo's formatter settings. That gate takes the ids npm's
     audit reports (a GHSA id, or npm-<number> for an advisory without one) and rejects a waiver
     more than 90 days out: say both in the Waivers table.
     More than one ecosystem (a Node app with a Python or Rust part): keep one register for all
     of them rather than one per tool. OSV-Scanner reads every lockfile in one run
     (`osv-scanner scan source -r .`) and its `osv-scanner.toml` is that register; fill the
     "One register" section below and delete it otherwise. Its waivers are `IgnoredVulns` entries
     (an array of tables) with `id`, `reason`, and `ignoreUntil` (a TOML date); OSV-Scanner leaves
     the last two optional, and the standard core.audit-waivers requires both. OSV-Scanner has no severity
     threshold (checked 2026-10-07 against its configuration docs): any advisory it finds fails
     the run, so with it the bar below is "every advisory blocks", not "high and critical". -->

How this project decides whether a known-vulnerable dependency can ship. The gate is
`[AUDIT COMMAND]`, run in CI on every pull request, on pushes to `[MAIN BRANCH]`, and on a weekly
schedule.

## The bar

- **High and critical advisories block**, in runtime *and* development dependencies. Build and
  test tooling runs with CI credentials and on every contributor's machine.
- **Moderate and low are reported, not blocked**, and cleared in the regular dependency-update
  batch.
- **The audit has to run.** No report (offline, registry outage) fails the gate. "Couldn't
  check" is not "clean".
- **It runs on a schedule, not just on PRs.** Advisories are published against code that has
  already merged. Don't rely on an update bot for this: if its jobs stop running, nothing tells
  you.

## Waivers

A waiver is a time-boxed decision to live with one advisory. It lives in
`[WAIVER REGISTER PATH — e.g. docs/security/audit-waivers.json]`, and the gate enforces the register:

| Field | Rule |
| --- | --- |
| Advisory | The advisory's stable id, as the audit tool reports it (GHSA for npm, RUSTSEC for cargo audit, …), not a package name |
| Package | Which dependency carries it |
| Reason | Why it's acceptable *here*: the code path that reaches it and why an attacker can't. "Low risk" is not a reason |
| Owner | Who revisits it at expiry |
| Expires | A date, typically one or two months out, and no further than the gate allows. **Expired waivers fail the gate** |

A waiver for an advisory the audit no longer reports also fails, because a stale entry would
pre-approve the advisory if it came back. The gate itself must be shown to fail: run it once
against a saved report that contains a blocking advisory before you trust a green run.

## One register

<!-- GUIDANCE: Only for more than one ecosystem; delete this section otherwise. -->

`[AUDIT COMMAND — e.g. osv-scanner scan source -r .]` audits `[ECOSYSTEMS — e.g. npm, PyPI, crates.io]`
in one run, and `osv-scanner.toml` is the register for all of them: each waiver is an
`IgnoredVulns` entry with the advisory's `id`, a `reason` that meets the Waivers table's rule, and
an `ignoreUntil` date no more than 90 days out.

OSV-Scanner fails on any advisory it finds, whatever its severity, so here every advisory blocks
until it's fixed or waived. The owner of each waiver is `[OWNER — a team or role]`. Don't also
waive the same advisory in a per-tool file (`.cargo/audit.toml`, a `--ignore-vuln` flag): those
hold no reason or expiry, and `core.audit-waivers` fails them.

## Install guards

<!-- GUIDANCE: The standard node.install-guards. npm: commit an .npmrc beside package.json (the
     workspace root's, in a monorepo) with min-release-age=7, allow-git=root, and
     allow-remote=root, and pin npm 11.15 or later in packageManager (npm 10 ignores all three).
     pnpm: minimumReleaseAge (minutes) and blockExoticSubdeps: true in pnpm-workspace.yaml.
     Other ecosystems: the closest equivalent, or delete this section and say so in the audit. -->

When the package manager chooses a version, it takes only releases at least [N] days old, and it
refuses a git or tarball-URL dependency that a dependency brings in: `[WHERE THE SETTINGS LIVE]`. Installing from
the lockfile isn't affected. An urgent fix younger than that is taken on purpose, with
`[COMMAND THAT LIFTS THE WAIT FOR ONE INSTALL]`, and the pull request says so.

## Fixing

1. The ecosystem's own fix command, within semver ranges. Review the lockfile diff and run the
   full gate.
2. A major bump of a direct dependency is a normal upgrade PR, with an ADR if it's
   consequential.
3. No fix available: waive it with a short expiry. Never loosen the bar.
