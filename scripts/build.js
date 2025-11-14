import { generateTeams } from '../src/teamGeneration.js';
import { schedulePractices } from '../src/practiceScheduling.js';
import { evaluatePracticeSchedule } from '../src/practiceMetrics.js';

// Lightweight build placeholder that ensures the module can be imported without executing tests.
if (typeof generateTeams !== 'function') {
  throw new Error('generateTeams export is missing');
}
if (typeof schedulePractices !== 'function') {
  throw new Error('schedulePractices export is missing');
}
if (typeof evaluatePracticeSchedule !== 'function') {
  throw new Error('evaluatePracticeSchedule export is missing');
}

console.log('Core scheduling modules ready for integration.');
