/**
 * Core vs Edge scoring parity over the season-2026 corpus (audit finding 1.1;
 * remediation plan Oct 2026, M1.2). The Vitest arm; the Deno arm is
 * `supabase/functions/_shared/tests/scoring-parity_test.ts`.
 *
 * ## Why this exists beside `scoringEngineDrift.test.js`
 *
 * The drift test compares the two `evaluatePracticeSchedule` implementations
 * (`packages/core/src/practiceMetrics.js` and the Edge's
 * `_shared/engines/scoring-engine.ts`) value against value, but only on the
 * ten hand-written vectors it names. Since the practice page now sends its real
 * roster to `fairness-scoring` (M1.1), any disagreement between the arms on a
 * real season reaches every practice page. This file runs both arms over one
 * real plan: the club's combined practice sheet ("93 Combined": 142 practice
 * rows for 88 teams) against the full 132-team roster, with its head and
 * assistant coaches.
 *
 * ## The extract, and why the Deno arm needs it
 *
 * An Edge Function cannot import `packages/core`, so the Deno arm cannot run
 * core. Both arms therefore read one committed extract,
 * `supabase/functions/_shared/tests/fixtures/scoring-parity.season-2026.json`:
 * the inputs, derived from the corpus below, and core's answer on them in the
 * agreed fields. This file checks (1) the extract's inputs are exactly what the
 * corpus derives today, (2) core still gives the recorded answer, and (3) the
 * Edge engine, imported here, gives it too. The Deno arm checks (3) again in
 * the runtime the engine is deployed to. Either arm drifting turns one red.
 *
 * ## What is compared
 *
 * The agreed contract `scoringEngineDrift.test.js` states: the summary counts
 * (`totalTeams`, `assignedTeams`, `unassignedTeams`), `assignmentRate` (the one
 * score both arms publish; core rounds it to 4 dp), per-slot occupancy and the
 * number of slot rows, the rows each arm drops (core's `dataQualityWarnings`,
 * the Edge's `data-quality` issues), and every coach conflict **by identity**:
 * which two (team, slot) placements clash and which coaches they share. The
 * Edge's `fairnessScore` is Edge-only and is a function of the conflict count
 * and `assignmentRate`, both compared here.
 *
 * ## Pseudonyms only
 *
 * The extract replaces the corpus's person keys with opaque `coach-NNN` ids;
 * only their equality matters to a conflict. Team codes and divisions are kept.
 * Regenerate it with `node scripts/generate-scoring-parity.mjs`, only when the
 * corpus or core's answer is meant to change, and review the diff.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadSeason2026 } from '@squadlogic/core/fixtures/index.js';
import { evaluatePracticeSchedule as edgeEvaluate } from '../supabase/functions/_shared/engines/scoring-engine.js';
import {
  SCORING_PARITY_EXTRACT,
  agreedFields,
  coreAgreedFields,
  deriveScoringParityInputs,
} from '../scripts/generate-scoring-parity.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DENO_ARM = 'supabase/functions/_shared/tests/scoring-parity_test.ts';

/**
 * Literals, not counts of the extract: a floor derived from the data a break
 * would shrink compares the data with itself. The Deno arm declares the same.
 */
const EXPECTED = {
  teams: 132,
  slots: 142,
  assignments: 142,
  assignedTeams: 88,
  coachConflicts: 1,
  teamsOnTwoOrMoreSlots: 54,
  teamsWithAssistants: 82,
};

const runEdge = (inputs) => {
  const result = edgeEvaluate(inputs);
  return agreedFields(result, result.issues.filter((i) => i.category === 'data-quality').length);
};

const extract = JSON.parse(readFileSync(path.join(REPO_ROOT, SCORING_PARITY_EXTRACT), 'utf8'));

describe('core vs Edge scoring parity on the season-2026 corpus', () => {
  it('the extract is what the corpus derives today', () => {
    expect(extract.inputs).toEqual(deriveScoringParityInputs());
  });

  it('the extract holds the season, with the cases parity needs (meta, can fail)', () => {
    const { teams, slots, assignments } = extract.inputs;
    expect(teams).toHaveLength(EXPECTED.teams);
    expect(slots).toHaveLength(EXPECTED.slots);
    expect(assignments).toHaveLength(EXPECTED.assignments);
    expect(new Set(assignments.map((a) => a.teamId)).size).toBe(EXPECTED.assignedTeams);
    // Teams on more than one slot: the case that once made the Edge count rows.
    const slotsPerTeam = new Map();
    for (const a of assignments) slotsPerTeam.set(a.teamId, (slotsPerTeam.get(a.teamId) ?? 0) + 1);
    expect([...slotsPerTeam.values()].filter((n) => n > 1)).toHaveLength(
      EXPECTED.teamsOnTwoOrMoreSlots
    );
    expect(teams.filter((t) => t.assistantCoachIds.length > 0)).toHaveLength(
      EXPECTED.teamsWithAssistants
    );
    // A real conflict, so "both arms found none" cannot pass as agreement.
    expect(extract.expected.coachConflicts).toHaveLength(EXPECTED.coachConflicts);
    // Some roster team is unplaced, so coverage is a real reading, not 100%.
    expect(extract.expected.summary.unassignedTeams).toBeGreaterThan(0);
  });

  it('no person key from the corpus is in the extract', () => {
    const text = JSON.stringify(extract).toLowerCase();
    const season = loadSeason2026();
    const keys = new Set(season.teams.flatMap((t) => [t.coachId, ...(t.assistantCoachIds ?? [])]));
    keys.delete(null);
    keys.delete(undefined);
    // Meta: the scan has keys to look for.
    expect(keys.size).toBeGreaterThan(100);
    // Anywhere, not only as a whole value: a key inside a longer string still leaks.
    for (const key of keys) expect(text.includes(key.toLowerCase()), key).toBe(false);
  });

  it('core gives the recorded answer', () => {
    expect(coreAgreedFields(extract.inputs)).toEqual(extract.expected);
  });

  it('the Edge engine gives the same answer', () => {
    expect(runEdge(extract.inputs)).toEqual(extract.expected);
  });

  it('the Deno arm reads the same extract, or this is not a cross-check', () => {
    const deno = readFileSync(path.join(REPO_ROOT, DENO_ARM), 'utf8');
    expect(deno).toContain('./fixtures/scoring-parity.season-2026.json');
    expect(deno).toContain(SCORING_PARITY_EXTRACT);
    // The same literals, so neither arm can quietly accept a smaller extract.
    for (const [name, value] of Object.entries(EXPECTED)) {
      expect(deno, name).toMatch(new RegExp(`\\b${name}: ${value},`));
    }
  });
});
