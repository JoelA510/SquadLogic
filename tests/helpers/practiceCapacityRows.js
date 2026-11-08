/**
 * Stored rows for the capacity-versus-demand panel's tests (schedule expansion, PR 13): the four
 * tables it reads, in the tables' own column names, with extra columns the panel does not ask for
 * (the fake client returns only the columns a select names, lesson 60, so a column the query
 * forgot changes the report).
 *
 * **Synthetic only.** Every name is a placeholder.
 *
 * The league (season 2026-09-07 to 2026-11-29, `America/Chicago`; "today" is 2026-10-05, a Monday,
 * which a test sets with a fake clock). Every expectation in the tests that use it is worked out
 * from this list:
 *
 *   Slots     tue-17   Tue 17:00-18:00  60 min  capacity 2   open to every division
 *             thu-17   Thu 17:00-18:00  60 min  capacity 1   open to every division
 *             wed-45   Wed 17:00-17:45  45 min  capacity 2   open to every division
 *             old-mon  Mon 17:00-18:00  60 min  capacity 3   valid to 2026-09-28: no date left from today
 *
 *   U8   1 a week, any length   Hawks (holds a row on tue-17), Bears
 *        needs 1; slots tue-17 (room 1 of 2), thu-17 (1 of 1), wed-45 (2 of 2): 3 slots, room 4 of 5; 3 to spare
 *   U10  2 a week, 60 minutes   Lions
 *        needs 2; slots tue-17 (room 1), thu-17 (1): 2 slots on 2 weekdays, room 2 of 3; 0 to spare
 *   U12  0 a week               Otters, Ravens, Foxes: none wanted
 *   U14  1 a week, 90 minutes   Wolves
 *        needs 1; no slot is 90 minutes: no slot open, practice-length, short by 1
 *   U6   (another season)       Minnows: not in this season's rows at all
 *
 *   Whole season: 7 teams, wants 5 a week, holds 1, still needs 4; 3 distinct slots open to some
 *   division (the rows add up to 5), room 4 of 5: 0 to spare.
 */

/** @param {number} n */
export const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const ORG = uuid(1);
export const SEASON_ID = uuid(2);
export const OTHER_SEASON_ID = uuid(3);

/** "Today" for the league: noon in Chicago. */
export const TODAY_INSTANT = '2026-10-05T17:00:00Z';
export const TODAY = '2026-10-05';

export const ID = Object.freeze({
  u8: uuid(11),
  u10: uuid(12),
  u12: uuid(13),
  u14: uuid(14),
  u6: uuid(15),
  hawks: uuid(21),
  bears: uuid(22),
  lions: uuid(23),
  otters: uuid(24),
  ravens: uuid(25),
  foxes: uuid(26),
  wolves: uuid(27),
  minnows: uuid(28),
  tue17: uuid(31),
  thu17: uuid(32),
  wed45: uuid(33),
  oldMon: uuid(34),
  hawksRow: uuid(41),
});

/** The season as `season_settings` stores it (the columns the organization context carries). */
export const SEASON = Object.freeze({
  id: SEASON_ID,
  timezone: 'America/Chicago',
  season_start: '2026-09-07',
  season_end: '2026-11-29',
});

const division = (id, name, perWeek, minutes, seasonId = SEASON_ID) => ({
  id,
  organization_id: ORG,
  season_settings_id: seasonId,
  name,
  practices_per_week: perWeek,
  practice_minutes: minutes,
  // Columns the panel does not ask for.
  gender_policy: 'coed',
  max_roster_size: 14,
});

const team = (id, name, divisionId) => ({
  id,
  organization_id: ORG,
  division_id: divisionId,
  name,
  notes: null,
  coach_id: null,
});

const slot = (id, day, start, end, capacity, until = '2026-11-30') => ({
  id,
  organization_id: ORG,
  day_of_week: day,
  start_time: start,
  end_time: end,
  capacity,
  valid_from: '2026-09-01',
  valid_until: until,
  division_id: null,
  field_id: uuid(900),
  label: null,
});

/** A fresh copy of every table, so a test may change its rows. */
export function capacityTables() {
  return {
    divisions: [
      division(ID.u8, 'U8', 1, null),
      division(ID.u10, 'U10', 2, 60),
      division(ID.u12, 'U12', 0, null),
      division(ID.u14, 'U14', 1, 90),
      division(ID.u6, 'U6', 1, null, OTHER_SEASON_ID),
    ],
    teams: [
      team(ID.hawks, 'Hawks', ID.u8),
      team(ID.bears, 'Bears', ID.u8),
      team(ID.lions, 'Lions', ID.u10),
      team(ID.otters, 'Otters', ID.u12),
      team(ID.ravens, 'Ravens', ID.u12),
      team(ID.foxes, 'Foxes', ID.u12),
      team(ID.wolves, 'Wolves', ID.u14),
      team(ID.minnows, 'Minnows', ID.u6),
    ],
    practice_slots: [
      slot(ID.tue17, 'tue', '17:00:00', '18:00:00', 2),
      slot(ID.thu17, 'thu', '17:00:00', '18:00:00', 1),
      slot(ID.wed45, 'wed', '17:00:00', '17:45:00', 2),
      slot(ID.oldMon, 'mon', '17:00:00', '18:00:00', 3, '2026-09-28'),
    ],
    practice_assignments: [
      {
        id: ID.hawksRow,
        organization_id: ORG,
        team_id: ID.hawks,
        practice_slot_id: ID.tue17,
        slot_id: null,
        effective_date_range: null,
        assigned_via: 'auto',
        source: 'auto',
        run_id: null,
      },
    ],
  };
}
