---
id: vite-spa.client-env
title: No secret reaches the client bundle through the environment
severity: high
enforcement: check
audit-area: 8
---

**Requires:** no secret-named variable behind a client prefix (`VITE_`), no whole-object read of
`import.meta.env`, no placeholder values in real env files, and no `define` in `vite.config.*` that
pushes a non-public variable into the bundle.

**Why:** whatever the bundle reads ships to every visitor. Google AI Studio's scaffold, for one,
loads every variable with `loadEnv(mode, '.', '')` and injects `process.env.GEMINI_API_KEY` through
`define`: the key isn't in the bundle until some component reads it, and then it is, with no
warning.

**Meeting it:** keep secrets in server code (an API route, an Edge Function) and call it. Read
public variables as `import.meta.env.VITE_NAME`. Remove `define` entries that copy environment
variables.

**The check:** runs `scripts/check-env.mjs --root <pack path>` (its header lists every finding)
and reports its findings. `n/a` when the app has no environment variables anywhere.
