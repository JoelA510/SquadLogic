/**
 * `carryGameIds` and `isHeld` (packages/core/src/gameIdentity.js): the pure half of "a game keeps its id" (plan
 * docs/changes/2026-11-06-games-table-source-of-truth.md, I2, task A2).
 *
 * After the generator runs again, a regenerated game is told which saved game it continues, by the same unordered
 * pair, preferring the same week and then the nearest unclaimed week, one saved game to one regenerated game. The
 * server only validates what the page proposes (lesson 53); this is the proposal.
 *
 * Verification conventions held here (AGENTS.md section 3):
 *   - The SAVED SET is the subject. Every expectation below is enumerated from the saved games ("was saved game X
 *     claimed, and by which regenerated game"), never from the result, so a game the matcher dropped cannot hide
 *     by being absent from the thing being checked.
 *   - "No saved game is claimed twice" is a meta-assertion: `claimedTwice` is shown to see a double claim planted by
 *     hand, and a property run over seeded leagues applies it to the matcher.
 *   - The week preference has a test only a week-ignoring matcher fails (a double round robin handed to the matcher in
 *     the opposite order). The planted defect is recorded in the PR.
 */
import { describe, expect, it } from 'vitest';
import { carryGameIds, holdReason, isHeld } from '../packages/core/src/gameIdentity.js';

/** @returns {Record<string, any>} */
const saved = (id, home, away, weekIndex, extra = {}) => ({
  id,
  homeTeamId: home,
  awayTeamId: away,
  weekIndex,
  ...extra,
});
/** @returns {Record<string, any>} */
const gen = (home, away, weekIndex, extra = {}) => ({
  homeTeamId: home,
  awayTeamId: away,
  weekIndex,
  ...extra,
});

/** Which regenerated game (by index) took each saved game's id: the answer, enumerated from the saved games. */
function claimsOf(savedGames, result) {
  return savedGames.map((game) => {
    const taken = result.map((r, index) => (r.id === game.id ? index : -1)).filter((i) => i >= 0);
    return taken.length === 0 ? null : taken.length === 1 ? taken[0] : taken;
  });
}

/** The meta-assertion's subject: a saved id carried by more than one regenerated game. */
function claimedTwice(savedGames, result) {
  return savedGames
    .filter((game) => result.filter((r) => r.id === game.id).length > 1)
    .map((game) => game.id);
}

