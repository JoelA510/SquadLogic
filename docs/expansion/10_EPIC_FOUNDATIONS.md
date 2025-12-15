# Epic: Foundations (FND)

**Summary**: Establish the bedrock for production quality. No feature work here, just tooling.

## 1. Requirements
*   **Must**: Have a reliable test runner (Vitest).
*   **Must**: Have consistent Linting/Formatting (ESLint/Prettier).
*   **Must**: Have a defined CI pipeline configuration (GitHub Actions).
*   **Must**: Have clear TypeScript/JSDoc type definitions for core entities.

## 2. Repo Mapping
*   `packages/core`: Standardize exports.
*   `tests/`: Ensure it's runnable.

## 3. Execution Plan (PRs)

| PR # | Branch | Scope | Description | Tests |
| :--- | :--- | :--- | :--- | :--- |
| **PR-01** | `feat/fnd-01-tooling` | CI/Lint/Test | Setup Vitest, ESLint, Prettier. Add `npm run test` and `npm run lint`. | Verify generic PASS on dummy test. |
| **PR-02** | `feat/fnd-02-types` | Types | Define JSDoc/TS types for `Organization`, `User`, `Event`, `Team` in `packages/core`. | N/A (Static check). |
| **PR-03** | `feat/fnd-03-utils` | Logging/Error | Create `Logger` and `AppError` classes in `packages/core`. | Unit tests for logger. |
