# PR Request: Persistence, Output Generation, and Evaluation Pipeline

## 1. High Level Summary
This PR implements the core integration features for the SquadLogic application, completing the "Persistence", "Output Generation", and "Evaluation Pipeline" phases of the roadmap. It enables the application to persist generated schedules to Supabase, generate and upload CSV exports, and track schedule evaluation metrics over time.

## 2. Type of Change
- [x] New Feature (non-breaking change which adds functionality)
- [ ] Bug Fix (non-breaking change which fixes an issue)
- [ ] Refactor (non-breaking change which improves code quality)
- [ ] Documentation Update
- [ ] Breaking Change (fix or feature that would cause existing functionality to not work as expected)

## 3. Detailed Changes
### Persistence
-   **Practice Persistence**: Implemented full stack (Snapshot -> Handler -> API -> Edge Function) for persisting practice assignments. Added `PracticePersistencePanel` to the dashboard.
-   **Game Persistence**: Implemented full stack for persisting game assignments. Added `GamePersistencePanel` to the dashboard.
-   **Edge Functions**: Wired up `practice-persistence` and `game-persistence` functions.

### Output Generation
-   **CSV Exports**: Implemented `OutputGenerationPanel` to trigger client-side CSV generation for Master and Per-Team schedules.
-   **Storage Integration**: Added `src/storageSupabase.js` to handle uploading generated files to the `exports` Supabase Storage bucket.

### Evaluation Pipeline
-   **Schema**: Added `supabase/migrations/20251204100000_evaluation_schema.sql` to create the `schedule_evaluations` table.
-   **Persistence**: Added `src/evaluationPersistence.js` to save evaluation snapshots.
-   **UI**: Added `EvaluationPanel` to the dashboard for real-time health checks and snapshot saving.

### Dashboard
-   **Integration**: Updated `frontend/src/App.jsx` to include all new panels (`PracticePersistencePanel`, `GamePersistencePanel`, `OutputGenerationPanel`, `EvaluationPanel`), providing a complete admin workflow.

## 4. Verification
-   **Manual Verification**: Verified that all new components render correctly in the dashboard. Verified that helper functions produce expected payloads.
-   **Schema**: Verified the new migration file syntax.

## 5. Screenshots (Optional)
N/A - Backend/Integration focus.

## 6. Related Tickets/Issues
-   Roadmap Items: Persistence, Output Generation, Evaluation Pipeline.
