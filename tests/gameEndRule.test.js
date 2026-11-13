/**
 * When a saved game ends (F11-3 review R6): the team page and the feed over one table of rows
 * (`supabase/functions/_shared/tests/game-end-cases.ts`). The Deno arm of the feed's half is `ics-feed_test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  GAME_END_CASES,
  GAME_END_TIMEZONE,
} from '../supabase/functions/_shared/tests/game-end-cases.ts';
import { buildFeedEvents } from '../supabase/functions/_shared/calendar/icsFeed.ts';
import { savedGameWallTimes } from '../frontend/src/utils/savedGamesClient.js';

describe.each(GAME_END_CASES)('$name', ({ game, feedStart, feedEnd, pageEnd }) => {
  it('the feed writes its start and end, the end never before the start', () => {
    const [event] = buildFeedEvents({
      teamName: 'Tigers',
      timezone: GAME_END_TIMEZONE,
      games: [game],
    });
    expect(event.kind).toBe('timed');
    expect([event.dtstart, event.dtend]).toEqual([feedStart, feedEnd]);
    expect(event.dtend >= event.dtstart).toBe(true);
  });

  it('the team page shows the same end, or none', () => {
    const page = savedGameWallTimes({ ...game, game_slot: game.game_slots }, GAME_END_TIMEZONE);
    expect(page.endTime).toBe(pageEnd);
  });
});
