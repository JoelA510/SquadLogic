import { test, describe, it, expect } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUDDY_REQUEST_STATUS,
  normalizeBuddyLinks,
  getCanonicalBuddyId,
  resolveBuddyRequests,
  summarizeBuddyRequests,
} from '../packages/core/src/buddyLinking.js';
import { prepareTeamingInput } from '../packages/core/src/teamingPipeline.js';
import { loadCoachRoster, loadSeason2026 } from '../packages/core/src/fixtures/index.js';

test('getCanonicalBuddyId reads buddyId then buddy_id', () => {
  assert.equal(getCanonicalBuddyId({ buddyId: 'b' }), 'b');
  assert.equal(getCanonicalBuddyId({ buddy_id: 'c' }), 'c');
  assert.equal(getCanonicalBuddyId({ buddyId: 'b', buddy_id: 'c' }), 'b');
  assert.equal(getCanonicalBuddyId({}), undefined);
  assert.equal(getCanonicalBuddyId(null), undefined);
  assert.equal(getCanonicalBuddyId({ buddyId: '  b  ' }), 'b');
});

test('normalizeBuddyLinks passes canonical buddyId through unchanged', () => {
  const players = [
    { id: 'a', division: 'U10', buddyId: 'b' },
    { id: 'b', division: 'U10', buddyId: 'a' },
  ];
  const { players: result, diagnostics } = normalizeBuddyLinks(players);
  assert.equal(result[0].buddyId, 'b');
  assert.equal(result[1].buddyId, 'a');
  assert.deepEqual(diagnostics, []);
  // Unchanged players keep identity (no needless copies).
  assert.equal(result[0], players[0]);
});

test('normalizeBuddyLinks canonicalizes buddy_id into buddyId', () => {
  const { players: result } = normalizeBuddyLinks([
    { id: 'a', division: 'U10', buddy_id: 'b' },
    { id: 'b', division: 'U10', buddy_id: 'a' },
  ]);
  assert.equal(result[0].buddyId, 'b');
  assert.equal(result[1].buddyId, 'a');
});

test('normalizeBuddyLinks resolves a two-player mutual_buddy_code into reciprocal links', () => {
  const { players: result, diagnostics } = normalizeBuddyLinks([
    { id: 'a', division: 'U10', mutual_buddy_code: 'PAIR-1' },
    { id: 'b', division: 'U10', mutual_buddy_code: 'PAIR-1' },
    { id: 'c', division: 'U10' },
  ]);
  assert.equal(result[0].buddyId, 'b');
  assert.equal(result[1].buddyId, 'a');
  assert.equal(result[2].buddyId, undefined);
  assert.deepEqual(diagnostics, []);
});

test('normalizeBuddyLinks resolves camelCase mutualBuddyCode too', () => {
  const { players: result } = normalizeBuddyLinks([
    { id: 'a', division: 'U10', mutualBuddyCode: 'X' },
    { id: 'b', division: 'U10', mutualBuddyCode: 'X' },
  ]);
  assert.equal(result[0].buddyId, 'b');
  assert.equal(result[1].buddyId, 'a');
});

test('normalizeBuddyLinks diagnoses a code shared by more than two players and links none', () => {
  const { players: result, diagnostics } = normalizeBuddyLinks([
    { id: 'a', division: 'U10', mutual_buddy_code: 'TRIO' },
    { id: 'b', division: 'U10', mutual_buddy_code: 'TRIO' },
    { id: 'c', division: 'U10', mutual_buddy_code: 'TRIO' },
  ]);
  assert.ok(result.every((p) => p.buddyId === undefined));
  const diag = diagnostics.find((d) => d.code === 'duplicate-buddy-code');
  assert.ok(diag);
  assert.deepEqual(diag.playerIds.sort(), ['a', 'b', 'c']);
});

