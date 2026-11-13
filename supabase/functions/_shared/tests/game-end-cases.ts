/**
 * One table of saved games for the rule "when does a game end" (F11-3 review R6), read by the feed's tests (Deno,
 * `ics-feed_test.ts`, and its Vitest twin `tests/calendarFeed.test.js`) and the team page's (`tests/gameEndRule.test.js`),
 * so the two readers are held to the same answers. New York, October (UTC-4); the slot is 09:00 to 10:00.
 *
 * - `feedEnd`: the event's DTEND as UTC `YYYYMMDDTHHMMSSZ` (the feed always writes one, never before its DTSTART).
 * - `pageEnd`: the team page's end, wall `HH:MM:SS`, or null when it has none to show.
 */
// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rec = Record<string, any>;

const slot = (over: Rec = {}): Rec => ({
  slot_date: '2026-10-03',
  start_time: '09:00:00',
  end_time: '10:00:00',
  start: null,
  end: null,
  fields: { name: 'Pitch 1', locations: { name: 'Example Park' } },
  ...over,
});

export const GAME_END_TIMEZONE = 'America/New_York';

export const GAME_END_CASES: Array<{
  name: string;
  game: Rec;
  feedStart: string;
  feedEnd: string;
  pageEnd: string | null;
}> = [
  {
    name: 'its own start and end',
    game: {
      id: 'g-own',
      start: '2026-10-03T13:00:00+00:00',
      end: '2026-10-03T14:30:00+00:00',
      game_slots: slot(),
    },
    feedStart: '20261003T130000Z',
    feedEnd: '20261003T143000Z',
    pageEnd: '10:30:00',
  },
  {
    name: 'its own start, no end, at another time than its slot: the slot’s length from its own start',
    game: { id: 'g-late', start: '2026-10-03T15:00:00+00:00', end: null, game_slots: slot() },
    feedStart: '20261003T150000Z',
    feedEnd: '20261003T160000Z',
    pageEnd: '12:00:00',
  },
  {
    name: 'its own start, no end, a slot with no length: the feed writes the default hour, the page shows no end',
    game: {
      id: 'g-nolength',
      start: '2026-10-03T15:00:00+00:00',
      end: null,
      game_slots: slot({ end_time: null }),
    },
    feedStart: '20261003T150000Z',
    feedEnd: '20261003T160000Z',
    pageEnd: null,
  },
  {
    name: 'its own start, no end, and no slot',
    game: { id: 'g-noslot', start: '2026-10-03T15:00:00+00:00', end: null, game_slots: null },
    feedStart: '20261003T150000Z',
    feedEnd: '20261003T160000Z',
    pageEnd: null,
  },
  {
    name: 'an end before its own start is not an end',
    game: {
      id: 'g-backwards',
      start: '2026-10-03T15:00:00+00:00',
      end: '2026-10-03T14:00:00+00:00',
      game_slots: slot(),
    },
    feedStart: '20261003T150000Z',
    feedEnd: '20261003T160000Z',
    pageEnd: '12:00:00',
  },
];
