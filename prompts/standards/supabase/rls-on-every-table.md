---
id: supabase.rls-on-every-table
title: Row-level security is enabled on every public table
severity: blocker
enforcement: check
audit-area: 3
---

**Requires:** every table created in the `public` schema by a migration, and not dropped later, has
row-level security enabled by a migration.

**Why:** the Data API serves `public` tables to anyone holding the publishable (anon) key, which
ships in every client. A table without RLS is readable, and often writable, by the whole internet.

**Meeting it:** `alter table public.<name> enable row level security;` in the migration that creates
the table, with policies for each operation and role, and tests that prove them
(`supabase.db-tests-in-ci`).

**The check:** reads every migration in order (see the pack's README for what it can't see). It
checks that RLS is on, not that the policies are right: that's what the database tests and the
advisors are for.