test('normalizeBuddyLinks diagnoses an unmatched single-player code', () => {
  const { diagnostics } = normalizeBuddyLinks([
    { id: 'a', division: 'U10', mutual_buddy_code: 'LONELY' },
  ]);
  assert.ok(diagnostics.some((d) => d.code === 'buddy-code-unmatched'));
});

test('normalizeBuddyLinks diagnoses a cross-division code pair and links none', () => {
  const { players: result, diagnostics } = normalizeBuddyLinks([
    { id: 'a', division: 'U10', mutual_buddy_code: 'XD' },
    { id: 'b', division: 'U12', mutual_buddy_code: 'XD' },
  ]);
  assert.ok(result.every((p) => p.buddyId === undefined));
  assert.ok(diagnostics.some((d) => d.code === 'cross-division-buddy'));
});

test('normalizeBuddyLinks diagnoses one-sided, missing, self, and cross-division direct requests', () => {
  const { diagnostics } = normalizeBuddyLinks([
    { id: 'one-sided', division: 'U10', buddyId: 'silent' },
    { id: 'silent', division: 'U10' },
    { id: 'orphan', division: 'U10', buddyId: 'ghost' },
    { id: 'narcissist', division: 'U10', buddyId: 'narcissist' },
    { id: 'crosser', division: 'U10', buddyId: 'other-div' },
    { id: 'other-div', division: 'U12', buddyId: 'crosser' },
  ]);
  assert.ok(diagnostics.some((d) => d.code === 'one-sided-buddy'));
  assert.ok(diagnostics.some((d) => d.code === 'missing-buddy-target'));
  assert.ok(diagnostics.some((d) => d.code === 'self-buddy-reference'));
  assert.ok(diagnostics.some((d) => d.code === 'cross-division-buddy'));
});

test('normalizeBuddyLinks does not flag one-sided when reciprocation arrives via a code', () => {
  const { players: result, diagnostics } = normalizeBuddyLinks([
    { id: 'a', division: 'U10', buddyId: 'b', mutual_buddy_code: 'P2' },
    { id: 'b', division: 'U10', mutual_buddy_code: 'P2' },
  ]);
  // a→b directly; b→a via the shared code: fully mutual, no one-sided diagnostic.
  assert.equal(result[1].buddyId, 'a');
  assert.ok(!diagnostics.some((d) => d.code === 'one-sided-buddy'));
});

test('normalizeBuddyLinks diagnoses a 2-player code group with an unusable id', () => {
  const { diagnostics } = normalizeBuddyLinks([
    { id: 'a', division: 'U10', mutual_buddy_code: 'BROKEN' },
    { division: 'U10', mutual_buddy_code: 'BROKEN' }, // malformed row: no id
  ]);
  assert.ok(
    diagnostics.some((d) => d.code === 'buddy-code-unmatched' && d.message.includes('BROKEN'))
  );
});

test('normalizeBuddyLinks lets an explicit buddyId win over a code and breaks the code pair', () => {
  const { players: result, diagnostics } = normalizeBuddyLinks([
    { id: 'a', division: 'U10', buddyId: 'c', mutual_buddy_code: 'PAIR' },
    { id: 'b', division: 'U10', mutual_buddy_code: 'PAIR' },
    { id: 'c', division: 'U10', buddyId: 'a' },
  ]);
  assert.equal(result[0].buddyId, 'c', 'explicit reference wins');
  // b's code partner (a) explicitly chose someone else: no silent one-sided link.
  assert.equal(result[1].buddyId, undefined, 'broken code pair links nobody');
  assert.ok(
    diagnostics.some((d) => d.code === 'buddy-code-unmatched' && d.playerIds.includes('b')),
    'the broken code pair is diagnosed'
  );
});

test('normalizeBuddyLinks still pairs via code when one partner self-references', () => {
  const { players: result } = normalizeBuddyLinks([
    { id: 'a', division: 'U10', buddyId: 'a', mutual_buddy_code: 'P' },
    { id: 'b', division: 'U10', mutual_buddy_code: 'P' },
  ]);
  // The self-reference cannot link, so the code pair holds symmetrically.
  assert.equal(result[0].buddyId, 'b');
  assert.equal(result[1].buddyId, 'a');
});

