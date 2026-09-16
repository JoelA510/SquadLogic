/**
 * Machine-readable reason codes for field and blackout administration, and the
 * single severity table that turns a list of findings into a status.
 *
 * Same two rules as every sibling table in this package:
 *
 * 1. **`code` is the contract, `message` is decoration.** Branch on `code`.
 *    Never parse `message`.
 * 2. **Severity lives here and nowhere else.** No call site decides "this one
 *    is blocking".
 *
 * ## The two axes, and why they are two
 *
 * `PHASE_8_PLAN.md` §8.4 asks for a per-row disposition of
 * `new / unchanged / differing / unresolvable`. That is not a partition of one
 * thing. `unresolvable` says *no domain record could be built from this source
 * row at all*; the other three say *how the record that was built compares with
 * what we already hold*. A row that cannot be interpreted has no comparison to
 * report, and a row that compares fine was interpreted by definition.
 *
 * So this module carries two axes, each reconciled separately:
 *
 * ```text
 * interpretation   interpreted | doubtful | unresolvable
 * disposition      matched | differing | added | removed | uncompared
 *                                                    (interpreted rows only)
 * ```
 *
 * The first four disposition words are `publication/parity.js`'s, unrenamed;
 * `uncompared` is a fifth added beside them for a case parity answers with a
 * finding rather than a bucket, and {@link DISPOSITION.UNCOMPARED} says why at
 * length. The plan
 * asked to reuse parity's vocabulary and then named a different four-word list;
 * renaming `matched` to `unchanged` and `added` to `new` *is* the second
 * vocabulary the plan forbids. The plan's words are synonyms:
 * `new` = `added`, `unchanged` = `matched`.
 *
 * **`removed` is the member the plan's list omits**, and it is not optional. An
 * import that cannot say "current state holds this and no source mentions it"
 * silently means everything unmentioned is fine, which is how a surface deleted
 * from a working sheet stays live forever.
 *
 * @module fieldAdmin/reasonCodes
 */

/**
 * How badly a finding counts against a change set.
 *
 * @readonly
 * @enum {string}
 */
export const FIELD_ADMIN_SEVERITY = Object.freeze({
  /** Nothing may be applied from this subject without a human deciding. */
  BLOCKING: 'blocking',
  /** Applicable, but the operator is being told something they must weigh. */
  COMPROMISE: 'compromise',
  /** Provenance only. Never changes the status. */
  INFO: 'info',
});

/**
 * The three-state outcome of a change set.
 *
 * @readonly
 * @enum {string}
 */
export const FIELD_ADMIN_STATUS = Object.freeze({
  CLEAN: 'clean',
  COMPROMISED: 'compromised',
  BLOCKED: 'blocked',
});

/**
 * Axis 1: could a domain record be built from this source row at all?
 *
 * Lowercase - these are states of a row, not finding codes.
 *
 * @readonly
 * @enum {string}
 */
export const INTERPRETATION = Object.freeze({
  /** The cells parsed to a record and nothing about the reading is in doubt. */
  INTERPRETED: 'interpreted',
  /**
   * A record was built, but the source or the reading is in doubt: an
   * Excel-corrupted cell, the fields ring's own `?`, an `XX`/`??` sentinel.
   * Never auto-applicable.
   */
  DOUBTFUL: 'doubtful',
  /**
   * No record could be built. Surfaced with the raw cell and a reason; a row
   * here is never dropped.
   */
  UNRESOLVABLE: 'unresolvable',
});

/**
 * Axis 2: how the built record compares with what is already held.
 *
 * `publication/parity.js`'s `PARITY_BUCKET` values, deliberately spelled the
 * same. Defined only for rows whose interpretation is not `unresolvable`.
 *
 * @readonly
 * @enum {string}
 */
