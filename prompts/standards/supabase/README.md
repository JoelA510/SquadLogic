---
pack: supabase
title: Supabase projects
detect:
  - file: supabase/config.toml
  - file: supabase/migrations/
---

# Supabase

A project with a `supabase/` directory: migrations the CLI can order, row-level security on every
table the Data API exposes, tests that prove it, and Supabase's own linters running in CI. Detected
from `supabase/config.toml` or `supabase/migrations/` at the root; a project kept below the root is
declared with a path.

The SQL checks read migrations as text. They see `create table`, `alter table ... enable row level
security`, `grant`, `revoke`, `drop table`, and `alter table ... rename to` statements, outside
comments and dollar-quoted bodies. A table created inside a function or a `DO` block is invisible
to them; say so in a waiver if that's how a repository creates tables.