test('normalizeBuddyLinks groups buddy codes case-insensitively', () => {
  const { players: result } = normalizeBuddyLinks([
    { id: 'a', division: 'U10', mutual_buddy_code: 'FamilyA' },
    { id: 'b', division: 'U10', mutual_buddy_code: 'familya' },
  ]);
  assert.equal(result[0].buddyId, 'b');
  assert.equal(result[1].buddyId, 'a');
});

test('normalizeBuddyLinks resolves buddy_request via external registration ids', () => {
  const { players: result, diagnostics } = normalizeBuddyLinks([
    { id: 'a', division: 'U10', external_registration_id: 'GS-A', buddy_request: 'GS-B' },
    { id: 'b', division: 'U10', external_registration_id: 'GS-B', buddy_request: 'GS-A' },
    { id: 'c', division: 'U10', buddy_request: 'GS-GHOST' },
  ]);
  assert.equal(result[0].buddyId, 'b');
  assert.equal(result[1].buddyId, 'a');
  assert.equal(result[2].buddyId, undefined);
  assert.ok(
    diagnostics.some((d) => d.code === 'missing-buddy-target' && d.message.includes('GS-GHOST'))
  );
});

test('normalizeBuddyLinks stores the trimmed canonical value over a padded raw buddyId', () => {
  const { players: result } = normalizeBuddyLinks([
    { id: 'a', division: 'U10', buddyId: ' b ' },
    { id: 'b', division: 'U10', buddyId: 'a' },
  ]);
  assert.equal(result[0].buddyId, 'b', 'padded reference is canonicalized for strict matching');
});

test('normalizeBuddyLinks does not mutate its input', () => {
  const players = [
    { id: 'a', division: 'U10', mutual_buddy_code: 'P' },
    { id: 'b', division: 'U10', mutual_buddy_code: 'P' },
  ];
  const frozen = players.map((p) => Object.freeze({ ...p }));
  const { players: result } = normalizeBuddyLinks(frozen);
  assert.equal(/** @type {any} */ (frozen[0]).buddyId, undefined);
  assert.equal(result[0].buddyId, 'b');
});

test('prepareTeamingInput canonicalizes buddy codes and reports buddyLinking diagnostics', () => {
  const { players, diagnostics } = prepareTeamingInput({
    players: [
      { id: 'a', division: 'U10', mutual_buddy_code: 'PAIR-9' },
      { id: 'b', division: 'U10', mutual_buddy_code: 'PAIR-9' },
      { id: 'c', division: 'U10', buddy_id: 'ghost' },
    ],
    seasonYear: 2026,
  });

  const byId = new Map(players.map((p) => [p.id, p]));
  assert.equal(byId.get('a').buddyId, 'b');
  assert.equal(byId.get('b').buddyId, 'a');
  assert.equal(byId.get('c').buddyId, 'ghost', 'direct reference canonicalized');
  assert.ok(diagnostics.buddyLinking.some((d) => d.code === 'missing-buddy-target'));
});

/* -------------------------------------------------------------------------- */
/* resolveBuddyRequests (Phase B1)                                             */
/* -------------------------------------------------------------------------- */

/** A program player: names, a division and, optionally, a request. */
const kid = (id, first, last, extra = {}) => ({
  id,
  division: 'U10',
  firstName: first,
  lastName: last,
  ...extra,
});

const resolutionOf = (requests, playerId) => requests.find((r) => r.playerId === playerId);

