---
id: core.security-policy
title: Says where to report a vulnerability privately
severity: medium
enforcement: check
audit-area: 8
---

**Requires:** a `SECURITY.md` at the root, in `.github/`, or in `docs/`, saying where to report a
vulnerability privately and what's in scope.

**Why:** without one, the only channel a finder has is a public issue.

**Meeting it:** copy the SECURITY skeleton. GitHub's private vulnerability reporting exists only for
public repositories, so a private one names another channel, and says so in the product too: only
collaborators can read a private repository's `SECURITY.md`.

**The check:** looks for the file in those three places. It can't see an account-wide default from
the owner's public `.github` repository; a repository that relies on one waives this standard with
that reason.
