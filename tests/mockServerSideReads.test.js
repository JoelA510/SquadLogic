// The mock arms of migration 20261021010000 apply the same access table as the
// SQL (supabase/tests/server_side_reads.sql holds the database to it), in both
// directions: the caller admitted gets the data, the caller refused gets 42501.
// Since 20261024010000 (R3) there is no guardian, and since
// docs/changes/2026-10-27-admin-only.md no coach signs in: only an admin or
// staff member reads a roster or a team's staff, and the coaches in the seed
// ('cora', 'finn', 'otto') are signed-in accounts with no membership, whose
// coach rows are data. Since 20261025010000 (R4) there is no
// contact surface: no read returns a contact, and the contact card writer and
// the coach directory are not arms of this module. The seed still carries a
// coach's imported phone and email and players' guardian contacts, as a row
// written before R4 might, so a read leaking one would show.
import { beforeEach, describe, expect, it } from 'vitest';
import { handleServerSideReadRpc, localDateIn } from '../frontend/src/lib/mockServerSideReads.js';

const ORG = 'org-a';
const NOW = new Date('2026-10-21T12:00:00Z');
const TODAY = '2026-10-21';
const YESTERDAY = '2026-10-20';

function seed() {
  return {
    organizations: [{ id: ORG, feature_flags: {} }],
    organization_members: [
      { organization_id: ORG, profile_id: 'admin', role: 'admin' },
      { organization_id: ORG, profile_id: 'staff', role: 'staff' },
      // A stale coach-role member: nothing grants one a read.
      { organization_id: ORG, profile_id: 'mo', role: 'coach' },
    ],
    profiles: [{ id: 'cora', email: 'cora@example.test' }],
    season_settings: [{ id: 'season', timezone: 'America/Los_Angeles' }],
    divisions: [{ id: 'div', season_settings_id: 'season' }],
    teams: [
      { id: 'team-a', organization_id: ORG, division_id: 'div', name: 'A-Team' },
      { id: 'team-b', organization_id: ORG, division_id: 'div', name: 'B-Team' },
    ],
    coaches: [
      {
        id: 'c-cora',
        organization_id: ORG,
        full_name: 'Cora',
        phone: '555-0102',
        email: 'cora@example.test',
        status: 'active',
      },
      { id: 'c-finn', organization_id: ORG, full_name: 'Finn', status: 'active' },
      { id: 'c-otto', organization_id: ORG, full_name: 'Otto', status: 'active' },
    ],
    team_coach_assignments: [
      {
        organization_id: ORG,
        team_id: 'team-a',
        coach_id: 'c-cora',
        role: 'lead',
        effective_from: '2026-09-01',
        effective_to: null,
      },
      {
        organization_id: ORG,
        team_id: 'team-a',
        coach_id: 'c-finn',
        role: 'assistant',
        effective_from: '2026-09-01',
        effective_to: YESTERDAY,
      },
      {
        organization_id: ORG,
        team_id: 'team-b',
        coach_id: 'c-otto',
        role: 'lead',
        effective_from: '2026-09-01',
        effective_to: null,
      },
    ],
    players: [
      {
        id: 'pia',
        organization_id: ORG,
        first_name: 'Pia',
        last_name: 'Able',
        rating: 3,
        guardian_contacts: [
          { name: 'Gwen', email: 'GWEN@example.test', phone: '555-0201' },
          { name: 'Gus', email: 'gus@example.test' },
        ],
      },
      {
        id: 'rex',
        organization_id: ORG,
        first_name: 'Rex',
        last_name: 'Baker',
        rating: 4,
        guardian_contacts: [
          {
            name: 'Rhea',
            email: 'rhea@example.test',
            alternate_email: 'rhea2@example.test',
            phone: '555-0202',
          },
          { name: 'Ron', email: 'ron@example.test' },
        ],
      },
    ],
    team_players: [
      { team_id: 'team-a', player_id: 'pia' },
      { team_id: 'team-a', player_id: 'rex' },
    ],
    audit_log: [],
  };
}

let db;
const call = (user, name, params = {}) =>
  handleServerSideReadRpc(db, name, params, {
    currentUserId: user,
    now: NOW,
  });
const roster = (user) => call(user, 'get_team_roster', { p_team_id: 'team-a' });

beforeEach(() => {
  db = seed();
});

describe('mock server-side reads', () => {
  it('judges today in the season timezone and falls back to UTC for an unreadable zone', () => {
    expect(localDateIn('America/Los_Angeles', new Date('2026-10-21T03:00:00Z'))).toBe('2026-10-20');
    expect(localDateIn('Not/AZone', new Date('2026-10-21T03:00:00Z'))).toBe('2026-10-21');
    expect(localDateIn(null, NOW)).toBe(TODAY);
  });

  it('has no guardian link, contact card or coach directory to call', () => {
    for (const name of ['link_my_guardian_records', 'set_my_contact_card', 'get_coach_directory']) {
      expect(call('cora', name, { p_organization_id: ORG })).toBeNull();
      expect(call('admin', name, { p_organization_id: ORG })).toBeNull();
    }
  });

  it('admits admins and staff to the roster, with every column', () => {
    for (const user of ['admin', 'staff']) {
      expect(roster(user).data.map((r) => `${r.first_name}:${r.rating}`)).toEqual([
        'Pia:3',
        'Rex:4',
      ]);
      for (const row of roster(user).data) expect(row).not.toHaveProperty('is_my_child');
    }
  });

  it('returns no contact to anyone: no guardian contact on the roster, no phone or email on the staff', () => {
    for (const user of ['admin', 'staff']) {
      for (const row of roster(user).data) {
        expect(Object.keys(row).filter((key) => /mail|phone|contact|guardian/i.test(key))).toEqual(
          []
        );
      }
      const staff = call(user, 'get_team_staff', { p_team_id: 'team-a' }).data;
      expect(staff).toEqual([
        {
          coach_id: 'c-cora',
          full_name: 'Cora',
          role: 'lead',
          status: 'active',
        },
      ]);
    }
    const text = JSON.stringify([
      roster('admin').data,
      call('admin', 'get_team_staff', { p_team_id: 'team-a' }).data,
    ]);
    for (const value of [
      '555-0102',
      'cora@example.test',
      'GWEN@example.test',
      'rhea2@example.test',
    ]) {
      expect(text).not.toContain(value);
    }
  });

  it('refuses a team’s coach, its former coach and a stale coach-role member, and an unknown team', () => {
    // Non-vacuous: the current coach of team-a has an assignment, and still reads nothing.
    expect(
      db.team_coach_assignments.some((a) => a.team_id === 'team-a' && a.coach_id === 'c-cora')
    ).toBe(true);
    for (const user of ['cora', 'finn', 'otto', 'mo']) {
      expect(roster(user).error?.code).toBe('42501');
      expect(call(user, 'get_team_staff', { p_team_id: 'team-a' }).error?.code).toBe('42501');
    }
    expect(call('admin', 'get_team_roster', { p_team_id: 'nope' }).error?.code).toBe('42501');
    expect(call(null, 'get_team_roster', { p_team_id: 'team-a' }).error?.code).toBe('42501');
  });

  it('has no coached-team or division read to call: no coach signs in', () => {
    for (const name of [
      'get_my_coached_team_ids',
      'admin_get_coached_team_ids',
      'get_my_division_teams',
      'admin_get_division_teams',
    ]) {
      expect(call('admin', name, { p_organization_id: ORG, p_user_id: 'cora' })).toBeNull();
    }
  });
});
