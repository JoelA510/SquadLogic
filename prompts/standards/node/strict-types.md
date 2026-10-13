---
id: node.strict-types
title: Types are strict, or checked as JavaScript
severity: high
enforcement: check
audit-area: 2
---

**Requires:** every TypeScript project config that compiles `.ts` or `.tsx` sources is strict: it
sets `strict`, or leaves it unset under TypeScript 6 or later, where strict is the default. One that
compiles only JavaScript sets `checkJs`.

**Why:** the definition of done says the project's agreed strictness holds and is never loosened to
get green. A strict flag turned off in an emergency and never restored is the common way it's lost,
and nothing else notices.

**Meeting it:** `"strict": true` in the config the sources compile under (a base config that others
extend counts). Set it even under TypeScript 6, so an older compiler or a copied config keeps it. For a JavaScript codebase, `"checkJs": true` with `allowJs`. Raising strictness on
an existing codebase is a flagged refactor; record the current state in the baseline meanwhile.

**The check:** parses `tsconfig.json` (or `jsconfig.json`) next to `package.json` with TypeScript
itself, following `extends` and project `references`, and reads each config's resolved options and
file list. An unset `strict` passes when the project's TypeScript (the installed one, else the
lowest major its declared range allows) is 6 or later, and fails below 6 or when the version can't be
read. Fails when no config exists, since then nothing typechecks the project.