describe('resolveBuddyRequests', () => {
  it('resolves a reciprocal name pair, each to the other, as reciprocated', () => {
    const { requests } = resolveBuddyRequests({
      players: [
        kid('a', 'Ada', 'One', { buddy_request: 'Bea Two' }),
        kid('b', 'Bea', 'Two', { buddy_request: 'Ada One' }),
      ],
    });
    expect(resolutionOf(requests, 'a')).toMatchObject({
      status: BUDDY_REQUEST_STATUS.RESOLVED,
      matchedBy: 'name',
      targetId: 'b',
      reciprocated: true,
    });
    expect(resolutionOf(requests, 'b')).toMatchObject({ targetId: 'a', reciprocated: true });
  });

  it('matches across accents, case, punctuation and "Last, First"', () => {
    const { requests } = resolveBuddyRequests({
      players: [
        kid('a', 'Zoë', "O'Neil-Park", { buddy_request: 'chloe  DUBOIS' }),
        kid('b', 'Chloé', 'Dubois', { buddy_request: 'oneil park, zoe' }),
      ],
    });
    expect(resolutionOf(requests, 'a')).toMatchObject({ targetId: 'b', reciprocated: true });
    expect(resolutionOf(requests, 'b')).toMatchObject({ targetId: 'a', reciprocated: true });
  });

  it('matches a preferred name with the last name', () => {
    const { requests } = resolveBuddyRequests({
      players: [
        kid('a', 'Ada', 'One', { buddy_request: 'Bee Two' }),
        kid('b', 'Beatrix', 'Two', { preferred_name: 'Bee' }),
      ],
    });
    expect(resolutionOf(requests, 'a')).toMatchObject({ targetId: 'b', reciprocated: false });
  });

  it('calls two players of one name ambiguous, and links neither', () => {
    const { requests } = resolveBuddyRequests({
      players: [
        kid('a', 'Ada', 'One', { buddy_request: 'Sam Lee' }),
        kid('s1', 'Sam', 'Lee'),
        kid('s2', 'Sam', 'Lee'),
      ],
    });
    const a = resolutionOf(requests, 'a');
    expect(a.status).toBe(BUDDY_REQUEST_STATUS.AMBIGUOUS);
    expect(a.targetId).toBeNull();
    expect(a.candidates.map((c) => c.playerId).sort()).toEqual(['s1', 's2']);
  });

  it('settles two of one name by reciprocity: the one who names the requester back', () => {
    const { requests } = resolveBuddyRequests({
      players: [
        kid('a', 'Ada', 'One', { buddy_request: 'Sam Lee' }),
        kid('s1', 'Sam', 'Lee'),
        kid('s2', 'Sam', 'Lee', { buddy_request: 'Ada One' }),
      ],
    });
    expect(resolutionOf(requests, 'a')).toMatchObject({
      status: BUDDY_REQUEST_STATUS.RESOLVED,
      matchedBy: 'reciprocity',
      targetId: 's2',
      reciprocated: true,
    });
  });

  it('keeps a namesake tie the target cannot settle one-way, never mutual', () => {
    // Both Sams name Ada, so Ada's own request stays ambiguous: each Sam's request resolves to
    // Ada, but neither is reciprocated.
    const { requests } = resolveBuddyRequests({
      players: [
        kid('a', 'Ada', 'One', { buddy_request: 'Sam Lee' }),
        kid('s1', 'Sam', 'Lee', { buddy_request: 'Ada One' }),
        kid('s2', 'Sam', 'Lee', { buddy_request: 'Ada One' }),
      ],
    });
    expect(resolutionOf(requests, 'a').status).toBe(BUDDY_REQUEST_STATUS.AMBIGUOUS);
    expect(resolutionOf(requests, 's1')).toMatchObject({ targetId: 'a', reciprocated: false });
    expect(resolutionOf(requests, 's2')).toMatchObject({ targetId: 'a', reciprocated: false });
  });

  it('calls a match only in another division cross-division, with the candidate', () => {
    const { requests } = resolveBuddyRequests({
      players: [kid('a', 'Ada', 'One', { buddy_request: 'Bea Two' })],
      roster: [kid('a', 'Ada', 'One'), { ...kid('b', 'Bea', 'Two'), division: 'U12' }],
    });
    const a = resolutionOf(requests, 'a');
    expect(a.status).toBe(BUDDY_REQUEST_STATUS.CROSS_DIVISION);
    expect(a.candidates).toEqual([{ playerId: 'b', name: 'Bea Two', division: 'U12' }]);
  });

  it('reports a near miss with its same-surname candidates and never links it', () => {
    const { requests } = resolveBuddyRequests({
      players: [
        kid('a', 'Ada', 'One', { buddy_request: 'Bee Two' }),
        kid('b', 'Bea', 'Two'),
        kid('c', 'Cy', 'Three'),
      ],
    });
    const a = resolutionOf(requests, 'a');
    expect(a.status).toBe(BUDDY_REQUEST_STATUS.NOT_FOUND);
    expect(a.targetId).toBeNull();
    expect(a.candidates.map((c) => c.playerId)).toEqual(['b']);
  });

  it('resolves a registration id, case and padding aside (the import pairing rule)', () => {
    const { requests } = resolveBuddyRequests({
      players: [
        kid('a', 'Ada', 'One', { external_registration_id: 'GS-A', buddy_request: ' gs-b ' }),
        kid('b', 'Bea', 'Two', { external_registration_id: 'GS-B', buddy_request: 'GS-A' }),
      ],
    });
    expect(resolutionOf(requests, 'a')).toMatchObject({
      matchedBy: 'registration-id',
      targetId: 'b',
      reciprocated: true,
    });
  });

  it('calls text naming two people, or one name only, unparsed', () => {
    const { requests } = resolveBuddyRequests({
      players: [
        kid('a', 'Ada', 'One', { buddy_request: 'Bea Two & Cy Three' }),
        kid('b', 'Bea', 'Two', { buddy_request: 'Ada' }),
        kid('c', 'Cy', 'Three', { buddy_request: 'Ada One and Bea Two' }),
      ],
    });
    for (const id of ['a', 'b', 'c']) {
      expect(resolutionOf(requests, id).status).toBe(BUDDY_REQUEST_STATUS.UNPARSED);
    }
  });

  it('calls a registration id nobody has not-found, never unparsed', () => {
    const { requests } = resolveBuddyRequests({
      players: [
        kid('a', 'Ada', 'One', { buddy_request: '98765' }),
        kid('b', 'Bea', 'Two', { buddy_request: 'GS-404' }),
      ],
    });
    expect(resolutionOf(requests, 'a').status).toBe(BUDDY_REQUEST_STATUS.NOT_FOUND);
    expect(resolutionOf(requests, 'b').status).toBe(BUDDY_REQUEST_STATUS.NOT_FOUND);
  });

  it("calls the requester's own name beside a namesake ambiguous, not self", () => {
    const { requests } = resolveBuddyRequests({
      players: [kid('a', 'Sam', 'Lee', { buddy_request: 'Sam Lee' }), kid('b', 'Sam', 'Lee')],
    });
    const a = resolutionOf(requests, 'a');
    expect(a.status).toBe(BUDDY_REQUEST_STATUS.AMBIGUOUS);
    expect(a.candidates.map((c) => c.playerId)).toEqual(['b']);
  });

  it('calls a request naming the requester self', () => {
    const { requests } = resolveBuddyRequests({
      players: [kid('a', 'Ada', 'One', { buddy_request: 'Ada One' }), kid('b', 'Bea', 'Two')],
    });
    expect(resolutionOf(requests, 'a').status).toBe(BUDDY_REQUEST_STATUS.SELF);
  });

  it('leaves an explicit buddyId to normalizeBuddyLinks, and counts it as reciprocity', () => {
    const { requests } = resolveBuddyRequests({
      players: [
        kid('a', 'Ada', 'One', { buddy_request: 'Bea Two' }),
        kid('b', 'Bea', 'Two', { buddyId: 'a', buddy_request: 'Cy Three' }),
        kid('c', 'Cy', 'Three'),
      ],
    });
    expect(resolutionOf(requests, 'b')).toBeUndefined();
    expect(resolutionOf(requests, 'a')).toMatchObject({ targetId: 'b', reciprocated: true });
  });
});

