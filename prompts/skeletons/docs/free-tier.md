# Staying inside free plans

<!-- GUIDANCE: For a project whose repository, host, or backend runs on a free plan (new-project
     Phase 2.5; existing-project audit §7). Keep it as docs/free-tier.md while any of them does:
     fill the plans line, delete the sections for services the project doesn't use, and copy the
     agent working rules into AGENTS.md's project-specific rules (or point to this file from
     there). Re-check each limit against its source before relying on it; plans change. -->

Plans this project is on: [PLANS AND THE DATE EACH WAS CHECKED].

Agents push more often than people do, and on a free plan every push is spent somewhere: a CI run,
a preview deployment, a database branch. On one project built this way, parallel agent branches
used up a Vercel Hobby team's 100 deployments for the day in under 13 hours: about 13 production
deployments, about 61 previews of agent branches, 14 from a notes branch that held no app, and 11
from Dependabot. Production couldn't deploy until the window reset. Nothing was wrong with any one
push; there were just too many places a push turned into a build.

## The budget

| Counts against it | Limit | The lever |
| --- | --- | --- |
| Vercel deployments: every push to any branch of a Git-connected project makes one | 100 a day on Hobby; past it, a deploy fails with `api-deployments-free-per-day` | `git.deploymentEnabled` in `vercel.json` for branches that don't need a preview (below) |
| GitHub Actions minutes: every push to a pull request re-runs CI | Free on standard runners in a public repository; 2,000 a month for a private one on GitHub Free | Push once per pull request; at most two pull requests in flight (below) |
| Dependabot pull requests and their rebases: each is a push, so a CI run and a deployment | Not a quota, but it spends the two above | Monthly, grouped, not rebased (`.github/dependabot.yml`) |
| Supabase preview branches and redeploys, when its GitHub integration branches per pull request | Plan-dependent | Leave "Automatic branching" off; test against a local stack |

## Agent working rules

- **At most two agent pull requests in flight.** A third waits; parallel branches are what
  multiply every other cost here.
- **Push once per pull request, when the local gates pass**, not once per commit. A fix push after
  review is fine; a push to see whether CI agrees is a CI run and a deployment.
- **Throwaway branches stay local**: a planted defect to prove a check fails, an experiment, a
  bisect. If one has to be pushed, its prefix has deployments disabled.
- **Branches that hold no app** (notes, run state, generated reports) have deployments disabled.
- **Previews on request.** An agent branch gets a preview deployment when someone will look at it,
  not by default.

## Vercel

Disable automatic deployments for the branches that don't need them, in `vercel.json` (globs are
minimatch; a branch that matches nothing keeps deploying, so production and people's branches are
unaffected):

```json
{
  "git": {
    "deploymentEnabled": {
      "claude/**": false,
      "dependabot/**": false
    }
  }
}
```

Add the prefix your agents and notes branches use. To preview one of those branches on request,
deploy it by hand (`vercel deploy` from that branch, or the dashboard's redeploy). Prefer this
over an "Ignored Build Step" command: whether a build that step skips still counts toward the
daily limit is unverified.

## GitHub

- **Keep "require branches to be up to date before merging"** (the ruleset skeleton's
  `strict_required_status_checks_policy: true`), and pay for it by keeping few pull requests open.
  It costs CI: every merge makes each other open pull request update and re-run before it can
  merge. Turning it off saves those runs but lets two pull requests that are each green alone
  merge into a red `main`, because nothing tested them together. With at most two in flight, the
  cost is one extra run per merge.
- A merge queue would test each merge's result with one run; whether it's available to a
  repository owned by a personal account is unverified.
- Rulesets and branch protection work only in a public repository on GitHub Free (a paid plan adds
  private ones).

## Dependabot

The skeleton `.github/dependabot.yml` is set for this: `interval: monthly`, `rebase-strategy:
disabled` (a pull request opened before the change keeps rebasing for 30 days), a small
`open-pull-requests-limit`, the cooldown kept, minor and patch bumps in one group and majors in
another. Security updates aren't scheduled and still open at once. Don't silence majors with an
`ignore` on `version-update:semver-major`: whether that also stops security updates is unverified,
so group them instead.

## Supabase

- **Password protection.** Leaked-password protection is a Pro plan feature. On Free, set the
  minimum password length to 8 or more and require character classes, and record that in the
  release runbook's settings table.
- **One migration writer.** The GitHub integration's "Deploy to production" applies migrations
  and deploys Edge Functions on every push to the production branch. If CI already deploys
  migrations, turn it off, so production has one writer.
- **"Automatic branching" off.** It creates a preview database per pull request, and when it syncs
  that branch's variables into Vercel, Vercel redeploys the pull request's preview: another
  deployment per pull request.
- **Remove the secrets the Vercel integration syncs.** It copies the secret (service) key, the JWT
  secret, and the Postgres password into the Vercel project's environment. A browser-only app (a
  Vite SPA) needs only the project URL and the publishable (anon) key; delete the rest, since a
  build that doesn't need a secret shouldn't hold one.
- **Tests run against a local stack** (`supabase start` in CI), not a hosted project: no
  quota, no shared state between runs, and no credentials in CI.

## What's verified

Checked 2026-10-14 against each provider's documentation:

- Vercel: `git.deploymentEnabled` per branch, with minimatch globs and unlisted branches deploying
  (vercel.com/docs/project-configuration/git-configuration); the Hobby limit of 100 deployments a
  day and its error code.
- Supabase: leaked-password protection on Pro and above (supabase.com/docs/guides/auth/password-security);
  what "Deploy to production" and "Automatic branching" do; which variables the Vercel
  integration syncs.
- Dependabot (docs.github.com, Dependabot options reference): `monthly`, `rebase-strategy:
  disabled` and its 30 days, `cooldown` applying to version updates only, `groups`.
- GitHub Actions: standard runners free in public repositories, and 2,000 minutes a month for a
  private repository on GitHub Free (docs.github.com, GitHub Actions billing).

Unverified as of 2026-10-14:

- Whether a build skipped by Vercel's "Ignored Build Step" counts toward the daily limit.
- Whether a Dependabot `ignore` on semver-major updates also suppresses security updates.
- Whether a merge queue is available to a repository owned by a personal account.
