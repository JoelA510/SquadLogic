# PR Request: Persistence, Output Generation, Evaluation Pipeline, and Core Refactoring

## 1. High Level Summary
This PR implements the core integration features for the SquadLogic application, completing the "Persistence", "Output Generation", and "Evaluation Pipeline" phases of the roadmap. Additionally, it includes a significant refactoring effort to modularize the codebase, extract shared utilities, and standardize persistence logic using atomic RPCs.

## 2. Type of Change
- [x] New Feature (non-breaking change which adds functionality)
- [ ] Bug Fix (non-breaking change which fixes an issue)
- [x] Refactor (non-breaking change which improves code quality)
- [ ] Documentation Update
- [ ] Breaking Change (fix or feature that would cause existing functionality to not work as expected)

## 3. Detailed Changes
### Persistence
-   **Practice Persistence**: Implemented full stack (Snapshot -> Handler -> API -> Edge Function) for persisting practice assignments. Added `PracticePersistencePanel` to the dashboard.
-   **Game Persistence**: Implemented full stack for persisting game assignments. Added `GamePersistencePanel` to the dashboard.
-   **Team Persistence**: Standardized `teamPersistenceHandler.js` to use a new atomic RPC `persist_team_schedule`, removing legacy transaction logic.
-   **Edge Functions**: Wired up `practice-persistence` and `game-persistence` functions.

### Output Generation
-   **CSV Exports**: Implemented `OutputGenerationPanel` to trigger client-side CSV generation for Master and Per-Team schedules.
-   **Storage Integration**: Added `src/storageSupabase.js` to handle uploading generated files to the `exports` Supabase Storage bucket.

### Evaluation Pipeline
-   **Schema**: Added `supabase/migrations/20251204100000_evaluation_schema.sql` to create the `schedule_evaluations` table.
-   **Persistence**: Added `src/evaluationPersistence.js` to save evaluation snapshots.
-   **UI**: Added `EvaluationPanel` to the dashboard for real-time health checks and snapshot saving.

### Refactoring & Standardization
-   **Utils Extraction**: Created shared utility modules to reduce duplication and improve maintainability:
    -   `src/utils/normalization.js`: Common data normalization functions.
    -   `src/utils/validation.js`: Shared validation logic for slots, teams, and assignments.
    -   **[NEW]** `src/utils/snapshot.js`: Shared snapshot processing and run metadata derivation.
    -   **[NEW]** `src/utils/date.js`: Centralized date and time manipulation utilities.
-   **Consumer Updates**: Refactored all consumers (`*Supabase.js`, `*Metrics.js`, `*Scheduling.js`, `*PersistenceSnapshot.js`) to use these new shared utilities.
-   **RPC Migration**: Created `supabase/migrations/20251206000000_team_persistence_rpc.sql` to support atomic team persistence.

### Code Review Fixes (PR #135)
-   **SQL Correctness**:
    -   Fixed `persist_practice_schedule` RPC to use correct table `practice_assignments` and columns (`practice_slot_id`, `effective_date_range`).
    -   Fixed `persist_game_schedule` RPC to use correct table `games` and columns (`game_slot_id`).
    -   Fixed `persist_team_schedule` RPC to remove invalid `season_settings_id` column from `teams` insert.
-   **Bug Fixes**:
    -   Fixed `ReferenceError` in `practiceSlotExpansion.js` (`slot.id` -> `slotId`).
-   **Frontend Quality**:
    -   Refactored `PersistencePanel.jsx` to use a theme configuration object and static Tailwind grid classes.
    -   Extracted Supabase auth header logic into `frontend/src/utils/authHeaders.js`.
    -   Added TODO in `OutputGenerationPanel.jsx` regarding Web Worker usage for large datasets.

### Dashboard
-   **Integration**: Updated `frontend/src/App.jsx` to include all new panels (`PracticePersistencePanel`, `GamePersistencePanel`, `OutputGenerationPanel`, `EvaluationPanel`), providing a complete admin workflow.

## 4. Verification
-   **Automated Tests**: Added and verified comprehensive unit tests for all new utilities and refactored handlers. **177 tests passing**.
-   **Manual Verification**: Verified that all new components render correctly in the dashboard. Verified that helper functions produce expected payloads.
-   **Schema**: Verified the new migration file syntax.

## 5. Screenshots (Optional)
N/A - Backend/Integration focus.

## 6. Related Tickets/Issues
-   Roadmap Items: Persistence, Output Generation, Evaluation Pipeline.
-   Refactoring: Modularization and Standardization.
