# Multi-Tenancy Strategy

## Overview
SquadLogic is designing a multi-tenant architecture to support multiple youth sports organizations within a single deployment. This document outlines the strategy for data partitioning, security, and migration.

## Core Concepts

### 1. Data Partitioning
*   **Organization ID**: The primary key for partitioning is `organization_id` (UUID).
*   **Table Structure**: Key tables (`season_settings`, `teams`, `players` via seasons) will eventually be linked to an `organization_id`.
*   **Hierarchy**:
    *   Organization -> Season -> Division -> Team -> Player/Coach

### 2. Authentication & Authorization
*   **JWT Claims**: Future authentication tokens will include an `organization_id` claim.
*   **Row Level Security (RLS)**:
    *   Policies will enforce `organization_id` matching.
    *   Example: `auth.jwt() ->> 'organization_id' = organization_id::text`

### 3. Current State (Transitional)
*   **Centralized Admin**: Currently, internal admins manage all data.
*   **Implicit Partitioning**: Data is naturally segmented by `Season`. Coaches only see teams they are assigned to, preventing cross-org data leakage validly but implicitly.

## Migration Path

### Phase 1: Schema Preparation (Current)
*   Create `organizations` table.
*   Add `organization_id` to `season_settings` (nullable).

### Phase 2: Data Backfill
*   Create a "Default Organization" for existing data.
*   Update all existing `season_settings` to point to this default org.
*   Make `organization_id` NOT NULL.

### Phase 3: Explicit Enforcement
*   Update RLS policies to strictly require `organization_id` checks for non-admin users.
*   Introduce `organization_id` into the invitation/auth flow for new users.

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

## Security Considerations
*   **Strict RLS**: Ensure every query explicitly filters by organization.
*   **Service Role**: Minimize use of `service_role` to avoid bypassing org checks accidentally.
*   **Cross-Org Access**: If a user belongs to multiple organizations, the JWT handling needs to support switching contexts or carrying multiple claims.
