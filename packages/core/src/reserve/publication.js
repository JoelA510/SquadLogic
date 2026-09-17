/**
 * Publication: putting slots that are not fully known, and fixtures that have no
 * slot at all, into the export.
 *
 * > *"They must occupy fields, appear in exports, and accept team assignment
 * > later without moving."* — and, for an unplaced fixture, *"export with
 * > explicit TIME TBD / LOCATION TBD plus the reason."*
 *
 * ## What this module is, and what it deliberately is not
 *
 * It is a **projection**. It turns {@link import('./types.js').ReservedSlot} and
 * {@link import('./types.js').UnplacedFixture} records into flat rows keyed by
 * `SCHEDULE_EXPORT_HEADERS` — the column vocabulary
 * `packages/core/src/outputGeneration.js` already publishes — so the two cannot
 * drift apart into two spellings of "Event Type".
 *
 * It is **not** wired into `generateScheduleExports()`, and that is a decision
 * rather than an omission. That function requires a truthy `homeTeamId` *and* a
 * truthy `awayTeamId`, requires both to resolve in the team directory, requires
 * truthy `start` and `end`, and normalises both through `new Date(value)`.
 * Every one of those is a wall an unnamed fixture or a TIME TBD row hits by
 * construction: a `Select Game 7` has no teams yet, and `TIME TBD` is not a
 * date. Relaxing four validators and a date normaliser inside a function the
 * shipping app already calls is not a small additive change, and Prompt 5.1
 * asks for the data in a shape that function can consume rather than for the
 * rewiring. So: rows in its vocabulary here, wiring named as follow-up in
 * `docs/MODEL_GAPS.md` (GAP-16, GAP-17, GAP-28).
 *
 * ## The one thing it checks
 *
 * That every subject produced at least one row — every reserved slot as well as
 * every unplaced fixture, both enumerated from the input rather than from the
 * rows. The export is the last place a fixture can quietly disappear, and a
 * projection that silently emitted nothing for a TIME TBD fixture would
 * reproduce incident 10 at the final step. {@link publicationCoverageFindings}
 * is that check, exported so a test can construct the drop and watch it fire.
 *
 * @module reserve/publication
 */

import { SCHEDULE_EXPORT_COLUMNS, SCHEDULE_EXPORT_HEADERS } from '../outputGeneration.js';
import {
  COACH_SOURCE_DISAGREEMENT_CODES,
  coachExportCells,
  coachesOfTeamRow,
} from '../people/coachList.js';

import {
  FIXTURE_SIDE,
  PUBLICATION_TBD,
  RESERVE_KIND,
  RESERVE_REASON,
  createReserveMeta,
  deriveReserveStatus,
  makeReserveFinding,
} from './reasonCodes.js';
import { slotNamesATeam } from './slots.js';

/** The `Event Type` values this module emits. */
export const PUBLICATION_EVENT_TYPE = Object.freeze({
  /** A committed league slot whose teams are not yet known. */
  UNNAMED_FIXTURE: 'Game (teams TBD)',
  /** Ground held for a purpose, with no fixture behind it. */
  RESERVATION: 'Field Reservation',
  /** A named game. */
  GAME: 'Game',
  /** A fixture that must exist and has no legal slot. */
  UNPLACED: 'Game (unscheduled)',
});

/** Minutes in one calendar day. */
const MINUTES_PER_DAY = 24 * 60;

/**
 * `date` plus `days`, as calendar arithmetic.
 *
 * Still naive. The instant a wall-clock time denotes is never constructed and no
 * offset is ever applied to it; what is computed here is which *day* the clock
 * rolled onto, and it is done in UTC so that no local zone — and no DST
 * transition (GAP-30) — can move the answer. `days` is `0` for every time inside
 * its own day, which is every time the corpus contains.
 *
 * @param {string} date - `YYYY-MM-DD`
 * @param {number} days
 * @returns {string}
 */
