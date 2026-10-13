---
id: core.lf-line-endings
title: Text is committed with LF line endings
severity: low
enforcement: check
audit-area: 12
---

**Requires:** no tracked text file whose committed content has CRLF or mixed line endings.

**Why:** a file committed with CRLF shows every line as changed the first time someone on another
platform touches it, which hides the real change from review, and some tools (shell scripts,
frontmatter parsers, exact-match checks) misread it.

**Meeting it:** add `* text=auto eol=lf` to `.gitattributes` (with binary types marked `binary`),
then `git add --renormalize .` and commit.

A file that must stay byte for byte as shipped isn't renormalized: an applied database migration
(the migration tool never re-runs it, and a check on its history or checksum rejects the edit), a
vendored or signed file. Mark each one `-text` in `.gitattributes` first, by name
(`supabase/migrations/20260101000000_init.sql -text`), so the renormalize leaves it alone. A rule
for the whole folder also exempts every migration still to be written, which can then be committed
with CRLF. Review the renormalize's diff for any such file before committing it.

**The check:** `git ls-files --eol` reports what's in the index: an entry marked `i/crlf` or
`i/mixed` fails, unless its attributes say `-text` (or `binary`), which keeps it as committed on
purpose; those are listed in the evidence. A catch-all rule that makes every path `-text` excuses
none of them. `skipped` outside a git work tree, `n/a` with nothing committed.
