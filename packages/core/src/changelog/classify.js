/**
 * **Classifying a change log: what changed, why, and who has to be told.**
 *
 * A change log arrives as dated rows of free text. This module turns it into
 * entries that carry a kind, a declared cause and a resolved set of
 * addressees — and refuses, loudly, in the three places where a quiet answer
 * would be wrong.
 *
 * ## 1. The kind vocabulary is `publication/`'s, not a new one
 *
 * `NOTICE_CHANGE_KIND` — `changed` / `added` / `removed` — already exists and
 * already means what a family reads. It is imported rather than restated. The
 * build plan's instruction for this task is *"do not invent a parallel
 * vocabulary"*, and the kind axis is where that instruction binds hardest,
 * because a second three-value enum with the same three words is the kind of
 * drift nothing detects.
 *
 * ## 2. The cause axis is NOT `ConsequentialChange.causeKind`, and that is a
 * decision rather than an oversight
 *
 * The plan names `resolve/`'s causal taxonomy as the thing to persist instead
 * of designing a parallel one, and for a **re-solver run** that is right.
 * `causeKind` has two values, `constraint` and `global-reoptimisation`
 * (`resolve/types.js:222`), and both describe why *the solver* moved a game.
 *
 * A change log records why *the club* moved one, and those are not the same
 * question. In `fixtures/season-2026/practice/game_change_log.csv` the four
 * causes are an operator policy decision (respacing a venue to 30-minute gaps,
 * 87 rows), an external league's fixtures arriving (59), a facility closure
 * (20) and one person's conflict (1). Not one of the four is a `constraint` in
 * the registry sense and none is a global re-optimisation. Filing "Gardening
 * Day — Maplewood 1-7 closed until noon" under `causeKind: 'constraint'` puts
 * a wrong word in front of the operator, which is what
 * `ConsequencePreview.jsx` refuses to do about disposition and for the same
 * reason.
 *
 * So the cause axis is a **caller-declared registry**, not a fixed enum: the
 * corpus's four sources live in `adapters/season2026ChangeLog.js`, an
 * operator's log declares its own, and a reason matching none of them is
 * {@link CHANGELOG_REASON.SOURCE_UNDECLARED} at blocking. When a resolve run
 * becomes a source of log entries, `causeKind` is what its declaration will
 * carry — the registry is the seam that lets both exist without either
 * pretending to be the other.
 *
 * ## 3. The team universe is supplied, never derived from the entries
 *
 * Enumerating teams from the changes is exactly backwards, for the reason
 * `publication/notices.js` gives at length: a team whose fixture vanished
 * produces no row to be enumerated from, so grouping from rows means the
 * family with the worst news is the family that gets nothing. The universe is
 * a parameter. A participant that is neither a known team nor a declared
 * non-team label is {@link CHANGELOG_REASON.PARTICIPANT_UNRESOLVED} at
 * blocking rather than a silent skip, and a label more than one team answers
 * to is routed to neither.
 *
 * ## 4. The partition is reconciled, and the reconciliation is exported
 *
 * {@link changeLogPartitionFindings} is separate and public so a test can hand
 * it a partition with an entry dropped and one with an entry counted twice and
 * prove both fire. The precedent is `fieldAdmin/changeSet.js`
 * `changeSetPartitionFindings()` and, before it, `publication/parity.js`
 * `parityPartitionFindings()`. A coverage assertion that cannot be made to
 * fail is not a coverage assertion.
 *
 * @module changelog/classify
 */

import { deepFreeze } from '../facility/facilityGraph.js';
import { NOTICE_CHANGE_KIND } from '../publication/reasonCodes.js';

import {
  CHANGELOG_REASON,
  PARTICIPANT_RESOLUTION,
  createChangelogMeta,
  deriveChangelogStatus,
  makeChangelogFinding,
} from './reasonCodes.js';
import { ChangeLogTeamSchema, RawChangeEntrySchema } from './schemas.js';

/** The fields a `changed` entry can differ on. Ordered, so a report is stable. */
export const COMPARED_FIELDS = Object.freeze(['startMinutes', 'location']);

