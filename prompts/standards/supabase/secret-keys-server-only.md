---
id: supabase.secret-keys-server-only
title: Secret keys and claims stay on the server
severity: blocker
enforcement: audit
audit-area: 8
---

**Requires:** the secret (`sb_secret_...`) and legacy `service_role` keys are read only by server
code (Edge Functions, a backend), never by client code or a client-prefixed variable; authorization
decisions read `app_metadata`, never `user_metadata`, which the user can edit.

**Why:** either key bypasses row-level security entirely. `user_metadata` is writable by the signed-in
user, so a policy that trusts it lets anyone grant themselves a role.

**Audit question:** search the repository for every read of a secret or `service_role` key: which
file reads it, and does that file run only on a server? Search policies and functions for
`user_metadata`: is any authorization decision made from it?