export const DISPOSITION = Object.freeze({
  /** The plan's `unchanged`. */
  MATCHED: 'matched',
  DIFFERING: 'differing',
  /** The plan's `new`. */
  ADDED: 'added',
  /** Held in current state and named by no source row. The plan omits this. */
  REMOVED: 'removed',
  /**
   * **Both sides hold it and nothing could be compared.** Every compared field
   * was absent on one side or the other, so the subject is neither a match nor
   * a difference - it is a question nobody answered.
   *
   * **A fifth value: an extension of parity's vocabulary, not a renaming of
   * it.** The four above are spelled as `PARITY_BUCKET` spells them and mean
   * what parity means. This one names a case parity *does* reach and answers
   * differently - checked against `compareParityRows()` rather than assumed,
   * because the tidier story (that parity's declared field set is always
   * compared, so the case cannot arise there) is not what its code does. Parity
   * skips a compared field whose cell is absent on either side, and a pair with
   * every compared field skipped leaves `changedFields` empty and lands in
   * `matched`, with the absence carried on `pair.absentFields` and re-reported
   * as `PUBLICATION_REASON.PARITY_FIELD_ABSENT`. So the *case* is not
   * new here. The *bucket* is.
   *
   * It earns a bucket here because a change set is read for its buckets. A
   * parity report is read beside its findings, where "matched, and here is
   * every absent cell" is a complete answer. Here {@link
   * FIELD_ADMIN_REASON.SUBJECTS_MATCHED} counts a bucket and says those
   * subjects agree - and a pair that compared nothing agreed about nothing.
   * Folding it into `matched` was the half of fix 7 that was missed: it had
   * already stopped being *applicable*, and went on being counted and reported
   * as a match, in a set that still came back `clean`.
   */
  UNCOMPARED: 'uncompared',
});

/**
 * Every reason a field-administration change set can give.
 *
 * @readonly
 * @enum {string}
 */
