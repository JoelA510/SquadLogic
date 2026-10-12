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

**The check:** `git ls-files --eol` reports what's in the index: an entry marked `i/crlf` or
`i/mixed` fails. `skipped` outside a git work tree, `n/a` with nothing committed.
