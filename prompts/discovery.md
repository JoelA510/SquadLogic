# Discovery prompt template

Two prompts. **Stage 0** surveys a project and names the questions worth a discovery pass before the next piece
of work. **Stage 1** runs one of those passes. Treat both as a menu, not a form: fill every `{{PLACEHOLDER}}`,
delete any block the task doesn't need, then search for leftover `{{` before pasting.

---

## Stage 0: find the discovery candidates

Paste this with the Stage 1 template below it, so the session can draft the filled Stage 1 for the candidate you
pick.

```
Task: find the best discovery candidates in {{PROJECT}} (read-only)

Goal
I'm about to {{UPCOMING WORK, or: "start the work this project's own plan says is next"}}. Before that, I want
to know which open questions are worth a discovery pass first: the places where an assumption is carrying weight
the source hasn't confirmed. This is a survey, not the discovery itself, so name the candidates and give the
evidence for each, but don't answer them.

Read {{ORIENTATION FILES, e.g. CLAUDE.md, README, the docs index, any decisions or open-questions file}} first.
Then look for candidates in:
* open decisions, TODO and FIXME notes, open issues, and decision logs;
* places where docs and source disagree, or where two files both claim to be the source of truth;
* assumptions about external systems (APIs, browser rules, hosting, licenses, platform policies) that nothing
  in the project verifies;
* parts many other parts depend on (schema, interfaces, shared modules, an outline), and parts the history
  shows being fixed more than once;
* anything the upcoming work will build on.

For each candidate give: the decision it supports; what depends on it; what's unknown and where the answer
probably lives; what being wrong would cost and how reversible it is; what is about to build on it, which is
its deadline; the facts you would need from me; and the evidence, as a location plus a short quote.

Group the candidates as "run before the upcoming work", "run soon" and "can wait", with the reason for each
placement. Don't score them: the grouping and its reasons are the ranking, because a number would claim a
precision this survey doesn't have. Keep the full entries to the {{N, e.g. five to seven}} candidates that
would change what I do next, and name the rest in one line each.

Then stop. When I pick a candidate, draft its discovery prompt from the Stage 1 template below, filled in from
what you found. Leave as {{PLACEHOLDERS}} the facts only I can supply.
```

---

## Stage 1: the discovery pass

