import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { buildPracticeApplyStatus } from '../frontend/src/utils/practiceApplyStatus.js';

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
