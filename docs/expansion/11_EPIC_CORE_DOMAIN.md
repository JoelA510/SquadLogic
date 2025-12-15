# Epic: Core Domain (CORE)

**Summary**: Implement the core database schema and security policies.

## 1. Requirements
*   **Multi-tenancy**: Data strictly isolated by `organization_id`.
*   **Users**: Unified auth with profile data.
*   **Context**: frontend `AuthProvider` and `OrganizationProvider`.

## 2. Data Model
*   Table `organizations`: valid, settings.
*   Table `profiles`: linked to `auth.users`.
*   Table `organization_members`: links Profile <-> Org with Role.

## 3. Execution Plan (PRs)

| PR # | Branch | Scope | Description | Tests |
| :--- | :--- | :--- | :--- | :--- |
| **PR-04** | `feat/core-01-schema` | DB Schema | create `profiles`, `organization_members` tables + RLS policies. | [x] Test RLS with distinct users. |
| **PR-05** | `feat/core-02-auth` | Frontend | Update `AuthProvider` to fetch Profile. Create `OrganizationProvider`. | [x] Integration test: Login -> Load Org. |
| **PR-06** | `feat/core-03-roles` | Permissions | Implement `usePermission` hook based on Role. | Unit test hook logic. |
