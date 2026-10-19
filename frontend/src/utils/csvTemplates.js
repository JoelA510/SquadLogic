/**
 * CSV template generators for the three import types (players / coaches /
 * fields). Users click "Download Template" in ImportPanel to get a .csv
 * with the expected header row + one example row they can replace.
 *
 * Header labels use the human-friendly form (e.g. "First Name") rather than
 * the canonical snake_case — the import pipeline's alias map in
 * `src/utils/telemetryUtils.js` normalizes them back on upload, and the
 * friendlier form is easier to hand to club admins.
 *
 * Required columns mirror `REQUIRED_HEADERS` in `ImportContext.jsx` and
 * `REQUIRED_FIELDS` in `supabase/functions/import-validation/index.ts`. Add
 * the common optional columns so users discover what else they can include.
 */

import { escapeCsvCell } from '@squadlogic/core/csv.js';

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
    headers: ['Full Name', 'Email', 'Willing to Coach'],
    example: ['Alex Smith', 'coach@example.com', 'yes'],
    filename: 'squadlogic-coaches-template.csv',
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
 * @param {'players'|'coaches'|'fields'|'field_availability'} type
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
