/**
 * The season-2026 external fixture change request.
 *
 * `external_fixtures_published.csv` is the other league's eight seeding
 * fixtures **as they published them** — 10:30 and 12:30 on both days. The
 * corpus's `combined_schedule.csv` carries the *agreed* times: 08/23 stayed as
 * published, and the 08/22 pair moved thirty minutes earlier to 10:00 and
 * 12:00. That thirty minutes is incident 3, and integrating these eight rows is
 * incident 1.
 *
 * **The direction is honest about being reconstructed.** The corpus holds one
 * snapshot, the post-negotiation one, so there is no "before" file to load. The
 * scenario is therefore assembled: the corpus is the baseline, and the
 * published external times are the incoming change — which runs history
 * backwards, since the club moved *from* the published times *to* the agreed
 * ones. What that costs is nothing the acceptance test depends on: the delta
 * between the two states is the same four games on the same date either way,
 * and the question being asked is what happens to the **other 606**.
 *
 * Like every other adapter in the codebase this one takes already-parsed rows
 * and reads nothing from disk; the arrow points fixtures -> resolve, never back.
 *
 * @module resolve/adapters/season2026ChangeRequest
 */

import { season2026SurfaceId } from '../../facility/adapters/season2026Geometry.js';
import { CHANGE_ORIGIN } from '../schemas.js';

/**
 * Turn the published external fixtures into change requests against a schedule.
 *
 * The join is on **date plus both side labels**, not on the venue string: the
 * external league writes `Alder Park (Back Pitch 2)` where the club writes
 * `Alder Park` / `Pitch 2`, and a checker that read one as the other is the
 * second half of incident 4. A fixture that matches no game, or more than one,
 * throws rather than being skipped — a change request that silently covered
 * seven of eight fixtures would produce a beautifully clean report about the
 * wrong thing.
 *
 * @param {ReadonlyArray<Object>} fixtures - parsed `external_fixtures_published.csv` rows
 * @param {import('../../ruleEngine/types.js').Schedule} schedule
 * @returns {Array<{ gameId: string, date: string, surfaceId: string, startMinutes: number, reason: string, origin: string }>}
 */
export function season2026ExternalFixtureChanges(fixtures, schedule) {
  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    throw new Error(
      'resolve: the external fixture list is empty, so the change request would ask for nothing (incident 4)'
    );
  }

  return fixtures
    .map((fixture) => {
      const matches = schedule.games.filter(
        (game) =>
          game.date === fixture.date &&
          game.homeLabel === fixture.homeLabel &&
          game.awayLabel === fixture.awayLabel
      );
      if (matches.length !== 1) {
        throw new Error(
          `resolve: the external fixture "${fixture.homeLabel} v ${fixture.awayLabel}" on ${fixture.date} matches ${matches.length} games in the schedule; a change request must name exactly one game per fixture`
        );
      }
      if (fixture.venue === null || fixture.field === null) {
        throw new Error(
          `resolve: the external fixture "${fixture.homeLabel} v ${fixture.awayLabel}" on ${fixture.date} carries the venue label "${fixture.externalVenueLabel}", which does not resolve to a club venue and field`
        );
      }
      return {
        gameId: matches[0].id,
        date: fixture.date,
        surfaceId: season2026SurfaceId(fixture.venue, fixture.field),
        startMinutes: fixture.kickoffMinutes,
        reason: 'the external league published this kickoff',
        // Incident 3: an externally-published fixture is an instruction, not a
        // machine's choice, and keeps #436's exemption from the placer's gate.
        origin: CHANGE_ORIGIN.OPERATOR,
      };
    })
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.startMinutes - b.startMinutes ||
        a.gameId.localeCompare(b.gameId)
    );
}
