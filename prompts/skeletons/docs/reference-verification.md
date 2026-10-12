# Reference verification

<!-- GUIDANCE: Phase 0 output. Fill in one row per reference actually consulted; list the skipped ones.
     This table is what separates "borrowed from a maintained source" from "copied from
     something that quietly died two years ago" — it's mandatory before any pattern is
     borrowed, and it's dated because its conclusions expire. -->

**References verified as of [DATE].**

Staleness rule: a reference is STALE if its last commit is more than 9 months old, **or** it
targets a framework one major behind current at time of execution. Stale references may still
supply architectural ideas (boundaries, naming, test strategy) but never dependency versions,
config files, or API usage verbatim.

<!-- GUIDANCE: Issue activity is the issues open now, and the issues opened in the last 90 days
     with how many are still open (e.g. "81 open; 3 opened, 3 still open"). It doesn't make a
     reference stale; it's a warning: one whose recent issues mostly sit unanswered is called
     that here, and borrowed from less. Note under the table which channel each column came
     from: the GitHub API, the web page, or git alone (a depth-1 clone gives the last commit and
     package.json, but no issues: write "not available (git only)"). A number you read through
     a page summary is executed, not fully validated; say so. -->

| Reference | Last commit | Framework majors | Issue activity | Status | How it will be used |
| --- | --- | --- | --- | --- | --- |
| [REFERENCE] | [YYYY-MM-DD] | [FRAMEWORK MAJORS, e.g. framework@15, lib@11] | [OPEN NOW; OPENED IN 90 DAYS, STILL OPEN] | current / stale / unreachable | [WHAT IS BEING BORROWED, AT WHAT FIDELITY] |

Sources: [WHICH CHANNEL GAVE EACH COLUMN]

## Yardsticks when no reference fits

<!-- GUIDANCE: If none of the listed references fit this stack, say so and name what was used
     instead: the stack's official docs (with the version they describe) and the repo's own
     stated rules. Delete this section if a listed reference fits. -->

- [OFFICIAL DOCS OR STATED RULES USED, WITH VERSION] — [WHY NO LISTED REFERENCE FIT]

## Skipped

<!-- GUIDANCE: References not relevant to this stack, with a word on why. An empty section means
     everything listed in the prompt was checked. -->

- [REFERENCE] — [WHY IT DOESN'T APPLY HERE]

## Provisional patterns

<!-- GUIDANCE: Anything borrowed from a stale or unverified source. Each entry is a standing TODO to
     re-verify or replace. If verification was skipped entirely (offline), say so here and
     mark every borrowed pattern provisional. -->

- [PATTERN] — borrowed from [REFERENCE] ([STALE / UNVERIFIED]); revisit when [CONDITION]
