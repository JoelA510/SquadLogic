/**
 * The roster editor lists who is playing up or down on the rosters it shows (play-down plan,
 * 2026-11-03, PR 2, task B3). The age check that lived in the red conflict banner could not fire in
 * production: it read `team.minAge`/`maxAge` and `player.playUpRequested`, and a team row has no age
 * band (the `teams` table has no age column) and the page never passed the request. The list reads what
 * production has: the team's division and its SAVED band (`divisions.min_age/max_age`), and the
 * player's stored natural age and request.
 *
 * So every team below is the shape the page builds from a persisted team row, with NO age keys, and
 * every expected flag is worked out from the bands and ages written here.
 *
 *   U10 is for ages 9 to 10, U12 for ages 11 to 12, and "Open Play" has no band.
 */
import React from 'react';
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RosterManager from '../frontend/src/components/teaming/RosterManager.jsx';
import { rosterAgeFlags } from '../frontend/src/utils/rosterAgeFlags.js';
import { applyRosterDirectory } from '../frontend/src/utils/rosterPeople.js';
import { FeatureFlagSchema } from '../frontend/src/constants/featureFlags.js';
import { useRosterDirectory } from '../frontend/src/hooks/useRosterDirectory.js';

const db = vi.hoisted(() => ({
  /** @type {Record<string, any[]>} */ tables: {},
  /** @type {Array<[string, string]>} the columns each read asked for */ selected: [],
}));

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: 'org-1' },
    currentSeasonSetting: { id: 'season-1' },
    featureFlags: FeatureFlagSchema.parse({}),
  }),
}));
// A test double that returns ONLY the columns asked for, as PostgREST does (lesson 60): a select that
// leaves a column out gives rows without it, so the directory cannot pass by luck of a whole row.
vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    from: (table) => {
      let columns = null;
      const builder = {
        select: (list) => {
          db.selected.push([table, list]);
          columns = String(list)
            .split(',')
            .map((column) => column.trim());
          return builder;
        },
        eq: () => builder,
        order: () => builder,
        range: (from, to) => {
          builder.window = [from, to];
          return builder;
        },
        window: [0, Infinity],
        then: (resolve, reject) => {
          const [from, to] = builder.window;
          const rows = (db.tables[table] ?? [])
            .slice(from, to + 1)
            .map((row) =>
              Object.fromEntries(Object.entries(row).filter(([key]) => columns?.includes(key)))
            );
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  },
}));

const divisions = [
  { id: 'div-u10', name: 'U10 Boys', min_age: 9, max_age: 10 },
  { id: 'div-u12', name: 'U12 Boys', min_age: 11, max_age: 12 },
  { id: 'div-open', name: 'Open Play' },
];

/** A team as the page builds it from a persisted team row: no `minAge`, `maxAge` or gender. */
const team = (id, name, divisionId, players) => ({
  id,
  name,
  division: name.split(' Team')[0],
  divisionId,
  players,
});
const player = (id, name, naturalAge, extra = {}) => ({ id, name, naturalAge, ...extra });

/**
 * Pia   age 10, asked to play up, on a U12 team       under U12's 11: playing up, requested
 * Quinn age 10, no request, on a U12 team             playing up, no request on file (a manual move)
 * Jake  age 12, on a U10 team                         over U10's 10: playing down
 * Ana   age 10, on a U10 team                         in band
 * Ben   age 12, on a U12 team                         in band
 * Cy    no age on file, on a U12 team                 nothing to compare
 * Dee   age 10, on an Open Play team                  the division has no band
 */
const rosters = () => [
  team('t-u10', 'U10 Boys Team 1', 'div-u10', [
    player('jake', 'Jake Jones', 12),
    player('ana', 'Ana Ash', 10),
  ]),
  team('t-u12', 'U12 Boys Team 1', 'div-u12', [
    player('pia', 'Pia Pine', 10, { playUpRequested: true }),
    player('quinn', 'Quinn Quill', 10, { playUpRequested: false }),
    player('ben', 'Ben Birch', 12),
    player('cy', 'Cy Cedar', null),
  ]),
  team('t-open', 'Open Play Team 1', 'div-open', [player('dee', 'Dee Dune', 10)]),
];

