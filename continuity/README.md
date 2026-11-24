# Continuity ledger

The ledger records a decision, the evidence it depends on, and later observations about that
evidence. It runs with Node and Git in a clean checkout. Each repository owns its ledger.
Start with the [template's ADR 0023](https://github.com/JoelA510/agent-ready-template/blob/395863275232b92b920c2595a4998b41e5b80f13/docs/adr/0023-content-bound-continuity.md) for the design choice.

## Check a decision

Run from the repository root, or supply `--root PATH`. To inspect an existing decision, set
`id` to the decision's full filename stem in `continuity/ledger/`. A unique lowercase hex
prefix of at least 12 characters also works in the CLI. Use full IDs in records and PRs.

```sh
node continuity/gate.mjs status "$id" --tree HEAD
node continuity/gate.mjs is-current "$id" --tree HEAD
node continuity/gate.mjs report --tree HEAD --json
```

`is-current` succeeds only for HELD. A local read with no `--tree` uses the working ledger
and the staged Git evidence. An explicit commit reads records and evidence from that commit.
Checking the protected base adds assurance that a candidate retained reviewed history.
Use the actual base and candidate merge commits provided by your PR system.

```sh
node continuity/gate.mjs verify --base "$base" --tree "$candidate"
node continuity/gate.mjs check --base "$base" --tree "$candidate" --stale warn
```

## Record and revalidate

Use `append` for a decision the team will rely on later. Name a workstream, state the claim,
and cite each supporting file with a repo-relative path. The following illustrates the input
for an architectural decision. Check existing records first to avoid recording it twice.

```sh
node continuity/gate.mjs append --workstream architecture \
  --title "Clean checkout" --statement "The shared core runs without local memory services." \
  --cite docs/adr/0022-shared-core-and-two-agent-targets.md
```

The returned decision ID is initially UNCHECKED. Stage the intended evidence first. Local writes
refuse unstaged changes to cited files. Supply `--tree COMMIT` to observe an immutable commit
instead. Writers append to the working ledger in either case. Record a receipt only after
checking the claim against the selected evidence. For this example, inspect the cited ADR,
run the relevant clean-clone check, and put its command and observed result in `method`.

```sh
node continuity/gate.mjs revalidate "$id" --outcome held --method "$method"
node continuity/gate.mjs status "$id"
git add -- continuity/ledger
```

An observed failure uses `--outcome failed`. When the claim or its evidence set changes,
append another decision with `--supersedes "$id"`. An explicit citation of the old decision
then returns STALE. Preserve both records. Revalidating preserves the original set of citation
identities and observes their present contents.

| Status | Meaning |
| --- | --- |
| UNCHECKED | The decision has no receipt. |
| FAILED | At least one causally latest receipt records failure. |
| STALE | The decision was superseded, the latest successful observations disagree, evidence changed or disappeared, or an external proof expired. |
| HELD | The latest observations agree, succeeded, and still match their evidence in this snapshot. |

A new receipt that descends from all conflicting heads can reconcile them. Timestamps have no
vote. Workstream labels organize decisions; they grant no privileges.

## What the PR check selects

Write `continuity`, a colon, and the decision ID as one whitespace-delimited token in the PR
body or an added non-ledger diff line when the change relies on it. HTML comments in the PR
body are ignored. The check also selects active decisions whose cited file or local proof
was changed, renamed or deleted. It verifies the whole graph even when no decision is selected.
Appending a failed observation alone preserves the failure for the next dependent change.

The initial policy warns on selected STALE and blocks FAILED, UNCHECKED, malformed references,
and integrity failures. Weekly and manual audits examine all active decisions, including
expiring proofs. The maintainer can propose moving to `--stale block` after four consecutive
weekly audits on main, at least ten active decisions in two workstreams, at least three
stale-to-revalidated transitions, passing negative controls, and zero unresolved false blocks
or active stale records. Record the run IDs, invalidations and typical revalidation time in
the promotion PR. A rollback to warning mode changes only the handling of STALE.

## Format and trust

Schema version 1 uses one regular file `ledger/<sha256>.json` per record. The filename hashes
the canonical UTF-8 JSON without the final LF. The stored bytes have exactly one LF after it.
Keys sort recursively, arrays retain their declared order, strings use JSON escaping, and
timestamps are UTC to the second. The gate rejects duplicate or unexpected fields, malformed
text, unsorted or duplicate parent/citation identities, and unknown versions. Records are
bounded to 256 KiB, 128 citations and 256 parents.

- Common fields are `v`, `type`, `ts`, `workstream`, `prev`, and `cites`. Each decision adds
  `title` and `statement`, and may name an earlier decision in `supersedes`. Each receipt adds
  `of`, `outcome`, and `method`, and may include public `attestations`.
- A `git-file` citation records `path`, `mode` (100644 or 100755), and SHA-256 of the exact Git
  blob bytes. A failed observation may identify a missing cited file by kind `missing` and
  `path`. Links, submodules, paths outside the repository, and citations into the ledger are
  refused.
- Supply one external citation as a JSON object via `--ref-file FILE`. Its `kind` is `ref`,
  with `uri`, `sha256` of the external bytes, UTC `expires_at`, and a tracked `proof_path`
  and `proof_sha256`. Revalidation supplies a fresh observation for every external URI.
  The gate checks the local proof and expiry. Authenticating the external source and
  obtaining its bytes are the verifier's responsibility.
- An optional Nomos object in `--attest-file FILE` records `system` (`nomos`), `kind`,
  `artifact_id`, `format_version` and `artifact_sha256` of the exact signed artifact bytes.
  For a Writ, include the council ID, trusted issuer fingerprint and intent hash. For
  execution evidence, include the executor fingerprint, Writ ID and intent hash. For a
  ledger entry, preserve its native algorithm-qualified content hash in `ledger_hash`
  and its sequence if available. A signed Writ, an executor receipt, and the council
  ledger entry have different identities. The local verifier checks signatures and
  subject/audience against a separately configured trust store before exporting public
  metadata. Core validates the metadata's shape. Keep tokens, original executable Writs,
  private payloads and raw command output outside Git.

One genesis and its parent links join all workstreams. Different branches can add immutable
records sharing the same parent. After merging, the next append refers to all observed heads.
Writers use a lock for the local checkout. If a process dies while writing, stop and inspect the
active writers and any scratch file before removing its abandoned `continuity/.append-lock`
directory. Never remove or repair reviewed records to recover a writer.

A checksum catches changed bytes under an existing filename. Someone who can replace every
record can construct a different self-consistent graph. Verification against a trusted
protected-base commit detects lost or rewritten records even then. Preserve that external
anchor and protect changes to the workflow and gate in review. The bootstrap change lands
the seed and reader on the protected branch under ordinary CI. A subsequent change adds the
PR workflow against that base. Require its status after observing a successful run. A held
receipt cannot certify its own method or grant authority to execute an action.
