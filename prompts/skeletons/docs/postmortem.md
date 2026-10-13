# Postmortem: [ONE-LINE SUMMARY OF WHAT BROKE]

<!-- GUIDANCE: Copy to docs/postmortems/YYYY-MM-DD-<slug>.md after any incident users felt, any
     data loss or exposure, and any near miss that only luck stopped. Blameless: name systems,
     checks, and decisions, not people. Write it while the logs still exist, and label every
     claim statically reviewed, executed, or fully validated. It's finished when every action
     item has an owner and names the check that will catch this next time. -->

Date of incident: [DATE] · Written: [DATE] · Author: [WHO] · Status: [DRAFT / REVIEWED]

## Summary

[TWO OR THREE SENTENCES: what users saw, for how long, and what fixed it]

## Impact

- **Who was affected:** [USERS, TENANTS, OR SYSTEMS, AND HOW MANY — MEASURED, OR MARKED AS AN ESTIMATE]
- **Duration:** [FROM FIRST BAD EVENT TO FULL RECOVERY]
- **Data:** [LOST, CORRUPTED, EXPOSED, OR NONE — AND HOW THAT WAS ESTABLISHED]

## Timeline

<!-- GUIDANCE: In UTC, from the change that introduced the problem (often days earlier) to
     recovery. Include when it could first have been noticed, not only when it was. -->

| Time (UTC) | Event |
| --- | --- |
| [TIME] | [EVENT — e.g. the change that introduced it merged, with a link] |
| [TIME] | [FIRST USER-VISIBLE FAILURE] |
| [TIME] | [DETECTED — BY WHOM OR WHAT] |
| [TIME] | [MITIGATED] |
| [TIME] | [RESOLVED, AND HOW THAT WAS VERIFIED] |

## Detection

<!-- GUIDANCE: How it was found, and why nothing found it sooner. If a check existed and passed,
     say why it passed: it examined nothing, it checked the config instead of the artifact, it
     ran against a fixture the real data didn't match. That answer usually matters more than
     the root cause. -->

- **Found by:** [ALERT, USER REPORT, OR A PERSON NOTICING]
- **Why not sooner:** [THE CHECK THAT SHOULD HAVE CAUGHT IT, AND WHY IT DIDN'T]

## Root cause

<!-- GUIDANCE: The mechanism, with evidence: the commit, the log line, the query that shows it.
     Keep asking why until you reach something a change to code, a check, or a process would
     have prevented. "Human error" is where the analysis starts, not where it ends. -->

[ROOT CAUSE, WITH EVIDENCE]

## What helped, what hurt

- **Helped:** [WHAT MADE DETECTION OR RECOVERY FASTER]
- **Hurt:** [WHAT MADE IT SLOWER — MISSING RUNBOOK STEP, UNCLEAR ALERT, NO ROLLBACK REHEARSAL]

## Action items

<!-- GUIDANCE: Each one small enough to finish, with an owner and a date. At least one adds a
     check (a test, a validator, an alert, a runbook step), and that check is shown failing
     against this incident's cause before the item is closed. -->

| Action | Owner | Due | Check that catches it next time | Status |
| --- | --- | --- | --- | --- |
| [ACTION] | [WHO] | [DATE] | [TEST, ALERT, OR RUNBOOK STEP, SHOWN FAILING FIRST] | [OPEN / DONE — PR LINK] |

## Lesson

[THE DURABLE LESSON, AS IT WILL APPEAR IN THE LESSONS-LEARNED FILE (skeleton: docs/lessons-learned.md)]
