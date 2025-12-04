/**
 * Persist evaluation results to the database.
 *
 * @param {Object} params
 * @param {Object} params.supabaseClient
 * @param {Object} params.evaluationResult - Result from runScheduleEvaluations
 * @param {string} [params.runId] - Optional run ID to link
 * @param {string} [params.createdBy] - Optional user ID
 * @returns {Promise<Object>} Persisted record
 */
export async function persistEvaluation({
    supabaseClient,
    evaluationResult,
    runId,
    createdBy,
}) {
    if (!supabaseClient || typeof supabaseClient.from !== 'function') {
        throw new TypeError('supabaseClient is required');
    }
    if (!evaluationResult) {
        throw new Error('evaluationResult is required');
    }

    const { status, issues, practice, games } = evaluationResult;

    // Determine type based on what data is present
    let type = 'combined';
    if (practice && !games) type = 'practice';
    if (!practice && games) type = 'game';

    // Summarize metrics for quick querying
    const summary = {
        issueCount: issues.length,
        errorCount: issues.filter((i) => i.severity === 'error').length,
        warningCount: issues.filter((i) => i.severity === 'warning').length,
        practiceUnassigned: practice?.summary?.unassignedTeams ?? 0,
        gameUnscheduled: games?.unscheduled?.length ?? 0,
    };

    const payload = {
        run_id: runId,
        evaluation_type: type,
        status,
        summary,
        issues,
        details: { practice, games },
        created_by: createdBy,
    };

    const { data, error } = await supabaseClient
        .from('schedule_evaluations')
        .insert(payload)
        .select()
        .single();

    if (error) {
        throw new Error(`Failed to persist evaluation: ${error.message}`);
    }

    return data;
}
