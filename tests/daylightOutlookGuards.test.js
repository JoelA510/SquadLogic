// @vitest-environment node
/**
 * The Practice daylight model's own checks, shown able to fail (duration-phase wiring, PR B).
 *
 * `buildDaylightOutlook` refuses to draw a report that lost a slot, that the two reports disagree
 * about, or that gave a verdict it has no words for; and it counts the slots on lit ground from the
 * ROWS by each venue's own flag, so a report that moved a slot between lit and unlit is caught even
 * when its two halves agree with each other. A check like that is hollow until something makes it
 * fail (AGENTS.md, verification conventions): here each is made to fail by a copy of the real
 * report with one thing wrong, and the control is the same call with nothing wrong.
 *
 * The reports are real (`importOriginal`); only what they return is altered, in a copy.
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  g3: /** @type {(report: any) => any} */ ((report) => report),
  g5: /** @type {(report: any) => any} */ ((report) => report),
}));

vi.mock('@squadlogic/core/practice/durationPhases.js', async (importOriginal) => {
  const real = /** @type {any} */ (await importOriginal());
  return {
    ...real,
    derivePracticeDurationPhases: (input) => h.g3(real.derivePracticeDurationPhases(input)),
    buildDstSurvivalReport: (input) => h.g5(real.buildDstSurvivalReport(input)),
  };
});

import {
  OUTLOOK_VERDICT,
  buildDaylightOutlook,
  describeFix,
  describePhase,
  describeVerdict,
} from '../frontend/src/utils/daylightOutlook.js';
import { ID, SEASON, estateRows } from './helpers/practiceDaylightRows.js';

// The hooks are module state, set and cleared around a synchronous call: keep these tests sequential.
const build = (tamper = /** @type {Record<string, any>} */ ({})) => {
  h.g3 = tamper.g3 ?? ((report) => report);
  h.g5 = tamper.g5 ?? ((report) => report);
  try {
    return buildDaylightOutlook({ rows: estateRows(), season: SEASON });
  } finally {
    h.g3 = (report) => report;
    h.g5 = (report) => report;
  }
};

describe('the model refuses a report it cannot stand behind', () => {
  it('control: untouched reports build the outlook, eight unlit slots and one lit', () => {
    const outlook = build();
    expect(outlook.rows).toHaveLength(8);
    expect(outlook.counts.litSlots).toBe(1);
  });

  it('the survival report loses a slot: the two reports disagree', () => {
    expect(() => build({ g5: (r) => ({ ...r, rows: r.rows.slice(1) }) })).toThrow(
      /disagree on which slots are on unlit ground/
    );
  });

  it('the phase report counts one slot fewer than the rows read', () => {
    expect(() =>
      build({ g3: (r) => ({ ...r, meta: { ...r.meta, slotsExamined: r.meta.slotsExamined - 1 } }) })
    ).toThrow(/examined 8 of the 9 practice slots read/);
  });

  it('both reports lose the same slot: caught by counting the unlit slots from the rows', () => {
    expect(() =>
      build({
        g3: (r) => ({ ...r, slotPhases: r.slotPhases.slice(1) }),
        g5: (r) => ({ ...r, rows: r.rows.slice(1) }),
      })
    ).toThrow(/lists 7 unlit and 1 lit slots of the 9 read, and the rows say 1 are lit/);
  });

  it('the survival report moves a slot from unlit to lit: the rows say otherwise', () => {
    expect(() =>
      build({
        g5: (r) => ({ ...r, meta: { ...r.meta, litSlotsExempt: r.meta.litSlotsExempt + 1 } }),
      })
    ).toThrow(/the rows say 1 are lit/);
  });

  it('a flagged date is lost from the phase report: the reports disagree on it', () => {
    const lose = (r) => ({
      ...r,
      slotPhases: r.slotPhases.map((t) =>
        t.slotId === ID.floor ? { ...t, flagged: t.flagged.slice(1) } : t
      ),
    });
    expect(() => build({ g3: lose })).toThrow(/the reports disagree on its flagged dates/);
  });

  it('a survival verdict it has no words for is refused, never drawn as fine', () => {
    const odd = (r) => ({
      ...r,
      rows: r.rows.map((row) => (row.slotId === ID.ok ? { ...row, verdict: 'cannot-say' } : row)),
    });
    expect(() => build({ g5: odd })).toThrow(/gave the verdict "cannot-say"/);
  });
});

describe("the lit slots are counted from the rows, by each venue's own flag", () => {
  const withBrightPark = (lighting) => {
    const rows = estateRows();
    rows.locations = rows.locations.map((l) =>
      l.name === 'Bright Park' ? { ...l, lighting_available: lighting } : l
    );
    return rows;
  };

  it('control: with no lit venue the reports and the rows agree on none, and the slot is judged', () => {
    for (const lighting of [false, null]) {
      const outlook = buildDaylightOutlook({ rows: withBrightPark(lighting), season: SEASON });
      expect(outlook.counts.litSlots).toBe(0);
      expect(outlook.rows).toHaveLength(9);
    }
  });

  it('a report that still says one slot is lit, over rows that say none, is refused', () => {
    h.g5 = (r) => ({ ...r, meta: { ...r.meta, litSlotsExempt: 1 } });
    try {
      expect(() => buildDaylightOutlook({ rows: withBrightPark(false), season: SEASON })).toThrow(
        /the rows say 0 are lit/
      );
    } finally {
      h.g5 = (r) => r;
    }
  });
});

describe('the words refuse what they have no sentence for', () => {
  const day = (iso) => iso;
  it('a verdict key it does not know is not the green one', () => {
    expect(() => describeVerdict('cannot-say', /** @type {any} */ ({}), day)).toThrow(
      /no wording for the verdict/
    );
    expect(describeVerdict(OUTLOOK_VERDICT.OK, /** @type {any} */ ({}), day).label).toBe(
      'Ends by sunset all season'
    );
  });

  it('a fix kind it does not know is not worded as portable lighting', () => {
    expect(() =>
      describeFix(
        { kind: 'move-the-league', available: true },
        { day, surfaceName: String, durationMinutes: 60, minimumDurationMinutes: 40 }
      )
    ).toThrow(/no wording for a fix of kind "move-the-league"/);
    // An unavailable fix is not listed, whatever its kind.
    expect(
      describeFix(
        { kind: 'move-the-league', available: false },
        { day, surfaceName: String, durationMinutes: 60, minimumDurationMinutes: 40 }
      )
    ).toBeNull();
  });

  it('a phase retimed in a way it does not know is not worded as a shortening', () => {
    expect(() =>
      describePhase(
        {
          effectiveFrom: '2026-10-06',
          startMinutes: 1080,
          durationMinutes: 40,
          retime: 'stretch',
          bound: null,
        },
        { day, minimumDurationMinutes: 40 }
      )
    ).toThrow(/no wording for a phase retimed as "stretch"/);
  });
});
