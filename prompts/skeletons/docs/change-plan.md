# [CHANGE TITLE]

<!-- GUIDANCE: One plan per change that's big enough to need one (prompts/plan-change.md says
     when), kept at docs/changes/YYYY-MM-DD-<slug>.md and committed with the code it changes. It's agreed
     before the work starts and updated as tasks finish, so it reads as the change's record
     afterwards. Delete each guidance comment as you fill its section. -->

Kind: [FEATURE / BUGFIX / REFACTOR] · Drawn up: [DATE] · Owner: [WHO] · Status: [PROPOSED / AGREED / IN PROGRESS / DONE / DROPPED]

## Why

[THE PROBLEM, IN USER TERMS, AND WHO HAS IT: A LINE OF docs/product.md'S USERS OR MISSION IT SERVES]

## Behavior

<!-- GUIDANCE: For a feature, "Now" and "After". For a bugfix, "Now" is what happens (with the
     reproduction), "After" what should, and "Unchanged" what must stay exactly as it is: that
     list becomes regression tests, so a fix doesn't trade one bug for another. -->

- **Now:** [CURRENT BEHAVIOR]
- **After:** [THE BEHAVIOR THIS CHANGE DELIVERS]
- **Unchanged:** [BEHAVIOR THAT MUST NOT MOVE, EACH ONE TESTABLE]

## Out of scope

- [WHAT THIS CHANGE DELIBERATELY DOESN'T DO, AND WHERE IT'S TRACKED IF ANYWHERE]

## Against the rules

<!-- GUIDANCE: Read the plan against AGENTS.md (its operating rules and "stop and agree a plan
     first" list) and every accepted ADR. A plan that departs from one names it here, and the
     work doesn't start until an ADR records the decision. "None" is an answer; an empty section
     isn't. -->

- [RULE OR ADR] — [FOLLOWS IT / DEPARTS: HOW, AND THE ADR THAT RECORDS IT]

## Design

<!-- GUIDANCE: Only the parts this change touches, each concretely: data (schema, migrations,
     who can read and write each row), API (endpoints, contracts, errors), UI (states, including
     empty, loading, error, and disabled), environment (new variables, through the env module),
     security (authorization on every path, input validated at the boundary), observability
     (what's logged or reported when it fails), accessibility. -->

[FILL IN]

## Risks and rollback

- **Risk:** [WHAT COULD GO WRONG] — **watch:** [HOW YOU'D KNOW] — **if it happens:** [WHAT YOU DO]
- **Rollback:** [HOW TO UNDO IT, INCLUDING ANY DATA MIGRATION, OR WHY IT CAN'T BE UNDONE]

## Tasks

<!-- GUIDANCE: Small and in order, each independently reviewable where possible. Every task
     names the test that proves it: the file, and what it asserts. A task with no test names
     the manual check and why a test can't do it. Tick a task only when its test passes on the
     branch. -->

- [ ] [TASK] — proved by [TEST FILE: WHAT IT ASSERTS]

## Done when

- [ ] Every task's test passes, and the "Unchanged" list has a test each.
- [ ] The repository's full gate passes, and every new check was shown failing first.
- [ ] docs/product.md, the README, and any ADR are updated where this change moved them.
