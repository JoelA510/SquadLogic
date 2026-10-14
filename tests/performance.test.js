import { describe, it, expect } from 'vitest';
import { generateTeams } from '../packages/core/src/teamGeneration.js';

describe('Core Engine Performance Benchmarks', () => {
  const createMockPlayers = (count) => {
    return Array.from({ length: count }, (_, i) => ({
      id: `player_${i}`,
      firstName: `First${i}`,
      lastName: `Last${i}`,
      ageGroup: 'U10',
      skillRating: Math.floor(Math.random() * 5) + 1,
      buddyRequest: i % 10 === 0 ? `player_${i + 1}` : null,
    }));
  };

  const getPerformanceBudgetMs = () => {
    const override = Number(process.env.PERF_TEAM_GEN_MAX_MS);
    if (Number.isFinite(override) && override > 0) return override;

    // `npm run test:perf` runs this file alone (CI's Performance benchmark
    // step). It used to be detected from process.argv, but this code runs in a
    // Vitest worker whose argv names the worker, not the test file, so the
    // 3 s branch never applied. Workers inherit the environment.
    const isFocusedPerformanceRun = process.env.npm_lifecycle_event === 'test:perf';

    // Keep the focused benchmark strict. The aggregate Vitest suite runs many
    // worker files at once, so wall-clock timing includes CPU contention.
    // Never timed under coverage: v8's instrumentation slows this engine about
    // 9x (1.2 s to 10.9 s alone, 0.9-2.1 s to 20.0 s in CI's full run), so
    // `test:coverage` excludes this file and CI runs it alone as `test:perf`.
    if (isFocusedPerformanceRun) return 3000;
    return 10000;
  };

  it(
    'Team generation engine processes 1500 players within the configured budget',
    { timeout: getPerformanceBudgetMs() + 5000 },
    () => {
      const massivePlayerPool = createMockPlayers(1500);

      const config = {
        maxRosterSize: 12,
        minRosterSize: 10,
        targetTeams: 125,
      };

      const startTime = performance.now();

      const result = generateTeams({
        players: massivePlayerPool.map((p) => ({ ...p, division: 'U10' })),
        divisionConfigs: {
          U10: {
            id: 'U10',
            teamsCount: config.targetTeams,
            slotsPerWeek: config.targetTeams * 2,
            maxRosterSize: config.maxRosterSize,
            teamCountOverride: config.targetTeams,
          },
        },
      });

      const endTime = performance.now();
      const executionTime = endTime - startTime;

      console.log(`Execution time for 1500 players: ${executionTime}ms`);

      expect(executionTime).toBeLessThan(getPerformanceBudgetMs());
      expect(result.teamsByDivision['U10'].length).toBeGreaterThan(0);
    }
  );
});
