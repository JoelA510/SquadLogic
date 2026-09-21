/**
 * Machine-readable reason codes for publication state, parity, change notices
 * and the downstream sync registry.
 *
 * Same two rules as the eleven modules before it:
 *
 * 1. **`code` is the contract, `message` is decoration.** Never parse a message.
 * 2. **Severity lives in a table, never at a call site.**
 *
 * Severities and statuses come from `constraints/reasonCodes.js`, so a
 * publication finding lands in the same list as a facility, timing,
 * availability, waiver, rule, resolve, attribution or reserve one and
 * {@link derivePublicationStatus} reads nothing but `finding.severity`.
 *
 * ## Why some of these are `blocking` and some are `info`
 *
 * The acceptance test this module is built around turns on one distinction:
 * **an addition is not a divergence.** 112 rows exist in the working schedule
 * that were never in the published rec artifact — the whole 11v11 layer — and
 * reporting them as differences would be a 112-row false alarm on a schedule
 * that is in fact perfectly faithful. So {@link PUBLICATION_REASON.PARITY_ROW_ADDED}
 * is `info` and {@link PUBLICATION_REASON.PARITY_ROW_REMOVED} is `blocking`: a
 * row that appeared is news, a row families were told about and that is now
 * gone is a game somebody loses (incident 10, one layer up).
 *
 * @module publication/reasonCodes
 */

import {
  CONSTRAINT_SEVERITY,
  CONSTRAINT_STATUS,
  deriveConstraintStatus,
} from '../constraints/reasonCodes.js';

/**
 * How badly a finding counts against a publication result.
 *
 * @readonly
 * @enum {string}
 */
export const PUBLICATION_SEVERITY = CONSTRAINT_SEVERITY;

/**
 * The three-state outcome of any check in this module.
 *
 * @readonly
 * @enum {string}
 */
export const PUBLICATION_STATUS = CONSTRAINT_STATUS;

/**
 * How long a publication snapshot survives.
 *
 * One member, and it is on the record rather than only in the docs, because a
 * consumer holding the object has to be able to learn the limitation from the
 * object: a snapshot passed around in this process is gone when the process
 * is.
 *
 * **Still one member after GAP-29 Stage 2 gave the package a store.** See
 * {@link PUBLICATION_REASON.SNAPSHOT_IN_MEMORY_ONLY} for why: nothing in this
 * package can produce a `persisted` value honestly, because
 * `readPublicationSnapshot()` cannot tell a row of `publication_baselines`
 * from a fixture file. Durability is a property of where a copy was put, and
 * a snapshot object is not that copy.
 *
 * @readonly
 * @enum {string}
 */
export const PUBLICATION_DURABILITY = Object.freeze({
  /** Lives for the lifetime of the process and no longer. */
  IN_MEMORY: 'in-memory',
});

/**
 * The four buckets a parity comparison partitions its two row sets into.
 *
 * Enumerated from **both** inputs, never from the matched set:
 * `matched + differing + added + removed === rowsCompared`, and a partition
 * that does not add up is {@link PUBLICATION_REASON.PARITY_PARTITION_INCOMPLETE}
 * at blocking.
 *
 * @readonly
 * @enum {string}
 */
export const PARITY_BUCKET = Object.freeze({
  /** Same identity, every compared field equal. */
  MATCHED: 'matched',
  /** Same identity, at least one compared field different. */
  DIFFERING: 'differing',
  /** In the current schedule and not in the published artifact. */
  ADDED: 'added',
  /** In the published artifact and not in the current schedule. */
  REMOVED: 'removed',
});

/**
 * How a downstream destination gets its copy of the schedule.
 *
 * The distinction is not decoration: **a pull destination cannot be told it is
 * stale.** The public site auto-synced daily from a master file, so when its
 * pointer went stale nothing here could push a correction — the remedy is at
 * the destination, and a report that says "stale" without saying which way the
 * data flows sends an operator to the wrong end of the pipe.
 *
 * @readonly
 * @enum {string}
 */
export const SYNC_DESTINATION_KIND = Object.freeze({
  /** The destination fetches from us on its own schedule. */
  PULL: 'pull',
  /** We send to the destination. */
  PUSH: 'push',
  /** A person copies it across. */
  MANUAL: 'manual',
});

/**
 * What a change notice says happened to one fixture.
 *
 * @readonly
 * @enum {string}
 */
