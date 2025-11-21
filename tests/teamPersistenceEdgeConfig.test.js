import assert from 'node:assert';
import { describe, it } from 'node:test';
import { DEFAULT_ALLOWED_ROLES, parseAllowedRolesEnv } from '../src/teamPersistenceEdgeConfig.js';

describe('parseAllowedRolesEnv', () => {
  it('returns default roles when value is undefined', () => {
    const roles = parseAllowedRolesEnv(undefined);
    assert.deepStrictEqual(roles, DEFAULT_ALLOWED_ROLES);
  });

  it('normalizes comma-separated roles', () => {
    const roles = parseAllowedRolesEnv('Admin, Scheduler ,  CoAcH');
    assert.deepStrictEqual(roles, ['admin', 'scheduler', 'coach']);
  });

  it('throws when no roles remain after normalization', () => {
    assert.throws(() => parseAllowedRolesEnv(','), /at least one allowed role is required/);
  });

  it('throws for non-string/array inputs', () => {
    assert.throws(() => parseAllowedRolesEnv(42), /comma-separated string or array/);
  });
});
