---
id: core.error-reporting
title: You can answer "what failed for user X yesterday?"
severity: high
enforcement: audit
audit-area: 9
---

**Requires:** errors from every running part of the product reach an error reporter or a structured
log someone can query, with enough context to diagnose (an ID, not a name or an email), from the
first milestone.

**Why:** an error nobody sees is a defect nobody fixes. A user report with no matching event can't be
diagnosed.

**Audit question:** pick a real failure path (a rejected API call, a thrown render error, a failed
background job). Trigger it in a deployed environment. Can you find the event, by user and time, and
does it carry what you need to fix it?
