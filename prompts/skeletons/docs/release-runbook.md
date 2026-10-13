# Release runbook

<!-- GUIDANCE: A milestone 1 deliverable (new-project Phase 3): written when the deploy pipeline
     lands, finished (no placeholders) by milestone 1's exit, and kept current in the same PR
     that changes how the app is built or deployed. Written for the
     person deploying at a bad moment: exact commands, no "as usual". A release is done when the
     shipped artifact has been checked, not when the pipeline turned green. -->

Project: **[PROJECT]** · Last verified end to end: [DATE] by [WHO]

## Environments

<!-- GUIDANCE: One row per place the app runs. "Config as code" names the file in this repo that
     holds the build and deploy settings (vercel.json, netlify.toml, eas.json, a workflow file,
     a Dockerfile). A setting that exists only in a hosting dashboard (build command, output
     directory, runtime version, environment variable names) goes in the next section until it
     can move into code: nobody reviews a dashboard change, and nobody can restore one. -->

| Environment | URL / channel | Host | Deployed by | Config as code | Runtime version |
| --- | --- | --- | --- | --- | --- |
| Preview | [URL PATTERN] | [HOST] | [TRIGGER — e.g. every PR] | `[FILE]` | [VERSION] |
| Staging | [URL] | [HOST] | [TRIGGER] | `[FILE]` | [VERSION] |
| Production | [URL] | [HOST] | [TRIGGER — e.g. merge to main, manual promote] | `[FILE]` | [VERSION] |

The runtime version is the same in CI, in every environment, and in the pinned version file
(`.nvmrc`, `.tool-versions`, or equivalent): [CONFIRMED ON DATE / NOT YET — WHY].

## Settings that live outside the repo

<!-- GUIDANCE: Everything a rebuild from this repo alone would get wrong: dashboard build
     settings, environment variables (names only, never values), DNS, secrets-store entries,
     scheduled jobs configured in a console. Each row says how to check the live value. If this
     table is empty, say so; an empty table that was never looked at is a finding. -->

| Setting | Where it lives | Value or variable names (no secrets) | How to check it |
| --- | --- | --- | --- |
| [SETTING] | [DASHBOARD / CONSOLE PATH] | [VALUE OR NAMES] | [COMMAND OR CLICK PATH] |

## Before releasing

- [ ] The full gate passed on the exact commit being released, in CI, and CI is a required check
      on the default branch (or, where the repository's plan can't enforce one, the settings
      table above records that).
- [ ] Every migration in the release has a tested revert or a written recovery path.
- [ ] Every environment variable the release reads is set in the target environment, and the
      typed env module accepted it at build or boot (placeholder values like `your-key-here`
      fail validation rather than ship).
- [ ] No secret sits behind a public prefix: from a template checkout,
      `npm run check:env -- --root <this repo>` (or the equivalent check this repo runs).
- [ ] The CHANGELOG entry and any user-facing docs describe what's shipping.

## Release

```bash
[EXACT COMMANDS OR STEPS, IN ORDER — e.g. tag, promote, submit build]
```

<!-- GUIDANCE: If a step is a click in a dashboard, write the click path. If a step needs a
     credential, name the secret store entry, never the value. -->

## Verify the shipped artifact

<!-- GUIDANCE: Check what users actually receive, not the config that produced it. A green
     pipeline has shipped a page that still served the old bundle, an error reporter that a
     Content-Security-Policy silently blocked, a scheduled job that "succeeded" while ingesting
     nothing, and a fix checked against the wrong page. Each line here names the command or
     URL and the expected result, and is run after every production release. -->

- [ ] The deployed version is the one released, e.g. a commit SHA in a meta tag, a /version
      endpoint, or the store build number: [HOW TO READ IT] shows `[EXPECTED]`.
- [ ] The core flow works on production, by hand: [CORE FLOW, STEP BY STEP].
- [ ] The page or bundle that changed is the one checked: [URL OR SCREEN], not a neighbor that
      looks similar.
- [ ] An induced error reaches the error reporter from production (and isn't blocked by CSP or
      an ad blocker): [HOW TO INDUCE IT].
- [ ] Nothing secret shipped to the client: search the built assets for public-prefixed secret
      names and for values that should be server-only: [COMMAND].
- [ ] Scheduled or background jobs produced their output, not just a success status:
      [QUERY OR CHECK].

## Rollback

<!-- GUIDANCE: Decided before it's needed. Say how long it takes, what it doesn't undo (a
     migration, a sent email, a published app build), and who can do it. Rehearse it once on
     staging and record the date. -->

- **How:** [EXACT STEPS — e.g. promote the previous deployment, revert and redeploy]
- **Takes:** [MINUTES] · **Rehearsed on staging:** [DATE / NOT YET]
- **Doesn't undo:** [DATA CHANGES, EXTERNAL SIDE EFFECTS, STORE RELEASES]
- **Data:** [HOW A MIGRATION IS REVERSED OR RECOVERED, OR WHY IT'S FORWARD-ONLY]

## After an incident

Write a postmortem from the skeleton (docs/postmortem.md) in
`docs/postmortems/YYYY-MM-DD-<slug>.md`, and carry its lesson into the lessons-learned file.