function addDays(date, days) {
  if (days === 0) return date;
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/**
 * Render minutes past local midnight as a naive local datetime.
 *
 * The first place in Phases 1-5 that renders a time for a human, and it stays
 * **naive**: the wall clock is never turned into an instant and no offset is
 * applied to it, because the corpus is wall-clock only and two of its dates fall
 * after DST ends. GAP-30 has since given the repository a composer
 * (`timing/seasonClock.js`), but a renderer is the wrong place to call it: this
 * function is handed minutes and a date and no zone, and turning those into an
 * instant without one is how an evening kickoff moves an hour without anybody
 * asking.
 *
 * A time at or past midnight rolls onto the next calendar date rather than
 * printing a 24th hour. `${date}T24:00:00` is not a time, and an `End` column
 * carrying one is a cell no calendar or spreadsheet can read.
 *
 * @param {string} date - `YYYY-MM-DD`
 * @param {number|null} minutes
 * @param {string} fallback - what to print when there is no time
 * @returns {string}
 */
export function naiveDateTime(date, minutes, fallback) {
  if (minutes === null || minutes === undefined) return fallback;
  // A day holds 1440 minutes and no more. An 11v11 block that starts at 23:00
  // ends at minute 1470, and `T24:30:00` is not a time — no parser accepts it,
  // so a late game's `End` column would arrive at a family's calendar as
  // garbage. The overflow rolls onto the next calendar date instead.
  const dayOffset = Math.floor(minutes / MINUTES_PER_DAY);
  const withinDay = minutes - dayOffset * MINUTES_PER_DAY;
  const hours = String(Math.floor(withinDay / 60)).padStart(2, '0');
  const mins = String(withinDay % 60).padStart(2, '0');
  return `${addDays(date, dayOffset)}T${hours}:${mins}:00`;
}

/**
 * One blank row in the export's vocabulary.
 *
 * @returns {Record<string, string>}
 */
function blankRow() {
  /** @type {Record<string, string>} */
  const row = {};
  for (const column of SCHEDULE_EXPORT_COLUMNS) row[column] = '';
  return row;
}

/**
 * What a side should print as.
 *
 * @param {string} side - a `FIXTURE_SIDE` value
 * @param {string|null} teamId
 * @param {string|null} label
 * @param {Map<string, Object>} directory
 * @returns {string}
 */
function sideText(side, teamId, label, directory) {
  if (side === FIXTURE_SIDE.TEAM && teamId) {
    return String(directory.get(teamId)?.name ?? teamId);
  }
  if (side === FIXTURE_SIDE.TBD) return PUBLICATION_TBD.OPPONENT;
  if (side === FIXTURE_SIDE.NONE) return '';
  return label ?? '';
}

/**
 * Fill a row's team columns from the directory, or from the id alone.
 *
 * The coach columns come from the same reconciliation
 * `generateScheduleExports()` uses, so a team prints the same coaches whichever
 * of the two projections produced the row. 8.2: one `Coaches` column carrying
 * every coach in the club's declared order, and no column asserting which of
 * them is the head — see `people/coachList.js` for why that claim is gone.
 *
 * @param {Record<string, string>} row
 * @param {string|null} teamId
 * @param {string} displayName
 * @param {Map<string, Object>} directory
 * @param {string|null} divisionLabel
 * @param {(team: Object) => { coaches: string, emails: string }} [coachCellsFor] - reconciled once per team, on first lookup
 * @returns {void}
 */
function fillTeam(row, teamId, displayName, directory, divisionLabel, coachCellsFor) {
  const team = teamId ? directory.get(teamId) : null;
  row[SCHEDULE_EXPORT_HEADERS.TEAM_ID] = teamId ?? '';
  row[SCHEDULE_EXPORT_HEADERS.TEAM_NAME] = String(team?.name ?? displayName);
  row[SCHEDULE_EXPORT_HEADERS.DIVISION] = String(team?.division ?? divisionLabel ?? '');

  const cell = team && coachCellsFor ? coachCellsFor(team) : undefined;
  row[SCHEDULE_EXPORT_HEADERS.COACHES] = cell?.coaches ?? '';
  row[SCHEDULE_EXPORT_HEADERS.COACH_EMAILS] = cell?.emails ?? '';
}

/**
 * Project reserved slots and unplaced fixtures into export rows.
 *
 * @param {{ slots?: ReadonlyArray<import('./types.js').ReservedSlot>, unplaced?: ReadonlyArray<import('./types.js').UnplacedFixture>, teams?: ReadonlyArray<Object> }} input
 * @returns {{ rows: import('./types.js').PublicationRow[], columns: ReadonlyArray<string>, findings: import('./types.js').ReserveFinding[], status: string, meta: import('./types.js').ReserveMeta }}
 */
export function publicationRowsFor(input) {
  const meta = createReserveMeta();
  /** @type {import('./types.js').ReserveFinding[]} */
  const findings = [];
  /** @type {import('./types.js').PublicationRow[]} */
  const rows = [];

  const directory = new Map((input.teams ?? []).map((team) => [String(team.id), team]));
  // Reconciled **once per team, and only for a team a row names**. A team with
  // five unplaced fixtures produces five rows, and reconciling inside
  // `fillTeam()` reported its one disagreement five times — a finding count
  // that scaled with the export rather than with the facts. The opposite
  // error came next: reconciling every team in the directory reported a
  // disagreement for teams on no row at all, so a two-fixture TIME TBD
  // publication naming neither of them came back `compromise` with every row
  // clean. `TEAM_COACH_SOURCES_DISAGREE` is defined on the exported rows, so
  // its subject set is the teams `fillTeam()` actually looked up.
  //
  // The disagreement lands in `findings`, in **this** module's vocabulary.
  // Carrying it out on a separate `coachFindings` key made it inert: produced
  // here, read by nothing, and therefore silently dropped on the reserve /
  // TIME TBD path while its twin in `outputGeneration.js` reached an operator.
  // `deriveReserveStatus()` reads `findings`, so every existing consumer of
  // this projection sees it with no new reader to write.
  /** @type {Map<string, { coaches: string, emails: string }>} */
  const coachCells = new Map();
  /** @param {Object} team */
  const coachCellsFor = (team) => {
    const key = String(team.id);
    const cached = coachCells.get(key);
    if (cached) return cached;
    const reconciled = coachesOfTeamRow(team);
    const disagreements = reconciled.findings.filter((finding) =>
      COACH_SOURCE_DISAGREEMENT_CODES.has(finding.code)
    );
    if (disagreements.length > 0) {
      findings.push(
        makeReserveFinding(
          RESERVE_REASON.TEAM_COACH_SOURCES_DISAGREE,
          `team "${team.id}" has ${disagreements.length} coach-source disagreement(s) (${[...new Set(disagreements.map((finding) => finding.code))].sort().join(', ')}); every coach is exported and none is treated as the team's primary`,
          {
            teamId: key,
            codes: [...new Set(disagreements.map((finding) => finding.code))].sort(),
            disagreements: disagreements.length,
          }
        )
      );
    }
    const cells = coachExportCells(reconciled.coaches);
    coachCells.set(key, cells);
    return cells;
  };

  const slots = input.slots ?? [];
  const unplaced = input.unplaced ?? [];

  for (const slot of slots) {
    meta.slotsExamined += 1;
    const eventType =
      slot.kind === RESERVE_KIND.RESERVATION
        ? PUBLICATION_EVENT_TYPE.RESERVATION
        : slotNamesATeam(slot)
          ? PUBLICATION_EVENT_TYPE.GAME
          : PUBLICATION_EVENT_TYPE.UNNAMED_FIXTURE;

    const sides = /** @type {const} */ (['home', 'away']);
    const named = sides.filter((side) => slot[`${side}Side`] === FIXTURE_SIDE.TEAM);
    const notes = slot.purpose ?? '';

    const base = () => {
      const row = blankRow();
      row[SCHEDULE_EXPORT_HEADERS.EVENT_TYPE] = eventType;
      row[SCHEDULE_EXPORT_HEADERS.START] = naiveDateTime(
        slot.date,
        slot.startMinutes,
        PUBLICATION_TBD.TIME
      );
      row[SCHEDULE_EXPORT_HEADERS.END] = naiveDateTime(
        slot.date,
        slot.endMinutes,
        PUBLICATION_TBD.TIME
      );
      row[SCHEDULE_EXPORT_HEADERS.FIELD] = slot.surfaceId;
      row[SCHEDULE_EXPORT_HEADERS.SLOT] = slot.id;
      row[SCHEDULE_EXPORT_HEADERS.NOTES] = notes;
      return row;
    };

    if (named.length === 0) {
      // Nobody is named yet, and the row still has to exist: the club committed
      // this field and this kickoff, and a schedule that omitted it would show
      // the ground as free.
      const row = base();
      fillTeam(row, null, slot.label, directory, slot.divisionLabel, coachCellsFor);
      row[SCHEDULE_EXPORT_HEADERS.OPPONENT] = sideText(
        slot.awaySide,
        slot.awayTeamId,
        slot.awayLabel,
        directory
      );
      rows.push({ row, subjectId: slot.id, teamId: null });
      meta.rowsEmitted += 1;
      continue;
    }

    for (const side of named) {
      const other = side === 'home' ? 'away' : 'home';
      const teamId = slot[`${side}TeamId`];
      const row = base();
      fillTeam(row, teamId, String(teamId), directory, slot.divisionLabel, coachCellsFor);
      row[SCHEDULE_EXPORT_HEADERS.ROLE] = side === 'home' ? 'Home' : 'Away';
      row[SCHEDULE_EXPORT_HEADERS.OPPONENT] = sideText(
        slot[`${other}Side`],
        slot[`${other}TeamId`],
        slot[`${other}Label`],
        directory
      );
      rows.push({ row, subjectId: slot.id, teamId: /** @type {string} */ (teamId) });
      meta.rowsEmitted += 1;
    }
  }

  for (const fixture of unplaced) {
    meta.fixturesTimeTbd += 1;
    const base = () => {
      const row = blankRow();
      row[SCHEDULE_EXPORT_HEADERS.EVENT_TYPE] = PUBLICATION_EVENT_TYPE.UNPLACED;
      row[SCHEDULE_EXPORT_HEADERS.START] = fixture.timeStatus;
      row[SCHEDULE_EXPORT_HEADERS.END] = fixture.timeStatus;
      row[SCHEDULE_EXPORT_HEADERS.FIELD] = fixture.locationStatus;
      row[SCHEDULE_EXPORT_HEADERS.SLOT] = fixture.fixtureId;
      row[SCHEDULE_EXPORT_HEADERS.NOTES] = fixture.reason;
      return row;
    };

    const sides = /** @type {const} */ (['home', 'away']);
    const named = sides.filter((side) => Boolean(fixture[`${side}TeamId`]));

    if (named.length === 0) {
      const row = base();
      fillTeam(row, null, fixture.label, directory, fixture.divisionLabel, coachCellsFor);
      rows.push({ row, subjectId: fixture.fixtureId, teamId: null });
      meta.rowsEmitted += 1;
      continue;
    }

    for (const side of named) {
      const other = side === 'home' ? 'away' : 'home';
      const teamId = /** @type {string} */ (fixture[`${side}TeamId`]);
      const row = base();
      fillTeam(row, teamId, teamId, directory, fixture.divisionLabel, coachCellsFor);
      row[SCHEDULE_EXPORT_HEADERS.ROLE] = side === 'home' ? 'Home' : 'Away';
      row[SCHEDULE_EXPORT_HEADERS.OPPONENT] = String(
        fixture[`${other}TeamId`] ?? fixture[`${other}Label`] ?? PUBLICATION_TBD.OPPONENT
      );
      rows.push({ row, subjectId: fixture.fixtureId, teamId });
      meta.rowsEmitted += 1;
    }
  }

  findings.push(...publicationCoverageFindings(input, rows));

  return {
    rows,
    columns: SCHEDULE_EXPORT_COLUMNS,
    findings,
    status: deriveReserveStatus(findings),
    meta,
  };
}

/**
 * Did every subject reach the export?
 *
 * The export is the last place a fixture can quietly disappear, so this is the
 * check that says it did not — and it is **exported and given both its inputs**
 * for one reason. The subjects come from `input`, the inventory the rows were
 * built *from*; they are never enumerated from `rows`, because a subject that
 * produced no row is exactly what is missing from `rows` and a check that took
 * its universe from there would be comparing a set against itself. `CLAUDE.md`
 * §"Verification conventions" names that shape by name, and this is the third
 * time it has been found in this repository.
 *
 * Taking `rows` as an argument rather than closing over them is what makes the
 * check **falsifiable**: `tests/reserveCapacity.test.js` hands it the same
 * inventory with one subject's rows removed and proves it fires. A coverage
 * assertion nobody can make fail is not a coverage assertion.
 *
 * A missing reserved slot is `RESERVED_SLOT_DROPPED` and a missing fixture is
 * `FIXTURE_DROPPED`: both `blocking`, and each named for what was lost — ground
 * the club committed that would print as free, or a game a team would never be
 * told about.
 *
 * @param {{ slots?: ReadonlyArray<import('./types.js').ReservedSlot>, unplaced?: ReadonlyArray<import('./types.js').UnplacedFixture> }} input
 * @param {ReadonlyArray<import('./types.js').PublicationRow>} rows
 * @returns {import('./types.js').ReserveFinding[]}
 */
export function publicationCoverageFindings(input, rows) {
  const covered = new Set(rows.map((entry) => entry.subjectId));
  /** @type {import('./types.js').ReserveFinding[]} */
  const findings = [];

  for (const slot of input.slots ?? []) {
    if (covered.has(slot.id)) continue;
    findings.push(
      makeReserveFinding(
        RESERVE_REASON.RESERVED_SLOT_DROPPED,
        `reserved slot "${slot.id}" (${slot.label}) produced no export row, so the ground the club committed on ${slot.date} would print as free`,
        { slotId: slot.id, label: slot.label, date: slot.date, surfaceId: slot.surfaceId }
      )
    );
  }

  for (const fixture of input.unplaced ?? []) {
    if (covered.has(fixture.fixtureId)) continue;
    findings.push(
      makeReserveFinding(
        RESERVE_REASON.FIXTURE_DROPPED,
        `fixture "${fixture.fixtureId}" is carried as ${fixture.timeStatus} and produced no export row, so it would be invisible to the people it belongs to`,
        { fixtureId: fixture.fixtureId }
      )
    );
  }

  return findings;
}
