import {
    authorizePersistenceRequest,
    validateSnapshot,
    persistSnapshotTransactional,
} from './persistenceHandler.js';

/**
 * Authorize a game persistence request.
 */
export function authorizeGamePersistenceRequest(params) {
    return authorizePersistenceRequest({ ...params, runType: 'game' });
}

/**
 * Validate the game persistence payload.
 */
export function handleGamePersistence(params) {
    return validateSnapshot(params);
}

/**
 * Persist the game snapshot transactionally.
 */
export async function persistGameSnapshotTransactional(params) {
    return persistSnapshotTransactional({
        ...params,
        runType: 'game',
        rpcName: 'persist_game_schedule',
    });
}