export const NOTICE_CHANGE_KIND = Object.freeze({
  /** Published, still exists, and something families were told has changed. */
  CHANGED: 'changed',
  /** Not in the published artifact; new since publication. */
  ADDED: 'added',
  /** Published and no longer in the schedule. */
  REMOVED: 'removed',
});

/**
 * Every reason this module can give.
 *
 * @readonly
 * @enum {string}
 */
export const PUBLICATION_REASON = Object.freeze({
  /* -- snapshots ------------------------------------------------------------ */
  /**
   * The snapshot's stored digest does not match a digest recomputed over its
   * rows.
   *
   * `blocking`. Without durability the digest is the only thing standing
   * between "the artifact families were sent" and "an object somebody edited",
   * and a snapshot whose rows no longer hash to its stamp cannot be used as
   * ground truth for anything.
   */
  SNAPSHOT_DIGEST_MISMATCH: 'SNAPSHOT_DIGEST_MISMATCH',
  /**
   * This snapshot *record* lives in memory. Provenance, emitted on every
   * snapshot.
   *
   * `info`, because it is a stated property of the object rather than a defect
   * — but it is stated, in the findings and on the record's `durability` field,
   * so nobody reads a snapshot handed around in this process as a durable
   * audit artifact.
   *
   * **The emission stays unconditional, and after GAP-29 Stage 2 that is a
   * decision rather than an inheritance.** The store exists
   * (`public.publication_baselines`, `20260920000000`), so it is fair to ask
   * why a stored snapshot does not say `persisted` instead. Because nothing
   * could produce that value honestly:
   * {@link import('./serialise.js').readPublicationSnapshot} is handed a
   * document and has no way to tell a row of that table from a fixture file, so
   * a second member of {@link PUBLICATION_DURABILITY} would be a branch no
   * input can take — which this repository counts as evidence of a missing
   * feature rather than as coverage. Durability is a property of *where a copy
   * was put*, and this record is not that copy. A caller that wants to know
   * whether a baseline is stored asks the store; that is what
   * `frontend/src/hooks/usePublicationBaselines.js` lists.
   *
   * The *message* is falsifiable, and that is the part a reader can check: it
   * names `serialisePublicationSnapshot()` / `readPublicationSnapshot()` and
   * the RPC and table a copy goes to, and `tests/publicationParity.test.js`
   * enumerates the repository to hold that naming true — where it once
   * required no production caller, it now requires the writer and the reader
   * it names.
   */
  SNAPSHOT_IN_MEMORY_ONLY: 'SNAPSHOT_IN_MEMORY_ONLY',
  /** A snapshot was created. Provenance, with the row count and the digest. */
  SNAPSHOT_CREATED: 'SNAPSHOT_CREATED',

  /* -- parity --------------------------------------------------------------- */
  /**
   * A published fixture is still there and something families were told about
   * it has changed. `blocking`.
   */
  PARITY_ROW_DIFFERS: 'PARITY_ROW_DIFFERS',
  /**
   * A fixture exists now that the published artifact never contained.
   *
   * `info`, and this is the code the acceptance test turns on. The 11v11 layer
   * is 112 rows that were never in the published rec schedule; calling them
   * differences would be a false alarm on a faithful schedule.
   */
  PARITY_ROW_ADDED: 'PARITY_ROW_ADDED',
  /** A published fixture is not in the current schedule at all. `blocking`. */
  PARITY_ROW_REMOVED: 'PARITY_ROW_REMOVED',
  /** Every compared row matched. Provenance, with the counters. */
  PARITY_ROWS_MATCHED: 'PARITY_ROWS_MATCHED',
  /**
   * The comparison examined zero rows, or compared zero fields.
   *
   * `blocking`. "Parity holds" is a true statement about an empty comparison
   * and means nothing — incident 4, on the one assertion this module exists to
   * make.
   */
  PARITY_VACUOUS: 'PARITY_VACUOUS',
  /**
   * A compared field is absent on one side of a matched pair, so the two rows
   * cannot be compared on it.
   *
   * `blocking`, never a silent equality. An adapter whose source has no
   * `Division` column must be told to leave division out of the comparison —
   * not have `null === null` read as agreement, and not have `null` read as a
   * difference either.
   */
  PARITY_FIELD_ABSENT: 'PARITY_FIELD_ABSENT',
  /**
   * A field both sides carry was neither part of the identity nor compared.
   *
   * `compromise`. The subject is narrower than the data, which is legitimate
   * and must not be silent: "567/567 match" means nothing until you know on
   * how many columns.
   */
  PARITY_FIELD_UNCOMPARED: 'PARITY_FIELD_UNCOMPARED',
  /**
   * The four buckets do not account for every input row exactly once.
   *
   * `blocking`. The partition is **counted**, not asserted from the way the
   * lists were built, which is why the count can fail at all.
   */
  PARITY_PARTITION_INCOMPLETE: 'PARITY_PARTITION_INCOMPLETE',
  /**
   * One identity key names more than one row on a side.
   *
   * `compromise`. The rows are still paired, in order, and the surplus falls
   * into `added` or `removed` — but a key that does not identify a row is a key
   * that can pair the wrong two, and a comparison run on one is worth less than
   * it looks.
   */
  PARITY_KEY_AMBIGUOUS: 'PARITY_KEY_AMBIGUOUS',

  /* -- field-name mapping --------------------------------------------------- */
  /**
   * A declared mapping rule matched nothing in this comparison.
   *
   * `blocking`, and this is the check that keeps a mapping table honest. The
   * public view's labels drift; a table full of plausible rules for labels that
   * no longer exist reads as a working translation layer and does nothing. A
   * rule that never fires is either a label that has gone or a rule that was
   * never right, and both need a person.
   */
  MAPPING_RULE_UNEXERCISED: 'MAPPING_RULE_UNEXERCISED',
  /** Mapping rules were applied. Provenance, with declared and applied counts. */
  MAPPING_APPLIED: 'MAPPING_APPLIED',
  /**
   * No mapping rule was declared, so no label was translated.
   *
   * `info`. Not a defect — two artifacts written in the same vocabulary need no
   * translation — but stated, so a report can never imply a mapping was
   * exercised when `mappingRulesApplied` is `0`.
   */
  MAPPING_NOT_EXERCISED: 'MAPPING_NOT_EXERCISED',

  /* -- change notices ------------------------------------------------------- */
  /**
   * A changed row names a participant the notice builder cannot address.
   *
   * `blocking`, in both of its shapes, which `details.reason` tells apart:
   *
   * - `unrecognised` — neither a team in the universe nor a declared non-team
   *   label. Incident 4's second half is a checker that read `Select Game 7` as
   *   a team code; a builder that quietly dropped it would send nobody the news.
   * - `ambiguous` — a label **more than one team answers to**, one team's id
   *   spelled the same way as another's name (`details.teamIds` names them).
   *   The change is routed to neither: misrouting a family's schedule change to
   *   a different family is worse than failing to send it.
   */
  NOTICE_PARTICIPANT_UNKNOWN: 'NOTICE_PARTICIPANT_UNKNOWN',
  /**
   * Notices were built with coach contact columns included.
   *
   * `compromise`. `CLAUDE.md` §2 is data minimisation: a family-facing notice
   * carries fixtures, not people's contact details, unless a caller names the
   * flag — and when one does, the finding says so rather than the inclusion
   * being invisible.
   */
  NOTICE_CONTACTS_INCLUDED: 'NOTICE_CONTACTS_INCLUDED',
  /**
   * A notice run reports a quiet season it has no basis to report.
   *
   * `blocking`, in three shapes, which `details.reason` tells apart:
   *
   * - `no-team-universe` — zero teams were enumerated, so no notice can be
   *   addressed to anybody.
   * - `parity-examined-nothing` — the parity behind the run carried
   *   {@link PUBLICATION_REASON.PARITY_VACUOUS}, partitioned no rows, or
   *   compared no fields. "0 teams have something to be told" from a comparison
   *   that looked at nothing is incident 4 in the layer families actually read.
   * - `divergence-told-to-nobody` — the parity was `rejected` and not one
   *   enumerated team was told anything.
   *
   * A `rejected` parity whose changes *do* reach families is none of these: it
   * is the ordinary case this module exists for, and that run is `allowed`.
   */
  NOTICE_VACUOUS: 'NOTICE_VACUOUS',
  /** Notices were built. Provenance, with the counters. */
  NOTICE_BUILT: 'NOTICE_BUILT',

  /* -- downstream sync registry --------------------------------------------- */
  /**
   * A destination has never reported a sync.
   *
   * `blocking`, and deliberately not "assume fresh". An unknown last-sync time
   * is the state in which a stale pointer publishes plausible-looking wrong
   * data with no error anywhere; defaulting it to now would be this repository
   * writing that failure itself.
   */
  DESTINATION_NEVER_SYNCED: 'DESTINATION_NEVER_SYNCED',
  /**
   * A destination's last sync predates the active snapshot, so it is serving an
   * older schedule than the one that was published.
   *
   * `compromise`: the schedule is right and the copy of it out in the world is
   * not. `details.kind` says which way the data flows, because a `pull`
   * destination cannot be told it is stale from here.
   */
  DESTINATION_STALE: 'DESTINATION_STALE',
  /** A destination synced at or after the active snapshot. Provenance. */
  DESTINATION_CURRENT: 'DESTINATION_CURRENT',
  /**
   * Nothing in this system observes these timestamps.
   *
   * `compromise`, emitted on every registry report. Each `destinationSyncedAt`
   * is an operator's assertion that a sync happened; no code here polls a
   * destination, and a registry that reads as monitoring while it is really a
   * notebook is the "declared is not enforced" shape this repository keeps
   * finding.
   */
  DESTINATION_SYNC_UNOBSERVED: 'DESTINATION_SYNC_UNOBSERVED',
  /** The registry report covered zero destinations. `blocking`. */
  SYNC_REGISTRY_VACUOUS: 'SYNC_REGISTRY_VACUOUS',
});

