// Who reaches what after admin focus R6 (plan
// docs/changes/2026-10-22-admin-focus.md; migration 20261028010000): a coach
// holds no scheduling permission and has a three-item nav; score entry and
// standings are admin functions the league turns on, off by default; and the
// Standings page offers score entry only to an admin while `score_entry` is on.
import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { seedMockDb } from './helpers/seedMockDb.js';
import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLES,
  hasPermission,
} from '../frontend/src/constants/permissions.js';
import { NAV, ROLE_NAV } from '../frontend/src/constants/navigation.js';
import {
  FEATURE_CATALOG,
  FEATURE_DEFAULTS,
  FEATURE_FLAGS,
  FeatureFlagSchema,
} from '../frontend/src/constants/featureFlags.js';

const ORG = 'org-r6-standings';
const context = vi.hoisted(() => ({
  role: 'admin',
  flags: /** @type {Record<string, any>} */ ({}),
}));

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mockSupabase, supabaseReady: Promise.resolve() };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: 'org-r6-standings', name: 'Synthetic FC' },
    currentSeasonSetting: { id: 'season-r6' },
    orgMember: { role: context.role },
    featureFlags: context.flags,
  }),
}));
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'user-r6' }, isImpersonating: false }),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

/** @type {any[]} */
const flatNav = NAV.flatMap((/** @type {any} */ node) =>
  node.type === 'item' ? [node] : node.items
);

describe('the coach role', () => {
  it('holds no scheduling, score entry, standings or lighting permission, and the field-permit one', () => {
    expect([...ROLE_PERMISSIONS[ROLES.COACH]].sort()).toEqual(
      [
        PERMISSIONS.VIEW_ORGANIZATION,
        PERMISSIONS.MANAGE_OWN_TEAM,
        PERMISSIONS.REQUEST_PRACTICE_PREFERENCE,
        // Phase C3: the permits of the fields their teams use.
        PERMISSIONS.VIEW_FIELD_PERMITS,
      ].sort()
    );
    for (const permission of [
      PERMISSIONS.MANAGE_SCHEDULE,
      PERMISSIONS.VIEW_SCHEDULE,
      PERMISSIONS.DECIDE_PRACTICE_LIGHTING_OVERRIDE,
    ]) {
      expect(hasPermission(ROLES.COACH, permission)).toBe(false);
      expect(hasPermission(ROLES.ADMIN, permission)).toBe(true);
      expect(hasPermission(ROLES.STAFF, permission)).toBe(true);
    }
  });

  it('has a nav of home, My Team (the coach’s team, not the league’s), field permits and practice preferences', () => {
    expect(ROLE_NAV.coach.map((item) => [item.label, item.path])).toEqual([
      ['My Dashboard', '/'],
      ['My Team', '/my-team'],
      ['Field Permits', '/permits'],
      ['Practice Preferences', '/coaches/practice-preferences'],
    ]);
    // "My Team" pointed at /teams, the admin's league view a coach may not open.
    const teamsItem = flatNav.find((item) => item.path === '/teams');
    expect(hasPermission(ROLES.COACH, teamsItem.permission)).toBe(false);
  });
});

describe('score entry and standings: admin functions the league turns on', () => {
  it('are off unless set, offered in the settings, and parsed as booleans', () => {
    expect(FEATURE_DEFAULTS).not.toHaveProperty(FEATURE_FLAGS.SCORE_ENTRY);
    expect(FEATURE_DEFAULTS).not.toHaveProperty(FEATURE_FLAGS.STANDINGS);
    const keys = FEATURE_CATALOG.map((entry) => entry.key);
    expect(keys).toContain(FEATURE_FLAGS.SCORE_ENTRY);
    expect(keys).toContain(FEATURE_FLAGS.STANDINGS);
    expect(FeatureFlagSchema.parse({ score_entry: true, standings: 'yes' })).toEqual({
      score_entry: true,
    });
  });

  it('gate their nav items on the admin permission and the setting', () => {
    const standings = flatNav.find((item) => item.path === '/standings');
    const scores = flatNav.find((item) => item.path === '/scores');
    expect([standings.permission, standings.feature]).toEqual([
      PERMISSIONS.VIEW_SCHEDULE,
      FEATURE_FLAGS.STANDINGS,
    ]);
    expect([scores.permission, scores.feature]).toEqual([
      PERMISSIONS.MANAGE_SCHEDULE,
      FEATURE_FLAGS.SCORE_ENTRY,
    ]);
  });
});

describe('LeagueStandings :: score entry', () => {
  beforeEach(() => {
    sessionStorage.clear();
    delete window.__MOCK_DB__;
    seedMockDb({
      teams: [
        { id: 'r6-home', name: 'R6 Home', organization_id: ORG },
        { id: 'r6-away', name: 'R6 Away', organization_id: ORG },
      ],
      games: [
        {
          id: 'r6-game',
          organization_id: ORG,
          home_team_id: 'r6-home',
          away_team_id: 'r6-away',
          start_time: new Date(Date.now() - 86_400_000).toISOString(),
          score_home: null,
          score_away: null,
        },
      ],
    });
  });

  const cases = [
    ['an admin, score entry on', 'admin', { score_entry: true }, true],
    ['an admin, score entry unset', 'admin', {}, false],
    ['an admin, score entry off', 'admin', { score_entry: false }, false],
    ['staff, score entry on', 'staff', { score_entry: true }, true],
    ['a coach, score entry on', 'coach', { score_entry: true }, false],
  ];

  it.each(cases)('%s', async (_name, role, flags, offered) => {
    context.role = String(role);
    context.flags = /** @type {Record<string, any>} */ (flags);
    const { default: LeagueStandings } = await import('../frontend/src/pages/LeagueStandings.jsx');
    render(<LeagueStandings />);
    const card = await screen.findByTestId('game-score-card');
    expect(card).toHaveTextContent('R6 Home');
    expect(screen.queryAllByLabelText('Home Score')).toHaveLength(offered ? 1 : 0);
  });
});
