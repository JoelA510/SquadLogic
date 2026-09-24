import { describe, it, expect } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildPracticeApplyStatus,
  buildTeamsWithoutPracticeWarnings,
} from '../frontend/src/utils/practiceApplyStatus.js';

describe('buildPracticeApplyStatus (#64)', () => {
  it('says nothing beyond "applied" when nothing was replaced or kept', () => {
    assert.equal(buildPracticeApplyStatus({ supersededCount: 0, retainedManualCount: 0 }), null);
    assert.equal(buildPracticeApplyStatus({}), null);
  });

  it('keeps the metrics-unavailable wording the page used before', () => {
    assert.equal(
      buildPracticeApplyStatus({ metricsUnavailableReason: 'no teams' }),
      'Schedule applied. Readiness metrics were not computed for this run: no teams'
    );
  });

  it('reports what the save replaced and the manual rows it kept', () => {
    const message = buildPracticeApplyStatus({ supersededCount: 4, retainedManualCount: 1 });
    assert.match(message, /4 earlier practice assignment\(s\) were replaced/);
    assert.match(message, /1 manual assignment\(s\) for teams not in this schedule were kept/);
  });

  it('reports kept manual rows even when nothing was replaced', () => {
    assert.match(buildPracticeApplyStatus({ retainedManualCount: 2 }), /2 manual assignment/);
  });
});

describe('buildTeamsWithoutPracticeWarnings (#64)', () => {
  const rows = [
    { team_id: 't4', team_name: 'Team 4', had_prior_rows: true },
    { team_id: 't8', team_name: 'Team 8', had_prior_rows: false },
    { team_id: 't9', team_name: 'Team 9', had_prior_rows: true },
  ];
  const unassigned = [{ teamId: 't9', reason: 'no slot fits the coach availability' }];

  it('returns one warning per team, with the solver reason or "not in this schedule"', () => {
    expect(buildTeamsWithoutPracticeWarnings({ teamsWithoutPractice: rows, unassigned })).toEqual([
      {
        teamId: 't4',
        teamName: 'Team 4',
        message: 'not in this schedule; an earlier practice was removed',
      },
      { teamId: 't8', teamName: 'Team 8', message: 'not in this schedule' },
      {
        teamId: 't9',
        teamName: 'Team 9',
        message: 'no slot fits the coach availability; an earlier practice was removed',
      },
    ]);
  });

  it('is empty when every team has a practice, and tolerates a missing list', () => {
    expect(buildTeamsWithoutPracticeWarnings({ teamsWithoutPractice: [], unassigned })).toEqual([]);
    expect(buildTeamsWithoutPracticeWarnings({ teamsWithoutPractice: undefined })).toEqual([]);
  });
});
