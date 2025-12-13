/**
 * Maps a 'game' scheduler_run to the summary format expected by GameReadinessPanel.
 * 
 * @param {Object} run - The raw scheduler run from Supabase
 * @returns {Object} The mapped summary object with generatedAt and snapshot data
 */
export function mapSchedulerRunToGameSummary(run) {
    if (!run || !run.results) {
        return null;
    }

    // The 'results' column in the DB contains the full metrics object
    // returned by gameMetrics.js. This matches the structure of
    // gameReadinessSnapshot (excluding top-level generatedAt).
    const snapshot = run.results;

    // Lift the 'summary' property for easier access
    const gameSummary = snapshot.summary || {};

    // Use the run's completion timestamp as the generation time
    const generatedAt = run.completed_at || run.created_at;

    return {
        runId: run.id,
        generatedAt,
        gameSummary,
        gameReadinessSnapshot: snapshot
    };
}
