/**
 * A team's practice history as a sequence of ranges, and a readable rendering
 * of it.
 *
 * **A history is a sequence of non-overlapping ranges, not a mutable row.**
 * That is the model's central claim, so overlap is a `blocking` finding rather
 * than a note: the day two of a team's ranges cover the same Tuesday, "when
 * did this team practise" has two answers and the history has stopped being
 * one.
 *
 * @module practice/history
 */

import { deepFreeze } from '../facility/facilityGraph.js';
import { isoDateOfDayNumber, isoDayNumber } from '../facility/eligibility.js';

import { PRACTICE_REASON, derivePracticeStatus, makePracticeFinding } from './reasonCodes.js';

/**
 * `HH:MM` for minutes past midnight.
 *
 * Local, and deliberately not imported: the sibling
 * (`fieldAdmin/consequences.js:180 minutesToClock`) lives a layer up, and a
 * domain model reaching into a projector to borrow a formatter inverts the
 * dependency for three lines of string building. The civil-date arithmetic,
 * where a second copy would actually be dangerous, *is* shared — see
 * `facility/eligibility.js`.
 *
 * @param {number} minutes
 * @returns {string}
 */
function clockOf(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Weekday code -> the word a person reads. */
const WEEKDAY_WORD = Object.freeze({
  SUN: 'Sunday',
  MON: 'Monday',
  TUE: 'Tuesday',
  WED: 'Wednesday',
  THU: 'Thursday',
  FRI: 'Friday',
  SAT: 'Saturday',
});

/**
 * One team's history, as phases.
 *
 * Undated phases are **included and marked**, never dropped. The corpus's
 * seven revisions carry no dates (`fixtures/season-2026/practice/README.md`
 * §4), and a history that quietly omitted them would report a team with no
 * practices as confidently as a team with none. The undated ones sort last.
 *
 * @param {import('./types.js').PracticeSlotSet} slotSet
 * @param {{ teamId: string }} query
 * @returns {import('./types.js').PracticeHistory}
 */
export function buildPracticeHistory(slotSet, { teamId }) {
  if (!teamId) throw new TypeError('buildPracticeHistory requires a teamId');

  /** @type {import('./types.js').PracticeFinding[]} */
  const findings = [];
  /** @type {import('./types.js').PracticePhase[]} */
  const phases = [];

  for (const assignment of slotSet.assignments) {
    if (assignment.teamId !== teamId) continue;
    const slot = slotSet.slots.find((candidate) => candidate.id === assignment.slotId);
    /* c8 ignore next 3 -- buildPracticeSlotSet() rejects a dangling assignment */
    if (!slot) {
      throw new Error(`practice: assignment "${assignment.id}" has no slot`);
    }
    phases.push({
      from: assignment.effectiveFrom ?? slot.validFrom,
      until: assignment.effectiveUntil ?? slot.validUntil,
      slotId: slot.id,
      surfaceId: slot.surfaceId,
      weekday: slot.weekday,
      startMinutes: slot.startMinutes,
      durationMinutes: slot.durationMinutes,
      revisionId: slot.revisionId,
      label: slot.label,
    });
  }

  phases.sort((a, b) => {
    if (a.from === null && b.from === null)
      return a.slotId < b.slotId ? -1 : a.slotId > b.slotId ? 1 : 0;
    if (a.from === null) return 1;
    if (b.from === null) return -1;
    if (a.from !== b.from) return a.from < b.from ? -1 : 1;
    return a.slotId < b.slotId ? -1 : a.slotId > b.slotId ? 1 : 0;
  });

  const dated = phases.filter((phase) => phase.from !== null);

  let overlapCount = 0;
  for (let i = 0; i < dated.length; i += 1) {
    for (let j = i + 1; j < dated.length; j += 1) {
      const a = dated[i];
      const b = dated[j];
      if (
        /** @type {string} */ (a.from) <= /** @type {string} */ (b.until) &&
        /** @type {string} */ (b.from) <= /** @type {string} */ (a.until)
      ) {
        overlapCount += 1;
        findings.push(
          makePracticeFinding(
            PRACTICE_REASON.HISTORY_OVERLAP,
            `team ${teamId} holds "${a.slotId}" (${a.from}..${a.until}) and "${b.slotId}" (${b.from}..${b.until}) over the same dates; a practice history is a sequence of non-overlapping ranges`,
            {
              teamId,
              slotIds: [a.slotId, b.slotId],
              ranges: [`${a.from}..${a.until}`, `${b.from}..${b.until}`],
            }
          )
        );
      }
    }
  }

  let gapCount = 0;
  for (let i = 1; i < dated.length; i += 1) {
    const previousEnd = isoDayNumber(/** @type {string} */ (dated[i - 1].until));
    const thisStart = isoDayNumber(/** @type {string} */ (dated[i].from));
    if (thisStart <= previousEnd + 1) continue;
    gapCount += 1;
    findings.push(
      makePracticeFinding(
        PRACTICE_REASON.HISTORY_GAP,
        `team ${teamId} has no practice between ${isoDateOfDayNumber(previousEnd + 1)} and ${isoDateOfDayNumber(thisStart - 1)}`,
        {
          teamId,
          gapFrom: isoDateOfDayNumber(previousEnd + 1),
          gapUntil: isoDateOfDayNumber(thisStart - 1),
          days: thisStart - previousEnd - 1,
        }
      )
    );
  }

  findings.push(
    makePracticeFinding(
      PRACTICE_REASON.MODEL_UNWIRED,
      `this history for team ${teamId} reaches no production path; nothing outside packages/core/src/practice/ builds one`,
      { teamId, phaseCount: phases.length }
    )
  );

  return deepFreeze({
    teamId,
    phases,
    findings,
    status: derivePracticeStatus(findings),
    stats: {
      phaseCount: phases.length,
      datedPhaseCount: dated.length,
      undatedPhaseCount: phases.length - dated.length,
      overlapCount,
      gapCount,
    },
  });
}

/**
 * Render a history as the phase list a person reads.
 *
 * One line per phase, in order, each naming the range it covers, the ground,
 * and the weekly window. An undated phase says so in the place the dates would
 * have been, rather than being rendered as though it covered the season.
 *
 * @param {import('./types.js').PracticeHistory} history
 * @returns {string[]}
 */
export function describePracticeHistory(history) {
  if (history.phases.length === 0) {
    return [`Team ${history.teamId}: no practice slot in this plan.`];
  }
  const lines = [`Team ${history.teamId} — ${history.phases.length} phase(s):`];
  for (const phase of history.phases) {
    const range =
      phase.from === null ? 'dates not stated in the source' : `${phase.from} to ${phase.until}`;
    const window = `${WEEKDAY_WORD[phase.weekday]} ${clockOf(phase.startMinutes)}–${clockOf(
      phase.startMinutes + phase.durationMinutes
    )}`;
    const revision = phase.revisionId === null ? '' : ` [${phase.revisionId}]`;
    lines.push(`  ${range}: ${window} on ${phase.surfaceId}${revision}`);
  }
  return lines;
}
