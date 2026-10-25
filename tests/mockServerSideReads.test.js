// The mock arms of migration 20261021010000 apply the same access table as the
// SQL (supabase/tests/server_side_reads.sql holds the database to it), in both
// directions: the caller admitted gets the data, the caller refused gets 42501.
// Since 20261024010000 (R3) there is no guardian: no guardian link, a coach's
// roster is names only, and the member with no tie to a team ('mo') is a
// coach-role member who coaches none. Since 20261025010000 (R4) there is no
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
      { organization_id: ORG, profile_id: 'cora', role: 'coach' },
      { organization_id: ORG, profile_id: 'finn', role: 'coach' },
      { organization_id: ORG, profile_id: 'otto', role: 'coach' },
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
        user_id: 'cora',
        full_name: 'Cora',
        phone: '555-0102',
        email: 'cora@example.test',
        status: 'active',
      },
      { id: 'c-finn', organization_id: ORG, user_id: 'finn', full_name: 'Finn', status: 'active' },
      { id: 'c-otto', organization_id: ORG, user_id: 'otto', full_name: 'Otto', status: 'active' },
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

  it('admits admins, staff and the current coach to the roster, the coach to names only', () => {
    for (const user of ['admin', 'staff']) {
      expect(roster(user).data.map((r) => `${r.first_name}:${r.rating}`)).toEqual([
        'Pia:3',
        'Rex:4',
      ]);
    }
    const coach = roster('cora').data;
    expect(coach.map((r) => `${r.first_name} ${r.last_name}`)).toEqual(['Pia Able', 'Rex Baker']);
    for (const row of coach) {
      expect(row).not.toHaveProperty('is_my_child');
      expect([row.gender, row.years_played, row.rating, row.willing_to_coach]).toEqual([
        null,
        null,
        null,
        null,
      ]);
    }
  });

  it('returns no contact to anyone: no guardian contact on the roster, no phone or email on the staff', () => {
    for (const user of ['admin', 'staff', 'cora']) {
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
          status: user === 'cora' ? null : 'active',
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

  it('refuses the former coach, another team’s coach, an unrelated member and an unknown team', () => {
    for (const user of ['finn', 'otto', 'mo']) {
      expect(roster(user).error?.code).toBe('42501');
      expect(call(user, 'get_team_staff', { p_team_id: 'team-a' }).error?.code).toBe('42501');
    }
    expect(call('admin', 'get_team_roster', { p_team_id: 'nope' }).error?.code).toBe('42501');
    expect(call(null, 'get_team_roster', { p_team_id: 'team-a' }).error?.code).toBe('42501');
  });

  it('answers an admin’s role preview of a coach, and refuses a non-admin', () => {
    expect(
      call('admin', 'admin_get_coached_team_ids', { p_organization_id: ORG, p_user_id: 'cora' })
        .data
    ).toEqual(['team-a']);
    expect(
      call('otto', 'admin_get_coached_team_ids', { p_organization_id: ORG, p_user_id: 'cora' })
        .error?.code
    ).toBe('42501');
  });

  it('lists the teams the caller currently coaches', () => {
    expect(call('cora', 'get_my_coached_team_ids', { p_organization_id: ORG }).data).toEqual([
      'team-a',
    ]);
    expect(call('finn', 'get_my_coached_team_ids', { p_organization_id: ORG }).data).toEqual([]);
  });
});

// Admin focus R6 (20261028010000): the coach's divisions, as division_teams_of
// answers them -- every team of a division where the user currently coaches a
// team, its current coaches' names (lead first), and no contact.
describe('mock division reads', () => {
  beforeEach(() => {
    db.divisions = [
      { id: 'div', organization_id: ORG, season_settings_id: 'season', name: 'U10' },
      { id: 'div-2', organization_id: ORG, season_settings_id: 'season', name: 'U12' },
    ];
    db.teams.push({ id: 'team-c', organization_id: ORG, division_id: 'div-2', name: 'C-Team' });
    db.coaches.push({
      id: 'c-uma',
      organization_id: ORG,
      user_id: 'uma',
      full_name: 'Uma',
      email: 'uma@example.test',
    });
    db.organization_members.push({ organization_id: ORG, profile_id: 'uma', role: 'coach' });
    db.team_coach_assignments.push(
      {
        organization_id: ORG,
        team_id: 'team-c',
        coach_id: 'c-uma',
        role: 'lead',
        effective_from: '2026-09-01',
        effective_to: null,
      },
      // Otto also assists A-Team: named after its lead.
      {
        organization_id: ORG,
        team_id: 'team-a',
        coach_id: 'c-otto',
        role: 'assistant',
        effective_from: '2026-09-01',
        effective_to: null,
      }
    );
  });

  const teams = (user, name = 'get_my_division_teams', extra = {}) =>
    call(user, name, { p_organization_id: ORG, ...extra });

  it('gives a coach every team of their division, its current coaches lead first, and no contact', () => {
    expect(teams('cora').data).toEqual([
      {
        division_id: 'div',
        division_name: 'U10',
        team_id: 'team-a',
        team_name: 'A-Team',
        coach_names: ['Cora', 'Otto'],
        is_mine: true,
      },
      {
        division_id: 'div',
        division_name: 'U10',
        team_id: 'team-b',
        team_name: 'B-Team',
        coach_names: ['Otto'],
        is_mine: false,
      },
    ]);
    // Finn's A-Team assignment ended yesterday: he is named nowhere and reads nothing.
    expect(JSON.stringify(teams('cora').data)).not.toMatch(/Finn|@|555/);
    expect(teams('finn').data).toEqual([]);
    expect(teams('uma').data.map((row) => row.team_name)).toEqual(['C-Team']);
    for (const user of ['mo', 'admin']) expect(teams(user).data).toEqual([]);
  });

  it('answers an admin’s preview of a coach, and refuses a non-admin and no session', () => {
    expect(
      teams('admin', 'admin_get_division_teams', { p_user_id: 'uma' }).data.map((r) => r.team_id)
    ).toEqual(['team-c']);
    expect(teams('cora', 'admin_get_division_teams', { p_user_id: 'uma' }).error?.code).toBe(
      '42501'
    );
    expect(teams(null).error?.code).toBe('42501');
  });
});
