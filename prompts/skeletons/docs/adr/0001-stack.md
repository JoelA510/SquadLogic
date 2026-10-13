# 0001. Stack: [ONE-LINE SUMMARY OF THE CHOSEN STACK]

- **Status:** [Proposed / Accepted]
- **Date:** [YYYY-MM-DD]
- **Deciders:** [WHO MADE THE CALL]
- **Applies to:** the whole codebase

<!-- GUIDANCE: Phase 1 output in decision-record form. One primary stack, each component justified,
     each rejected alternative given its one-sentence reason. If two stacks were genuinely
     close, say so and name the tiebreaker — "close call, tiebreaker was X" ages far better
     than false certainty. -->

## Context

Project: [PROJECT] — [ONE-PARAGRAPH DESCRIPTION AND TARGET USERS].
Platform targets: [PLATFORM TARGETS: web / mobile / web+native / API-only / desktop].
Constraints: [HOSTING, BUDGET, EXISTING ACCOUNTS, TEAM SIZE, SKILLS].
Stated preferences: [ANY, and whether they were honored or overridden — and why].

Reference patterns informing this choice were verified on [DATE] — see
[`../reference-verification.md`](../reference-verification.md). Anything borrowed from a
stale or unverified source is marked provisional there.

## Decision

We will build [PROJECT] on:

| Component | Choice | Why (one honest sentence) | Rejected alternative | Why it lost (one sentence) |
| --- | --- | --- | --- | --- |
| Language | [FILL IN] | [FILL IN] | [FILL IN] | [FILL IN] |
| Framework | [FILL IN] | [FILL IN] | [FILL IN] | [FILL IN] |
| Database & ORM/access | [FILL IN] | [FILL IN] | [FILL IN] | [FILL IN] |
| Auth | [FILL IN] | [FILL IN] | [FILL IN] | [FILL IN] |
| Styling / UI | [FILL IN] | [FILL IN] | [FILL IN] | [FILL IN] |
| Testing | [FILL IN] | [FILL IN] | [FILL IN] | [FILL IN] |
| CI & hosting | [FILL IN] | [FILL IN] | [FILL IN] | [FILL IN] |

[If two stacks were genuinely close: name the runner-up and the tiebreaker in one sentence.]

## Consequences

- **Easier:** [WHAT THIS STACK MAKES CHEAP FOR THIS TEAM AND PRODUCT]
- **Harder / owned:** [WHAT THE TEAM NOW MAINTAINS, UPGRADES, OR MUST LEARN]
- **Locked in:** [MIGRATIONS THIS FORECLOSES OR MAKES EXPENSIVE]
- **Revisit if:** [THE CONCRETE CONDITION — a scale number, a platform change, a dependency signal]

## Verification

- [The command that proves the walking skeleton runs on this stack, e.g. the full CI gate]
- [Where the pinned versions live — lockfile, manifest — and what enforces them]
