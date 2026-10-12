---
id: core.dependency-updates
title: Dependency updates arrive on their own
severity: medium
enforcement: check
audit-area: 8
---

**Requires:** a Dependabot or Renovate configuration in the repository.

**Why:** a repository nobody bumps by hand falls behind until an advisory forces a large, risky
upgrade all at once. Grouped weekly updates keep each step small.

**Meeting it:** a `.github/dependabot.yml` covering each package ecosystem and `github-actions`,
grouped (the template's own is an example), or a Renovate config. Dependabot version and security
updates work on private repositories too.

**The check:** `n/a` when there's nothing to update: no package manifest for any ecosystem (npm,
Python, Cargo, Go, NuGet, Maven, Gradle, and the rest), no Dockerfile, and no workflow that uses an
action. Otherwise it looks for `.github/dependabot.yml` (or `.yaml`), a Renovate config file
(`renovate.json`, `renovate.json5`, `.renovaterc`, `.renovaterc.json`, `.renovaterc.json5`, under
`.github/` or `.gitlab/` too), or a `renovate` key in the root `package.json`. It can't tell whether
updates actually run: a configured Dependabot whose jobs never start passes here, so look at the
repository's Actions runs.
