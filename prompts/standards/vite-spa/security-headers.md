---
id: vite-spa.security-headers
title: The deployed site sends security headers
severity: medium
enforcement: audit
audit-area: 8
---

**Requires:** the deployed app sends a Content-Security-Policy (report-only while it's being
tuned, with a date to enforce it), `X-Content-Type-Options: nosniff`, a frame policy
(`frame-ancestors` or `X-Frame-Options`), and a `Referrer-Policy`, configured in the repository
(`vercel.json`, `firebase.json`, `netlify.toml`), not only in a hosting dashboard.

**Why:** a single-page app has no server of its own to set them, so they're easy to never set at all,
and a dashboard-only setting disappears with the next project rebuild.

**Audit question:** `curl -sI <deployed URL>`: which of these come back, and where in the repository
is each one set?
