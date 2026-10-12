# Contributing

<!-- GUIDANCE: Fill in the [BRACKETED] placeholders and delete these comments. Sections 1–3 are
     project policy — adjust them to how your team actually works, because a documented
     process nobody follows is worse than none. Section 4 is the production bar; edit it
     only to strengthen it. -->

## 1. Branches and commits

- **Default branch:** `[MAIN BRANCH]`. It deploys to [WHERE], so it stays green — work lands via
  pull request, never direct push.
- **Merge gate:** [HOW A RED CI RUN IS KEPT OUT OF THE DEFAULT BRANCH]
  <!-- GUIDANCE: e.g. "CI is a required check on main, through the ruleset in
       .github/rulesets/main.json." On a plan that can't enforce one (GitHub Free, private
       repository), say so instead of implying it: "Nothing enforces CI here: merge only when
       every check is green. .github/rulesets/main.json is kept, filled in, but not imported." -->
- **Branch naming:** `[PATTERN — e.g. feat/short-slug, fix/issue-123]`.
- **Commit convention:** `[CONVENTION — e.g. Conventional Commits, or imperative ≤ 72 chars]`.
  Either is fine; pick one and enforce it in review.
- **History policy:** [HISTORY POLICY — squash-merge, merge commits, or rebase, and why].

## 2. Before opening a PR

Run the full gate locally — a red CI run costs more of everyone's time than catching it
yourself would have:

```bash
[CHECK COMMAND — the same command CI runs]
```

## 3. PR checklist

Every pull request:

- [ ] Says what changed and why, in plain language. Link the issue if one exists.
- [ ] Is minimal — refactors beyond the request were flagged and agreed first.
- [ ] Passes the full local gate (section 2).
- [ ] Adds or updates tests for the change (see section 4 — this is not optional), and shows
      each new check failing against the defect it guards.
- [ ] Updates docs touched by the change: README, `.env.example`, an ADR if a consequential
      decision was made.
- [ ] Labels claims honestly: what was statically reviewed vs. executed vs. fully validated.

## 4. Definition of done

A feature is done only when **all** of these are true. The three items that reliably get
deferred — testing, error handling, accessibility — are the reason this list exists; none of
them belongs in a "later hardening" milestone, because by then the code that needed them is
load-bearing and the deferral is permanent.

<!-- definition-of-done:start -->

- **Types are strict and honest.** The project's agreed strictness (strict mode, or `checkJs`
  for a JavaScript codebase) holds and is never loosened to get green; raising it further is a
  flagged refactor, not a precondition. No escape-hatch types (`any` or equivalent) without an
  inline comment justifying the specific one.
- **Input is validated at every trust boundary** — user input, external API responses, and
  environment variables (through the typed env module, never raw access).
- **Failure modes are surfaced**, to the user or to a log with enough context to diagnose.
  No silent catches, no unhandled rejections, timeouts and retries on every external call, and
  no success reported for work that didn't happen.
- **Tests exist and pass:** unit coverage for the logic, at least one meaningful edge case
  (not a happy-path duplicate), and end-to-end coverage of the user-facing flow. A bug fix
  includes a test that reproduces the reported case and fails without the fix.
- **Checks prove they can fail.** A new test, validator, lint rule, or CI gate is shown failing
  against the defect it guards (a planted defect, or the fix reverted) before it's trusted. A
  check that enumerates things (a validator, a scanner, a list-driven suite) asserts it examined
  a nonzero number of them; skipped suites are reported rather than silent; an allow or
  exclusion list fails when an entry goes stale.
- **Authentication and authorization are enforced server-side**, with row-level or
  query-level tenancy checks anywhere data belongs to more than one user.
- **Data is handled carefully.** Migrations are reviewed, and each has a tested revert — or,
  where the change is destructive or the tooling is forward-only, a written and tested recovery
  path instead. Identifiers are stored as text where leading zeros or formatting matter; blank
  is distinguished from zero; display precision is kept separate from stored precision; each
  derived value is computed in one place; multi-step writes are wrapped in a transaction.
  Fixtures and the repo hold no real personal or customer data, and logs carry only the
  identifiers diagnosis needs (an ID, not a name or an email).
- **Observability is wired** — structured logs and error reporting, from the first milestone.
  The test: can you answer "what failed for user X yesterday?"
- **Accessibility basics hold** on all new UI, at WCAG 2.2 AA: labels, focus order, keyboard
  operability, focus never fully hidden behind sticky content, a single-pointer alternative to
  any drag, pointer targets at least 24px or spaced as if they were, and contrast at AA or
  better.
- **Docs are current:** README, `.env.example`, user-facing text that describes what a check or
  rule does, and an ADR if a consequential decision was made.
- **It's deployed to a preview or staging environment and smoke-tested** against what shipped
  (the deployed page, bundle, or build), not the config that produced it. Not "should work."

<!-- definition-of-done:end -->

## 5. Review

<!-- GUIDANCE: e.g. any maintainer for routine changes; schema and auth changes need a second reviewer.
     Decide and write it down. -->

- [WHO REVIEWS WHAT]
- A reviewer's job includes the checklist above — approving a PR that skips tests is
  co-signing the skip.
