# Lessons learned

<!-- GUIDANCE: The project's durable memory: the handful of things a new contributor, human or
     agent, would otherwise have to rediscover the hard way. Read it before non-trivial work.
     If the repo already keeps one (a LESSONS file, a "gotchas" section), use that instead of
     creating a second.

     What earns an entry: a defect class that has already happened more than once, or once
     expensively; a rule that exists because of an incident; a trap in the stack that the docs
     don't warn about. Not a changelog, not a status log, not a design doc.

     Keep entries short, and keep the file short. When a lesson recurs, the fix isn't a longer
     entry, it's a check: a test, a lint rule, or a CI step that makes the mistake fail loudly.
     Then shrink the entry to one line pointing at the check. A lessons file that grows without
     turning into checks is a list of things that will happen again. When the check would hold
     in other repositories too, propose it to the template as a standard, so they get it
     without having the incident first. -->

Last reviewed: [DATE]

## [LESSON TITLE — the rule, stated as an instruction]

- **What happened:** [THE INCIDENT OR DEFECT, WITH A LINK TO THE PR, ISSUE, OR COMMIT]
- **Why it slipped through:** [THE CHECK THAT SHOULD HAVE CAUGHT IT, AND WHY IT DIDN'T]
- **The rule:** [WHAT TO DO DIFFERENTLY, CONCRETELY]
- **Enforced by:** [THE TEST / LINT RULE / CI STEP, OR "not yet — tracked in LINK"]
