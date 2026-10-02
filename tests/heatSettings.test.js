/**
 * Org heat settings: the client Zod schema, the mock RPC arm, and the SQL
 * writer's URL rule agree on one case table -- the same cases
 * `docs/sql/20261006000000_smoke.sql` runs against the real RPC.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GUIDANCE_URL_PATTERN,
  OrgHeatSettingsSchema,
  normalizeSurface,
} from '@squadlogic/core/heat/index.js';

import { HEAT_SETTINGS_RPCS, handleHeatSettingsRpc } from '../frontend/src/lib/mockHeatSettings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORG = 'org-1';
const ADMIN = 'admin-1';

const makeDb = () => ({
  organization_members: [
    { organization_id: ORG, profile_id: ADMIN, role: 'admin' },
    { organization_id: ORG, profile_id: 'coach-1', role: 'coach' },
    { organization_id: 'org-2', profile_id: 'outsider', role: 'admin' },
  ],
});

const call = (db, params, user = ADMIN) =>
  handleHeatSettingsRpc(db, 'admin_set_org_heat_settings', params, { currentUserId: user });

/** @type {Array<[string, any]>} */
const BAD_LINK_LISTS = [
  ['not an array', 'not an array'],
  ['a non-object item', [1]],
  ['a missing url', [{ label: 'x' }]],
  ['an extra key', [{ label: 'x', url: 'https://example.org', extra: 1 }]],
  ['a blank label', [{ label: '   ', url: 'https://example.org' }]],
  ['an http url', [{ label: 'x', url: 'http://example.org' }]],
  ['a host with no dot', [{ label: 'x', url: 'https://localhost' }]],
  ['whitespace in the url', [{ label: 'x', url: 'https://exa mple.org' }]],
  ['a non-string label', [{ label: 5, url: 'https://example.org' }]],
  [
    '11 links',
    Array.from({ length: 11 }, (_, i) => ({ label: `L${i}`, url: `https://example.org/${i}` })),
  ],
];

describe('mock admin_set_org_heat_settings', () => {
  it('is the one RPC the arm claims, and ignores others', () => {
    expect(HEAT_SETTINGS_RPCS).toEqual(['admin_set_org_heat_settings']);
    expect(
      handleHeatSettingsRpc(makeDb(), 'something_else', {}, { currentUserId: ADMIN })
    ).toBeNull();
  });

  it('upserts trimmed values for an admin', () => {
    const db = makeDb();
    const res = call(db, {
      p_organization_id: ORG,
      p_threshold_category: 2,
      p_guidance_links: [{ label: '  League safety ', url: ' https://example.org/safety ' }],
    });
    expect(res.error).toBeNull();
    expect(db.organization_heat_settings).toEqual([
      expect.objectContaining({
        organization_id: ORG,
        threshold_category: 2,
        guidance_links: [{ label: 'League safety', url: 'https://example.org/safety' }],
        updated_by: ADMIN,
      }),
    ]);
    call(db, { p_organization_id: ORG, p_threshold_category: 1, p_guidance_links: [] });
    expect(db.organization_heat_settings).toHaveLength(1);
    expect(db.organization_heat_settings[0]).toMatchObject({
      threshold_category: 1,
      guidance_links: [],
    });
  });

  it("refuses a coach and another organisation's admin with 42501", () => {
    for (const user of ['coach-1', 'outsider']) {
      const db = makeDb();
      const res = call(
        db,
        { p_organization_id: ORG, p_threshold_category: 1, p_guidance_links: [] },
        user
      );
      expect(res.error.code).toBe('42501');
      expect(db.organization_heat_settings).toBeUndefined();
    }
  });

  it.each([0, 4, -1, null, '2'])('refuses category %j with 22023', (cat) => {
    const res = call(makeDb(), {
      p_organization_id: ORG,
      p_threshold_category: cat,
      p_guidance_links: [],
    });
    expect(res.error.code).toBe('22023');
  });

  it.each(BAD_LINK_LISTS)('refuses %s with 22023', (_name, links) => {
    const res = call(makeDb(), {
      p_organization_id: ORG,
      p_threshold_category: 1,
      p_guidance_links: links,
    });
    expect(res.error.code).toBe('22023');
  });

  it('refuses a missing organization with 23502', () => {
    expect(call(makeDb(), { p_threshold_category: 1, p_guidance_links: [] }).error.code).toBe(
      '23502'
    );
  });
});

describe('OrgHeatSettingsSchema agrees with the RPC', () => {
  it.each(BAD_LINK_LISTS)('refuses %s', (_name, links) => {
    expect(
      OrgHeatSettingsSchema.safeParse({ thresholdCategory: 1, guidanceLinks: links }).success
    ).toBe(false);
  });

  it('accepts and trims a valid payload', () => {
    const parsed = OrgHeatSettingsSchema.parse({
      thresholdCategory: 3,
      guidanceLinks: [
        { label: ' NorCal ', url: ' https://norcalpremier.com/resources/player-health-safety/ ' },
      ],
    });
    expect(parsed.guidanceLinks[0]).toEqual({
      label: 'NorCal',
      url: 'https://norcalpremier.com/resources/player-health-safety/',
    });
  });

  it.each([0, 4, 1.5, '1'])('refuses category %j', (cat) => {
    expect(
      OrgHeatSettingsSchema.safeParse({ thresholdCategory: cat, guidanceLinks: [] }).success
    ).toBe(false);
  });
});

describe('the SQL URL rule is the client rule', () => {
  it("the migration's regex, read as a JS regex, decides every case the same way", () => {
    const sql = readFileSync(
      path.join(ROOT, 'supabase/migrations/20261006000000_org_heat_settings.sql'),
      'utf8'
    );
    const m = /v_url !~ '([^']+)'/.exec(sql);
    expect(m).not.toBeNull();
    const asJs = new RegExp(
      m[1].replace(/\[\^\[:space:\]\]/g, '\\S').replace(/\[:space:\]/g, '\\s')
    );
    const cases = [
      'https://example.org',
      'https://example.org/path?q=1#f',
      'https://sub.example.org:8443/x',
      'http://example.org',
      'https://localhost',
      'https://exa mple.org',
      'https://example.org/a b',
      'https://.org',
      'ftp://example.org',
      'https://example.',
    ];
    let compared = 0;
    for (const url of cases) {
      expect(asJs.test(url), url).toBe(GUIDANCE_URL_PATTERN.test(url));
      compared += 1;
    }
    expect(compared).toBe(cases.length);
    // Both accept and refuse something: the comparison is not vacuous.
    expect(cases.some((u) => GUIDANCE_URL_PATTERN.test(u))).toBe(true);
    expect(cases.some((u) => !GUIDANCE_URL_PATTERN.test(u))).toBe(true);
  });
});

describe('normalizeSurface', () => {
  it.each([
    ['Grass', { surface: 'grass' }],
    [' TURF ', { surface: 'turf' }],
    ['Indoor', { surface: null, reason: 'indoor' }],
    ['', { surface: null, reason: 'missing' }],
    [null, { surface: null, reason: 'missing' }],
    ['Clay', { surface: null, reason: 'unknown' }],
  ])('%j -> %j', (raw, expected) => {
    expect(normalizeSurface(raw)).toEqual(expected);
  });
});