/**
 * Severity of every reason code.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const PUBLICATION_REASON_SEVERITY = Object.freeze({
  [PUBLICATION_REASON.SNAPSHOT_DIGEST_MISMATCH]: PUBLICATION_SEVERITY.BLOCKING,
  [PUBLICATION_REASON.SNAPSHOT_IN_MEMORY_ONLY]: PUBLICATION_SEVERITY.INFO,
  [PUBLICATION_REASON.SNAPSHOT_CREATED]: PUBLICATION_SEVERITY.INFO,

  [PUBLICATION_REASON.PARITY_ROW_DIFFERS]: PUBLICATION_SEVERITY.BLOCKING,
  [PUBLICATION_REASON.PARITY_ROW_ADDED]: PUBLICATION_SEVERITY.INFO,
  [PUBLICATION_REASON.PARITY_ROW_REMOVED]: PUBLICATION_SEVERITY.BLOCKING,
  [PUBLICATION_REASON.PARITY_ROWS_MATCHED]: PUBLICATION_SEVERITY.INFO,
  [PUBLICATION_REASON.PARITY_VACUOUS]: PUBLICATION_SEVERITY.BLOCKING,
  [PUBLICATION_REASON.PARITY_FIELD_ABSENT]: PUBLICATION_SEVERITY.BLOCKING,
  [PUBLICATION_REASON.PARITY_FIELD_UNCOMPARED]: PUBLICATION_SEVERITY.COMPROMISE,
  [PUBLICATION_REASON.PARITY_PARTITION_INCOMPLETE]: PUBLICATION_SEVERITY.BLOCKING,
  [PUBLICATION_REASON.PARITY_KEY_AMBIGUOUS]: PUBLICATION_SEVERITY.COMPROMISE,

  [PUBLICATION_REASON.MAPPING_RULE_UNEXERCISED]: PUBLICATION_SEVERITY.BLOCKING,
  [PUBLICATION_REASON.MAPPING_APPLIED]: PUBLICATION_SEVERITY.INFO,
  [PUBLICATION_REASON.MAPPING_NOT_EXERCISED]: PUBLICATION_SEVERITY.INFO,

  [PUBLICATION_REASON.NOTICE_PARTICIPANT_UNKNOWN]: PUBLICATION_SEVERITY.BLOCKING,
  [PUBLICATION_REASON.NOTICE_CONTACTS_INCLUDED]: PUBLICATION_SEVERITY.COMPROMISE,
  [PUBLICATION_REASON.NOTICE_VACUOUS]: PUBLICATION_SEVERITY.BLOCKING,
  [PUBLICATION_REASON.NOTICE_BUILT]: PUBLICATION_SEVERITY.INFO,

  [PUBLICATION_REASON.DESTINATION_NEVER_SYNCED]: PUBLICATION_SEVERITY.BLOCKING,
  [PUBLICATION_REASON.DESTINATION_STALE]: PUBLICATION_SEVERITY.COMPROMISE,
  [PUBLICATION_REASON.DESTINATION_CURRENT]: PUBLICATION_SEVERITY.INFO,
  [PUBLICATION_REASON.DESTINATION_SYNC_UNOBSERVED]: PUBLICATION_SEVERITY.COMPROMISE,
  [PUBLICATION_REASON.SYNC_REGISTRY_VACUOUS]: PUBLICATION_SEVERITY.BLOCKING,
});

/**
 * Severity of a publication reason code.
 *
 * Throws on an unknown code rather than defaulting to `info`, for the same
 * reason every module before it does: a code with no severity is a code
 * somebody forgot to register, and defaulting would make it silently
 * non-blocking.
 *
 * @param {string} code
 * @returns {string} a {@link PUBLICATION_SEVERITY} value
 */
