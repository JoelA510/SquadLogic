# Epic: Registration Data (DATA)

**Summary**: Collecting and managing member data (Not payments).

## 1. Requirements
*   **Forms**: Custom fields for intake.
*   **Ingestion**: Import from CSV.
*   **No Payments**: Explicitly excluded.

## 2. Execution Plan (PRs)

| PR # | Branch | Scope | Description | Tests |
| :--- | :--- | :--- | :--- | :--- |
| **PR-17** | `feat/data-01-forms` | Form Builder | Schema for `intake_forms` and `fields`. | UI form rendering test. |
| **PR-18** | `feat/data-02-ingest` | Import | CSV Parser -> User Creation. | Mock CSV upload test. |
