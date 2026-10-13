# Typed environment validation

<!-- GUIDANCE: Phase 2.6 companion. This doc describes the pattern; once the module exists in your
     codebase, move anything project-specific into its comments and delete this file — a
     pattern doc that outlives its implementation drifts into a lie. -->

Every project gets one module through which **all** environment access flows. Raw
`process.env.X` (or the platform equivalent) scattered through a codebase produces the
classic failure: a missing variable that nobody notices until the one code path that reads
it runs in production, at night.

The module has three jobs:

1. **Validate at build/boot time.** Every variable is checked against a schema when the app
   starts (or better, when it builds). A missing or malformed variable fails fast with a
   named error — not later, at first use.
2. **Type the access.** Consumers import a typed object; a typo'd variable name is a compile
   error, not `undefined` at runtime.
3. **Separate server from client.** Variables holding secrets must be structurally unable to
   reach client bundles. Public variables are explicitly marked (framework prefix
   conventions like a `PUBLIC_`/client prefix exist for this — use yours).

Keep [`.env.example`](../.env.example) current in the same PR that adds a variable — the
example file is the contract, this module is the enforcement, and drift between them is a
bug in whichever one is wrong.

## Illustration (TypeScript + a schema library)

Adapt, don't paste — names and framework prefix depend on your stack:

```ts
// src/env.ts — the only file allowed to read process.env
import { z } from 'zod'

// Refuses what an example file holds: a URL check alone accepts
// `https://<your-key>@o0.ingest.sentry.io/0`, the shape vendors document a DSN in. In a URL,
// `your-` counts in the user or host, not the path (`/your-account` can be a real page).
const PLACEHOLDER = /<\w[^>]*>|^your[-_]|change[-_]?me|replace[-_]?me/i
const vendorSlot = (v: string) => {
  if (!URL.canParse(v)) return false
  const { username, hostname } = new URL(v)
  return /^your[-_]/i.test(username) || /(^|\.)your[-_]/i.test(hostname)
}
const real = (schema: z.ZodString) =>
  schema.refine((v) => !PLACEHOLDER.test(v) && !vendorSlot(v), 'still a placeholder')

const server = z.object({
  DATABASE_URL: real(z.string().url()),
  AUTH_SECRET: real(z.string().min(32)),
  SERVICE_API_KEY: real(z.string().min(1)),
  NODE_ENV: z.enum(['development', 'test', 'production']),
})

const client = z.object({
  // Only variables safe to ship to a browser, marked by your framework's public prefix.
  PUBLIC_APP_URL: real(z.string().url()),
  // An optional integration: unset turns it off; a placeholder or malformed value still fails.
  PUBLIC_ERROR_REPORTER_DSN: real(z.string().url()).optional(),
})

// Public variables are listed one by one, in the literal form the bundler inlines: a bundler
// replaces `process.env.PUBLIC_APP_URL` in client code, never `process.env` passed whole (see
// "Client bundlers" below; T3 Env's `runtimeEnv` exists for the same reason).
const parsed = server.merge(client).safeParse({
  ...process.env, // server side only; in client code this spread is empty
  PUBLIC_APP_URL: process.env.PUBLIC_APP_URL,
  PUBLIC_ERROR_REPORTER_DSN: process.env.PUBLIC_ERROR_REPORTER_DSN || undefined,
})

if (!parsed.success) {
  console.error('❌ Invalid environment:', z.treeifyError(parsed.error))
  throw new Error('Invalid environment — see missing/malformed variables above.')
}

export const env = parsed.data
```

The illustration validates both halves in one place, which suits a server entry point. In a
client bundle, only the explicitly listed public variables exist; if client code imports this
module, split the client schema into its own file so it never touches the server half.

Three refinements, all from real incidents:

- **Reject placeholder values, not just empty ones.** A copied `.env.example` passes
  `z.string().min(1)` with `your-api-key` in it, and ships; `z.string().url()` passes
  `https://<your-key>@o0.ingest.sentry.io/0`. Refuse the shapes your example file uses
  (`your-…`, `<…>`, `changeme`), inside a URL too, as `real()` above does, optional
  variables included, and test it with a placeholder that is otherwise well formed: one the
  schema refuses as malformed anyway proves nothing about the placeholder rule.