export function publicationSeverityOf(code) {
  const severity = PUBLICATION_REASON_SEVERITY[code];
  if (!severity) {
    throw new Error(`publication: reason code "${code}" has no registered severity`);
  }
  return severity;
}

/**
 * Build a publication finding. `severity` is looked up, never passed in.
 *
 * @param {string} code - a {@link PUBLICATION_REASON} value
 * @param {string} message - for humans only
 * @param {Record<string, unknown>} [details] - flat primitives and ids only
 * @returns {import('./types.js').PublicationFinding}
 */
export function makePublicationFinding(code, message, details = {}) {
  return { code, severity: publicationSeverityOf(code), message, details };
}

/**
 * Derive the status of a result mechanically from its findings.
 *
 * @param {ReadonlyArray<import('./types.js').PublicationFinding>} findings
 * @returns {string} a {@link PUBLICATION_STATUS} value
 */
export function derivePublicationStatus(findings) {
  return deriveConstraintStatus(
    /** @type {ReadonlyArray<import('../constraints/types.js').ConstraintFinding>} */ (findings)
  );
}

/**
 * Fresh zeroed counters.
 *
 * Every one is additive, so a per-subject result folds into a whole-run one
 * without any of them meaning something different at the two scales. Facts that
 * are not sums — the snapshot's digest, a destination's state — live in the
 * result body rather than here.
 *
 * @returns {import('./types.js').PublicationMeta}
 */
