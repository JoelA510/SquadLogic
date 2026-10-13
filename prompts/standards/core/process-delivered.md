---
id: core.process-delivered
title: The repository carries the shared process
severity: medium
enforcement: check
audit-area: 12
---

**Requires:** the template's process in the repository: delivered by `process:apply`, or inherited
as a fork or a "Use this template" copy that records its `templateVersion`.

**Why:** the workflows (bootstrap, complete, discovery, root-cause, review-change, pre-pr, verify)
and the skeletons are how agents in the repository do the work the standards measure. Without them
each session improvises its own process.

**Meeting it:** from a template checkout, `npm run process:apply -- --target <repo>`, then commit the
delivery as `prompts/README.md` describes.

**The check:** passes on `prompts/.apply-manifest.json` (and names the template commit it records),
on a `templateVersion` in the root `package.json`, or on the template itself. Whether that delivery
is the latest release is a later check.
