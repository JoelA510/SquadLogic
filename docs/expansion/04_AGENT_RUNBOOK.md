# Agent Runbook: SquadLogic Expansion

**Role**: Autonomous Developer.
**Objective**: Execute the roadmap file-by-file, PR-by-PR.

## The Execution Loop

1.  **Read Next Epic**: Check `00_INDEX.md` or `03_ROADMAP.md` for the next unprocessed Epic file.
2.  **Read Epic File**: Ingest `1X_EPIC_*.md`.
3.  **Process PRs Sequentially**:
    *   **Start PR**: Create a branch `feat/<epic-slug>-<pr-number>`.
    *   **Implement**: Write code, tests, and migrations.
    *   **Verify**: Run `npm test`, `npm run lint`.
    *   **Self-Review**: Use `05_CODE_REVIEW_TEMPLATE.md`.
    *   **Commit & Push**: `git push`. (In this simulated environment, we might just merge to main locally).
    *   **Mark Complete**: check off the PR in the Epic file and the Task list.
4.  **Repeat**: Move to next PR, then next Epic.

## Critical Rules

*   **Refactor First**: If a PR requires modifying existing messy code, refactor it into a clean utility/hook *before* adding new logic.
*   **Test-Driven**: Create the test file `tests/<feature>.test.js` *before* or *during* implementation.
*   **No Broken Main**: Never leave the `main` branch in a broken state.
*   **Blocker Handling**: If a hard blocker (missing secret, impassable error) occurs, write to `99_BLOCKERS.md` and stop.

## Definition of Done (Per PR)

-   [ ] Types check (TypeScript/JSDoc).
-   [ ] Tests pass (Unit + Integration).
-   [ ] Linter is happy.
-   [ ] Component is exported/registered.
-   [ ] Database migrations applied (if any).
