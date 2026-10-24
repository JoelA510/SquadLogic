// The mock arms of migration 20261021010000 apply the same access table as the
// SQL (supabase/tests/server_side_reads.sql holds the database to it), in both
// directions: the caller admitted gets the data, the caller refused gets 42501.
// Since 20261024010000 (R3) there is no guardian: no guardian link, a coach's
// roster is names only, and the member with no tie to a team ('mo') is a
// coach-role member who coaches none.
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
    newId: () => 'id',
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

  it('has no guardian link to call', () => {
    expect(call('cora', 'link_my_guardian_records')).toBeNull();
  });

  it('admits admins, staff and the current coach to the roster, the coach to names only', () => {
    for (const user of ['admin', 'staff']) {
      expect(
        roster(user).data.map((r) => `${r.first_name}:${r.rating}:${r.guardian_contacts.length}`)
      ).toEqual(['Pia:3:2', 'Rex:4:2']);
    }
    expect(roster('admin').data[1].guardian_contacts[0]).toEqual({
      name: 'Rhea',
      email: 'rhea@example.test',
      alternate_email: 'rhea2@example.test',
      phone: '555-0202',
    });
    const coach = roster('cora').data;
    expect(coach.map((r) => `${r.first_name} ${r.last_name}`)).toEqual(['Pia Able', 'Rex Baker']);
    for (const row of coach) {
      expect(row).not.toHaveProperty('is_my_child');
      expect(row.guardian_contacts).toEqual([]);
      expect([row.gender, row.years_played, row.rating, row.willing_to_coach]).toEqual([
        null,
        null,
        null,
        null,
      ]);
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

  it('keeps only the contact objects of a malformed contact list, as the SQL does', () => {
    db.players[1].guardian_contacts = ['legacy text', { name: 'Pat', email: 'pat@example.test' }];
    expect(roster('admin').data[1].guardian_contacts).toEqual([
      { name: 'Pat', email: 'pat@example.test' },
    ]);
    expect(roster('cora').data[1].guardian_contacts).toEqual([]);
  });

  it('reads a stored guardian_contact_sharing nowhere', () => {
    db.organizations[0].feature_flags.guardian_contact_sharing = false;
    expect(roster('admin').data.map((r) => r.guardian_contacts.length)).toEqual([2, 2]);
  });

  it('a saved card replaces a coach’s imported details, an unshared one shows none, and each save is audited', () => {
    expect(
      call('cora', 'set_my_contact_card', { p_phone: 'call me', p_email: null, p_share: true })
        .error?.code
    ).toBe('22023');
    expect(
      call('cora', 'set_my_contact_card', { p_phone: '+1 555 0199', p_email: 'card@example.test' })
        .error?.code
    ).toBe('23502');
    call('cora', 'set_my_contact_card', {
      p_phone: '+1 555 0199',
      p_email: 'card@example.test',
      p_share: true,
    });
    const staff = () => call('admin', 'get_team_staff', { p_team_id: 'team-a' }).data;
    expect(staff()[0]).toMatchObject({ phone: '+1 555 0199', email: 'card@example.test' });
    call('cora', 'set_my_contact_card', { p_phone: '', p_email: '', p_share: false });
    expect(call('cora', 'get_team_staff', { p_team_id: 'team-a' }).data).toEqual([
      {
        coach_id: 'c-cora',
        full_name: 'Cora',
        role: 'lead',
        phone: null,
        email: null,
        status: null,
      },
    ]);
    const audits = db.audit_log.filter((row) => row.action === 'profile.contact_card_updated');
    expect(audits).toHaveLength(2);
    expect(audits[1].metadata).toEqual({
      share_contact: false,
      has_phone: false,
      has_email: false,
    });
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

  it('the directory admits a current coach while on, refuses them while off, and admits staff either way', () => {
    const names = (user) =>
      call(user, 'get_coach_directory', { p_organization_id: ORG }).data?.map((d) => d.full_name);
    expect(names('otto')).toEqual(['Cora', 'Otto']);
    expect(call('mo', 'get_coach_directory', { p_organization_id: ORG }).error?.code).toBe('42501');
    expect(call('finn', 'get_coach_directory', { p_organization_id: ORG }).error?.code).toBe(
      '42501'
    );
    db.organizations[0].feature_flags.coach_directory = false;
    expect(call('otto', 'get_coach_directory', { p_organization_id: ORG }).error?.code).toBe(
      '42501'
    );
    expect(names('staff')).toEqual(['Cora', 'Otto']);
  });

  it('lists the teams the caller currently coaches', () => {
    expect(call('cora', 'get_my_coached_team_ids', { p_organization_id: ORG }).data).toEqual([
      'team-a',
    ]);
    expect(call('finn', 'get_my_coached_team_ids', { p_organization_id: ORG }).data).toEqual([]);
  });
});