```
Task: {{ONE-LINE TASK}} ({{MODE, e.g. "read-only discovery" or "discovery, then build"}})

Goal
{{WHAT I NEED TO SEE OR HAVE, AND THE DECISION IT SUPPORTS}}. The decision is {{WHOSE}}, because {{REASON}}.
{{KEEP ONE OF THESE TWO LINES:}}
Lay out the options with their costs and don't recommend one, because {{REASON, e.g. "the call is a judgment
that's mine to make, and a recommendation tends toward the most probable answer"}}.
Recommend one option, and name the alternatives you rejected and why.
{{DEADLINE, if any: what is about to build on this, and when.}}

Reference (the source of truth)
{{THE AUTHORITATIVE SOURCES, AND WHICH WINS WHEN THEY DISAGREE}}. Treat {{THE REFERENCE: an implementation, a
spec, canon, a contract}} as the reference and port it faithfully. If you change a behavior, a constant or a
settled fact, flag it and show its effect on {{GOLDEN VALUES OR INVARIANTS}}; don't change it silently. Where the
source conflicts with a direction I've given, say what each version does and leave the choice to me.

Discovery first. Do not assume structure.
Read {{ORIENTATION FILES}}. Search {{ANY SOURCE TOO LARGE TO LOAD WHOLE}} instead of loading it, so the context
stays free for the work. Use subagents only for large reads that are independent of each other, at most {{N}},
and never to re-check work. Then answer from the source, not from memory, with a location and a short quote
for each answer; where the source doesn't say, write "not in the source":
* {{WHERE THE RELEVANT THING LIVES, AND ITS CURRENT SHAPE}}
* {{THE PROJECT'S EXISTING PATTERN FOR THIS KIND OF CHANGE}}
* {{AN EXTERNAL SYSTEM'S BEHAVIOR: check its documentation and a live response rather than inferring it}}
* {{WHERE NEW WORK BELONGS BY THE PROJECT'S OWN CONVENTIONS, AND WHICH FILES MUST POINT TO IT}}

Then present a plan (what you'll build or produce, where it lives, how it stays current) and stop for my
go-ahead. If a requirement looks wrong or you see a better route, say so in one sentence in the plan, then plan
what I asked for.

Build order (after my go-ahead; stop after each step, because I check the pilot before the method scales)
  a. {{THE SMALLEST SLICE THAT EXERCISES THE WHOLE METHOD}}
  b. {{THE REST}}
  c. {{ANYTHING EXPENSIVE, only when I say}}

Done looks like
* Discovery: every question answered with a location and a quote, or "not in the source".
* {{EACH DELIVERABLE, AS A COVERAGE PROPERTY, e.g. "each trace covers every source type", not an expected
  answer}}
* {{THE PROJECT'S CHECKS: tests, linters, house checks}} pass.

Deliverables
1. {{DELIVERABLE, AND WHAT EACH ENTRY MUST CARRY}}
2. {{DELIVERABLE}}
Every result carries its provenance ({{SOURCES, VERSIONS, TIMESTAMPS, AUTHORSHIP}}) as data the output is built
from, not only as prose around it.

<facts_from_me>
{{FACTS ONLY I CAN SUPPLY: which accounts exist, which threshold applies, who is a real person}}
Use these as given. For anything not listed, mark it "unknown" instead of inferring it, because the source
doesn't record it and a wrong guess would {{CONSEQUENCE}}.
</facts_from_me>

Output
{{SHAPE: which files, which formats; tables for enumerable facts, prose for reasoning and options}}. Cover the
substance without filler sections or recaps. In chat, after each step, lead with what you found, then what you
need from me.

Constraints
* Match the project's existing stack and conventions; they override generic best practice, because they encode
  context a general rule doesn't have.
* Keep changes minimal, and flag any refactor beyond the request before doing it, because review cost grows
  with the size of the change.
* Every count comes from a command you ran, shown alongside it, because a remembered count is a guess.
* Cite only sources you opened. If a link or reference doesn't resolve, flag it rather than substituting
  another.
* Never fill a gap with invented data or material, because an invented fill reads as fact to the next person
  or session; say what's missing instead.
* Mark anything stubbed.
* A confirmation from me covers only the items I was shown, as shown. If a list or a finding behind a
  confirmation changes, put it back to me rather than carrying the confirmation over, because I confirmed
  what I saw, not what you later found.
* {{PROJECT RULE}}, because {{REASON}}.
* Commit, push and open a PR only when I say.
* In the summary, separate what you found by reading or searching, what you executed or tested, and what was
  confirmed live or by me.

Out of scope (note as follow-ups; don't do)
* {{EXCLUSION}}
```

---

## Running it

- **One pass per session, in a fresh session.** Answers should come from the source, not from an earlier
  conversation's conclusions. Run Stage 0 in one session and each Stage 1 in its own.
- **Type one line of your own before pasting**, such as "Run the prompt below; I wrote it." If the app wraps a
  large paste in pasted-content tags, the model follows instructions inside it only where your own words ask.
- **Set effort explicitly** in the session's model settings. `high` suits discovery. Move to `xhigh` only if the
  pilot shows a gap that better wording doesn't close.
- **Write a held-out check before you run Stage 1:** three to five things a complete answer must find, kept out
  of the prompt. Compare the pilot against it. Fix the wording behind each miss rather than adding emphasis,
  and don't let the session scale up until the pilot passes.
- **Pick the decision mode deliberately.** Choose "options, no recommendation" when the call is a judgment
  that's yours (creative work, values, authorship). Choose "recommend" for engineering choices with a
  checkable right answer.
- **Confirm items, not summaries.** When you confirm something, look at the list itself. On one project a
  confirmation was given on a model-built list of four that turned out wrong; the review caught it, but the
  constraint above is there so the session raises it without needing a review.
- **Keep the prompt free of the expected answers.** "Done looks like" states coverage ("covers the logs, the
  novel and the plan"), never findings ("finds Chapter 94"); the findings belong in the held-out check.

## Starting points by project type

Generic places to look, for Stage 0 to confirm or discard against the actual project. These aren't findings
about your projects.

| Project type | Where discovery usually pays first |
|---|---|
| Portfolio site | Where content's source of truth lives; the build and deploy path; image and font licenses; analytics and privacy |
| Repo template | What's fixed versus parameterized; how a template change reaches repos already made from it; CI and license defaults |
| Shipping documentation software | Which rules are external and versioned (carriers, customs) and how the software learns a rule changed; real documents to use as golden tests |
| Youth sports league app | Role scoping and row-level access; which privacy rules apply to minors' data (verify, don't assume); external APIs and what the browser can call |
| Web-app game | The game-state model and save compatibility across versions; determinism; a performance budget; asset licenses |
| Long-form writing | What's settled versus invented; what depends on what (setups and payoffs); provenance and authorship; who is a real person |
