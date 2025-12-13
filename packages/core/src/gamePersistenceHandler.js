import {
    authorizePersistenceRequest,
    handlePersistenceRequest,
    persistSnapshotTransactional,
} from './persistenceHandler.js';
import { evaluateOverrides } from './utils/snapshot.js';

/**
 * Normalize the game snapshot to ensure a usable runId.
 */
const normalizeSnapshot = (snapshot) => ({
    ...snapshot,
    runId: snapshot.lastRunId ?? snapshot.runId ?? null,
});

/**
 * Authorize a game persistence request.
 */
export function authorizeGamePersistenceRequest(params) {
    return authorizePersistenceRequest({ ...params, runType: 'game' });
}

/**
 * Handle game persistence using the generic pipeline.
 */
export function handleGamePersistence({ snapshot, overrides, now }) {
    return handlePersistenceRequest({
        snapshot,
        overrides,
        now,
        snapshotNormalizer: normalizeSnapshot,
        overrideEvaluator: evaluateOverrides,
        successMessage: 'Snapshot validated. Ready for game persistence.',
    });
}

/**
 * Persist the game snapshot transactionally.
 */
export async function persistGameSnapshotTransactional(params) {
    const { snapshot, runMetadata = {} } = params;
    const { runId: snapshotRunId } = normalizeSnapshot(snapshot);
    const effectiveRunMetadata = { ...runMetadata, runId: runMetadata.runId ?? snapshotRunId };

    return persistSnapshotTransactional({
        ...params,
        runMetadata: effectiveRunMetadata,
        runType: 'game',
        rpcName: 'persist_game_schedule',
        // @ts-ignore
        transformPayload: ({ snapshot, runData }) => ({
            run_data: runData,
            assignments: snapshot.payload.assignmentRows,
        }),
    });
}
