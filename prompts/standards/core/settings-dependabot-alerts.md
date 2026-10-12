---
id: core.settings-dependabot-alerts
title: Dependabot alerts and security updates are on
severity: high
enforcement: settings
audit-area: 8
---

**Requires:** Dependabot alerts, and Dependabot security updates (not paused).

**Why:** a vulnerability is published against a dependency the repository already ships, long
after the dependency audit gate let it in. Alerts are how the repository hears about it; security
updates open the fix. Both are free for private repositories owned by a user, and both are off
until someone turns them on.

**Meeting it:** Settings -> Advanced Security (Code security on older accounts): turn on
Dependabot alerts and Dependabot security updates. Version updates are a separate file,
`core.dependency-updates`.

**The check:** `GET /repos/{owner}/{repo}/vulnerability-alerts` (204 on) and
`/automated-security-fixes` (`enabled`, `paused`). Both answer 404 both when the feature is off
and when the token can't see it, so the check first confirms the token has admin access, and is
`skipped` without it. It can't see whether Dependabot's jobs actually run: a "Dependabot on
self-hosted runners" setting with no matching runner leaves every job queued until it's cancelled
24 hours later, and no API reports that setting.
