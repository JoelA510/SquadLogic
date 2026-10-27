/**
 * Synthetic permits in the shape `get_facility_permits` returns them, for the coach's card and page
 * tests (Phase C3). No real venue, issuer or document: invented names, example data only.
 */
export const ORG = 'a1111111-1111-4111-8111-111111111111';
export const VENUE = 'f1000000-0000-4000-8000-000000000001';
export const FIELD = 'f1000000-0000-4000-8000-000000000011';

const file = (id, name = 'permit.pdf') => ({
  path: `${ORG}/${id}/c0000000-0000-4000-8000-000000000001.pdf`,
  name,
  mime: 'application/pdf',
  size: 52_000,
});

const scope = {
  id: 's1',
  kind: 'field',
  field_id: FIELD,
  location_id: VENUE,
  field_name: 'Pitch 1',
  location_name: 'Permit Park',
  retired: false,
};

/**
 * @param {string} id - the last character of a fixed UUID
 * @param {Record<string, any>} [over]
 */
export const permitFixture = (id, over = {}) => {
  const permitId = `f6000000-0000-4000-8000-00000000000${id}`;
  return {
    id: permitId,
    organization_id: ORG,
    issuer: 'Parks Dept',
    permit_number: '0042',
    valid_from: '2026-09-01',
    valid_to: '2027-03-01',
    notes: null,
    status: 'valid',
    days_left: 125,
    file: file(permitId),
    scopes: [scope],
    ...over,
  };
};

export const VALID = permitFixture('1', { issuer: 'Valley Parks' });
export const EXPIRING = permitFixture('2', {
  issuer: 'City Recreation',
  permit_number: '0099',
  status: 'expiring',
  days_left: 12,
  valid_to: '2026-11-08',
});
export const EXPIRED = permitFixture('3', {
  issuer: 'County Fields',
  permit_number: null,
  status: 'expired',
  days_left: -3,
  valid_to: '2026-10-24',
});
export const NO_FILE = permitFixture('4', { issuer: 'School District', file: null });
export const NOT_YET = permitFixture('5', {
  issuer: 'Winter Lease',
  status: 'not_yet_valid',
  days_left: 200,
  valid_from: '2026-12-01',
  valid_to: '2027-05-01',
});

/** What `supabase.rpc('get_facility_permits')` answers. */
export const readOf = (permits) => ({
  data: { today: '2026-10-27', lead_days: 30, permits },
  error: null,
});
