import { describe, expect, it } from 'vitest';
import { loadSeason2026, loadSeason2026Practice } from '@squadlogic/core/fixtures/index.js';
import {
  AGE_CUTOFF_MODES,
  computeAgeNumber,
  importNaturalAge,
} from '../packages/core/src/ageGroups.js';
import { PLACEMENT, applyPlayUpEligibility } from '../packages/core/src/playUp.js';

/**
 * R5 (docs/changes/2026-10-22-admin-focus.md): the import stores a natural age instead of the
 * birth date, so play-up eligibility read from the stored natural age must equal what the birth
 * date gave, on the season fixture's 1,153 registrations (`fixtures/season-2026/practice/
 * player_registration.csv`), in every division of the fixture.
 *
 * **The fixture holds a birth year, not a date** (its README: exact dates were dropped). So each
 * player is tried with a birth date in every month of their birth year, which covers both sides
 * of the August cutoff. The subject set is the registrations and the divisions are every
 * `age_group_code` the registrations name; neither is derived from a placement.
 *
 * **The season the ages are counted in.** The export's age group is the U-number of the seasonal
 * year August 2026 to July 2027 (a child born in 2021 is age group 6, `U06B`), so ages are
 * counted with season year 2027, and the first test checks that every registration's age group
 * is one an August-cutoff birth date in its birth year gives that season, rather than assuming
 * it.
 */

const season = loadSeason2026();
const practice = loadSeason2026Practice({ season });
const REGISTRATIONS = practice.playerRegistrations;
const SEASON_YEAR = 2027;
const MONTHS = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));

/** Each registration's division: its age group code, or the Minis cohort (age 4, no code). */
const divisionOf = (registration) => registration.ageGroupCode ?? 'Minis U04';
const DIVISIONS = [...new Set(REGISTRATIONS.map(divisionOf))].sort();

/** The placement fields eligibility decides, per player id. */
function eligibility(players, division, cutoffMode) {
  const { players: annotated } = applyPlayUpEligibility({
    players: players.map((player) => ({ ...player, division })),
    divisions: DIVISIONS.map((name) => ({ id: name, name })),
    seasonYear: SEASON_YEAR,
    cutoffMode,
    remapBlocked: false,
  });
  return new Map(
    annotated.map((p) => [
      p.id,
      {
        placement: p.placement,
        naturalAge: p.naturalAge,
        needsReview: p.needsReview,
        sanctioned: p.playUpSanctioned,
      },
    ])
  );
}

/**
 * Every (player, birth month, division) under a cutoff: the birth-date path and the stored path,
 * whose natural age is `natural(registration, dob)` and reaches eligibility as the stored column
 * does (`natural_age` on the player, no birth date).
 * @param {string} cutoffMode
 * @param {(registration: any, dob: string, cutoffMode: string) => number|null} natural
 * @param {{ include?: (registration: any, dob: string, cutoffMode: string) => boolean }} [options]
 */
function compare(cutoffMode, natural, { include = () => true } = {}) {
  /** @type {{ compared: number, differing: number, byPlacement: Record<string, number> }} */
  const counts = { compared: 0, differing: 0, byPlacement: {} };
  for (const month of MONTHS) {
    const rows = REGISTRATIONS.map((registration, index) => ({
      registration,
      id: `p${index}`,
      dob: `${registration.birthYear}-${month}-15`,
    })).filter((row) => include(row.registration, row.dob, cutoffMode));
    const byDob = rows.map(({ registration, id, dob }) => ({
      id,
      date_of_birth: dob,
      isCoachChild: registration.playingUp,
    }));
    const byStored = rows.map(({ registration, id, dob }) => ({
      id,
      natural_age: natural(registration, dob, cutoffMode),
      isCoachChild: registration.playingUp,
    }));
    for (const division of DIVISIONS) {
      const fromDob = eligibility(byDob, division, cutoffMode);
      const fromStored = eligibility(byStored, division, cutoffMode);
      for (const { id } of rows) {
        counts.compared += 1;
        const a = fromDob.get(id);
        if (JSON.stringify(a) !== JSON.stringify(fromStored.get(id))) counts.differing += 1;
        counts.byPlacement[a.placement] = (counts.byPlacement[a.placement] ?? 0) + 1;
      }
    }
  }
  return counts;
}

const computedAtImport = (registration, dob, cutoffMode) =>
  importNaturalAge({ dob, seasonYear: SEASON_YEAR, cutoffMode });