export function createPublicationMeta() {
  return {
    /** Snapshots taken. */
    snapshotsCreated: 0,
    /** Rows frozen into snapshots. */
    snapshotRowsFrozen: 0,
    /**
     * Snapshots read back through {@link import('./serialise.js').readPublicationSnapshot}.
     *
     * Counted rather than assumed, so a round-trip assertion cannot pass over a
     * read that never happened.
     */
    snapshotsRead: 0,
    /** Rows on the published side of a comparison. */
    publishedRowsRead: 0,
    /** Rows on the current side of a comparison. */
    currentRowsRead: 0,
    /**
     * Subjects the partition accounts for: pairs plus unpaired rows on either
     * side. Never zero on a real run.
     */
    rowsCompared: 0,
    /** Pairs whose every compared field agreed. */
    rowsMatched: 0,
    /** Pairs that disagreed on at least one compared field. */
    rowsDiffering: 0,
    /** Rows present only in the current schedule. */
    rowsAdded: 0,
    /** Rows present only in the published artifact. */
    rowsRemoved: 0,
    /**
     * Individual field-to-field comparisons performed.
     *
     * The meta-assertion the parity numbers rest on: 567 pairs compared on zero
     * fields is 567 matches meaning nothing.
     */
    fieldComparisons: 0,
    /** Mapping rules the caller declared. */
    mappingRulesDeclared: 0,
    /** Times a declared rule actually rewrote a row. */
    mappingRulesApplied: 0,
    /** Rows at least one rule rewrote. */
    rowsRewritten: 0,
    /** Teams enumerated from the team universe — never from the changed rows. */
    teamsEnumerated: 0,
    /** Teams with at least one change to tell. */
    teamsWithChanges: 0,
    /** Notice lines emitted across all teams. */
    noticeLinesEmitted: 0,
    /** Destinations the registry report covered. */
    destinationsExamined: 0,
    /** Destinations serving an older schedule than the snapshot. */
    destinationsStale: 0,
    /** Destinations that have never reported a sync. */
    destinationsNeverSynced: 0,
  };
}

/**
 * Fold one set of counters into another.
 *
 * @param {import('./types.js').PublicationMeta} target
 * @param {import('./types.js').PublicationMeta} source
 * @returns {import('./types.js').PublicationMeta}
 */
export function mergePublicationMeta(target, source) {
  for (const key of Object.keys(target)) {
    target[key] += source[key] ?? 0;
  }
  return target;
}
