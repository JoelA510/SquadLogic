---
id: node.ci-uses-pin
title: CI takes its Node version from the pin
severity: medium
enforcement: check
audit-area: 7
---

**Requires:** every `actions/setup-node` step reads `node-version-file`, except a job that
deliberately tests the oldest supported version, which names exactly the `engines` floor, and a
matrix whose versions all satisfy `engines`.

**Why:** a version written into a workflow drifts from `.nvmrc` the first time one of them is bumped,
and then CI tests a runtime production doesn't use. CI that runs Node with no `setup-node` step uses
whatever the runner image ships that month.

**Meeting it:** `node-version-file: .nvmrc` in every `setup-node` step.

**The check:** reads every workflow's `setup-node` steps. A `${{ matrix.<name> }}` value is resolved
from the job's matrix when it's a plain list; any other expression can't be read and fails with
that reason. `skipped` when a matrix or a literal version can only be judged against an `engines`
range in a form `node.runtime-pinned` can't compare. `n/a` when no workflow runs Node at all.