/** The import had no birth date that gave an age: the age group the export states. */
const statedByTheExport = (registration, _dob, cutoffMode) =>
  importNaturalAge({ ageGroup: registration.ageGroup, seasonYear: SEASON_YEAR, cutoffMode });

describe('play-up eligibility from the stored natural age equals the birth-date result (R5)', () => {
  it('reads every registration of the fixture, and every age group is a natural age of its birth year', () => {
    expect(REGISTRATIONS).toHaveLength(1153);
    expect(DIVISIONS.length).toBeGreaterThanOrEqual(20);
    const inconsistent = REGISTRATIONS.filter(
      (r) =>
        !MONTHS.some(
          (month) =>
            computeAgeNumber(
              `${r.birthYear}-${month}-15`,
              SEASON_YEAR,
              AGE_CUTOFF_MODES.SCHOOL_YEAR_AUG_JUL
            ) === r.ageGroup
        )
    );
    expect(inconsistent).toEqual([]);
  });

  it.each([AGE_CUTOFF_MODES.SCHOOL_YEAR_AUG_JUL, AGE_CUTOFF_MODES.BIRTH_YEAR])(
    'a natural age computed at import from the birth date, under %s',
    (cutoffMode) => {
      const counts = compare(cutoffMode, computedAtImport);
      expect(counts.compared).toBe(REGISTRATIONS.length * MONTHS.length * DIVISIONS.length);
      expect(counts.differing).toBe(0);
      // The comparison saw every kind of placement, and no player went unchecked.
      for (const placement of [
        PLACEMENT.IN_BAND,
        PLACEMENT.PLAY_UP_SANCTIONED,
        PLACEMENT.PLAY_UP_BLOCKED,
        PLACEMENT.PLAY_DOWN_BLOCKED,
      ]) {
        expect(counts.byPlacement[placement], placement).toBeGreaterThan(0);
      }
      expect(counts.byPlacement[PLACEMENT.UNKNOWN] ?? 0).toBe(0);
    }
  );

  it('the age group the export states (no birth date gave an age), for each birth date that age group allows', () => {
    const counts = compare(AGE_CUTOFF_MODES.SCHOOL_YEAR_AUG_JUL, statedByTheExport, {
      include: (registration, dob, cutoffMode) =>
        computeAgeNumber(dob, SEASON_YEAR, cutoffMode) === registration.ageGroup,
    });
    // Each registration is born on one side of the cutoff, so 7 or 5 of its months qualify.
    expect(counts.compared).toBeGreaterThanOrEqual(REGISTRATIONS.length * 5 * DIVISIONS.length);
    expect(counts.differing).toBe(0);
    expect(counts.byPlacement[PLACEMENT.PLAY_DOWN_BLOCKED]).toBeGreaterThan(0);
    expect(counts.byPlacement[PLACEMENT.PLAY_UP_BLOCKED]).toBeGreaterThan(0);
  });

  it('POSITIVE CONTROL: a stored natural age one year off differs from the birth date', () => {
    const counts = compare(
      AGE_CUTOFF_MODES.SCHOOL_YEAR_AUG_JUL,
      (registration, dob, cutoffMode) => computedAtImport(registration, dob, cutoffMode) + 1
    );
    expect(counts.differing).toBeGreaterThan(0);
  });

  it('POSITIVE CONTROL: the birth date wins over an age group that contradicts it', () => {
    // A birth date the stated age group does not allow: the stored age is the birth date's, so
    // the stored path still equals the birth-date path, which is what teaming read before R5.
    const registration = REGISTRATIONS.find((r) => r.ageGroup === 2027 - r.birthYear);
    const dob = `${registration.birthYear}-09-15`;
    const cutoffMode = AGE_CUTOFF_MODES.SCHOOL_YEAR_AUG_JUL;
    expect(computeAgeNumber(dob, SEASON_YEAR, cutoffMode)).toBe(registration.ageGroup - 1);
    expect(
      importNaturalAge({
        ageGroup: registration.ageGroup,
        dob,
        seasonYear: SEASON_YEAR,
        cutoffMode,
      })
    ).toBe(registration.ageGroup - 1);
    // And the age group alone, the case the third test compares, is the export's.
    expect(statedByTheExport(registration, dob, cutoffMode)).toBe(registration.ageGroup);
  });
});
