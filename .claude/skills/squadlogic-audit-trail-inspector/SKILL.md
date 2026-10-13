---
name: squadlogic-audit-trail-inspector
description: Use when reading or reviewing the organization settings audit trail (feature flag and settings changes) for anomalies, or changing how it is recorded or shown. Covers audit_log, the get_settings_audit_log RPC, the SettingsAuditLog page, and what each row carries.
---

<!-- Claude Code's copy of .agents/skills/squadlogic-audit-trail-inspector/SKILL.md, kept by hand: this is one of the repository's own skills. Edit the .agents/ file and carry the same change into this one. -->

# SquadLogic Audit Trail Inspector

How to read the settings audit trail and spot configuration anomalies.

## Where things are

- Table: `audit_log` (`organization_id`, `user_id`, `action`, `resource_type`, `resource_id`,
  `metadata`, `created_at`). Rows are written by `record_audit_event`, which the admin RPCs call
  and some client code calls directly (`supabase.rpc('record_audit_event', …)`).
- Read RPC: `get_settings_audit_log(p_organization_id)` (admin-only), defined in
  `supabase/migrations/20260403000000_settings_audit_rpc.sql`. It returns the organization's
  `settings.updated` and `feature_flags.updated` rows, newest first, each with `actor_name` and
  `actor_email` joined from `profiles`.
- UI: `frontend/src/components/settings/SettingsAuditLog.jsx`, which filters by `action` and
  searches the metadata and actor.
- A flag change (`update_org_feature_flags`) records `metadata = { field: 'feature_flags',
  old: <flags before>, new: <flags after> }`.

## Inspecting

1. Read the rows through the RPC (as an organization admin), never with a service-role query
   that skips the admin check.
2. For each `feature_flags.updated` row, compare `metadata.old` with `metadata.new` to see
   which flags changed.
3. Check the actor (`actor_name`, `actor_email`) against the organization's admins.
4. Report what you can show from the rows: who changed what and when. Say so when a row's
   metadata lacks `old` or `new`; don't infer the change.

## Anomalies worth reporting

- **Flip-flopping:** the same flag enabled and disabled repeatedly in a short period.
- **An unexpected actor:** a change by someone who is not, or is no longer, an admin.
- **A gap:** a setting that differs from what the trail's last row says; every configuration
  change must write a row (AGENTS.md §3, Audit Immutability).

## Practices

- The trail is read-only: nothing edits or deletes `audit_log` rows.
- Keep search and filters in the UI covering both `action` and actor.
