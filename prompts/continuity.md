# Record or check a continuity decision

Use the repository's [continuity gate](../continuity/README.md) when a decision will be
relied on across changes. The caller supplies the claim, the files or external proof it rests
on, or an existing decision ID.

- **Record.** Identify the workstream and the evidence that would invalidate the decision if
  it changed. Append the stated decision against the intended Git snapshot. Report its ID and
  initial state. A change to the claim or its citation set needs a superseding decision.
- **Revalidate.** Read the claim, identify its citations, and perform the check that establishes
  whether it still holds on the selected snapshot. Record the observed outcome and the method
  actually used. A runner that could not perform the check cannot supply a held receipt.
- **Inspect a citation.** Use the gate's status and currentness results. Report the decision ID,
  snapshot, status, and reason for an unresolved or stale result. Inspecting a citation leaves
  the ledger alone.

Include the decision marker in a pull request that relies on it. Stage newly created ledger
files with their supporting evidence when preparing the change. Credentials, raw private
transcripts, and signed bearer material belong in the operator's private evidence store.
