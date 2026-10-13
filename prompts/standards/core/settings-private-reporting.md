---
id: core.settings-private-reporting
title: A public repository accepts vulnerability reports privately
severity: medium
enforcement: settings
audit-area: 8
---

**Requires:** private vulnerability reporting is on, for a public repository.

**Why:** `SECURITY.md` (`core.security-policy`) tells a reporter where to go. On a public
repository the natural place is GitHub's private reporting form; with it off, the only channel
GitHub shows is a public issue, which discloses the vulnerability to everyone first.

**Meeting it:** Settings -> Advanced Security -> Private vulnerability reporting.

**The check:** `GET /repos/{owner}/{repo}/private-vulnerability-reporting`. `n/a` for a private
repository: GitHub offers the form on public ones only.
