[← Back to Documentation Index](../README.md)
---

# Self-hosting SquadLogic

> Run your own copy: a Supabase project for the database, authentication and Edge Functions, and a
> Vercel project for the web app. Both have free plans that carry a league (see "What it costs"
> below). This is the current setup reference; [`production-cutover.md`](./production-cutover.md)
> is the historical runbook of the first deployment and names that deployment's project.

You need accounts at [Supabase](https://supabase.com) and [Vercel](https://vercel.com), a clone of
this repository (a fork is fine), Node 24 (`.nvmrc`), and the
[Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started) at the
version CI pins (`SUPABASE_CLI_VERSION` in `.github/workflows/ci.yml`).

Nothing here needs the repository's CI. `ci-cd.md` describes how the original deployment automates
steps 3 and 4; doing them by hand is the same commands.

## 1. Create the Supabase project

1. In Supabase, create a project (any region; remember the database password you choose).
2. Note the **project ref** (the subdomain of its URL), the **Project URL**, the **publishable
   (anon) key** and, separately, the **service-role (secret) key** (Settings, API).
   The service-role key bypasses Row Level Security: it goes into Edge Function secrets and
   GitHub Actions secrets only, **never into a `VITE_` variable** (a build refuses it there).

## 2. Link the CLI

```bash
supabase login
supabase link --project-ref <project-ref>
```

## 3. Apply the migrations

```bash
supabase db push --dry-run   # what would be applied
supabase db push
```

Apply the whole directory, in order, as it is: `supabase/migrations/` is the schema, and a migration
is never edited after it ships. The migrations create the extensions they use (`pg_cron`,
`btree_gist` and others). Then check `supabase migration list` shows nothing pending.

If the project already holds objects that did not come from these migrations, stop and read
[`schema-drift-2026-10.md`](./schema-drift-2026-10.md) and
[`migration-ledger-normalisation.md`](./migration-ledger-normalisation.md) first.

## 4. Deploy the Edge Functions and set their secrets

```bash
supabase functions deploy --project-ref <project-ref>
```

This deploys every function in `supabase/functions/` with the `verify_jwt` setting that
`supabase/config.toml` gives it (`auto-scheduler`, `calendar-feed`, `fairness-scoring`,
`game-persistence`, `import-validation`, `practice-persistence`, `team-persistence`). Supabase
injects `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` into every function.
The optional secrets (`BETTERSTACK_SOURCE_TOKEN`, the `*_PERSISTENCE_ALLOWED_ROLES` lists) are in
[`ENVIRONMENT.md`](./ENVIRONMENT.md#supabase-edge-functions); set one with
`supabase secrets set NAME=value --project-ref <project-ref>`.

## 5. Allow the app to reach your project

`vercel.json` sets the production Content-Security-Policy, and its `connect-src` names one Supabase
project by ref. In your copy, replace that ref with yours (both the `https://` and the `wss://`
entries) in `vercel.json` and in the policy block of [`docs/security/csp.md`](../security/csp.md);
`tests/cspPolicy.test.js` holds the two together. Leave the other origins as they are.

In Supabase, Authentication, URL Configuration: set the **Site URL** to your Vercel production URL and
add it (and any preview URL pattern you use) to the redirect allow-list, so confirmation and
password-reset links return to your app.

## 6. Deploy the web app on Vercel

1. Import the repository into Vercel as a new project. `vercel.json` already sets the framework,
   the build command (`npm run frontend:build`), the install command (`npm ci`) and the output
   directory, so nothing needs changing in the build settings.
2. Set the environment variables (Production, and Preview if you use previews):

   | Variable | Value |
   | --- | --- |
   | `VITE_SUPABASE_URL` | the Project URL |
   | `VITE_SUPABASE_ANON_KEY` | the publishable (anon) key |
   | `VITE_SENTRY_DSN` | optional; unset turns Sentry off |

   Do **not** set `VITE_USE_MOCK_SUPABASE`. A production build without the first two fails, naming
   the missing one. Every variable and its rules: [`ENVIRONMENT.md`](./ENVIRONMENT.md).
3. Deploy. Sign up on the new site, then create your organization (the first user becomes its
   admin).

## 7. Turn on the demo (optional)

The demo gives a visitor a private, 30-minute copy of a ready-made league, with no account. It is off
unless you turn it on, and a deployment that does not shows nothing of it. To offer it:

1. **Make sure the demo migrations are applied** (step 3; `20261030010000_demo_sessions.sql` and
   `20261031010000_anonymous_signups_skip_password_check.sql` are part of the directory). The
   second keeps an anonymous sign-in from the password-length check on `auth.users` (an anonymous
   user has no password); every other sign-up and every password change is still checked.
2. **Enable anonymous sign-ins**: Supabase, Authentication, Sign In / Providers, "Allow anonymous
   sign-ins".
3. **Protect it with CAPTCHA** (strongly advised: the endpoint is public). Create a Cloudflare
   Turnstile widget that allows your site's domain, then in Supabase, Authentication, Attack Protection,
   enable CAPTCHA protection with provider Turnstile and its **secret key**. This setting covers
   sign-in, sign-up, password reset and anonymous sign-in alike, so deploy the app with the site key
   (next step) **before** you enable it, or sign-in will ask for a token the app cannot send.
4. **Set the demo variables in Vercel** and redeploy (they are read at build time):

   | Variable | Value |
   | --- | --- |
   | `VITE_DEMO_ENABLED` | `true` |
   | `VITE_TURNSTILE_SITE_KEY` | the Turnstile **site** key (public); unset with CAPTCHA off |
   | `VITE_OFFICIAL_SITE_URL` | leave unset. Only the official hosted deployment sets it, so its demo's import notice can point visitors there |

5. **Check the purge is scheduled**: `select jobname, schedule from cron.job;` lists
   `purge-expired-demos` every 10 minutes. The repository's `demo-health.yml` workflow (secrets
   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`) reads `demo_health()` hourly and opens an issue
   when the purge stops; copy it if you want the same watch.

At most 10 demos run at once (a visitor at the cap is told to try again in a few minutes). One demo
takes about 1.4 MiB of database (measured with indexes, D3); the cap bounds the demo's whole
footprint to a few tens of MiB.

To turn it off again: unset `VITE_DEMO_ENABLED` and redeploy (the entry point disappears), then
disable anonymous sign-ins. The full rollback, including the database, is in
[`docs/changes/2026-10-22-demo-mode.md`](../changes/2026-10-22-demo-mode.md), "Risks and rollback".

## What it costs

On the free plans: Supabase Free (500 MB database, 50,000 monthly active users, a project paused
after a week of inactivity, so keep a scheduled ping, as `ci.yml`'s keep-alive does) and Vercel
Hobby. [`ci-cd.md`](./ci-cd.md#free-tier-budgets) records the limits that have bitten.

## Updating

Pull the new release, then repeat steps 3 and 4 (migrations first, then functions) and let Vercel
redeploy. A release that needs a different order says so in its changelog entry.
