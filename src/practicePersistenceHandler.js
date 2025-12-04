import {
    authorizePersistenceRequest,
    validateSnapshot,
    persistSnapshotTransactional,
} from './persistenceHandler.js';

/**
 * Authorize a practice persistence request.
 */
export function authorizePracticePersistenceRequest(params) {
    return authorizePersistenceRequest({ ...params, runType: 'practice' });
}

/**
 * Validate the practice persistence payload.
 */
export function handlePracticePersistence(params) {
    return validateSnapshot(params);
}

/**
 * Persist the practice snapshot transactionally.
 */
export async function persistPracticeSnapshotTransactional(params) {
    return persistSnapshotTransactional({
        ...params,
        runType: 'practice',
        rpcName: 'persist_practice_schedule',
    });
}
