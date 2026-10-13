---
id: core.dependency-cooldown
title: Updates wait for a release to age
severity: low
enforcement: check
audit-area: 8
---

**Requires:** the update bot waits at least three days after a release before proposing it:
`cooldown` with `default-days` on every Dependabot `updates` entry, or Renovate's
`minimumReleaseAge`.

**Why:** a compromised package version is usually caught and pulled within days. An update that
takes a release the hour it's published installs it first. Security updates aren't delayed by
either setting.

**Meeting it:** in `.github/dependabot.yml`, under each entry, `cooldown: { default-days: 7 }`
(Dependabot applies three days when it's unset, since 2026-07-14; saying so keeps the choice
visible and zizmor quiet). In Renovate, `"minimumReleaseAge": "3 days"` or more, or extend
`config:best-practices`, which sets it for npm.

**The check:** `n/a` without a Dependabot or Renovate configuration (`core.dependency-updates`
covers that). Every Dependabot `updates` entry needs `cooldown.default-days` of 3 or more, no
`semver-major-days`, `semver-minor-days`, or `semver-patch-days` under 3, and no `exclude: ["*"]`.
A Renovate config needs a `minimumReleaseAge` of 3 days or more for every package: at the top
level, or in a package rule whose only selector is `matchPackageNames: ["*"]` (a later such rule
overrides it). A rule scoped to some packages doesn't raise it, and one that sets less than 3
days (or `null`) for them is a finding, except for `lockFileMaintenance` alone, which has no
release to age (Renovate's own waiting presets exempt it). Ages read as Renovate reads them:
"3 days", "1 week 2 days", "1 yr", and "3 M" for months. A built-in preset that waits counts
only when, between them, the presets cover every kind of package manifest the repository has
(`go.mod`, a `Gemfile`, a `Dockerfile`, and the rest `core.dependency-updates` looks for) outside
the paths Renovate skips: `config:best-practices`, `security:minimumReleaseAgeNpm`, and
`npm:unpublishSafe` (and its old aliases) cover a `package.json`;
`security:minimumReleaseAgeCrate` a `Cargo.toml`; `security:minimumReleaseAgePypi` a Python
manifest; none covers the others (`packages.config` doesn't count: Renovate doesn't update it).
Renovate skips `node_modules` and `bower_components` by default, and tests, fixtures, examples,
and vendored code too under `:ignoreModulesAndTests`, which `config:recommended` (and its old
names), `config:best-practices`, `config:js-app`, `config:js-lib`, and
`security:only-security-updates` extend; that preset's own
NuGet rule leaves test projects in. A config's own `ignorePaths` replaces either (and its
`nuget.ignorePaths` the NuGet rule), matched as Renovate matches it: a substring of the path, or
a glob with `{a,b}` alternatives, where one ending in `/` matches nothing; character classes
aren't read. `enabledManagers` isn't read, so a manifest kind the config turns off still counts.
Workflow files aren't counted, though no preset makes GitHub Actions updates wait either. A config that extends a shared preset (`github>…`, `local>…`, an npm package, a URL)
is `skipped`, whatever age it sets and whatever a Dependabot config beside it says: the preset's
own rules could lower the age, and the check can't read them.
