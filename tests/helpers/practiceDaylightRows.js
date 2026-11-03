/**
 * Stored rows for the Practice daylight outlook's tests (duration-phase wiring,
 * PR B): the shapes the page reads, in the table's own column names, so the
 * model, the component, the hook's fake client and the E2E seed all start from
 * one estate.
 *
 * **Synthetic only.** No real venue, club, person or coordinate: 40.00 / -75.00
 * are round numbers, not a place, and every name is a placeholder.
 *
 * The estate (season 2026-09-01 to 2026-11-30, `America/New_York`, school ends
 * 16:00; the clocks go back on Sunday 2026-11-01). Every expectation in the
 * tests that use it is derived from this list and from the plan's arithmetic,
 * not from what the page printed:
 *
 *   Central Park (coordinates, unlit)   Field 1:  Mon 15:00-16:00   ends well before sunset
 *                                                 Tue 18:00-19:00   shortened, then started earlier;
 *                                                                   one date nothing saves; two teams
 *                                                 Wed 17:00-18:00   four dates nothing saves
 *                                                 Sat 10:00-11:00   dated 1 to 3 Sep: no Saturday in it
 *                                       Field 2:  half A Tue 18:00-19:00, approved lighting all season
 *                                                 half B Wed 18:00-19:00, approved lighting 6 to 19 Oct
 *                                       Field 5:  Mon 18:00-19:00, dated to 31 Oct: retimed, always saved
 *   Far Park (no coordinates, unlit)    Field 3:  Thu 17:00-18:00   sunset unknown
 *   Bright Park (coordinates, lit)      Field 4:  Fri 18:00-19:00   not judged
 */

/** @param {number} n */
export const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const ORG = uuid(1);
export const SEASON_ID = uuid(2);

export const ID = Object.freeze({
  parkVenue: uuid(101),
  farVenue: uuid(102),
  brightVenue: uuid(103),
  field1: uuid(201),
  field2: uuid(202),
  field3: uuid(203),
  field4: uuid(204),
  field5: uuid(205),
  halfA: uuid(301),
  halfB: uuid(302),
  tigers: uuid(401),
  lions: uuid(402),
  hawks: uuid(403),
  ok: uuid(501),
  dark: uuid(502),
  floor: uuid(503),
  unknown: uuid(504),
  lit: uuid(505),
  retimed: uuid(506),
  exempt: uuid(507),
  partial: uuid(508),
  noDates: uuid(509),
});

/** The season as `season_settings` stores it. */
export const SEASON = Object.freeze({
  id: SEASON_ID,
  organization_id: ORG,
  name: 'Fall 2026',
  status: 'active',
  season_start: '2026-09-01',
  season_end: '2026-11-30',
  timezone: 'America/New_York',
  school_day_end: '16:00:00',
});

const slot = (id, field, day, start, end, validFrom = '2026-09-01', validUntil = '2026-11-30') => ({
  id,
  organization_id: ORG,
  field_id: field,
  field_subunit_id: null,
  day_of_week: day,
  start_time: start,
  end_time: end,
  valid_from: validFrom,
  valid_until: validUntil,
});

/**
 * The rows, as the hook reads them (`locations`, `fields`, `fieldSubunits`,
 * `practiceSlots`, `practiceAssignments`, `lightingOverrides`, `teams`).
 *
 * @returns {Record<string, any[]>}
 */
