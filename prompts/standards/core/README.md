---
pack: core
title: Every repository
---

# Core

What every repository is held to, whatever its stack: agent rules every agent reads, CI on every
pull request, workflows audited the way code is, dependency updates that wait for a release to
age, waivers that expire, a way to report a vulnerability, the shared process, and hygiene that
keeps a diff reviewable. Core applies everywhere, so it has no markers.

The `core.settings-*` standards live in the repository's GitHub settings, not its files, so
`scripts/check-settings.mjs` scores them over the API (`npm run check:settings`) and
`check:conformance` only lists them.
