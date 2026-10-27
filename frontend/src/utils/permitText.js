/**
 * What a permit's status and scopes read as. Plain text, never colour alone: the status badge shows
 * an icon beside these words.
 *
 * Dates are wall-clock `YYYY-MM-DD` (inclusive); they are shown in UTC so the browser's zone cannot
 * move a day.
 */

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * @param {string} iso - `YYYY-MM-DD`
 * @returns {string} e.g. `Dec 31, 2026`
 */
export function formatPermitDate(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return String(iso ?? '');
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * @param {{ status: string, days_left: number, valid_from: string, valid_to: string }} permit - as
 *   `get_facility_permits` returns it
 * @returns {string}
 */
export function permitStatusText(permit) {
  switch (permit.status) {
    case 'expiring':
      if (permit.days_left === 0) return 'Expires today';
      return `Expires in ${plural(permit.days_left, 'day')}`;
    case 'expired': {
      const ago = -permit.days_left;
      return ago === 1 ? 'Expired yesterday' : `Expired ${plural(ago, 'day')} ago`;
    }
    case 'not_yet_valid':
      return `Starts ${formatPermitDate(permit.valid_from)}`;
    case 'valid':
      return `Valid until ${formatPermitDate(permit.valid_to)}`;
    default:
      throw new Error(`Unknown permit status ${JSON.stringify(permit.status)}`);
  }
}

/** The badge tone for a status (the shared `.badge` tones). */
export function permitStatusTone(status) {
  return (
    { expired: 'danger', expiring: 'warning', not_yet_valid: 'info', valid: 'success' }[status] ??
    'neutral'
  );
}

/**
 * One scope as text: `Permit Park` for a venue, `Permit Park, Pitch 1` for a field, with
 * ` (retired)` when its end date has passed.
 * @param {{ kind: string, field_name?: string|null, location_name?: string|null, retired?: boolean }} scope
 */
export function permitScopeText(scope) {
  const text =
    scope.kind === 'field'
      ? [scope.location_name, scope.field_name].filter(Boolean).join(', ')
      : `${scope.location_name ?? 'Venue'} (whole venue)`;
  return scope.retired ? `${text} (retired)` : text;
}