describe('carryGameIds', () => {
  it('gives a regenerated game the id of the saved game of the same pair in the same week', () => {
    const s = [saved('g1', 'A', 'B', 1), saved('g2', 'C', 'D', 1), saved('g3', 'A', 'C', 2)];
    const g = [gen('A', 'B', 1), gen('A', 'C', 2), gen('C', 'D', 1)];
    expect(claimsOf(s, carryGameIds(s, g))).toEqual([0, 2, 1]);
  });

  it('a pair moved across weeks keeps its id', () => {
    const s = [saved('g1', 'A', 'B', 2)];
    const out = carryGameIds(s, [gen('A', 'B', 5)]);
    expect(claimsOf(s, out)).toEqual([0]);
    expect(out[0].weekIndex).toBe(5);
  });

  it('a double round robin matches each of the two meetings once, by week and not by order', () => {
    // The pair meets in weeks 2 and 6. The regenerated schedule lists them in the opposite order, in weeks 7 and 3.
    // A matcher that took them in the order given would give the week-6 id to the week-3 game.
    const s = [saved('early', 'A', 'B', 2), saved('late', 'B', 'A', 6)];
    const g = [gen('A', 'B', 7), gen('B', 'A', 3)];
    const out = carryGameIds(s, g);
    expect(out[0].id).toBe('late');
    expect(out[1].id).toBe('early');
    expect(claimsOf(s, out)).toEqual([1, 0]);
  });

  it('prefers the same week, then the nearest unclaimed week', () => {
    const s = [saved('w1', 'A', 'B', 1), saved('w4', 'A', 'B', 4), saved('w9', 'A', 'B', 9)];
    // Regenerated meetings in weeks 4, 5 and 12. The combinations are taken nearest first: 4 with 4 (same week, 0 apart),
    // then 12 with 9 (3 apart), and week 5 is left with week 1 (4 apart).
    const out = carryGameIds(s, [gen('A', 'B', 4), gen('A', 'B', 5), gen('A', 'B', 12)]);
    expect(out.map((r) => r.id)).toEqual(['w4', 'w1', 'w9']);
  });

  it("a game at a saved game's exact place (same slot, same week) takes that saved game, not the first of two tied by week", () => {
    // X and Y are the same pair in the same week, at slots s1 and s2, and the regenerated meeting is exactly at s2. Tied on
    // the week alone, the first saved game (X) would take it and move from s1 to s2, onto the place Y already holds: the
    // save then refuses the Apply (`game_identity_conflict`). The exact place decides first.
    const s = [
      saved('X', 'A', 'B', 1, { slotId: 's1' }),
      saved('Y', 'A', 'B', 1, { slotId: 's2' }),
    ];
    const out = carryGameIds(s, [gen('A', 'B', 1, { slotId: 's2' })]);
    expect(out).toHaveLength(1);
    expect({ slotId: out[0].slotId, id: out[0].id }).toEqual({ slotId: 's2', id: 'Y' });
    expect(claimsOf(s, out)).toEqual([null, 0]);
  });

  it("the mirror: two regenerated meetings in one week and one saved game at the second one's slot", () => {
    // The first regenerated meeting is at s1, the second at s2, and the one saved game is at s2. In the order given the
    // first would take it; the exact place gives it to the second, which stays where the saved game is.
    const s = [saved('Y', 'A', 'B', 1, { slotId: 's2' })];
    const out = carryGameIds(s, [
      gen('A', 'B', 1, { slotId: 's1' }),
      gen('A', 'B', 1, { slotId: 's2' }),
    ]);
    expect(out.map((r) => r.id)).toEqual([undefined, 'Y']);
  });

  it('reads either spelling of the slot, and a flipped pair, for the exact place', () => {
    // Saved: g_week at week 3 / slot s1, g_slot at week 3 / slot s2 (database spelling). Regenerated: one meeting at week 3
    // slot s2 (camel spelling). Both saved games are 0 weeks away; only g_slot is at the same place.
    const s = [
      { id: 'g_week', home_team_id: 'A', away_team_id: 'B', week_index: 3, game_slot_id: 's1' },
      { id: 'g_slot', home_team_id: 'A', away_team_id: 'B', week_index: 3, slot_id: 's2' },
    ];
    expect(carryGameIds(s, [gen('A', 'B', 3, { gameSlotId: 's2' })])[0].id).toBe('g_slot');
    expect(carryGameIds(s, [gen('B', 'A', 3, { slotId: 's2' })])[0].id).toBe('g_slot');
  });

  it('with no slot to compare, or no game at the same place, the week still decides (the order of the keys)', () => {
    // Without slots (as every case above) the week keys decide, unchanged. With slots that match nowhere, the same.
    const s = [
      saved('w1', 'A', 'B', 1, { slotId: 's1' }),
      saved('w4', 'A', 'B', 4, { slotId: 's1' }),
    ];
    const out = carryGameIds(s, [
      gen('A', 'B', 4, { slotId: 's9' }),
      gen('A', 'B', 2, { slotId: 's9' }),
    ]);
    expect(out.map((r) => r.id)).toEqual(['w4', 'w1']);
  });

  it('an odd division with byes: a game with no counterpart keeps no id, a saved game with none is not claimed', () => {
    // Five teams, so one sits out each week. The saved schedule has B v C in week 3; the regenerated one does not play
    // that pair at all (a bye moved), and plays D v E, which was never saved.
    const s = [saved('ab', 'A', 'B', 1), saved('bc', 'B', 'C', 3), saved('de1', 'D', 'E', 2)];
    const g = [gen('A', 'B', 1), gen('D', 'E', 4), gen('A', 'C', 3)];
    const out = carryGameIds(s, g);
    expect(claimsOf(s, out)).toEqual([0, null, 1]);
    expect(out[2].id).toBeUndefined();
    expect('id' in out[2]).toBe(false);
  });

  it('a flipped pair continues the same game', () => {
    const s = [saved('g1', 'A', 'B', 3)];
    const out = carryGameIds(s, [gen('B', 'A', 3)]);
    expect(out[0].id).toBe('g1');
    expect(out[0].homeTeamId).toBe('B');
  });

  it('a team removed: the games it played are not claimed, and the others still are', () => {
    const s = [saved('az', 'A', 'Z', 1), saved('bz', 'B', 'Z', 2), saved('ab', 'A', 'B', 3)];
    const out = carryGameIds(s, [gen('A', 'B', 3)]);
    expect(claimsOf(s, out)).toEqual([null, null, 0]);
  });

  it('a team added: its games are new, and nothing is taken from a saved pair', () => {
    const s = [saved('ab', 'A', 'B', 1)];
    const out = carryGameIds(s, [gen('A', 'B', 1), gen('A', 'N', 2), gen('B', 'N', 3)]);
    expect(claimsOf(s, out)).toEqual([0]);
    expect(out.slice(1).every((r) => !('id' in r))).toBe(true);
  });

  it('more regenerated meetings than saved ones: the extras are new games', () => {
    const s = [saved('ab', 'A', 'B', 2)];
    const out = carryGameIds(s, [gen('A', 'B', 1), gen('A', 'B', 2), gen('A', 'B', 3)]);
    expect(out.map((r) => r.id)).toEqual([undefined, 'ab', undefined]);
  });

  it('a game already carrying a saved id (a Published game the generator carried) keeps it and the saved game is spent', () => {
    // The generator hands a held game back as itself. Another regenerated game of the same pair must not take its id.
    const held = saved('held', 'A', 'B', 2, { published: true });
    const s = [held, saved('free', 'A', 'B', 6)];
    const out = carryGameIds(s, [
      gen('A', 'B', 2, { id: 'held', published: true }),
      gen('A', 'B', 2),
    ]);
    expect(out[0].id).toBe('held');
    expect(out[1].id).toBe('free');
    expect(claimedTwice(s, out)).toEqual([]);
  });

  it('a game carrying an id that is not a saved game is left alone and spends nothing', () => {
    const s = [saved('ab', 'A', 'B', 1)];
    const out = carryGameIds(s, [gen('A', 'B', 1, { id: 'review-0' })]);
    expect(out[0].id).toBe('review-0');
    // It names no saved game, so it does not claim the pair's saved game either: the pair's game is untouched.
    expect(claimsOf(s, out)).toEqual([null]);
  });

  it('two regenerated games carrying one saved id is a caller error, said loudly', () => {
    const s = [saved('ab', 'A', 'B', 1)];
    expect(() =>
      carryGameIds(s, [gen('A', 'B', 1, { id: 'ab' }), gen('A', 'B', 2, { id: 'ab' })])
    ).toThrow(/ab/);
  });

  it('reads the database spelling of a saved game and the camel one of a regenerated game', () => {
    const s = [{ id: 'g1', home_team_id: 'A', away_team_id: 'B', week_index: 4 }];
    const out = carryGameIds(s, [{ home_team_id: 'B', away_team_id: 'A', week_index: 4 }]);
    expect(out[0].id).toBe('g1');
  });

  it('ignores a saved game that names no pair or no id, and a game that plays itself', () => {
    const s = [
      { id: 'x1', homeTeamId: 'A', awayTeamId: null, weekIndex: 1 },
      { homeTeamId: 'A', awayTeamId: 'B', weekIndex: 1 },
      saved('x3', 'C', 'C', 1),
    ];
    const out = carryGameIds(s, [gen('A', 'B', 1), gen('C', 'C', 1)]);
    expect(out.every((r) => !('id' in r))).toBe(true);
  });

  it('does not change what it is given, and returns one game for each it is given, in order', () => {
    const s = [saved('g1', 'A', 'B', 1)];
    const g = [gen('C', 'D', 1), gen('A', 'B', 2)];
    const sBefore = structuredClone(s);
    const gBefore = structuredClone(g);
    const out = carryGameIds(s, g);
    expect(s).toEqual(sBefore);
    expect(g).toEqual(gBefore);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(g[0]);
    expect(out[1]).not.toBe(g[1]);
    expect(out.map((r) => [r.homeTeamId, r.awayTeamId])).toEqual([
      ['C', 'D'],
      ['A', 'B'],
    ]);
  });

  it('an empty saved schedule or an empty regeneration is not an error', () => {
    expect(carryGameIds([], [gen('A', 'B', 1)])).toEqual([gen('A', 'B', 1)]);
    expect(carryGameIds([saved('g1', 'A', 'B', 1)], [])).toEqual([]);
  });

  it('refuses what is not a list', () => {
    expect(() => carryGameIds(null, [])).toThrow(TypeError);
    // @ts-expect-error -- a caller error, on purpose
    expect(() => carryGameIds([], 'nope')).toThrow(TypeError);
  });

  describe('no saved game is claimed twice', () => {
    it('the check sees a double claim planted by hand (it can fail)', () => {
      const s = [saved('g1', 'A', 'B', 1), saved('g2', 'C', 'D', 1)];
      const planted = [
        gen('A', 'B', 1, { id: 'g1' }),
        gen('A', 'B', 2, { id: 'g1' }),
        gen('C', 'D', 1, { id: 'g2' }),
      ];
      expect(claimedTwice(s, planted)).toEqual(['g1']);
      expect(claimedTwice(s, [planted[0], planted[2]])).toEqual([]);
    });

    // A small deterministic generator, so the property is a fixed set of leagues and not a lucky run.
    const prng = (seed) => {
      let x = seed >>> 0;
      return () => {
        x = (Math.imul(x ^ (x >>> 15), 1 | x) + 0x6d2b79f5) >>> 0;
        return ((x ^ (x >>> 7)) >>> 0) / 4294967296;
      };
    };

    it('holds over 400 seeded leagues, each applying all five invariants from the saved set', () => {
      let examined = 0;
      let matchedTotal = 0;
      let exactPlaces = 0;
      for (let seed = 1; seed <= 400; seed += 1) {
        const rand = prng(seed);
        const teams = Array.from({ length: 3 + Math.floor(rand() * 5) }, (_, i) => `T${i}`);
        const meetings = 1 + Math.floor(rand() * 2);
        const savedGames = [];
        for (let a = 0; a < teams.length; a += 1) {
          for (let b = a + 1; b < teams.length; b += 1) {
            for (let m = 0; m < meetings; m += 1) {
              if (rand() < 0.15) continue; // a game the saved schedule never had
              savedGames.push(
                saved(
                  `s${savedGames.length}`,
                  rand() < 0.5 ? teams[a] : teams[b],
                  rand() < 0.5 ? teams[b] : teams[a],
                  1 + Math.floor(rand() * 12),
                  { slotId: `slot${Math.floor(rand() * 3)}` }
                )
              );
            }
          }
        }
        // Make the sides of each game consistent (home differs from away).
        for (const game of savedGames) {
          if (game.homeTeamId === game.awayTeamId)
            game.awayTeamId = teams.find((t) => t !== game.homeTeamId);
        }
        // A regenerated game is often at the very place (week and slot) of the saved game it came from, so exact places
        // are common in these leagues; one in ten is a saved game handed back as itself (a carried Published game).
        const generated = savedGames
          .filter(() => rand() < 0.85)
          .map((game) => {
            const sameWeek = rand() < 0.5;
            const sameSlot = rand() < 0.5;
            return gen(
              rand() < 0.5 ? game.homeTeamId : game.awayTeamId,
              rand() < 0.5 ? game.awayTeamId : game.homeTeamId,
              sameWeek ? game.weekIndex : 1 + Math.floor(rand() * 12),
              {
                slotId: sameSlot ? game.slotId : `slot${Math.floor(rand() * 3)}`,
                ...(rand() < 0.1
                  ? {
                      id: game.id,
                      homeTeamId: game.homeTeamId,
                      awayTeamId: game.awayTeamId,
                      weekIndex: game.weekIndex,
                      slotId: game.slotId,
                    }
                  : {}),
              }
            );
          })
          .filter((g) => g.homeTeamId !== g.awayTeamId);
        for (let extra = Math.floor(rand() * 3); extra > 0; extra -= 1)
          generated.push(
            gen(teams[0], teams[1], 1 + Math.floor(rand() * 12), {
              slotId: `slot${Math.floor(rand() * 3)}`,
            })
          );
        generated.sort(() => rand() - 0.5);

        const out = carryGameIds(savedGames, generated);
        examined += savedGames.length;
        // 1. No saved game is claimed twice.
        expect(claimedTwice(savedGames, out), `seed ${seed}`).toEqual([]);
        // 2. A claimed saved game was claimed by a game of its own unordered pair.
        const pair = (g) => [g.homeTeamId, g.awayTeamId].sort().join('|');
        for (const game of savedGames) {
          const claimer = out.find((r) => r.id === game.id);
          if (claimer) {
            matchedTotal += 1;
            expect(pair(claimer), `seed ${seed} ${game.id}`).toBe(pair(game));
          }
        }
        // 3. Maximal per pair: the number claimed is the smaller of the saved and the regenerated count.
        const pairs = new Set([...savedGames, ...generated].map(pair));
        for (const key of pairs) {
          const inSaved = savedGames.filter((g) => pair(g) === key);
          const inGenerated = generated.filter((g) => pair(g) === key);
          const claimed = inSaved.filter((g) => out.some((r) => r.id === g.id)).length;
          expect(claimed, `seed ${seed} pair ${key}`).toBe(
            Math.min(inSaved.length, inGenerated.length)
          );
        }
        // 4. One game out for each game in.
        expect(out).toHaveLength(generated.length);
        // 5. An exact place decides first: a regenerated game at a saved game's exact place (the pair, the slot and the
        //    week) takes that saved game's id, unless the saved game is spent by a game that already carries its id. In
        //    each exact place the games taking part (neither carries an id) are matched as far as the smaller of the
        //    two counts, whatever else is in the league. Enumerated from the saved set, as every invariant here is.
        const carriedIds = new Set(generated.filter((g) => g.id !== undefined).map((g) => g.id));
        const place = (g) => `${pair(g)}|${g.slotId}|${g.weekIndex}`;
        const places = new Set(savedGames.map(place));
        for (const key of places) {
          const here = savedGames.filter((g) => place(g) === key && !carriedIds.has(g.id));
          const meetingsHere = generated.filter((g) => g.id === undefined && place(g) === key);
          const takenHere = here.filter((g) =>
            out.some(
              (r, index) => r.id === g.id && generated[index].id === undefined && place(r) === key
            )
          ).length;
          exactPlaces += Math.min(here.length, meetingsHere.length) > 0 ? 1 : 0;
          expect(takenHere, `seed ${seed} place ${key}`).toBe(
            Math.min(here.length, meetingsHere.length)
          );
        }
      }
      // The meta-assertion: the leagues examined something, and the matcher matched something.
      expect(examined).toBeGreaterThan(5000);
      expect(matchedTotal).toBeGreaterThan(2000);
      // ... and invariant 5 met exact places that had a saved game and a regenerated one to match.
      expect(exactPlaces).toBeGreaterThan(300);
    });
  });
});

