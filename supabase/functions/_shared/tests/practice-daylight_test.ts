/**
 * The daylight post-pass under Deno (8.9 PR 6), run by
 * `scripts/deno-mirror-tests.sh` under two host zones.
 *
 * The one step of the pass that could consult the host's zone is reading a
 * slot's instants back onto the season's wall clock (`toDaylightSlot`). A
 * host-zone read would move the date or the end minute in exactly one of the
 * two runs. The Vitest witnesses (`tests/autoSchedulerDaylight.test.js`) hold
 * the rule itself -- W7, W9, W15 -- against core's sunset; this file holds the
 * Deno arm's clock and its three verdicts with times no sunset can straddle.
 *
 * Coordinates are synthetic (40.00/-75.00).
 */
import { assertEquals } from 'https://deno.land/std@0.203.0/assert/mod.ts';
import {
  applyDaylightPostPass,
  DAYLIGHT_TBD_REASON,
  PRACTICE_SUNSET_MARGIN_MINUTES,
  toDaylightSlot,
  type VenueDaylight,
} from '../engines/practice-daylight.ts';

const ZONE = 'America/New_York';

function venue(fieldId: string, lit: boolean | null): VenueDaylight {
  return { fieldId, locationId: `loc-${fieldId}`, lit, latitude: 40.0, longitude: -75.0 };
}

function slotEnding(id: string, fieldId: string, end: string) {
  return toDaylightSlot(
    {
      id,
      start: new Date('2026-09-15T08:00:00-04:00'),
      end: new Date(`2026-09-15T${end}:00-04:00`),
    },
    ZONE,
    // As `practice_slots` stores it: the venue and last date.
    { fieldId, validUntil: '2026-09-29' }
  );
}

Deno.test('the practice margin is 0 (D6)', () => {
  assertEquals(PRACTICE_SUNSET_MARGIN_MINUTES, 0);
});

Deno.test('a slot is read on the season clock, whatever the host zone', () => {
  const slot = slotEnding('s', 'f-unlit', '19:00');
  assertEquals(slot.firstDate, '2026-09-15');
  assertEquals(slot.endMinutes, 19 * 60);
  // Late evening on the season clock is the next UTC date: still the 15th here.
  const late = slotEnding('s', 'f-unlit', '22:30');
  assertEquals(late.firstDate, '2026-09-15');
  assertEquals(late.endMinutes, 22 * 60 + 30);
});

Deno.test('lit is exempt, noon is in daylight, 22:30 is withdrawn to TIME TBD', () => {
  const slots = new Map([
    ['s-lit', slotEnding('s-lit', 'f-lit', '22:30')],
    ['s-noon', slotEnding('s-noon', 'f-unlit', '12:00')],
    ['s-late', slotEnding('s-late', 'f-unlit', '22:30')],
  ]);
  const venues = new Map([
    ['f-lit', venue('f-lit', true)],
    ['f-unlit', venue('f-unlit', false)],
  ]);
  const placements = [...slots.keys()].map((slotId, i) => ({
    teamId: `t${i}`,
    slotId,
    source: 'auto' as const,
  }));
  const pass = applyDaylightPostPass({
    placements,
    unassigned: [],
    locked: [],
    slots,
    venues,
    timeZone: ZONE,
    today: '2026-09-01',
  });
  assertEquals(
    pass.placements.map((p) => p.slotId),
    ['s-lit', 's-noon']
  );
  // The same objects where nothing changed.
  assertEquals(pass.placements[0] === placements[0], true);
  assertEquals(pass.unassigned, [
    { teamId: 't2', reason: DAYLIGHT_TBD_REASON, date: '2026-09-15' },
  ]);
  assertEquals(pass.report.meta.litPlacementsExempt, 1);
  // s-noon: 15, 22, 29 in daylight; s-late: its first date is past sunset.
  assertEquals(pass.report.meta.occurrencesWithinDaylight, 3);
  assertEquals(pass.report.meta.occurrencesExamined, 4);
  assertEquals(
    pass.report.timeTbd.map((t) => [t.teamId, t.from, t.until, t.withdrawn]),
    [['t2', '2026-09-15', '2026-09-29', true]]
  );
});