/**
 * The `bySource` bucket entries no declared source claimed.
 *
 * A named sentinel rather than the string `'null'`, and a declared source may
 * not use it as an id — checked, because a source called `null` would merge
 * its own count with the undeclared one and the partition would still
 * reconcile. A bucket collision that still adds up is the worst kind.
 */
export const UNDECLARED_SOURCE = '(undeclared)';

/**
 * The `bySource` bucket for entries **more than one** declared source claimed.
 *
 * Separate from {@link UNDECLARED_SOURCE} because the two are opposite faults
 * with opposite remedies — nobody wrote a matcher, versus two matchers
 * overlap — and a single bucket makes them indistinguishable in the partition
 * a reader actually looks at. A declared source may not use it as an id, for
 * the same reason.
 */
export const AMBIGUOUS_SOURCE = '(ambiguous)';

/**
 * Which kind of change this pair of states describes.
 *
 * Read from `scheduled` on both sides rather than from the presence of a
 * time, because "no time" and "no fixture" are different states and the
 * schema keeps them apart.
 *
 * @param {import('./types.js').ChangeState} before
 * @param {import('./types.js').ChangeState} after
 * @returns {string} a `NOTICE_CHANGE_KIND` value
 */
export function kindOf(before, after) {
  if (!before.scheduled && after.scheduled) return NOTICE_CHANGE_KIND.ADDED;
  if (before.scheduled && !after.scheduled) return NOTICE_CHANGE_KIND.REMOVED;
  return NOTICE_CHANGE_KIND.CHANGED;
}

/**
 * Which compared fields differ between two states.
 *
 * Empty for an addition and a removal: the whole fixture appeared or vanished,
 * and naming every field as "changed" would make a new game read as a move.
 *
 * @param {import('./types.js').ChangeState} before
 * @param {import('./types.js').ChangeState} after
 * @returns {string[]}
 */
export function changedFieldsOf(before, after) {
  if (!before.scheduled || !after.scheduled) return [];
  return COMPARED_FIELDS.filter(
    (field) =>
      /** @type {Record<string, unknown>} */ (before)[field] !==
      /** @type {Record<string, unknown>} */ (after)[field]
  );
}

/**
 * Does the partition account for every entry exactly once?
 *
 * **Exported so it can be made to fail.** Hand it a `byKind` short of an entry
 * or a `bySource` counting one twice and it reports which side is wrong;
 * `tests/changelog.test.js` does exactly that in both directions.
 *
 * Both axes are checked against `entriesExamined` — the count taken from the
 * *input*, never from the buckets — because a reconciliation that compares two
 * numbers it derived from the same walk compares a set against itself, which
 * is the Phase 2 defect `CLAUDE.md` names first.
 *
 * @param {Record<string, number>} byKind
 * @param {Record<string, number>} bySource
 * @param {number} entriesExamined
 * @returns {import('./types.js').ChangeLogFinding[]}
 */
export function changeLogPartitionFindings(byKind, bySource, entriesExamined) {
  /** @type {import('./types.js').ChangeLogFinding[]} */
  const findings = [];
  const kindTotal = Object.values(byKind).reduce((sum, count) => sum + count, 0);
  const sourceTotal = Object.values(bySource).reduce((sum, count) => sum + count, 0);

  if (kindTotal !== entriesExamined) {
    findings.push(
      makeChangelogFinding(
        CHANGELOG_REASON.PARTITION_UNSOUND,
        `the kind axis accounts for ${kindTotal} entr(ies) and ${entriesExamined} were examined; every entry belongs to exactly one kind`,
        { axis: 'kind', bucketed: kindTotal, examined: entriesExamined }
      )
    );
  }
  if (sourceTotal !== entriesExamined) {
    findings.push(
      makeChangelogFinding(
        CHANGELOG_REASON.PARTITION_UNSOUND,
        `the source axis accounts for ${sourceTotal} entr(ies) and ${entriesExamined} were examined; every entry belongs to exactly one source`,
        { axis: 'source', bucketed: sourceTotal, examined: entriesExamined }
      )
    );
  }
  return findings;
}

