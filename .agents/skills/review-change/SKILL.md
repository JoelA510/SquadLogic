---
name: review-change
description: Use when someone asks for a review, a critical or hard look, or a second opinion on a change before it merges, whether a PR, a branch, a diff range, or a pasted diff. Runs prompts/review.md — an adversarial, evidence-cited review, including the "passes its own tests" failures.
metadata:
  argument-hint: "<PR number, branch, diff range, or the diff itself>"
---

Run the adversarial review exactly as written in `prompts/review.md`. Read that file in full
first; it is the authoritative instruction set, and this skill only wires it up.

1. **Resolve the target** from what was given with the request (a PR number, a branch, a `base..head` range, or a
   diff pasted or saved to a file).
   If nothing is given, review the current branch against its base. State the exact range,
   or the diff, before reviewing.
2. **Run the passes in order** and verify every finding before reporting it.
3. **Report** using the prompt's "Output of this prompt" contract.