describe('a name request reaches prepareTeamingInput', () => {
  it('pairs a reciprocal name pair (today: two missing-buddy-target diagnostics)', () => {
    const { players, diagnostics } = prepareTeamingInput({
      players: [
        kid('a', 'Ada', 'One', { buddy_request: 'Bea Two' }),
        kid('b', 'Bea', 'Two', { buddy_request: 'Ada One' }),
      ],
      seasonYear: 2026,
    });
    const byId = new Map(players.map((p) => [p.id, p]));
    expect(byId.get('a').buddyId).toBe('b');
    expect(byId.get('b').buddyId).toBe('a');
    expect(diagnostics.buddyLinking.some((d) => d.code === 'missing-buddy-target')).toBe(false);
    // The request text is handed back on the output players.
    expect(byId.get('a').buddy_request).toBe('Bea Two');
  });

  it('under the default mutual rule lists a one-way request and links nothing', () => {
    const { players, diagnostics } = prepareTeamingInput({
      players: [kid('a', 'Ada', 'One', { buddy_request: 'Bea Two' }), kid('b', 'Bea', 'Two')],
      seasonYear: 2026,
    });
    expect(players.every((p) => p.buddyId === undefined)).toBe(true);
    expect(diagnostics.buddyRequests).toEqual([
      expect.objectContaining({
        playerId: 'a',
        outcome: 'one-way',
        honoured: false,
        reason: 'buddy-rule-mutual',
      }),
    ]);
  });

  it('under one_way_best_effort sets buddyId on the requester only, when the named player listed none', () => {
    const { players, diagnostics } = prepareTeamingInput({
      players: [
        kid('a', 'Ada', 'One', { buddy_request: 'Bea Two' }),
        kid('b', 'Bea', 'Two'),
        kid('c', 'Cy', 'Three', { buddy_request: 'Dee Four' }),
        kid('d', 'Dee', 'Four', { buddy_request: 'Eve Five' }),
        kid('e', 'Eve', 'Five'),
      ],
      seasonYear: 2026,
      buddyRule: 'one_way_best_effort',
    });
    const byId = new Map(players.map((p) => [p.id, p]));
    expect(byId.get('a').buddyId).toBe('b');
    expect(byId.get('b').buddyId).toBeUndefined();
    // Dee listed a buddy of her own, so Cy's request is listed, not honoured.
    expect(byId.get('c').buddyId).toBeUndefined();
    expect(diagnostics.buddyRequests.find((r) => r.playerId === 'c')).toMatchObject({
      honoured: false,
      reason: 'named-player-listed-another-buddy',
    });
  });

  it('keeps numeric ids numeric, so a resolved pair is one unit downstream', () => {
    const { players } = prepareTeamingInput({
      players: [
        { ...kid('a', 'Ada', 'One', { buddy_request: 'Bea Two' }), id: 1 },
        { ...kid('b', 'Bea', 'Two', { buddy_request: 'Ada One' }), id: 2 },
      ],
      seasonYear: 2026,
    });
    expect(players.map((p) => p.buddyId)).toEqual([2, 1]);
  });

  it('keeps a code pair over an honoured one-way request (one buddy per player)', () => {
    const { players, diagnostics } = prepareTeamingInput({
      players: [
        kid('a', 'Ada', 'One', { buddy_request: 'Bea Two', mutual_buddy_code: 'P1' }),
        kid('b', 'Bea', 'Two'),
        kid('c', 'Cy', 'Three', { mutual_buddy_code: 'P1' }),
      ],
      seasonYear: 2026,
      buddyRule: 'one_way_best_effort',
    });
    expect(players.find((p) => p.id === 'a').buddyId).toBe('c');
    expect(diagnostics.buddyRequests[0]).toMatchObject({
      honoured: false,
      reason: 'requester-has-another-buddy',
    });
  });

  it('never reads a name as a registration key (no one-way link from normalizeBuddyLinks)', () => {
    const { players } = prepareTeamingInput({
      players: [
        kid('a', 'Ada', 'One', { buddy_request: 'GS-B' }),
        kid('b', 'Bea', 'Two', { external_registration_id: 'GS-B' }),
      ],
      seasonYear: 2026,
    });
    // A one-way id request is a one-way request: under the mutual rule it links nothing.
    expect(players.find((p) => p.id === 'a').buddyId).toBeUndefined();
  });
});

