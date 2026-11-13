/**
 * CSV template generators for the import types (players / coaches /
 * evaluations / fields / field availability). Users click "Download Template" in ImportPanel to get a .csv
 * with the expected header row + one example row they can replace.
 *
 * Header labels use the human-friendly form (e.g. "First Name") rather than
 * the canonical snake_case — the import pipeline's alias map in
 * `src/utils/telemetryUtils.js` normalizes them back on upload, and the
 * friendlier form is easier to hand to club admins.
 *
 * Required columns mirror `REQUIRED_HEADERS` in `ImportContext.jsx` and
 * `REQUIRED_FIELDS` in `supabase/functions/import-validation/index.ts` (the
 * coach import also takes First Name and Last Name for Full Name). Add
 * the common optional columns so users discover what else they can include.
 */

import { escapeCsvCell } from '@squadlogic/core/csv.js';
// The constants module, not the parser: this file loads with the Import page, the parser only with the schedule panel.
import { SCHEDULE_IMPORT_TEMPLATE_HEADER } from '@squadlogic/core/scheduleImport/columns.js';

export const CSV_TEMPLATES = {
  players: {
    headers: [
      'First Name',
      'Last Name',
      'Date of Birth',
      'Registration ID',
      'Buddy ID',
      'Medical Info',
      'Skill Tier',
    ],
    example: ['Jane', 'Doe', '2015-03-14', 'GS-1001', 'GS-1002', 'None', 'developing'],
    filename: 'squadlogic-players-template.csv',
  },
  coaches: {
    // Child Registration ID is optional: the registration ids (as the players import has them) of
    // the coach's children, separated by ; or ,. It is what anchors the coach's team (S7), so import
    // players first.
    headers: ['Full Name', 'Email', 'Willing to Coach', 'Child Registration ID'],
    example: ['Alex Smith', 'coach@example.com', 'yes', 'GS-1001; GS-1003'],
    filename: 'squadlogic-coaches-template.csv',
  },
  // E3c: only the registration id and the values it sets. A blank cell leaves a stored value alone,
  // so a file can carry any of the three columns, and a player's row any of the three cells.
  evaluations: {
    headers: ['Registration ID', 'Years Played', 'Skill Tier', 'Rating'],
    example: ['GS-1001', '2', 'developing', '3'],
    filename: 'squadlogic-evaluations-template.csv',
  },
  // The games import (plan 4.3 of docs/changes/2026-11-03-schedule-expansion.md): the header row is core's own
  // (`SCHEDULE_IMPORT_TEMPLATE_HEADER`), so the template cannot name a column the import does not read. Placeholder
  // values; a `Length` column of minutes may stand in for `End Time`.
  games: {
    headers: [...SCHEDULE_IMPORT_TEMPLATE_HEADER],
    example: [
      'G-0001',
      '2026-09-12',
      '09:00',
      '10:00',
      'Venue A',
      'Field 1',
      'U10 Boys',
      'Home Team Name',
      'Away Team Name',
      '1',
    ],
    filename: 'squadlogic-games-template.csv',
  },
  // The practice schedule import (plan 4.11.2 of docs/changes/2026-11-03-schedule-expansion.md): the header row is
  // core's `PRACTICE_IMPORT_TEMPLATE_HEADER`, written out here so the parser does not load with the Import page
  // (`tests/practiceImportPanel.test.jsx` holds the two equal). Placeholder values; `Length` in minutes may stand in
  // for `End`, a blank Team is an open slot, and Use is blank or "hold".
  practice_schedule: {
    headers: [
      'Team',
      'Division',
      'Day',
      'Start',
      'End',
      'Location',
      'Field',
      'Subunit',
      'Valid From',
      'Valid Until',
      'Capacity',
      'Use',
    ],
    example: [
      'Team Name',
      'U10 Boys',
      'Tue',
      '16:00',
      '17:00',
      'Venue A',
      'Field 1',
      'A',
      '',
      '',
      '1',
      '',
    ],
    filename: 'squadlogic-practices-template.csv',
  },
  fields: {
    headers: [
      'Location',
      'Field',
      'Subunit',
      'Type',
      'Day',
      'Slot Date',
      'Start',
      'End',
      'Capacity',
      'Valid From',
      'Valid Until',
      'Surface Type',
      'Supports Halves',
      // D2: optional. A practice slot named for a division of the season is
      // reserved to it; blank leaves it open to every division.
      'Division',
    ],
    example: [
      'Main Park',
      'Field 1',
      'A',
      'practice',
      'Mon',
      '',
      '17:30',
      '18:30',
      '1',
      '2026-03-01',
      '2026-05-31',
      'Grass',
      'yes',
      '',
    ],
    filename: 'squadlogic-fields-template.csv',
  },
  field_availability: {
    headers: [
      'season_label',
      'record_status',
      'location',
      'name',
      'surface_type',
      'primary_format',
      'format_quantity',
      'secondary_format',
      'available_from',
      'available_until',
      'availability_rule',
      'blackout_months',
      'teams_per_hour',
      'aggregate_teams_per_hour',
      'capacity_basis',
      'lighted',
      'restroom_potty',
      'goal_equipment',
      'goal_status',
      'approval_status',
      'use_context',
      'day_constraints',
      'move_to_location',
      'current_app_import_status',
      'notes',
    ],
    example: [
      'Fall 2026',
      'active',
      'Example Park',
      'Main Field',
      'grass',
      '7v7',
      '2',
      '',
      '2026-08-01',
      '2026-11-30',
      'seasonal',
      'none',
      '6',
      '8',
      'field',
      'yes',
      'yes',
      'portable',
      'ready',
      'approved',
      'practice',
      'weekdays',
      '',
      'pending',
      '',
    ],
    filename: 'squadlogic-field-availability-template.csv',
  },
};

function toCsv(rows) {
  return rows.map((row) => row.map(escapeCsvCell).join(',')).join('\r\n');
}

/**
 * Generate a template CSV and trigger a browser download.
 * @param {'players'|'coaches'|'evaluations'|'fields'|'field_availability'|'games'|'practice_schedule'} type
 */
export function downloadTemplate(type) {
  const tmpl = CSV_TEMPLATES[type];
  if (!tmpl) return;

  const csv = toCsv([tmpl.headers, tmpl.example]);
  // Prepend UTF-8 BOM (U+FEFF) so Excel opens it with the right
  // encoding. The \uFEFF escape is preferred over a literal BOM so the
  // character survives editor round-trips (Gemini review on #185) and
  // so `no-irregular-whitespace` doesn't trip on the source file.
  const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = tmpl.filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
