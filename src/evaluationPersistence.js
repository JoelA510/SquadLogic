/**
 * Persist evaluation results to the database.
 * Matches schema: evaluation_runs, evaluation_findings
 *
 * @param {Object} params
 * @param {Object} params.supabaseClient
 * @param {Object} params.evaluationResult - Result from runScheduleEvaluations
 * @param {string} [params.runId] - Optional scheduler run ID to link
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

    // Determine run type based on what data is present
    let type = 'composite';
    if (practice && !games) type = 'practice';
    if (!practice && games) type = 'game';

    // Map internal status (ok, attention-needed, action-required) 
    // to DB status (queued, running, completed, completed_with_warnings, failed)
    let dbStatus = 'completed';
    if (status !== 'ok') {
        dbStatus = 'completed_with_warnings';
    }

    // Summarize metrics
    const summary = {
        finalStatus: status, // Keep original status in metrics
        issueCount: issues.length,
        errorCount: issues.filter((i) => i.severity === 'error').length,
        warningCount: issues.filter((i) => i.severity === 'warning').length,
        practiceUnassigned: practice?.summary?.unassignedTeams ?? 0,
        gameUnscheduled: games?.unscheduled?.length ?? 0,
    };

    // 1. Insert Run
    const { data: runData, error: runError } = await supabaseClient
        .from('evaluation_runs')
        .insert({
            scheduler_run_type: type,
            scheduler_run_id: runId || null,
            status: dbStatus,
            findings_severity: findingsSeverity,
            metrics_summary: summary,
            // We store a lightweight flag of what was analyzed, not the full massive snapshot
            input_snapshot: {
                hasPractice: !!practice,
                hasGames: !!games,
                generatedAt: evaluationResult.generatedAt
            },
            created_by: createdBy
        })
        .select()
        .single();

    if (runError) {
        throw new Error(`Failed to insert evaluation_runs: ${runError.message}`);
    }

    const evaluationRunId = runData.id;

    // 2. Insert Findings (if any)
    if (issues.length > 0) {
        const findingsPayload = issues.map((issue) => ({
            evaluation_run_id: evaluationRunId,
            severity: issue.severity === 'error' ? 'error' : 'warning',
            finding_code: issue.category, // Use category as a rough code
            description: issue.message,
            affected_entities: issue.details ? [issue.details] : []
        }));

        const { error: findingsError } = await supabaseClient
            .from('evaluation_findings')
            .insert(findingsPayload);

        if (findingsError) {
            // Re-throwing the error ensures the operation is atomic. The UI will
            // catch this and notify the user that the save failed, preventing
            // a partial-success state with inconsistent data.
            throw new Error(`Failed to persist evaluation findings: ${findingsError.message}`);
        }
    }

    return runData;
}
