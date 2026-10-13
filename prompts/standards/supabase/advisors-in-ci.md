---
id: supabase.advisors-in-ci
title: CI runs Supabase's own linters, set to fail
severity: medium
enforcement: check
audit-area: 8
---

**Requires:** a CI workflow runs `supabase db advisors` or `supabase db lint` with `--fail-on` set
to a level other than `none`.

**Why:** the advisors are Supabase's security and performance lints (RLS disabled on a public table,
a policy that re-evaluates `auth.uid()` per row, a view that bypasses RLS). `supabase db lint`
defaults to `--fail-on none`, so without the flag it reports and never fails.

**Meeting it:** after the database tests start the local stack, run
`supabase db advisors --fail-on <level>` (or `supabase db lint --fail-on error`). The advisors'
flags come from the CLI's pull request that added them; confirm with `supabase db advisors --help`
on the version CI pins.

**The check:** looks for those commands, with a `--fail-on` other than `none`, in every workflow's
commands, traced through scripts. A hand-written approximation of the lints doesn't count: it's
the real lints this standard asks for.