describe('the rosters of a persisted team run, which carry no age band', () => {
  it('the teams under test have no age keys, so nothing below can read one', () => {
    for (const t of rosters()) {
      expect(Object.keys(t)).not.toEqual(expect.arrayContaining(['minAge']));
      expect('minAge' in t || 'maxAge' in t || 'min_age' in t || 'max_age' in t).toBe(false);
    }
  });

  it('flags a player on a team of an older division as playing up, and says a request was made', () => {
    const { entries } = rosterAgeFlags({ teams: rosters(), divisions });
    const pia = entries.find((entry) => entry.playerId === 'pia');
    expect(pia?.text).toBe(
      'Playing up: Pia Pine (natural age 10) is on U12 Boys Team 1 in U12 Boys, a division for ages 11 to 12. A play-up was requested.'
    );
    const quinn = entries.find((entry) => entry.playerId === 'quinn');
    expect(quinn?.text).toBe(
      'Playing up: Quinn Quill (natural age 10) is on U12 Boys Team 1 in U12 Boys, a division for ages 11 to 12. No play-up request is on file.'
    );
  });

  it('flags a player on a team of a younger division as playing down', () => {
    const { entries } = rosterAgeFlags({ teams: rosters(), divisions });
    expect(entries.find((entry) => entry.playerId === 'jake')?.text).toBe(
      'Playing down: Jake Jones (natural age 12) is on U10 Boys Team 1 in U10 Boys, a division for ages 9 to 10.'
    );
  });

  it('says not checked, never in band, for an age the record lacks and a division with no band', () => {
    const { entries, counts } = rosterAgeFlags({ teams: rosters(), divisions });
    expect(entries.find((entry) => entry.playerId === 'cy')?.text).toBe(
      'Not checked: Cy Cedar has no natural age on file, so nothing can be compared with U12 Boys (no age, or no age band).'
    );
    expect(entries.find((entry) => entry.playerId === 'dee')?.text).toBe(
      'Not checked: Open Play has no age band, so Dee Dune (natural age 10) cannot be compared with it (no age, or no age band).'
    );
    // Worked by hand: up Pia and Quinn; down Jake; not checked Cy and Dee; Ana and Ben are in band.
    expect(counts).toEqual({ playingUp: 2, playingDown: 1, notChecked: 2 });
    expect(entries.map((entry) => entry.playerId)).toEqual(['jake', 'pia', 'quinn', 'cy', 'dee']);
  });

  it('judges a seat by the division’s saved band, never by an age on the team or an age the page made up', () => {
    const forged = rosters().map((t) => ({ ...t, minAge: 1, maxAge: 99 }));
    forged[1].players = [
      // No natural age, only the age the page defaults to (10): it must not be read.
      { id: 'made-up', name: 'Mo Made', age: 10 },
      player('pia', 'Pia Pine', 10, { playUpRequested: true }),
    ];
    const { entries } = rosterAgeFlags({ teams: forged, divisions });
    // The forged team band (1 to 99) would call Pia in band. The division's band says playing up.
    expect(entries.find((entry) => entry.playerId === 'pia')?.verdict).toBe('up');
    expect(entries.find((entry) => entry.playerId === 'made-up')?.verdict).toBe('unknown');
  });

  it('finds the division by the name a team carries when its row id is not listed', () => {
    const byName = [
      { id: 't', name: 'Team', division: 'u12 boys', players: [player('pia', 'Pia Pine', 10)] },
    ];
    expect(rosterAgeFlags({ teams: byName, divisions }).counts.playingUp).toBe(1);
  });

  it('counts a team that names no division, and a player on two teams once, instead of dropping or throwing', () => {
    const odd = [
      {
        id: 'a',
        name: 'Nameless',
        players: [player('x', 'Xi Xu', 10), player('dup', 'Dee Dup', 9)],
      },
      team('b', 'U10 Boys Team 2', 'div-u10', [player('dup', 'Dee Dup', 9)]),
    ];
    const { entries, counts } = rosterAgeFlags({ teams: odd, divisions });
    expect(entries.map((entry) => [entry.playerId, entry.verdict])).toEqual([
      ['x', 'unknown'],
      ['dup', 'unknown'],
    ]);
    expect(counts.notChecked).toBe(2);
  });

  it('flags nobody when every player is in band, and says so', () => {
    const { entries, counts } = rosterAgeFlags({
      teams: [rosters()[0]].map((t) => ({ ...t, players: [t.players[1]] })),
      divisions,
    });
    expect(entries).toEqual([]);
    expect(counts).toEqual({ playingUp: 0, playingDown: 0, notChecked: 0 });
  });
});

