---
id: core.workflow-caches
title: A job that publishes or holds a secret restores no cache
severity: medium
enforcement: check
audit-area: 8
---

**Requires:** no job restores the Actions cache in a workflow that publishes (a release, Pages, a
package registry, a container image, an app store), or in a job that is given a secret or a token
that can write.

**Why:** the cache is shared across a repository's runs, and any run with the default branch's
scope can write to it. A cache entry poisoned by one run (a compromised dependency's install
script, or a `pull_request_target` workflow that checked out a fork) is restored by the next job
that asks for the same key, and runs there with that job's token, secrets, and whatever it
publishes. A job that installs from the registry instead pays a minute and can't inherit
another run's files. zizmor's `cache-poisoning` audit covers release workflows it recognizes; it
doesn't see an npm cache in a workflow that deploys Pages, or one setup-node turns on by itself.

**Meeting it:** in those jobs, drop `cache:` from the setup action and, for `actions/setup-node`
v5 or later in a repository whose `package.json` names npm (`packageManager` or
`devEngines.packageManager`), set `package-manager-cache: false`: setup-node caches npm by default
there. The same for actions whose cache is on unless turned off: `actions/setup-go` v4 or later
(`cache: false`), `gradle/actions/setup-gradle` (`cache-disabled: true`), `oven-sh/setup-bun`
(`no-cache: true`), and `astral-sh/setup-uv` v6 or later (`enable-cache: false`). Keep caches in
jobs that only read: a pull request's tests, with a read-only token and no secrets.

**The check:** `n/a` with no workflows. A workflow publishes when it runs on `release`, when a
step uses a publishing action (`actions/deploy-pages`, `softprops/action-gh-release`,
`changesets/action`, `pypa/gh-action-pypi-publish`, `docker/build-push-action` with a `push` that
isn't `false`, and others) or runs a publishing command (`npm publish`, `pnpm publish`,
`cargo publish`, `twine upload`, `gh release create`, `docker push`, `wrangler deploy`, and
others), or when a local workflow it calls does. A job holds a secret when it, or the workflow's
`env`, names one other than `GITHUB_TOKEN`; its token can write when its permissions (or the
workflow's) grant `write` or are `write-all`. Without either, the repository's default token
decides, which this check can't read (`core.settings-token-read-only` scores it). A local reusable
workflow's jobs are also judged with what its caller gives them, however deep the calls nest:
the caller's publishing, its secrets (`secrets: inherit` or named), and its permissions. A step
restores a cache when it uses `actions/cache` or `actions/cache/restore`, `Swatinem/rust-cache`,
`docker/build-push-action` with `cache-from: type=gha`, a setup action with its cache asked for,
or one of the actions above with its default left on. An action's version comes from its ref or,
for a commit pin, the `# vN` comment beside it; a commit pin without one counts as a current
release.