describe('isHeld', () => {
  it('a Published game is held', () => {
    expect(isHeld({ published: true })).toBe(true);
    expect(isHeld({ published: true, scored: false })).toBe(true);
  });
  it('a game that is not Published is not held, and neither is nothing', () => {
    expect(isHeld({ published: false })).toBe(false);
    expect(isHeld({})).toBe(false);
    expect(isHeld(null)).toBe(false);
    expect(isHeld(undefined)).toBe(false);
  });
  it('a scored game is held (F11-2 supplies the score; the rule is here)', () => {
    expect(isHeld({ published: false, scored: true })).toBe(true);
    expect(isHeld({ scored: true })).toBe(true);
  });
  it('only a boolean true holds: a truthy string is not a flag', () => {
    expect(isHeld({ published: 'true' })).toBe(false);
    expect(isHeld({ published: 1 })).toBe(false);
    expect(isHeld({ scored: 'yes' })).toBe(false);
    // An array callback hands (game, index, array): the index is not a second argument, so a scored game is held at
    // any position and an unscored one at none (review of #725, R9).
    const games = [{ scored: true }, { published: false }, { published: true }];
    expect(games.filter(isHeld)).toEqual([{ scored: true }, { published: true }]);
    expect(games.map(holdReason)).toEqual(['scored', null, 'published']);
    expect(isHeld.length + holdReason.length).toBe(2);
  });
});
