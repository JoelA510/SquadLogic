---
id: node.install-guards
title: The package manager waits for releases to age and refuses a dependency's git and URL dependencies
severity: medium
enforcement: check
audit-area: 8
---

**Requires:** when the package manager chooses a version (an install that adds or updates a
dependency), it takes only releases at least three days old; and it refuses a git or tarball-URL
dependency that a dependency brings in.

**Why:** a compromised release is usually caught and pulled within days, and the update bot's
cooldown (`core.dependency-cooldown`) doesn't cover a developer or an agent running
`npm install some-package`, which takes whatever was published a minute ago. A git dependency
skips the registry entirely: no published version to pull, and no wait. TanStack's compromised
packages (May 2026) carried their payload in a git `optionalDependencies` entry.

**Meeting it:** with npm, pin npm 11.15 or later (`"packageManager": "npm@11.19.0"`) and commit an
`.npmrc` beside `package.json` (the workspace root's, in a monorepo: npm ignores a workspace's own)
with `min-release-age=7`, `allow-git=root`, and `allow-remote=root` (a git or tarball-URL
dependency only where `package.json` itself names one), or `none` for either. None of them changes
`npm ci`'s versions, which come from the lockfile. To take an urgent fix younger than the wait:
`npm install <pkg>@<version> --min-release-age=0`, approved and said in the pull request. With
pnpm, set `minimumReleaseAge` (in minutes, 4320 for three days) and `blockExoticSubdeps: true` in
`pnpm-workspace.yaml`.

**The check:** a workspace (listed in the root `package.json`'s `workspaces`, or in
`pnpm-workspace.yaml`'s `packages`, and not excluded by a `!` pattern, as npm or pnpm applies one;
braces and brackets in a pattern are read as text) is read at the workspace root; any other package
at its own directory. The package manager comes from `packageManager` or
`devEngines.packageManager`, else the lockfile. With npm: `.npmrc`, read as npm reads it (an
unquoted value ends at `;` or `#`), needs `min-release-age` of 3 or more, and `allow-git` and
`allow-remote` of `root` or `none` (npm 12 refuses both by default, so they may be unset there); and
`package.json` must pin npm 11.15 or later, since npm 10 ignores all three and 11.15 fixed
`allow-remote`. With pnpm: `pnpm-workspace.yaml` needs `minimumReleaseAge` of 4320 or more and
`blockExoticSubdeps: true`; the pnpm version isn't read. Settings given through the environment
(`npm_config_*`) or a user's own `.npmrc` don't count: they don't travel with the repository. Yarn
and Bun are `skipped`.