export function estateRows() {
  return {
    locations: [
      {
        id: ID.parkVenue,
        organization_id: ORG,
        name: 'Central Park',
        lighting_available: false,
        latitude: '40.00',
        longitude: '-75.00',
      },
      {
        id: ID.farVenue,
        organization_id: ORG,
        name: 'Far Park',
        lighting_available: false,
        latitude: null,
        longitude: null,
      },
      {
        id: ID.brightVenue,
        organization_id: ORG,
        name: 'Bright Park',
        lighting_available: true,
        latitude: '40.00',
        longitude: '-75.00',
      },
    ],
    fields: [
      { id: ID.field1, organization_id: ORG, location_id: ID.parkVenue, name: 'Field 1' },
      { id: ID.field2, organization_id: ORG, location_id: ID.parkVenue, name: 'Field 2' },
      { id: ID.field3, organization_id: ORG, location_id: ID.farVenue, name: 'Field 3' },
      { id: ID.field4, organization_id: ORG, location_id: ID.brightVenue, name: 'Field 4' },
      { id: ID.field5, organization_id: ORG, location_id: ID.parkVenue, name: 'Field 5' },
    ],
    fieldSubunits: [
      { id: ID.halfA, organization_id: ORG, field_id: ID.field2, label: 'A' },
      { id: ID.halfB, organization_id: ORG, field_id: ID.field2, label: 'B' },
    ],
    practiceSlots: [
      slot(ID.ok, ID.field1, 'mon', '15:00:00', '16:00:00'),
      slot(ID.dark, ID.field1, 'tue', '18:00:00', '19:00:00'),
      slot(ID.floor, ID.field1, 'wed', '17:00:00', '18:00:00'),
      slot(ID.unknown, ID.field3, 'thu', '17:00:00', '18:00:00'),
      slot(ID.lit, ID.field4, 'fri', '18:00:00', '19:00:00'),
      slot(ID.retimed, ID.field5, 'mon', '18:00:00', '19:00:00', '2026-09-01', '2026-10-31'),
      { ...slot(ID.exempt, null, 'tue', '18:00:00', '19:00:00'), field_subunit_id: ID.halfA },
      { ...slot(ID.partial, null, 'wed', '18:00:00', '19:00:00'), field_subunit_id: ID.halfB },
      slot(ID.noDates, ID.field1, 'sat', '10:00:00', '11:00:00', '2026-09-01', '2026-09-03'),
    ],
    practiceAssignments: [
      assignment(uuid(601), ID.tigers, ID.dark),
      assignment(uuid(602), ID.lions, ID.dark),
      assignment(uuid(603), ID.hawks, ID.retimed),
    ],
    lightingOverrides: [
      override(uuid(701), ID.exempt, '[2026-09-01,2026-12-01)', 'approved'),
      override(uuid(702), ID.partial, '[2026-10-06,2026-10-20)', 'approved'),
      // A window on lit ground exempts nothing: named, not applied.
      override(uuid(703), ID.lit, '[2026-10-06,2026-10-13)', 'approved'),
      // A window that is only requested is not in force.
      override(uuid(704), ID.floor, '[2026-11-04,2026-11-26)', 'requested'),
    ],
    teams: [
      { id: ID.tigers, organization_id: ORG, name: 'Tigers' },
      { id: ID.lions, organization_id: ORG, name: 'Lions' },
      { id: ID.hawks, organization_id: ORG, name: 'Hawks' },
    ],
  };
}

/**
 * @param {string} id
 * @param {string} team
 * @param {string} slotId
 */
export function assignment(id, team, slotId) {
  return {
    id,
    organization_id: ORG,
    team_id: team,
    practice_slot_id: slotId,
    effective_date_range: '[2026-09-01,2026-12-01)',
  };
}

/**
 * @param {string} id
 * @param {string} slotId
 * @param {string} window
 * @param {string} status
 */
export function override(id, slotId, window, status) {
  return {
    id,
    organization_id: ORG,
    practice_slot_id: slotId,
    window,
    kind: 'portable-lighting',
    status,
  };
}

/**
 * The same estate, as the tables the fake client serves (database names).
 *
 * @param {Record<string, any[]>} [rows]
 */
export function estateTables(rows = estateRows()) {
  return {
    locations: rows.locations,
    fields: rows.fields,
    field_subunits: rows.fieldSubunits,
    practice_slots: rows.practiceSlots,
    practice_assignments: rows.practiceAssignments,
    practice_lighting_overrides: rows.lightingOverrides,
    teams: rows.teams,
  };
}
