# Refactor: Frontend Data Access & Cleanup

## Summary
This PR consolidates the frontend data access layer, introducing a centralized configuration and a standardized API client. It also removes legacy static sample files and refactors the `TeamPersistencePanel` for better maintainability.

## Changes

### 1. Centralized Configuration
- **New**: `src/config.js`
    - Centralizes `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `API_BASE_URL`.
    - Supports both Vite (`import.meta.env`) and Node.js (`process.env`) environments for seamless testing.

### 2. Standardized API Client
- **New**: `src/utils/apiClient.js`
    - A generic `ApiClient` class that handles:
        - Base URL normalization.
        - Authorization headers (Bearer token).
        - Error response parsing.
        - Fetch implementation injection (for testing).

### 3. Refactored Persistence Layer
- **Updated**: `src/utils/teamPersistenceClient.js`
    - Modified to use `ApiClient`.
    - Removed redundant fetch logic and environment variable checks.
- **Updated**: `src/components/TeamPersistencePanel.jsx`
    - Extracted sub-components: `PersistenceOverridesList` and `PersistenceHistoryList`.
    - Reduced file size and complexity.
    - Now uses `useTeamPersistence` hook.

### 4. Legacy Cleanup
- **Deleted**: `src/teamSummarySample.js`, `src/practiceReadinessSample.js`, `src/gameReadinessSample.js`, `src/teamPersistenceSample.js`.
- **New Hook**: `src/hooks/useTeamPersistence.js`
    - Fetches real run history from `scheduler_runs`, replacing static samples.
- **Updated**: `src/hooks/useDashboardData.js`
    - Removed static fallbacks; now relies entirely on dynamic hooks.

## Verification
- **Build**: `npx vite build` passed.
- **Tests**: `npm test` passed (191 tests).
    - Validated `teamPersistenceClient` mock fallback and error handling.
    - validated `ApiClient` JSON parsing resilience.