describe('the roster editor shows the list and says when a move changes it', () => {
  beforeEach(() => {
    db.tables = {};
    db.selected = [];
  });
  afterEach(cleanup);

  const open = (props = {}) =>
    render(
      <RosterManager
        initialTeams={rosters()}
        onTeamsChange={() => {}}
        seasonDivisions={divisions}
        {...props}
      />
    );
  const list = () => screen.getByTestId('roster-age-flags');

  it('lists every flag in words, outside the red conflict banner', () => {
    open();
    expect(
      within(list()).getByRole('heading', { name: 'Play-up and play-down on these rosters' })
    ).toBeInTheDocument();
    expect(list()).toHaveTextContent('2 playing up, 1 playing down, 2 not checked');
    expect(within(list()).getAllByRole('listitem')).toHaveLength(5);
    expect(within(list()).getByText(/Pia Pine \(natural age 10\)/)).toBeInTheDocument();
    // A flag is not an error: no conflict banner, no "Conflict Detected" for a play-up.
    expect(screen.queryByRole('region', { name: 'Roster conflicts' })).toBeNull();
    expect(screen.queryByText('Conflict Detected')).toBeNull();
  });

  it('says None, as a word, when nobody on the rosters plays up or down', () => {
    open({ initialTeams: [rosters()[0]].map((t) => ({ ...t, players: [t.players[1]] })) });
    expect(list()).toHaveTextContent('None: nobody on these rosters plays up or down.');
    expect(within(list()).queryAllByRole('listitem')).toHaveLength(0);
  });

  it('says it has not checked, rather than None, while the divisions are not loaded', () => {
    open({ seasonDivisions: null });
    expect(list()).toHaveTextContent('Not checked yet');
    expect(list()).not.toHaveTextContent('None');
  });

  it('shows no list to a caller that does not pass the divisions', () => {
    open({ seasonDivisions: undefined });
    expect(screen.queryByTestId('roster-age-flags')).toBeNull();
  });

  it('flags a cross-division move at once, says so to a screen reader, and clears it when moved back', () => {
    open();
    // Ana (age 10) is in band on U10. Move her to the U12 team: she is playing up, no request on file.
    expect(within(list()).queryByText(/Ana Ash/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Move Ana Ash to another team' }));
    let dialog = screen.getByRole('dialog', { name: 'Move Ana Ash' });
    fireEvent.change(within(dialog).getByLabelText('Destination team'), {
      target: { value: 't-u12' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move player' }));

    expect(list()).toHaveTextContent('3 playing up, 1 playing down, 2 not checked');
    expect(
      within(list()).getByText(/Ana Ash \(natural age 10\) is on U12 Boys Team 1/)
    ).toBeInTheDocument();
    expect(list()).toHaveTextContent(/Ana Ash.*No play-up request is on file\./);
    const status = screen
      .getAllByRole('status')
      .find((node) => /Moved Ana Ash/.test(node.textContent ?? ''));
    expect(status).toHaveTextContent(
      'Moved Ana Ash from U10 Boys Team 1 to U12 Boys Team 1 Ana Ash is now playing up.'
    );

    // And back: no longer flagged.
    fireEvent.click(screen.getByRole('button', { name: 'Move Ana Ash to another team' }));
    dialog = screen.getByRole('dialog', { name: 'Move Ana Ash' });
    fireEvent.change(within(dialog).getByLabelText('Destination team'), {
      target: { value: 't-u10' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move player' }));
    expect(list()).toHaveTextContent('2 playing up, 1 playing down, 2 not checked');
    expect(list()).not.toHaveTextContent('Ana Ash');
    expect(
      screen
        .getAllByRole('status')
        .some((node) =>
          /Moved Ana Ash from .* Ana Ash is no longer playing up\./.test(node.textContent ?? '')
        )
    ).toBe(true);
  });

  it('says a move made a requested play-up and a play-up that had no request apart', () => {
    open();
    // Move Pia (asked) to the U10 team: in band there, no longer flagged.
    fireEvent.click(screen.getByRole('button', { name: 'Move Pia Pine to another team' }));
    const dialog = screen.getByRole('dialog', { name: 'Move Pia Pine' });
    fireEvent.change(within(dialog).getByLabelText('Destination team'), {
      target: { value: 't-u10' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move player' }));
    expect(list()).not.toHaveTextContent('Pia Pine');
    expect(
      screen
        .getAllByRole('status')
        .some((node) => /Pia Pine is no longer playing up\./.test(node.textContent ?? ''))
    ).toBe(true);
    // Quinn, who has no request on file, is still flagged with the words that say so.
    expect(list()).toHaveTextContent(/Quinn Quill.*No play-up request is on file\./);
  });
});

describe('the directory reads the two columns the list needs', () => {
  beforeEach(() => {
    db.selected = [];
    db.tables = {
      players: [
        {
          id: 'pia',
          first_name: 'Pia',
          last_name: 'Pine',
          rating: null,
          skill_tier: null,
          natural_age: 10,
          play_up_requested: true,
        },
        {
          id: 'cy',
          first_name: 'Cy',
          last_name: 'Cedar',
          rating: null,
          skill_tier: null,
          natural_age: null,
          play_up_requested: false,
        },
        // An age of zero is an age; a missing one is not zero.
        { id: 'zed', first_name: 'Zed', last_name: 'Zero', natural_age: 0 },
      ],
      coaches: [],
    };
  });
  afterEach(cleanup);

  it('selects natural_age and play_up_requested, and the double gives back only what was asked for', async () => {
    const { result } = renderHook(() => useRosterDirectory({ enabled: true }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const columns = db.selected.filter(([table]) => table === 'players').map(([, list]) => list);
    expect(columns.length).toBeGreaterThan(0);
    for (const list of columns) {
      expect(list).toMatch(/\bnatural_age\b/);
      expect(list).toMatch(/\bplay_up_requested\b/);
    }
    expect(result.current.players.get('pia')).toMatchObject({
      naturalAge: 10,
      playUpRequested: true,
    });
    // Unknown stays unknown, and is not 0 or false-by-accident for the age.
    expect(result.current.players.get('cy')).toMatchObject({
      naturalAge: null,
      playUpRequested: false,
    });
    expect(result.current.players.get('zed')?.naturalAge).toBe(0);
  });

  it('lays the stored age and request over a roster entry, so the list can judge the seat', async () => {
    const { result } = renderHook(() => useRosterDirectory({ enabled: true }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const teams = [
      {
        id: 't',
        name: 'U12 Boys Team 1',
        divisionId: 'div-u12',
        players: [
          { id: 'pia', name: 'Unknown Player' },
          { id: 'ghost', name: 'Unknown Player' },
        ],
      },
    ];
    const named = applyRosterDirectory(teams, result.current);
    expect(named[0].players[0]).toMatchObject({
      name: 'Pia Pine',
      naturalAge: 10,
      playUpRequested: true,
    });
    // A roster entry the table has no row for has no age: unknown, so the list says not checked.
    expect(named[0].players[1].naturalAge).toBeUndefined();
    const { entries } = rosterAgeFlags({ teams: named, divisions });
    expect(entries.map((entry) => [entry.playerId, entry.verdict, entry.label])).toEqual([
      ['pia', 'up', 'Playing up'],
      ['ghost', 'unknown', 'Not checked'],
    ]);
  });
});
