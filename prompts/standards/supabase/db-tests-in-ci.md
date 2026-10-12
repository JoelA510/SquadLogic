---
id: supabase.db-tests-in-ci
title: Database tests run in CI
severity: high
enforcement: check
audit-area: 6
---

**Requires:** SQL tests under `supabase/tests/`, run in a `pull_request` workflow by
`supabase test db` (or `pg_prove`).

**Why:** RLS policies are the authorization layer of a Supabase app. A policy that lets user A read
user B's rows passes every client-side test; only a test that runs as each role, against the real
database, catches it.

**Meeting it:** pgTAP tests per table: anonymous access is denied, one user can't select, update, or
delete another's rows, an insert with a forged owner fails. Run them in a job that starts the local
stack (`supabase start`) on each pull request.

**The check:** looks for `.sql` files under `supabase/tests/`, then for the test command in the
commands `pull_request` workflows run, traced through scripts.
