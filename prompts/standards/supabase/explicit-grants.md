---
id: supabase.explicit-grants
title: New public tables state their Data API exposure with grants
severity: high
enforcement: check
audit-area: 3
---

**Requires:** a public table created by a migration dated 2026-10-30 or later has a `grant` (or a
`revoke`) naming it, in that migration or a later one, or is created after an
`alter default privileges ... grant ... on tables` that covers `public` (default privileges apply
only to tables created after them).

**Why:** from 2026-10-30, Supabase stops granting `anon` and `authenticated` access to new `public`
tables in existing projects (new projects since 2026-05-30); existing tables keep their grants
(supabase.com/changelog, "Tables not exposed to Data API automatically", read 2026-10-07). After
that date a table created without a grant is invisible to the Data API, and the app fails with a
permission error that looks like an RLS bug.

**Meeting it:** in the migration that creates the table:
`grant select on public.<name> to anon; grant select, insert, update, delete on public.<name> to authenticated;`
(only what each role needs), or a `revoke` that says it's private on purpose.

**The check:** reads migrations as `supabase.rls-on-every-table` does, from the
`20261030000000` timestamp on. `n/a` until a migration that late creates a table.