/**
 * Build the label -> team map, detecting collisions rather than overwriting.
 *
 * Same construction as `publication/notices.js`, and for the same reason
 * stated there: a single overwriting pass is how one family's change reaches
 * another family.
 *
 * @param {ReadonlyArray<{ teamId: string, teamName: string|null }>} teams
 * @returns {{ byLabel: Map<string, string>, ambiguous: Map<string, string[]> }}
 */
function indexTeams(teams) {
  /** @type {Map<string, Set<string>>} */
  const claims = new Map();
  for (const team of teams) {
    for (const label of [team.teamId, team.teamName]) {
      if (typeof label !== 'string' || label.length === 0) continue;
      const set = claims.get(label) ?? new Set();
      set.add(team.teamId);
      claims.set(label, set);
    }
  }
  /** @type {Map<string, string>} */
  const byLabel = new Map();
  /** @type {Map<string, string[]>} */
  const ambiguous = new Map();
  for (const [label, set] of claims) {
    if (set.size === 1) byLabel.set(label, [...set][0]);
    else ambiguous.set(label, [...set].sort());
  }
  return { byLabel, ambiguous };
}

/**
 * Classify a raw change log.
 *
 * @param {Object} input
 * @param {string} input.subject - what this log is about, in words
 * @param {ReadonlyArray<Object>} input.entries - raw entries; see `RawChangeEntrySchema`
 * @param {ReadonlyArray<import('./types.js').ChangeSourceDeclaration>} input.sources
 * @param {ReadonlyArray<Object>} input.teams - the team universe; never derived from the entries
 * @param {ReadonlyArray<string>} [input.nonTeamLabels] - labels declared not to be teams
 * @param {string|null} [input.coverage] - what the log claims to cover, if anything
 * @returns {import('./types.js').ChangeLog}
 */
