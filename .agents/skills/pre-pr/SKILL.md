---
name: pre-pr
description: Use when a change is ready to leave your hands — before opening or updating a pull request. Runs prompts/pre-pr.md — merge the base, run the full gate, prove new checks can fail, self-review, sweep docs, and draft the description.
metadata:
  argument-hint: "<one sentence on the change>"
---

Run the pre-PR checklist exactly as written in `prompts/pre-pr.md`. Read that file in full
first; it is the authoritative instruction set, and this skill only wires it up.

1. **Assemble the inputs** from what was given with the request, the current branch, and the repo's default
   branch as the base unless told otherwise.
2. **Work through the steps in order.** Don't push, and don't open the PR, unless asked to;
   this skill prepares the change and reports.
3. **Report** using the prompt's "Output of this prompt" contract.
