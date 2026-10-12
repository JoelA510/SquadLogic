---
name: template-update
description: "Use when this repository should take a release of the template it was built from, or a template update pull request needs finishing. Runs prompts/template-update.md — finds the template version it has, reads the CHANGELOG to the release, brings the process files across, merges each parked .template, and does what the release's entries ask."
metadata:
  argument-hint: "<the release tag to take, and the template's repository URL>"
---

Take the update exactly as written in `prompts/template-update.md`. Read that file in full first;
it is the authoritative instruction set, and this skill only wires it up.

1. **Assemble the inputs** from what was given with the request, the branch you're on (a
   `template/process-...` branch is a fleet update already under way), and the AGENTS.md
   Workflows section, which names the template's repository. If the release isn't given, ask for
   it in one question.
2. **Work through the steps in order.** Step 1 can end the run: without a recorded starting
   point, an update can't tell this repository's edits from an old delivery.
3. **Report** using the prompt's "Output of this prompt" contract.
