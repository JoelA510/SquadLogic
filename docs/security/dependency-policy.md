[← Back to Documentation Index](../README.md)
---

# Dependency policy

How SquadLogic decides whether a known-vulnerable dependency can ship, and how
new releases reach the tree. The gate is `npm run check:audit`
([`scripts/check-audit.mjs`](../../scripts/check-audit.mjs)), run by
[`.github/workflows/audit.yml`](../../.github/workflows/audit.yml) on every
pull request to `main`, on every push to `main`, and weekly on a schedule.
Adopted from agent-ready-template 1.0.0 (remediation plan items M2.1 and M2.3,
audit findings 8.1 to 8.3). It replaces `dependabot-waivers.md`, a Markdown
register nothing read: it said "`npm audit` reports 0 vulnerabilities" while the
audit reported 8 high.

## The bar

- **High and critical advisories block**, in runtime, dev, optional and peer
  dependencies. The build and test tooling runs in CI with repository
  credentials and on every contributor's machine, so an exploitable dev
  dependency is not "just tooling". The gate passes `--include` for every
  dependency class, so `NODE_ENV=production` or an `omit` setting cannot shrink
  what npm reports.
- **Moderate and low advisories are reported, not blocked.** They are listed in
  the gate's output and on the job summary of every audit run, and cleared by
  Dependabot's weekly batch (below) or an `npm audit fix` pull request.
- **The audit has to run, and has to be read correctly.** The gate exits 2
  (fails) rather than passing when `npm audit` produced no report (offline,
  registry outage), when a high or critical entry does not trace to an
  advisory it parsed, or when its counts do not match npm's own totals. A
  changed report format must never read as "clean".

## Fixing an advisory

Remediation plan decision D6: in-range upgrades first; a major upgrade only
where the plan allows one (none is planned); a dated waiver only for what needs
a major.

1. `npm audit fix` (or `npm update <package>`). It stays within the ranges in
   `package.json`. Review the lockfile diff like any other change and run the
   CLAUDE.md verification sequence, plus the season-2026 fixture suite when a
   package the engines import changed. When the fix is a direct dependency,
   raise its floor in `package.json` to the fixed version too, so no fresh
   resolve can choose the vulnerable one.
2. If a dependency pins the vulnerable version exactly, so no in-range update
   reaches the fix, an `overrides` entry scoped to that dependency, shown to
   work (its tests, or a build diff), and named in the CHANGELOG. Drop it once
   the dependency's own range admits the fix. An override outlives its reason
   quietly: the `esbuild` override added in March 2026 was still forcing
   `0.25.x` under a Vite 7.3 that declares `^0.27.0 || ^0.28.0` until M2.1
   removed it.
3. A fix that needs a major bump of a direct dependency is its own upgrade pull
   request (and an ADR if it is consequential), not part of a refresh.
4. No fixed version yet, or the fix needs a major: a waiver (below). Never
   loosen the bar.

## Waivers

A waiver is a time-boxed decision to live with **one advisory in one package**.
It lives in [`audit-waivers.json`](./audit-waivers.json):

```json
{
  "waivers": [
    {
      "advisory": "GHSA-xxxx-xxxx-xxxx",
      "package": "react-router",
      "reason": "Scoped to RSC mode; this app is a client-side SPA and never renders through it.",
      "owner": "repository owner",
      "expires": "2026-12-31"
    }
  ]
}
```

| Field      | Rule                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `advisory` | The id the gate prints: the GHSA id, or `npm-<number>` for an advisory without one. Not a CVE id, not a package name.                                  |
| `package`  | The package that carries it. If the advisory turns up in a second package, that path needs its own decision and its own waiver.                        |
| `reason`   | Why it is acceptable _here_: which code path reaches it and why an attacker cannot. At least 40 characters; "low risk" is not a reason.                |
| `owner`    | Who revisits it when it expires.                                                                                                                       |
| `expires`  | `YYYY-MM-DD`, at most 90 days out. **An expired waiver covers nothing and fails the gate**: fix the advisory, or renew the waiver with a fresh reason. |

A waiver for an advisory the audit no longer reports in that package also fails
(it is stale): delete it, so it cannot pre-approve the advisory if it ever
comes back. The register is empty today (2026-10-13): every advisory open at
the audit was fixed in range.

`tests/checkAudit.test.js` holds the gate to all of this on saved reports: an
unwaived high fails, an expired waiver fails where the same waiver one day
later passes, a stale waiver fails, and a report the gate cannot account for
exits 2. It also fails if `audit.yml` stops running the gate on pull requests or
on the schedule, or could let it fail without failing the run.

## Install guards

