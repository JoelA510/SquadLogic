---
id: core.license
title: A public repository says how its code may be used
severity: medium
enforcement: check
audit-area: 12
---

**Requires:** a `LICENSE` (or `LICENCE`, `COPYING`) file at the root of every public repository.

**Why:** public code without a license is "all rights reserved" by default: nobody can reuse it,
which is rarely what publishing it meant, and it leaves the question open for anyone who copies it.

**Meeting it:** choose a license and commit its text. "All rights reserved, public for review" is a
choice too; write it down.

**The check:** looks for the file at the root: `LICENSE`, `LICENCE`, or `COPYING`, bare or with a
suffix (`LICENSE.md`, `LICENSE-Apache-2.0`), but not a code or config file (`license-checker.json`). `n/a` for a private repository. It needs the
visibility, from the repository's config or `--visibility`, and is `skipped` without it.
