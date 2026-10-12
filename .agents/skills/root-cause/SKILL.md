---
name: root-cause
description: Use when something is broken and the cause isn't known. Runs prompts/investigate.md — reproduce the reported case, confirm a baseline, test hypotheses one at a time, fix the root cause, find sibling occurrences.
metadata:
  argument-hint: "<symptom, where it was seen, expected vs actual>"
---

Run the defect investigation exactly as written in `prompts/investigate.md`. Read that file
in full first; it is the authoritative instruction set, and this skill only wires it up.

1. **Assemble the inputs** from what was given with the request.
   Map them onto the prompt's inputs (symptom, where, expected vs actual, since when). If the
   symptom or where it was seen is missing, ask for both in one question before starting.
2. **Execute the phases in order.** Don't touch code before Phase 0 has a reproduction of
   the reported case.
3. **Report** using the prompt's "Output of this prompt" contract.
