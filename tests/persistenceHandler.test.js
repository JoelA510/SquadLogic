import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authorizePersistenceRequest } from '../src/persistenceHandler.js';
import { PERSISTENCE_STATUS } from '../src/constants.js';

describe('authorizePersistenceRequest', () => {
    it('returns UNAUTHORIZED if no user is provided', () => {
        const result = authorizePersistenceRequest({ user: null });
        assert.equal(result.status, PERSISTENCE_STATUS.UNAUTHORIZED);
        assert.match(result.message, /Authentication required/);
    });

    it('returns FORBIDDEN if user role is not allowed (default allowed roles)', () => {
        const user = { role: 'authenticated', app_metadata: { role: 'player' } };
        // DEFAULT_ALLOWED_ROLES is ['admin', 'scheduler']
        const result = authorizePersistenceRequest({ user });
        assert.equal(result.status, PERSISTENCE_STATUS.FORBIDDEN);
        assert.match(result.message, /not authorized/);
    });

    it('returns AUTHORIZED if user role is allowed (admin)', () => {
        const user = { role: 'authenticated', app_metadata: { role: 'admin' } };
        const result = authorizePersistenceRequest({ user });
        assert.equal(result.status, 'authorized');
        assert.equal(result.message, undefined);
    });

    it('returns AUTHORIZED if user role is allowed (scheduler)', () => {
        const user = { role: 'authenticated', app_metadata: { role: 'scheduler' } };
        const result = authorizePersistenceRequest({ user });
        assert.equal(result.status, 'authorized');
    });

    it('respects custom allowed roles', () => {
        const user = { role: 'authenticated', app_metadata: { role: 'coach' } };
        const result = authorizePersistenceRequest({
            user,
            allowedRoles: ['coach'],
            runType: 'practice'
        });
        assert.equal(result.status, 'authorized');
    });

    it('returns FORBIDDEN if user role matches allowedRoles but user has different role', () => {
        const user = { role: 'authenticated', app_metadata: { role: 'parent' } };
        const result = authorizePersistenceRequest({
            user,
            allowedRoles: ['coach'],
            runType: 'practice'
        });
        assert.equal(result.status, PERSISTENCE_STATUS.FORBIDDEN);
    });
});
