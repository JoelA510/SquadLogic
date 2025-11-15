import { generateTeams } from '../src/teamGeneration.js';
import { schedulePractices } from '../src/practiceScheduling.js';
import { evaluatePracticeSchedule } from '../src/practiceMetrics.js';
import { generateRoundRobinWeeks, scheduleGames } from '../src/gameScheduling.js';
import { generateScheduleExports } from '../src/outputGeneration.js';

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
if (typeof generateRoundRobinWeeks !== 'function') {
  throw new Error('generateRoundRobinWeeks export is missing');
}
if (typeof scheduleGames !== 'function') {
  throw new Error('scheduleGames export is missing');
}
if (typeof generateScheduleExports !== 'function') {
  throw new Error('generateScheduleExports export is missing');
}

console.log('Core scheduling modules ready for integration.');
