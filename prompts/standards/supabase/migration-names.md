---
id: supabase.migration-names
title: Migrations are named the way the CLI orders them
severity: medium
enforcement: check
audit-area: 4
---

**Requires:** every file in `supabase/migrations/` is `<14-digit timestamp>_<name>.sql`.

**Why:** the Supabase CLI orders and records migrations by that timestamp. A file named any other way
is skipped or misordered, so a fresh database built from the repository isn't the one production
has.

**Meeting it:** create migrations with `supabase migration new <name>`, and rename strays to the
timestamp of when they were applied.

**The check:** lists the directory's `.sql` files, the only ones the CLI reads. `n/a` when there
are none yet.
