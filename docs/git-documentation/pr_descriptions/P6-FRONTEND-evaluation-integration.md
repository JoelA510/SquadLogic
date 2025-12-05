# P6: Frontend Evaluation Pipeline Integration

## PR Type
- [x] Feature
- [ ] Bugfix
- [ ] Refactor
- [ ] Documentation
- [ ] Other

## Description
This PR integrates the **Evaluation Pipeline** into the frontend admin dashboard. It specifically enables the **EvaluationPanel** to persist schedule evaluations (readiness scores, warnings, and error lists) to Supabase. This completes the "data refinement loop" where an admin can review the generated schedule and save the quality metrics.

### Key Changes
1.  **Frontend Integration**:
    *   Updated `App.jsx` to pass the authorized `supabase` client to `EvaluationPanel.jsx`. This was the missing link preventing the "Save Snapshot" button from working.
    
2.  **Persistence Logic Fix**:
    *   Refactored `src/evaluationPersistence.js`. The original implementation attempted to write to a non-existent `schedule_evaluations` table (a relic of an old schema draft).
    *   Updated the code to correctly write to the live schema tables:
        *   `evaluation_runs`: Stores the high-level run metadata, status, and summary metrics.
        *   `evaluation_findings`: Stores individual issues (warnings/errors) related to that run.
    *   Ensured correct mapping of frontend "status" (ok/attention-needed) to database "status" (completed/completed_with_warnings).

## Testing Plan
### Automated Tests
- `npx vite build` passed successfully, confirming no breaking syntax errors or missing imports.

### Manual Verification
1.  **Start App**: `npm run frontend:dev` (with local Supabase or mock).
2.  **Navigate**: Scroll to the Evaluation Panel in the dashboard.
3.  **Check Status**: Verify it shows "Ready" or "Warnings" based on the current schedule state (derived from practice/game inputs).
4.  **Save Snapshot**: Click "Save Snapshot".
5.  **Verify DB**: (If connected to live Supabase) Check `evaluation_runs` table for a new row with `metrics_summary` populated, and `evaluation_findings` for specific issues.

## Checklist
- [x] Code follows the project's style guidelines.
- [x] `App.jsx` restored and verified.
- [x] Persistence logic matches `initial_schema.sql`.
- [x] Build passes.

## Related Issues/Tasks
- Closes Task: "Integrate Evaluation Pipeline"
- Updates `roadmap.md` section 7.