export const FIELD_ADMIN_REASON = Object.freeze({
  /* -- axis 1: interpretation ------------------------------------------- */
  //
  // There is deliberately **no** `ROW_INTERPRETED` code. A per-row finding for
  // every cleanly read row would be 544 info findings on the permit subject
  // alone, burying the 223 that need a person, and the count an operator
  // actually wants is already `meta.rowsInterpreted`. A code declared here and
  // emitted by nothing is the hollow-guarantee shape `CLAUDE.md` §3 names, so
  // it is absent rather than unreachable.
  /**
   * A record was built from a cell whose reading is in doubt. The corpus has
   * 15 of these in `field_weekly_availability.csv` alone (Excel turned `4-7`
   * into `2026-04-07`), plus the fields ring's `Larkfield Green Field 2?` and
   * `field_inventory.csv`'s `XX` / `??` / `????` sentinels.
   */
  ROW_DOUBTFUL: 'ROW_DOUBTFUL',
  /**
   * No domain record could be built. The row is carried with its raw cell and
   * this reason; nothing is guessed and nothing is dropped.
   */
  ROW_UNRESOLVABLE: 'ROW_UNRESOLVABLE',

  /* -- axis 2: disposition ---------------------------------------------- */
  /** Aggregate: how many subjects the import agrees with current state on. */
  SUBJECTS_MATCHED: 'SUBJECTS_MATCHED',
  /** One subject, one finding: a person has to look at this row. */
  SUBJECT_DIFFERS: 'SUBJECT_DIFFERS',
  /**
   * Aggregate: additions are news rather than divergence, exactly as
   * `PARITY_ROW_ADDED` is, and one finding per row would bury the differences.
   */
  SUBJECTS_ADDED: 'SUBJECTS_ADDED',
  /** One subject, one finding: current state holds it and no source names it. */
  SUBJECT_REMOVED: 'SUBJECT_REMOVED',
  /**
   * One subject, one finding: both sides hold it and every compared field was
   * absent, so nothing was learned about it. Compromise rather than blocking -
   * an operator can look and decide - but never silence, and never a match.
   */
  SUBJECT_UNCOMPARED: 'SUBJECT_UNCOMPARED',

  /* -- two sources, one subject ----------------------------------------- */
  /**
   * Two sources describe one subject and disagree. **Both are carried and
   * neither is preferred.** The club's two decoder rings disagree on 12 of the
   * 20 codes they share; this is the code that says so per subject.
   *
   * That 12 is the count over **`actual_label`** - what each ring *calls* the
   * ground. Including the venue cell gives 13, because `11v11 Field 1` has both
   * rings writing `Willowmead Park Turf` while the practice ring leaves the
   * venue blank; the thirteenth is reported on the interpretation axis. Labels
   * are the right scope because `compareDecoderRings()` in the corpus loader is
   * the single producer of "decoder-ring disagreement" and it compares labels,
   * so a second scope here would be a second producer of one derived status.
   */
  SOURCES_DISAGREE: 'SOURCES_DISAGREE',

  /**
   * **Two held records share one identity.** The key fields do not identify a
   * record on the side already stored, so which of them a proposal is compared
   * against is arbitrary - and picking one silently is how 20 of 47 held alias
   * records were dropped with nothing naming them. Reported per key, and the
   * subject is never applicable: `PARITY_KEY_AMBIGUOUS` is the same hazard one
   * module over, under its own name.
   */
  HELD_KEY_AMBIGUOUS: 'HELD_KEY_AMBIGUOUS',

  /* -- partition integrity ---------------------------------------------- */
  /** The partition does not account for every input row exactly once. */
  CHANGE_SET_PARTITION_INCOMPLETE: 'CHANGE_SET_PARTITION_INCOMPLETE',
  /**
   * **Nothing was partitioned at all.** A change set over zero subjects holds
   * trivially and means nothing - the hazard `PARITY_VACUOUS` names one module
   * over.
   */
  CHANGE_SET_VACUOUS: 'CHANGE_SET_VACUOUS',
  /**
   * **Subjects were partitioned, and no comparison was made.**
   *
   * Split out from {@link CHANGE_SET_VACUOUS} because the two say different
   * things and only one of them is a defect. A first import of a single-source
   * subject holds nothing and has no second source to disagree with, so every
   * subject is an addition and nothing is compared - that is a *load*, not a
   * reconciliation, and an operator reading "11 blackouts imported cleanly"
   * should know no reconciliation happened. It is a compromise, not a block:
   * treating it as blocking would make every first import fail, which is how a
   * status stops meaning anything.
   */
  CHANGE_SET_UNCOMPARED: 'CHANGE_SET_UNCOMPARED',

  /* -- application ------------------------------------------------------ */
  /**
   * **Emitted on every change set this module builds.** Import is a proposal.
   * Nothing here writes to any store, and no report may imply that it did.
   */
  CHANGE_SET_NOT_APPLIED: 'CHANGE_SET_NOT_APPLIED',

  /* -- serialisation ---------------------------------------------------- */
  /**
   * The registry lives in memory. `serialiseFieldRegistry()` /
   * `readFieldRegistry()` are the declared persistence seam and PR 1 stores
   * through neither - the same position `EXTERNAL_MAPPING_NOT_PERSISTED` takes.
   */
  REGISTRY_NOT_PERSISTED: 'REGISTRY_NOT_PERSISTED',

  /* -- consequences of an administrative change -------------------------- */
  /**
   * A blackout window covers ground a booking already holds.
   *
   * Emitted by `consequences.js` `findBlackoutConflicts()`, per closure and
   * booking. `blocking` because the two statements cannot both be honoured: the
   * ground is either closed or played on.
   */
  BLACKOUT_BLOCKS_BOOKING: 'BLACKOUT_BLOCKS_BOOKING',
  /**
   * No repair could be proposed for an affected booking, because the repair
   * engine does not exist.
   *
   * 8.4's third capability asks a consequence preview to show "what the repair
   * from 8.6 proposes". 8.6 is unbuilt, so the honest rendering is this code
   * rather than an empty panel -- blank space where a repair belongs reads as
   * "no repair is needed", which is a stronger and false claim.
   *
   * `compromise`: the operator can still decide, and is told what they are
   * deciding without.
   */
  REPAIR_PROPOSAL_UNAVAILABLE: 'REPAIR_PROPOSAL_UNAVAILABLE',

  // **Privacy is enforced by refusal, not by a finding.** An earlier draft of
  // this table carried a `NOTE_IDENTITY_SHAPE` code. `NoteSchema` in
  // `schemas.js` refuses the value outright, which is a stronger guarantee than
  // reporting it and is the single producer of that verdict; a finding code
  // beside it would be a second producer that could disagree, and nothing could
  // emit it because a record carrying such a note cannot be constructed. The
  // guarantee is proved in `tests/fieldAdminChangeSet.test.js`, generated from
  // `privacy/textShapes.js`'s own samples.
  //
  // `REPAIR_PROPOSAL_UNAVAILABLE` was likewise absent here rather than declared
  // and unemittable: the consequence report it belongs to needs the persistence
  // and app layers, so the code arrives with its producer rather than ahead of
  // it. **PR 3 is that producer** -- `consequences.js` `repairProposal()` -- so
  // it is declared above, beside the conflict code it appears next to on the
  // screen.
});

