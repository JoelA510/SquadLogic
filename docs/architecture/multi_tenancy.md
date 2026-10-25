[← Back to Documentation Index](docs/README.md)
---

# Multi-Tenancy Implementation

## Overview

SquadLogic implements a fully enforced multi-tenant architecture supporting multiple youth sports organizations within a single deployment. Data isolation is guaranteed at the database level via Row Level Security policies on every table.

## Data Partitioning

- **Primary key**: `organization_id` (UUID) on all data tables
- **Hierarchy**: Organization → Season → Division → Team → Player/Coach
- **Enforcement**: The `is_org_member(organization_id)` SQL function validates that the authenticated user has a membership record in the `organization_members` table for the specified organization

All tables that previously relied on implicit scoping (e.g., through JOINs to parent tables) have been denormalized with a direct `organization_id` column during the security remediation (migration `20260310000002`).

## Authentication & Authorization

- **Auth Provider**: Supabase Auth (email/password, magic link)
- **Membership**: Users are linked to organizations via the `organization_members` table with a role (`admin`, `coach`, `staff`, or `tenant_admin`; no `parent` or `player` since `20261024010000`)
- **RLS Enforcement**: Every table has a `USING (is_org_member(organization_id))` policy — there is no cross-org data access even for admin users
- **Edge Functions**: Validate both JWT authenticity and organization membership before any write operation
- **Frontend**: `OrganizationContext` manages the active org selection, backed by `organization_members` queries. The active org is cached in `localStorage` as a preference (not as an auth token) and validated against the user's membership list on load

## Organization Schema

```sql
CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    contact_info JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

## Context Switching

Users who belong to multiple organizations can switch between them via the TopBar org/season switchers. On context switch:

1. `OrganizationContext` updates the active org in state and `localStorage`
2. All data hooks re-fetch with the new `organization_id` filter
3. Supabase RLS ensures only the target org's data is returned

## Security Safeguards

- **Strict RLS**: Every query is automatically filtered by organization — no opt-in required
- **Service Role Minimization**: Edge Functions use per-request scoped clients (user's JWT), not the service role key, for data queries
- **Defense in Depth**: Organization ID is validated at three layers — RLS policies (database), Edge Function handlers (server), and React context guards (client)
- **Audit Logging**: All admin actions are recorded in the `audit_log` table with `organization_id` for traceability

See `docs/security/rls-policies.md` for the complete RLS policy reference.

## Zero-to-One Onboarding Flow

To support self-serve registration, organizations can be initialized dynamically via the `initialize_new_tenant` RPC. 

- **Frontend Interception**: When a user logs in and the `OrganizationContext` determines they have an empty `organizations` array, the frontend router (`App.jsx`) intercepts the navigation and renders the `OrganizationCreation` component.
- **RPC `initialize_new_tenant`**: A single transaction creating a new record in `organizations`, assigning the calling user (`auth.uid()`) as an `admin`, and initialized the first `season_settings` entry.
- **Security**: The RPC is defined with `SECURITY DEFINER` constraints but explicitly checks `auth.uid()` to ensure safe self-provisioning. Upon successful initialization, the application reloads context to seamlessly authenticate the user within their new tenant. This mechanism provides a frictionless zero-to-one organization assignment.