export function buildChangeLog(input) {
  const subject = input.subject;
  if (typeof subject !== 'string' || subject.length === 0) {
    throw new TypeError('buildChangeLog requires a subject naming what was classified');
  }
  const raw = (input.entries ?? []).map((entry) => RawChangeEntrySchema.parse(entry));
  const teams = (input.teams ?? []).map((team) => ChangeLogTeamSchema.parse(team));
  const sources = input.sources ?? [];
  const nonTeamLabels = new Set(input.nonTeamLabels ?? []);
  const coverage = input.coverage ?? null;

  const meta = createChangelogMeta();
  /** @type {import('./types.js').ChangeLogFinding[]} */
  const findings = [];

  meta.entriesExamined = raw.length;
  meta.sourcesDeclared = sources.length;
  meta.teamsEnumerated = teams.length;

  const { byLabel, ambiguous } = indexTeams(teams);

  const collidingId = sources.find(
    (source) => source.id === UNDECLARED_SOURCE || source.id === AMBIGUOUS_SOURCE
  );
  if (collidingId) {
    throw new TypeError(
      `changelog: "${collidingId.id}" is a reserved bucket for entries no source claimed or more than one did, and cannot also be a declared source id`
    );
  }
  const duplicateId = sources.find(
    (source, index) => sources.findIndex((other) => other.id === source.id) !== index
  );
  if (duplicateId) {
    throw new TypeError(
      `changelog: source id "${duplicateId.id}" is declared twice; its two counts would merge into one bucket that still reconciles`
    );
  }

  /** @type {Record<string, number>} */
  const byKind = {
    [NOTICE_CHANGE_KIND.CHANGED]: 0,
    [NOTICE_CHANGE_KIND.ADDED]: 0,
    [NOTICE_CHANGE_KIND.REMOVED]: 0,
  };
  /** @type {Record<string, number>} */
  const bySource = { [UNDECLARED_SOURCE]: 0, [AMBIGUOUS_SOURCE]: 0 };
  for (const source of sources) bySource[source.id] = 0;

  /**
   * Which sources ever matched anything, read from `matches()` itself.
   *
   * **Not from the bucket counts.** A source whose every match is contested
   * banks its entries in {@link AMBIGUOUS_SOURCE}, so a bucket-derived answer
   * reports a source that matched *everything* as having matched nothing —
   * and points an operator debugging an overlap at "your matcher is broken".
   * The predicate is the only thing that knows.
   */
  /** @type {Set<string>} */
  const sourcesThatMatched = new Set();

  /** @type {import('./types.js').ChangeLogEntry[]} */
  const entries = [];
  /** Key -> the ordinal of the first entry that claimed it. */
  /** @type {Map<string, number>} */
  const seenKeys = new Map();

  raw.forEach((entry, ordinal) => {
    const label = `${entry.home} v ${entry.away}`;
    const key = `${entry.date}|${label}`;
    const kind = kindOf(entry.before, entry.after);
    const changedFields = changedFieldsOf(entry.before, entry.after);

    /* -- the cause axis -------------------------------------------------- */
    const claiming = sources.filter((source) => source.matches(entry.reason));
    for (const source of claiming) sourcesThatMatched.add(source.id);
    /** @type {string|null} */
    let sourceId = null;
    if (claiming.length === 1) {
      sourceId = claiming[0].id;
    } else if (claiming.length > 1) {
      findings.push(
        makeChangelogFinding(
          CHANGELOG_REASON.SOURCE_AMBIGUOUS,
          `entry "${key}" is claimed by ${claiming.length} declared sources (${claiming.map((source) => source.id).join(', ')}); which one it lands in would be declaration order`,
          { key, sourceIds: claiming.map((source) => source.id).sort() }
        )
      );
    } else {
      findings.push(
        makeChangelogFinding(
          CHANGELOG_REASON.SOURCE_UNDECLARED,
          `entry "${key}" states a reason no declared source claims: ${JSON.stringify(entry.reason)}`,
          { key, reason: entry.reason, sourcesDeclared: sources.length }
        )
      );
    }
    bySource[
      sourceId !== null ? sourceId : claiming.length > 1 ? AMBIGUOUS_SOURCE : UNDECLARED_SOURCE
    ] += 1;
    byKind[kind] += 1;

    /* -- who is told ------------------------------------------------------ */
    /** @type {import('./types.js').ChangeLogParticipant[]} */
    const participants = [];
    for (const side of [entry.home, entry.away]) {
      meta.participantsExamined += 1;
      // **Declared non-team labels are checked first, and the order is the
      // sibling's.** `publication/notices.js:204` tests `nonTeamLabels` ahead
      // of both the ambiguity map and the team lookup, so a caller who has
      // declared `TBD` or `-` a placeholder gets that answer even when a team
      // happens to answer to the same string. Checking teams first would read
      // the placeholder as a team code and route a family's news by it, with
      // no finding -- incident 4's shape, and the third contract CLAUDE.md
      // says not to invent when a sibling already has one.
      if (nonTeamLabels.has(side)) {
        meta.participantsDeclaredNonTeam += 1;
        participants.push({
          label: side,
          resolution: PARTICIPANT_RESOLUTION.DECLARED_NON_TEAM,
          teamId: null,
        });
        continue;
      }
      if (ambiguous.has(side)) {
        meta.participantsUnresolved += 1;
        participants.push({
          label: side,
          resolution: PARTICIPANT_RESOLUTION.UNRESOLVED,
          teamId: null,
        });
        findings.push(
          makeChangelogFinding(
            CHANGELOG_REASON.PARTICIPANT_AMBIGUOUS,
            `entry "${key}" names "${side}", which ${/** @type {string[]} */ (ambiguous.get(side)).length} teams answer to; routing it to one of them would misfile another family's news`,
            { key, label: side, teamIds: ambiguous.get(side) }
          )
        );
        continue;
      }
      const teamId = byLabel.get(side);
      if (teamId !== undefined) {
        meta.participantsResolved += 1;
        participants.push({ label: side, resolution: PARTICIPANT_RESOLUTION.TEAM, teamId });
        continue;
      }
      meta.participantsUnresolved += 1;
      participants.push({
        label: side,
        resolution: PARTICIPANT_RESOLUTION.UNRESOLVED,
        teamId: null,
      });
      findings.push(
        makeChangelogFinding(
          CHANGELOG_REASON.PARTICIPANT_UNRESOLVED,
          `entry "${key}" names "${side}", which is neither a team in the universe of ${teams.length} nor a declared non-team label; nobody can be told about this change`,
          { key, label: side, teamsEnumerated: teams.length }
        )
      );
    }

    const resolvedIds = participants
      .filter((participant) => participant.teamId !== null)
      .map((participant) => participant.teamId);
    if (resolvedIds.length === 2 && resolvedIds[0] === resolvedIds[1]) {
      findings.push(
        makeChangelogFinding(
          CHANGELOG_REASON.PARTICIPANT_SELF_PAIRED,
          `entry "${key}" resolves both sides to team "${resolvedIds[0]}"; one change would be told to one family twice`,
          { key, teamId: resolvedIds[0] }
        )
      );
    }

    if (kind === NOTICE_CHANGE_KIND.CHANGED && changedFields.length === 0) {
      findings.push(
        makeChangelogFinding(
          CHANGELOG_REASON.ENTRY_CHANGED_NOTHING,
          `entry "${key}" is logged as a change and its before and after are identical on every compared field (${COMPARED_FIELDS.join(', ')})`,
          { key, comparedFields: [...COMPARED_FIELDS] }
        )
      );
    }

    const firstOrdinal = seenKeys.get(key);
    if (firstOrdinal !== undefined) {
      findings.push(
        makeChangelogFinding(
          CHANGELOG_REASON.HISTORY_CONFLICT,
          `entries ${firstOrdinal} and ${ordinal} share the key "${key}"; a subject with two states on one date has two answers to "what was it then"`,
          // **Ordinals, not two copies of the key.** The key is `date|label`
          // and both colliding rows have the same one by construction, so a
          // finding that named only keys would tell an operator two rows
          // collide and hand them the same string twice, with no way to find
          // either. The ordinal is the source position and is unique.
          { key, ordinals: [firstOrdinal, ordinal] }
        )
      );
    } else {
      seenKeys.set(key, ordinal);
    }

    entries.push({
      ordinal,
      key,
      subjectId: label,
      date: entry.date,
      label,
      kind,
      sourceId,
      reason: entry.reason,
      before: entry.before,
      after: entry.after,
      changedFields,
      participants,
    });
  });

  meta.sourcesMatched = sourcesThatMatched.size;
  meta.subjectsEnumerated = new Set(entries.map((entry) => entry.subjectId)).size;

  for (const source of sources) {
    if (sourcesThatMatched.has(source.id)) continue;
    findings.push(
      makeChangelogFinding(
        CHANGELOG_REASON.SOURCE_MATCHED_NOTHING,
        `declared source "${source.id}" (${source.title}) claimed none of the ${raw.length} entr(ies); a matcher that matches nothing cannot be told from one that is broken`,
        { sourceId: source.id, entriesExamined: raw.length }
      )
    );
  }

  findings.push(...changeLogPartitionFindings(byKind, bySource, meta.entriesExamined));

  findings.push(
    makeChangelogFinding(
      CHANGELOG_REASON.TRANSACTION_TIME_ABSENT,
      `this log dates each entry by the thing that changed, not by when the decision was taken; "what was this fixture's time on date D" is answerable and "what did we believe the schedule was on date D" is not`,
      { subject, entriesExamined: meta.entriesExamined }
    )
  );

  if (coverage === null) {
    findings.push(
      makeChangelogFinding(
        CHANGELOG_REASON.COVERAGE_UNSTATED,
        `nothing states what this log of ${meta.entriesExamined} entr(ies) covers, so a subject with no entry is a subject nobody logged rather than a subject that held still`,
        { subject, entriesExamined: meta.entriesExamined }
      )
    );
  }

  findings.push(
    makeChangelogFinding(
      CHANGELOG_REASON.LOG_NOT_PERSISTED,
      `this change log lives for the lifetime of the process; the durable store is GAP-35 and is deliberately not built here (docs/MODEL_GAPS.md)`,
      { subject, entriesExamined: meta.entriesExamined }
    )
  );

  return deepFreeze({
    subject,
    entries,
    byKind,
    bySource,
    findings,
    status: deriveChangelogStatus(findings),
    meta,
  });
}
