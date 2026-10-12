# [PROJECT]: product

<!-- GUIDANCE: The context every change is planned against (prompts/plan-change.md reads it
     first). One page. It says what the product is for and what it refuses to become; the code,
     the ADRs, and AGENTS.md say how. Update it in the same change as anything that moves a line
     here, and date the change in the history at the bottom. Delete each guidance comment as you
     fill its section. -->

Last changed: [DATE]

## Mission

[ONE OR TWO SENTENCES: WHAT THE PRODUCT DOES, AND FOR WHOM, IN USER TERMS]

## Users

<!-- GUIDANCE: The people who use it, by role, each with the job they come to do. Name who is
     NOT a user too, when someone might assume they are (an admin console nobody outside the
     team sees). -->

| User | Comes to | Can't be assumed to |
| --- | --- | --- |
| [ROLE] | [THE JOB THEY HIRE THE PRODUCT FOR] | [WHAT THEY DON'T KNOW OR HAVE: AN ACCOUNT, A DESKTOP, ENGLISH] |

## Non-goals

<!-- GUIDANCE: What the product deliberately doesn't do, each with why. A plan that drifts into
     one of these needs an explicit decision (an ADR), not a quiet scope creep. -->

- [A THING IT WON'T DO] — [WHY]

## Constraints

<!-- GUIDANCE: Facts the product can't change: budget, hosting plan limits, legal or privacy
     rules (verify; don't assume, especially for minors' data), data the product must keep or
     must never keep, platforms, deadlines. Each with its source. -->

- [CONSTRAINT] — [SOURCE: A LAW, A CONTRACT, A PLAN LIMIT, A DECISION AND WHO MADE IT]

## Glossary

<!-- GUIDANCE: Terms with a specific meaning here, so plans, code, and copy use one word for one
     thing. Delete the section if there are none yet. -->

| Term | Means |
| --- | --- |
| [TERM] | [DEFINITION] |

## History

| Date | Change | Why |
| --- | --- | --- |
| [DATE] | First version | [FILL IN] |