/**
 * The frozen severity table. Every code above appears here exactly once;
 * {@link severityOf} throws on a code that does not.
 *
 * @readonly
 * @type {Readonly<Record<string, string>>}
 */
export const FIELD_ADMIN_REASON_SEVERITY = Object.freeze({
  [FIELD_ADMIN_REASON.ROW_DOUBTFUL]: FIELD_ADMIN_SEVERITY.COMPROMISE,
  [FIELD_ADMIN_REASON.ROW_UNRESOLVABLE]: FIELD_ADMIN_SEVERITY.BLOCKING,

  [FIELD_ADMIN_REASON.SUBJECTS_MATCHED]: FIELD_ADMIN_SEVERITY.INFO,
  [FIELD_ADMIN_REASON.SUBJECT_DIFFERS]: FIELD_ADMIN_SEVERITY.BLOCKING,
  [FIELD_ADMIN_REASON.SUBJECTS_ADDED]: FIELD_ADMIN_SEVERITY.INFO,
  [FIELD_ADMIN_REASON.SUBJECT_REMOVED]: FIELD_ADMIN_SEVERITY.BLOCKING,
  [FIELD_ADMIN_REASON.SUBJECT_UNCOMPARED]: FIELD_ADMIN_SEVERITY.COMPROMISE,

  [FIELD_ADMIN_REASON.SOURCES_DISAGREE]: FIELD_ADMIN_SEVERITY.BLOCKING,
  [FIELD_ADMIN_REASON.HELD_KEY_AMBIGUOUS]: FIELD_ADMIN_SEVERITY.BLOCKING,

  [FIELD_ADMIN_REASON.CHANGE_SET_PARTITION_INCOMPLETE]: FIELD_ADMIN_SEVERITY.BLOCKING,
  [FIELD_ADMIN_REASON.CHANGE_SET_VACUOUS]: FIELD_ADMIN_SEVERITY.BLOCKING,
  [FIELD_ADMIN_REASON.CHANGE_SET_UNCOMPARED]: FIELD_ADMIN_SEVERITY.COMPROMISE,

  [FIELD_ADMIN_REASON.CHANGE_SET_NOT_APPLIED]: FIELD_ADMIN_SEVERITY.INFO,
  [FIELD_ADMIN_REASON.REGISTRY_NOT_PERSISTED]: FIELD_ADMIN_SEVERITY.INFO,

  [FIELD_ADMIN_REASON.BLACKOUT_BLOCKS_BOOKING]: FIELD_ADMIN_SEVERITY.BLOCKING,
  [FIELD_ADMIN_REASON.REPAIR_PROPOSAL_UNAVAILABLE]: FIELD_ADMIN_SEVERITY.COMPROMISE,
});