describe('summarizeBuddyRequests', () => {
  it('lists pairs with their team, one-way requests, and unresolved requests with candidates', () => {
    const prepared = prepareTeamingInput({
      players: [
        kid('a', 'Ada', 'One', { buddy_request: 'Bea Two' }),
        kid('b', 'Bea', 'Two', { buddy_request: 'Ada One' }),
        kid('c', 'Cy', 'Three', { buddy_request: 'Dee Fore' }),
        kid('d', 'Dee', 'Four'),
        kid('e', 'Eve', 'Five', { buddy_request: 'Ada One' }),
      ],
      seasonYear: 2026,
    });
    const byId = new Map(prepared.players.map((p) => [p.id, p]));
    const summary = summarizeBuddyRequests({
      players: prepared.players,
      requests: prepared.diagnostics.buddyRequests,
      linkDiagnostics: prepared.diagnostics.buddyLinking,
      buddyDiagnostics: { mutualPairs: [{ playerIds: ['a', 'b'] }] },
      teams: [
        { id: 'T1', name: 'Lions', players: [byId.get('a'), byId.get('b'), byId.get('e')] },
        { id: 'T2', name: 'Bulls', players: [byId.get('c'), byId.get('d')] },
      ],
    });
    expect(summary.rule).toBe('mutual');
    expect(summary.paired).toEqual([
      {
        playerIds: ['a', 'b'],
        names: ['Ada One', 'Bea Two'],
        teamName: 'Lions',
        together: true,
        matchedByReciprocity: false,
      },
    ]);
    expect(summary.oneWay).toEqual([
      expect.objectContaining({
        playerId: 'e',
        targetId: 'a',
        honoured: false,
        together: true,
        teamName: 'Lions',
      }),
    ]);
    expect(summary.unresolved).toEqual([
      {
        playerId: 'c',
        playerName: 'Cy Three',
        request: 'Dee Fore',
        reason: 'not-found',
        candidates: [],
      },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* No names from the fixtures in the new source (the tests/people.test.js rule) */
/* -------------------------------------------------------------------------- */

describe('buddy request source names nobody', () => {
  const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const FILES = [
    'packages/core/src/buddyLinking.js',
    'packages/core/src/teamingPipeline.js',
    'frontend/src/components/teaming/BuddyRequestsList.jsx',
    'frontend/src/pages/TeamAnalysisPage.jsx',
  ];

  it('holds no season fixture person name or key', () => {
    const season = loadSeason2026();
    const needles = new Set();
    for (const rows of [season.assignments, loadCoachRoster({ revision: 'v1' })]) {
      for (const row of rows) {
        needles.add(row.personKey.toLowerCase());
        needles.add(`${row.firstName} ${row.lastName}`.toLowerCase());
      }
    }
    // Meta-assertion: an empty needle set would pass for the worst reason.
    expect(needles.size).toBeGreaterThan(100);
    const offenders = [];
    for (const file of FILES) {
      const text = readFileSync(path.join(ROOT, file), 'utf8').toLowerCase();
      for (const needle of needles) if (text.includes(needle)) offenders.push(`${file}: ${needle}`);
    }
    expect(offenders).toEqual([]);
    // Positive control: the fixture's own roster names the corpus, so the scan can find a name.
    const control = readFileSync(
      path.join(ROOT, 'fixtures/season-2026/coach_roster_v1.csv'),
      'utf8'
    ).toLowerCase();
    expect([...needles].some((needle) => control.includes(needle))).toBe(true);
  });
});
