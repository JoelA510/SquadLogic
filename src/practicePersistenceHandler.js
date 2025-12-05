import {
    authorizePersistenceRequest,
    handlePersistenceRequest,
    persistSnapshotTransactional,
} from './persistenceHandler.js';
import { evaluateOverrides } from './utils/snapshot.js';

/**
 * Normalize the practice snapshot to ensure a usable runId.
 */
const normalizeSnapshot = (snapshot) => ({
    ...snapshot,
    runId: snapshot.lastRunId ?? snapshot.runId ?? null,
});

/**
 * Authorize a practice persistence request.
 */
export function authorizePracticePersistenceRequest(params) {
    return authorizePersistenceRequest({ ...params, runType: 'practice' });
}

/**
 * Handle practice persistence using the generic pipeline.
 */
export function handlePracticePersistence({ snapshot, overrides, now }) {
    return handlePersistenceRequest({
        snapshot,
        overrides,
        now,
        snapshotNormalizer: normalizeSnapshot,
        overrideEvaluator: evaluateOverrides,
        successMessage: 'Snapshot validated. Ready for practice persistence.',
    });
}

/**
 * Persist the practice snapshot transactionally.
 */
export async function persistPracticeSnapshotTransactional(params) {
    const { snapshot, runMetadata = {} } = params;
    const { runId: snapshotRunId } = normalizeSnapshot(snapshot);
    const effectiveRunMetadata = { ...runMetadata, runId: runMetadata.runId ?? snapshotRunId };

    return persistSnapshotTransactional({
        ...params,
        runMetadata: effectiveRunMetadata,
        runType: 'practice',
        rpcName: 'persist_practice_schedule',
    });
}