/**
 * The severity of one code.
 *
 * @param {string} code
 * @returns {string} a {@link FIELD_ADMIN_SEVERITY} value
 */
export function severityOf(code) {
  const severity = FIELD_ADMIN_REASON_SEVERITY[code];
  if (!severity) {
    throw new Error(`fieldAdmin: reason code "${code}" has no registered severity`);
  }
  return severity;
}

/**
 * Build a finding. `severity` is looked up, never passed in.
 *
 * @param {string} code - a {@link FIELD_ADMIN_REASON} value
 * @param {string} message - for humans only
 * @param {Record<string, unknown>} [details] - flat primitives and ids only
 * @returns {import('./types.js').FieldAdminFinding}
 */
export function makeFieldAdminFinding(code, message, details = {}) {
  return { code, severity: severityOf(code), message, details };
}

/**
 * Refuse a finding whose severity disagrees with the frozen table.
 *
 * Thrown rather than reported, for the reason
 * `assertExternalImportFindings()` is: a finding carrying a hand-written
 * severity is a producer bug, and letting it through is how a `blocking`
 * quietly renders as `info`.
 *
 * @param {ReadonlyArray<import('./types.js').FieldAdminFinding>} findings
 * @param {string} [subject]
 * @returns {ReadonlyArray<import('./types.js').FieldAdminFinding>}
 */
export function assertFieldAdminFindings(findings, subject = 'a result') {
  for (const finding of findings) {
    const severity = severityOf(finding.code);
    if (finding.severity !== severity) {
      throw new Error(
        `fieldAdmin: ${subject} carries "${finding.code}" at severity ${JSON.stringify(finding.severity)}, but the frozen table registers it as "${severity}"`
      );
    }
  }
  return findings;
}

/**
 * Derive the status of a change set mechanically from its findings.
 *
 * @param {ReadonlyArray<import('./types.js').FieldAdminFinding>} findings
 * @returns {string} a {@link FIELD_ADMIN_STATUS} value
 */
export function deriveFieldAdminStatus(findings) {
  let compromised = false;
  for (const finding of findings) {
    if (finding.severity === FIELD_ADMIN_SEVERITY.BLOCKING) return FIELD_ADMIN_STATUS.BLOCKED;
    if (finding.severity === FIELD_ADMIN_SEVERITY.COMPROMISE) compromised = true;
  }
  return compromised ? FIELD_ADMIN_STATUS.COMPROMISED : FIELD_ADMIN_STATUS.CLEAN;
}

/**
 * A zeroed meta block.
 *
 * Every counter here names its unit, because `PHASE_8_PLAN.md` §8.2 made that a
 * standing requirement: a report that says "12" must say 12 of what.
 *
 * @returns {import('./types.js').FieldAdminMeta}
 */
export function createFieldAdminMeta() {
  return {
    /* axis 1, counted in source rows */
    sourceRowsRead: 0,
    rowsInterpreted: 0,
    rowsDoubtful: 0,
    rowsUnresolvable: 0,
    /* axis 2, counted in subjects */
    currentSubjectsRead: 0,
    projectedSubjects: 0,
    subjectsMatched: 0,
    subjectsDiffering: 0,
    subjectsAdded: 0,
    subjectsRemoved: 0,
    subjectsUncompared: 0,
    /* how much comparing actually happened, in field comparisons */
    fieldComparisons: 0,
    /* comparisons between two sources describing one subject */
    sourceComparisons: 0,
    /* subjects on which two sources disagree, counted in subjects */
    subjectsWithSourceDisagreement: 0,
    /* subjects an operator could apply without deciding anything */
    subjectsApplicable: 0,
  };
}
