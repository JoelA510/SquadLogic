// The mock arms of migration 20261021010000 apply the same access table as the
// SQL (supabase/tests/server_side_reads.sql holds the database to it), in both
// directions: the caller admitted gets the data, the caller refused gets 42501.
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
      { organization_id: ORG, profile_id: 'gwen', role: 'parent' },
      { organization_id: ORG, profile_id: 'mo', role: 'parent' },
    ],
    profiles: [
      { id: 'cora', email: 'cora@example.test' },
      { id: 'gwen', email: 'gwen@example.test' },
    ],
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
    profile_players: [],
    audit_log: [],
  };
}

let db;
const call = (user, name, params = {}, email = `${user}@example.test`) =>
  handleServerSideReadRpc(db, name, params, {
    currentUserId: user,
    sessionEmail: email,
    now: NOW,
    newId: () => 'id',
  });
const roster = (user) => call(user, 'get_team_roster', { p_team_id: 'team-a' });

beforeEach(() => {
  db = seed();
  // Gwen links through her imported guardian email, as she would on sign-in.
  expect(call('gwen', 'link_my_guardian_records').data).toEqual({ status: 'linked', linked: 1 });
});

describe('mock server-side reads', () => {
  it('judges today in the season timezone and falls back to UTC for an unreadable zone', () => {
    expect(localDateIn('America/Los_Angeles', new Date('2026-10-21T03:00:00Z'))).toBe('2026-10-20');
    expect(localDateIn('Not/AZone', new Date('2026-10-21T03:00:00Z'))).toBe('2026-10-21');
    expect(localDateIn(null, NOW)).toBe(TODAY);
  });

  it('links a guardian once, audits it, and a second call links nothing', () => {
    expect(call('gwen', 'link_my_guardian_records').data).toEqual({
      status: 'already_linked',
      linked: 0,
    });
    expect(db.audit_log.filter((row) => row.action === 'guardian.linked')).toHaveLength(1);
    expect(call('mo', 'link_my_guardian_records').data).toEqual({ status: 'no_match', linked: 0 });
  });

  it('admits admins, staff, the current coach and a guardian on the team to the roster', () => {
    for (const user of ['admin', 'staff']) {
      expect(roster(user).data.map((r) => `${r.first_name}:${r.rating}`)).toEqual([
        'Pia:3',
        'Rex:4',
      ]);
    }
    const coach = roster('cora').data;
    expect(coach.map((r) => `${r.rating}:${r.guardian_contacts.length}`)).toEqual([
      'null:2',
      'null:2',
    ]);
    const guardian = roster('gwen').data;
    expect(
      guardian.map((r) => `${r.first_name}:${r.is_my_child}:${r.guardian_contacts.length}`)
    ).toEqual(['Pia:true:2', 'Rex:false:1']);
    expect(guardian[1].guardian_contacts[0]).toEqual({
      name: 'Rhea',
      email: 'rhea@example.test',
      phone: '555-0202',
    });
  });

  it('refuses the former coach, another team’s coach, an unrelated member and an unknown team', () => {
    for (const user of ['finn', 'otto', 'mo']) {
      expect(roster(user).error?.code).toBe('42501');
      expect(call(user, 'get_team_staff', { p_team_id: 'team-a' }).error?.code).toBe('42501');
    }
    expect(call('admin', 'get_team_roster', { p_team_id: 'nope' }).error?.code).toBe('42501');
    expect(call(null, 'get_team_roster', { p_team_id: 'team-a' }).error?.code).toBe('42501');
  });

  it('takes the primary contact as the first element, as the SQL does, even when it is not a contact', () => {
    db.players[1].guardian_contacts = ['legacy text', { name: 'Pat', email: 'pat@example.test' }];
    expect(roster('gwen').data[1].guardian_contacts).toEqual([]);
    expect(roster('cora').data[1].guardian_contacts).toEqual([
      { name: 'Pat', email: 'pat@example.test' },
    ]);
  });

  it('with teammate contacts off, a guardian keeps only their own child’s', () => {
    db.organizations[0].feature_flags.guardian_contact_sharing = false;
    expect(roster('gwen').data.map((r) => r.guardian_contacts.length)).toEqual([2, 0]);
    expect(roster('cora').data.map((r) => r.guardian_contacts.length)).toEqual([2, 2]);
  });

  it('a saved card replaces imported details, and an unshared one shows none', () => {
    expect(
      call('gwen', 'set_my_contact_card', { p_phone: 'call me', p_email: null, p_share: true })
        .error?.code
    ).toBe('22023');
    expect(
      call('gwen', 'set_my_contact_card', { p_phone: '+1 555 0199', p_email: 'card@example.test' })
        .error?.code
    ).toBe('23502');
    call('gwen', 'set_my_contact_card', {
      p_phone: '+1 555 0199',
      p_email: 'card@example.test',
      p_share: true,
    });
    expect(roster('cora').data[0].guardian_contacts[0]).toEqual({
      name: 'Gwen',
      email: 'card@example.test',
      phone: '+1 555 0199',
    });
    call('gwen', 'set_my_contact_card', {
      p_phone: '+1 555 0199',
      p_email: 'card@example.test',
      p_share: false,
    });
    expect(roster('cora').data[0].guardian_contacts[0]).toEqual({ name: 'Gwen' });
    call('cora', 'set_my_contact_card', { p_phone: '', p_email: '', p_share: false });
    expect(call('gwen', 'get_team_staff', { p_team_id: 'team-a' }).data).toEqual([
      {
        coach_id: 'c-cora',
        full_name: 'Cora',
        role: 'lead',
        phone: null,
        email: null,
        status: null,
      },
    ]);
  });

  it('the directory admits a current coach while on, refuses them while off, and admits staff either way', () => {
    const names = (user) =>
      call(user, 'get_coach_directory', { p_organization_id: ORG }).data?.map((d) => d.full_name);
    expect(names('otto')).toEqual(['Cora', 'Otto']);
    expect(call('gwen', 'get_coach_directory', { p_organization_id: ORG }).error?.code).toBe(
      '42501'
    );
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
