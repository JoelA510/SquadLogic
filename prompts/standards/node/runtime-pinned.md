---
id: node.runtime-pinned
title: The Node version is pinned once, inside the range the package declares
severity: medium
enforcement: check
audit-area: 7
---

**Requires:** a version file (`.nvmrc`, `.node-version`, a `node` line in `.tool-versions`, or `node`
in `mise.toml`), an `engines.node` range in `package.json`, and the pinned version inside that range.

**Why:** without one pinned version, local runs, CI, agent sandboxes, and the host each pick their
own Node, and "works on my machine" is the default state. `engines` tells everyone else which
versions the code claims to support.

**Meeting it:** write the production major to `.nvmrc`, add `"engines": { "node": "^24.0.0" }` (or
the range you test), and point CI at the file (`node.ci-uses-pin`).

**The check:** reads the version file next to `package.json`, then at the root. A floating alias
(`lts/*`, `node`) isn't a pin. The range comparison understands `^` and `>=` ranges joined by `||`,
with a full or partial version (`^24.0.0`, `>=20`); with another form (`18.x`, `>=18 <25`) the
result is `skipped`, naming the range, because the check can't decide.