- **Fail the build, not the first request.** Where the platform builds on a remote service
  (EAS, a CI job), the validation runs there too, so a value missing from that environment stops
  the build instead of shipping.
- **An optional integration is off when unset, not a failed build.** Required is for what the app
  can't run without. A variable that switches on an optional service (an error reporter's DSN, an
  analytics key) is optional: unset turns the feature off, which is how local builds, CI and a
  rollback ("unset the variable") run. A placeholder or malformed value still fails. Marking one
  required breaks every build until someone creates the account.

Enforcement worth adding once the module exists: a lint rule (or a grep in CI) that fails on
`process.env` outside this file. A convention that isn't checked is a suggestion.

## Client bundlers: what actually ships

<!-- GUIDANCE: Keep the subsections for the bundlers this project uses; delete the rest. -->

A client-exposed prefix (`VITE_`, `NEXT_PUBLIC_`, `EXPO_PUBLIC_`, `PUBLIC_`, …) means the value
is compiled into code every visitor downloads. The name promises nothing: a variable called
`VITE_SERVICE_ROLE_KEY` is public the moment client code reads it. Three rules follow.

1. **No secret behind a public prefix, whatever it's called.** Server-only values (service-role
   keys, database URLs, signing secrets, vendor API keys) never get one. If a public-prefixed
   name reads as secret but the value really is public, rename it. The next reader will make
   the same mistake.
2. **Read public variables in the one form the bundler inlines**, literally:
   - **Expo:** `process.env.EXPO_PUBLIC_X`, dot notation only. `process.env['EXPO_PUBLIC_X']`
     and `const { EXPO_PUBLIC_X } = process.env` are not inlined and come out undefined in the
     app (Expo's environment-variables guide).
   - **Next.js:** `process.env.NEXT_PUBLIC_X`. A lookup through a variable or an alias of
     `process.env` isn't inlined (Next.js environment-variables guide).
   - **Vite:** `import.meta.env.VITE_X`. Using `import.meta.env` as a whole, such as
     `import.meta.env[key]` or destructuring it, makes Vite embed an object holding *every*
     `VITE_` variable present at build time at that spot (Vite's `define` plugin). That
     includes ones meant for tests or tooling, and it can drag unrelated modules into the entry
     chunk.
3. **Public values are fixed at build time.** Changing one in a hosting dashboard does nothing
   until the app is rebuilt. Redeploying a cached build ships the old value. After changing
   one, verify the built output (the release runbook's "Verify the shipped artifact").

### EAS (Expo Application Services)

- **Don't put `${VAR}` in `eas.json` `env` blocks.** EAS passes the text through literally,
  and a build profile's `env` overrides the value from the EAS environment. In one real app,
  every binary built for five weeks shipped `${EXPO_PUBLIC_SUPABASE_URL}` as the Supabase URL
  and died before first render. Local development never showed it, because `expo start` reads
  `.env`. Real values live in the EAS environment (`eas env:list <environment>`), and each
  profile names its `environment` explicitly.
- **Check the binary, not the config:** unzip a build and confirm the embedded config holds
  real values, never `${`.

### Checking all of this

From a template checkout, `npm run check:env -- --root <repo>` reports four things:

- public-prefixed names that read as secret, in env files, `eas.json`, and source;
- public variables read in a form the bundler handles differently (from the parsed source, so
  strings and comments don't count);
- leftover placeholder values in real env files and `eas.json`;
- `${…}` in `eas.json` env blocks.

It runs a self-test of its detectors first and refuses to report a clean repo if they fail.

## Non-TypeScript equivalents

The pattern is identical; only the tools change.

- **Python:** a settings class validated at import time (e.g. `pydantic-settings`-style
  `BaseSettings`) — one module, typed fields, fails on boot with named errors.
- **Go:** a `Config` struct populated and validated in one constructor called from `main`;
  nothing else reads the environment.
- **JVM / .NET:** typed configuration binding with validation-on-startup enabled, one
  options/config class per concern, no ad-hoc `getenv` calls.

Whatever the stack: one module, schema-checked at startup, typed access, secrets
structurally kept out of any client artifact.
