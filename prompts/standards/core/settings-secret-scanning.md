---
id: core.settings-secret-scanning
title: A public repository scans for secrets and blocks pushes that contain one
severity: medium
enforcement: settings
audit-area: 8
---

**Requires:** secret scanning and push protection, for a public repository.

**Why:** a key pushed to a public repository is found by scrapers in minutes. Push protection stops
the push; secret scanning finds what's already in the history. Both are free on public
repositories.

**Meeting it:** Settings -> Advanced Security: secret scanning, and push protection.

**The check:** the `security_and_analysis` block of `GET /repos/{owner}/{repo}`, which GitHub shows
only to admins (`skipped` without it). `n/a` for a private repository owned by a user, where
GitHub doesn't offer secret scanning without a paid add-on; a scanner in CI (gitleaks, betterleaks)
is the alternative there.