[`.npmrc`](../../.npmrc), read by the npm `package.json` pins in
`packageManager` (npm 11.15 or later reads all three settings; npm 10 ignores
them):

- `min-release-age=3`: when npm chooses a version (`npm install`,
  `npm update`, `npm audit fix`) it takes only releases at least 3 days old.
  A compromised release is usually caught and pulled within days. Dependabot
  keeps the same wait (`cooldown`, below).
- `allow-git=none` and `allow-remote=none`: no git or tarball-URL dependency
  anywhere in the tree, ours or a dependency's. Everything comes from the
  registry.

**Declared, not enforced.** An npm older than 11.15 ignores all three settings
without an error, and nothing in the repository stops one: `packageManager` is
read only by Corepack (not enabled here) and by the audit job, which installs
that npm before it runs. Node 24.21 bundles npm 11.19; on an older Node 24,
check `npm -v` before adding or updating a dependency, or run
`npx npm@11.19.0 install <pkg>`. `devEngines` or `engine-strict` could make it
an error, but Dependabot runs its own npm and Node, and either would fail every
update it tries.

**Install scripts.** `package.json`'s `allowScripts` records each dependency
install script's review (npm 11's own field): `true` lets it run, `false`
stops it. npm still runs a script it does not name, with a warning
(`strict-allow-scripts` is off), so when `npm ci` or `npm install` warns
"not yet covered by allowScripts", read the script, then record the decision
with `npm install-scripts approve <pkg> --no-allow-scripts-pin` or
`npm install-scripts deny <pkg>`. `esbuild` was approved until Vite 8
(2026-10-19), which bundles with Rolldown and no longer installs it; its entry
was removed with it. `tests/allowScripts.test.js` fails when a package in the
lockfile has an install script and no decision, and when a decision names a
package that has none. `fsevents` (macOS only,
`node-gyp rebuild`; its tarball ships the built binary) is denied by name: the
owner decided on 2026-10-18 that it stays denied.

None of them changes what `npm ci` installs: CI and Vercel install
`package-lock.json` as it is. To take an urgent fix younger than the wait, once
the owner approves it: `npm install <pkg>@<version> --min-release-age=0`, and
say so in the pull request.

**Node.** `.nvmrc` pins Node 24 (CI and Vercel use it; see
[`ENVIRONMENT.md`](../operations/ENVIRONMENT.md#node-runtime)), and
`@types/node` is held on 24.x to match, so typecheck refuses an API only Node 25
has. `engine-strict` is deliberately not set: Dependabot runs npm on its own
Node version, and with `engine-strict` an `engines` mismatch there fails every
update it tries. `npm ci` on another Node warns (`EBADENGINE`) instead.

## Dependency updates

[`.github/dependabot.yml`](../../.github/dependabot.yml): npm and GitHub Actions,
monthly, with a 3-day cooldown. Minor and patch npm bumps arrive as one grouped
pull request, npm majors as another, and the actions as a third. Five are
held back, each with its reason beside it: `@types/node` 25 (moves with
`.nvmrc`), `eslint-plugin-react-hooks` 7.1 (new lint rules flag 63 existing
patterns; pinned at 7.0.1 in `package.json`), `@tanstack/react-virtual`
3.14 (its chunk outgrows its bundle budget; pinned at 3.13.23 in
`package.json`), and `eslint` and `@eslint/js` 10 (`eslint-plugin-jsx-a11y`
6.10.2 accepts ESLint up to 9 only, so `npm ci` fails, #584; remove both when a
jsx-a11y release supports ESLint 10). Each other npm major is taken as its own
planned upgrade (the resume queue lists them). A held-back
package in the minor-and-patch group would otherwise fail a gate and hold the
whole batch with it. Security updates (Settings -> Advanced
Security) ignore the cooldown and arrive at once.

## When it runs, and what makes it bind

- **Every pull request to `main` and every push to `main`**: the
  `npm audit (high and critical block)` job. It needs only the lockfile, not an
  install.
- **Weekly, Mondays 06:00 UTC, against `main`.** Advisories are published
  against code that has already merged. When a scheduled run fails it opens one
  issue, "Dependency audit is failing on main", rather than relying on the
  Actions email, which only reaches whoever last edited the cron line. GitHub
  disables schedules in public repositories after 60 days without activity;
  re-enable it from the Actions tab when the banner shows.
- **It blocks the merge.** `npm audit (high and critical block)` is a required
  check in the `main` ruleset (`.github/rulesets/main.json`, from the moment
  the owner applies it to the live ruleset), so a red audit run stops a merge.
  See [`ci-cd.md`](../operations/ci-cd.md#dependency-audit).
- **Locally:** run `npm run check:audit` whenever you touch `package.json` or
  the lockfile.
