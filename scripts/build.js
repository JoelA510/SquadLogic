import { generateTeams } from '../src/teamGeneration.js';

// Lightweight build placeholder that ensures the module can be imported without executing tests.
if (typeof generateTeams !== 'function') {
  throw new Error('generateTeams export is missing');
}

console.log('Team generation module ready for integration.');
