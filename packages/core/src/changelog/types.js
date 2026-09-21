/**
 * Types for the change log.
 *
 * @module changelog/types
 */

/**
 * @typedef {Object} ChangeLogFinding
 * @property {string} code - a `CHANGELOG_REASON` value
 * @property {string} severity - a `CHANGELOG_SEVERITY` value, looked up from the frozen table
 * @property {string} message - for humans only; never parsed
 * @property {Record<string, unknown>} details - flat primitives and ids
 */

/**
 * @typedef {Object} ChangeLogMeta
 * @property {number} entriesExamined
 * @property {number} sourcesDeclared
 * @property {number} sourcesMatched
 * @property {number} teamsEnumerated - from the team universe, never from the entries
 * @property {number} participantsExamined
 * @property {number} participantsResolved
 * @property {number} participantsDeclaredNonTeam
 * @property {number} participantsUnresolved
 * @property {number} subjectsEnumerated
 */

/**
 * One declared cause a change can have.
 *
 * `id` is the contract and `matches` is how a raw entry is recognised as this
 * source. The two are separate so a log whose reasons are free text and one
 * whose reasons are already codes use the same registry.
 *
 * @typedef {Object} ChangeSourceDeclaration
 * @property {string} id
 * @property {string} title - for humans
 * @property {(reason: string) => boolean} matches
 */

/**
 * One state of a subject: where and when it sat.
 *
 * `null` throughout means "not scheduled at all" — the state before an
 * addition and after a removal. It is never used to mean "unknown".
 *
 * @typedef {Object} ChangeState
 * @property {string|null} raw - the source cell, kept for provenance
 * @property {number|null} startMinutes - minutes past local midnight; no `Date`
 * @property {string|null} location - the ground as the source names it
 * @property {boolean} scheduled - false when the subject had no slot in this state
 */

/**
 * One classified entry.
 *
 * ## The fields 8.10 derives a per-entry notice from
 *
 * `PHASE_8_PLAN.md` §8.10 asks for *"an individual change notice per changelog
 * entry"*, and `publication/notices.js` `ChangeNoticeEntry` is the shape it
 * will build. The correspondence is deliberate and is the contract this
 * package owes that one:
 *
 * | `ChangeNoticeEntry` needs | this entry supplies |
 * | --- | --- |
 * | `kind` | {@link ChangeLogEntry.kind} — the same `NOTICE_CHANGE_KIND` values, not a parallel set |
 * | `key` | {@link ChangeLogEntry.key} |
 * | `label` | {@link ChangeLogEntry.label} |
 * | `changedFields` | {@link ChangeLogEntry.changedFields} |
 * | `before` / `after` | {@link ChangeLogEntry.before} / {@link ChangeLogEntry.after} |
 * | who to address | {@link ChangeLogEntry.participants}, each already resolved |
 *
 * `reason` and `sourceId` are beyond what a notice entry carries and are kept
 * because a family asking *why* is the question the corpus's own log answers
 * and the parity comparator cannot.
 *
 * @typedef {Object} ChangeLogEntry
 * @property {number} ordinal - position in the source, stable and gap-free; the only unique handle
 * @property {string} key - `${date}|${label}`. Unique **unless** the log carries two
 *   states for one subject on one date, which is exactly `HISTORY_CONFLICT` — so a
 *   report that has to name one of two colliding rows uses `ordinal`, not this.
 * @property {string} subjectId - what this entry is about, across dates
 * @property {string} date - `YYYY-MM-DD`, the date of the thing that changed
 * @property {string} label - `${home} v ${away}`
 * @property {string} kind - a `NOTICE_CHANGE_KIND` value
 * @property {string|null} sourceId - a declared source, or null when undeclared
 * @property {string} reason - the source's own words
 * @property {ChangeState} before
 * @property {ChangeState} after
 * @property {string[]} changedFields
 * @property {ChangeLogParticipant[]} participants
 */

/**
 * One side of an entry, and whether anybody can be told.
 *
 * @typedef {Object} ChangeLogParticipant
 * @property {string} label - as the source writes it
 * @property {string} resolution - a `PARTICIPANT_RESOLUTION` value
 * @property {string|null} teamId - non-null only when `resolution` is `team`
 */

/**
 * The classified log.
 *
 * @typedef {Object} ChangeLog
 * @property {string} subject - what was classified, in words
 * @property {ChangeLogEntry[]} entries
 * @property {Record<string, number>} byKind - count per `NOTICE_CHANGE_KIND` value
 * @property {Record<string, number>} bySource - count per declared source id, plus
 *   `(undeclared)` for entries nobody claimed and `(ambiguous)` for entries more than one did
 * @property {ChangeLogFinding[]} findings
 * @property {string} status
 * @property {ChangeLogMeta} meta
 */

/**
 * One subject's history: the states it is logged as holding, in date order.
 *
 * @typedef {Object} ChangeHistoryPhase
 * @property {string} date
 * @property {number} ordinal - the source position; unique where `entryKey` may not be
 * @property {string} entryKey
 * @property {string} kind
 * @property {string|null} sourceId
 * @property {string} reason
 * @property {ChangeState} before
 * @property {ChangeState} after
 */

/**
 * @typedef {Object} ChangeHistory
 * @property {string} subjectId
 * @property {ChangeHistoryPhase[]} phases
 * @property {string} logStatus - the standing of the log this was derived from
 * @property {ChangeLogFinding[]} findings
 * @property {string} status
 * @property {{ phaseCount: number, conflictCount: number, logEntryCount: number }} stats
 */

/**
 * The answer to "what was this subject's state on `asOf`".
 *
 * `state` is null when the log says nothing about the subject on or before
 * that date — which is *not* the same as the subject having had no slot, and
 * `logged` is the field that keeps the two apart.
 *
 * @typedef {Object} ChangeStateAsOf
 * @property {string} subjectId
 * @property {string|null} asOf
 * @property {string} logStatus - the standing of the log this was derived from
 * @property {ChangeState|null} state
 * @property {boolean} logged - did the log carry an entry at or before `asOf`
 * @property {string|null} fromEntryKey
 * @property {ChangeLogFinding[]} findings
 * @property {string} status
 */

export {};
