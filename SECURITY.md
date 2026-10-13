# Security policy

## Reporting a vulnerability

Report it privately through GitHub's private vulnerability reporting: open this repository's
[Security tab](https://github.com/JoelA510/SquadLogic/security) and choose **Report a
vulnerability** (or go straight to
[the report form](https://github.com/JoelA510/SquadLogic/security/advisories/new)). Only you and
the maintainer can see the report. Please don't open a public issue, discussion or pull request
for it.

Include what's affected, how to reproduce it, and what an attacker gains: for example, which role
(admin, coach, parent, player, staff) can read or change which other organization's data.

One person maintains SquadLogic, so these are best-effort targets, not guarantees: a report is
acknowledged within 7 days, you are told whether it is accepted once it has been reproduced, and a
disclosure date is agreed with you before a fix is published. You are credited in the advisory
unless you ask not to be.

When testing, use an organization and accounts you created yourself. Don't read, change or delete
data that isn't yours, and stop and report as soon as you can see another organization's data.

## What's in scope

- In scope: the production app at https://squadlogic.vercel.app and its Supabase backend (Edge
  Functions under `supabase/functions/`, database functions, and the row-level security policies
  that keep each organization's data to its own members); this repository's code, its GitHub
  Actions workflows, and the deploy pipeline they run.
- Out of scope: the third-party services themselves (Supabase, Vercel, GotSport, Sentry, GitHub);
  denial of service by request volume; findings that need an already-compromised device, browser
  or account; and the in-browser mock backend (`VITE_USE_MOCK_SUPABASE`), which holds no real data,
  unless it can be switched on in a production build.

## Supported versions

Only the current production deployment, built from `main`, gets security fixes. There are no
maintained older releases.
