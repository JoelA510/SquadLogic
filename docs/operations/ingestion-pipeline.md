[← Back to Documentation Index](../README.md)

---

> [!NOTE]
> **Implementation Status: PARTIAL** — team import promotion remains v1.1 scope.
> The June 2026 redesign expanded the player finalize mapping (migration
> `20260611000200`): years played, tri-state payment status, waitlist (gated by
> the org's `waitlist` feature flag), Guardian 1/2 → `guardian_contacts` (no
> longer: R0 stopped storing guardians and R4, `20261025010000`, dropped the
> column), and gendered `U{n}B`/`U{n}G` division derivation honoring the org `gender_model`,
> with season-scoped division auto-creation.
>
> The validation and player-promotion slice of the ingestion pipeline has been
> implemented. Key implementation differences from the original design:
>
> - CSV parsing uses **PapaParse** (not `@fast-csv/parse`)
> - Client-side validation is in `ImportContext.jsx`; server-side validation is in the `import-validation` Edge Function
> - Valid player rows are staged in `staging_players` with source row numbers and promoted by `finalize_import_job(uuid, jsonb)` into `players`
> - Player-import coach volunteer rows no longer create interested coach leads (R0 stopped the capture; R4, `20261025010000`, dropped its RPCs and table); reciprocal player-import buddy requests are materialized into `player_buddies`; coach CSV and field-slot CSV imports now have durable validate-only, apply, cancel, and rollback RPC-backed flows, while team promotion remains pending v1.1 follow-up work
> - Header matching uses a strict alias map (not fuzzy `.includes()`)
> - Testing uses **Vitest** (not Jest)
> - File size enforcement (10 MB) is implemented both client-side and via Supabase Storage policy

# Data Ingestion Pipeline Specification

This document expands on the roadmap tasks for importing GotSport registrations and facility availability spreadsheets. It provides a step-by-step plan for implementing resilient ingestion tooling that writes normalized records into Supabase while giving the league administrator quick feedback when files contain issues.

## 1. Registration Import Flow

### 1.1 Upload Interface

- **Entry point**: Admin UI page labelled "Data Import" with an upload drop zone for GotSport CSV exports.
- **Accepted formats**: `.csv` files encoded as UTF-8 with headers; reject Excel files and provide guidance to export as CSV first.
- **Validation prior to upload**:
  - Ensure the file size is below 10 MB (covers ~15k rows comfortably).
  - Confirm the header row contains required columns (`First Name`, `Last Name`, `Division`, `Buddy`, `Coach Volunteer`, etc.).
  - Display a summary of detected divisions and player counts before submission.

### 1.2 Serverless Processing

1. Upload the raw CSV to Supabase Storage under `imports/registrations/<uuid>.csv` with metadata referencing the user id.
2. Invoke the `import-validation` Edge Function with parsed rows and a generated `import_job_id`.
3. Inside the function:
   - Validate and sanitize chunked rows received from the browser.
   - Normalize guardian contacts into a JSON array (`[{ name, email, phone, primary }]`).
   - Build a map of `mutual_buddy_code → [playerIds]` to quickly detect reciprocal pairs.
   - For each row, stage inserts into a staging table `staging_players` that includes the `import_job_id` to handle concurrent jobs, with raw values and validation flags.

### 1.3 Validation Rules

- **Division mapping**: Use the `divisions` table to resolve `division_id`; record a validation error when the division name is unknown.
- **Duplicate detection**: Flag rows where `external_registration_id` already exists for the season.
- **Buddy reciprocity**: Mark buddy codes that appear only once so the admin can review them later.
- **Contact quality**: Require at least one guardian email or phone number.
- **Coach volunteer linkage**: When `Coach Volunteer = yes`, resolve guardian/parent contact fields and create or reuse a `coaches` row with status `interested`; link the lead to the org-scoped division/player when those ids can be resolved.

### 1.4 Commit Phase

1. If rows fail validation, keep row errors in `import_jobs.error_summary` and finish as `completed_with_warnings` when at least one valid player row is promoted.
2. When validation completes:
   - Call `finalize_import_job(import_job_id, validation_errors)` to promote staged player rows into `players` in one transaction.
   - Use GotSport/external registration id as the preferred player match key. Rows without an external id are still promoted once per import job.
   - Mark promoted staging rows with `promoted_at` / `promoted_by` so re-running finalization for the same job does not duplicate players.
   - Store promotion counts in `import_jobs.warning_summary.finalize` and mark the import job `completed` or `completed_with_warnings`.
3. For player imports, call `materialize_import_buddy_pairs` after finalization. The RPC creates mutual directional `player_buddies` rows only when imported players reciprocally reference each other by external registration id or share an exactly two-player mutual buddy code; unmatched, self, non-reciprocal, and cross-division requests are preserved as warning metadata.
4. (Removed.) Player imports no longer capture coach leads: `upsert_coach_leads` and its table were dropped by `20261025010000`; the player's `willing_to_coach` flag is the coaching lead.
5. Coach CSV and field-slot imports use dedicated validate-only, apply, cancel, and rollback RPCs backed by `staging_import_rows`, `import_jobs.warning_summary.deferred_apply`, and `import_application_records`.
6. Chunked validation writes `last_heartbeat_at`, `processed_rows`, and `progress_percent`; `/import` calls `fail_stale_import_jobs` before rehydrating active work so interrupted browser-driven imports fail cleanly for retry.
7. Pending follow-up: team creation.

### 1.4.1 Production RPC Readiness Check

Browser-driven imports depend on PostgREST exposing the import lifecycle RPCs.
If production shows errors such as `Could not find the function
public.create_import_job(...)`, verify that these migrations have been applied
in order:

```text
supabase/migrations/20260502000000_import_finalize_pipeline.sql
supabase/migrations/20260503000000_secure_coach_lead_scoping.sql
supabase/migrations/20260503080000_player_import_buddy_materialization.sql
supabase/migrations/20260503090000_import_deferred_apply_status.sql
supabase/migrations/20260503100000_import_stale_job_cleanup.sql
supabase/migrations/20260504080000_import_job_lifecycle_rpcs.sql
```

The migrations above must be applied in chronological order. The deferred-apply
status migration (`20260503090000`) must precede the lifecycle RPC migration
(`20260504080000`) because `create_import_job`, `update_import_job_progress`,
`fail_import_job`, `mark_import_job_ready_to_apply`, and `cancel_ready_import_job`
insert or update `import_jobs.status` values including `importing`,
`ready_to_apply`, and `failed`. Finalization (`finalize_import_job`) and buddy
materialization (`materialize_import_buddy_pairs`) come from the earlier
`20260502000000` and `20260503080000` migrations and must also be present before
a player import can finish. (The coach-lead RPCs from `20260503000000` were
dropped by `20261025010000`.)

Run this SQL against the target Supabase database to confirm every import
lifecycle RPC signature is present (each row should report `present = true`):

```sql
select fn, to_regprocedure('public.' || fn) is not null as present
from unnest(array[
  'fail_stale_import_jobs(uuid,timestamptz)',
  'create_import_job(uuid,text,text)',
  'update_import_job_progress(uuid,integer,integer,integer,jsonb)',
  'mark_import_job_ready_to_apply(uuid,text,jsonb)',
  'cancel_ready_import_job(uuid,text)',
  'fail_import_job(uuid,text,jsonb)',
  'finalize_import_job(uuid,jsonb)',
  'materialize_import_buddy_pairs(uuid)'
]) as fn
order by fn;
```

After applying missing migrations, reload the PostgREST schema cache so RPC
discovery sees the new functions:

```sql
notify pgrst, 'reload schema';
```

**Deployment order (prevents recurrence).** Apply the import lifecycle
migrations _before_ deploying any frontend bundle that calls these RPCs —
otherwise the browser issues `POST /rest/v1/rpc/create_import_job` against a
database that has not yet defined it and PostgREST returns
`404 Could not find public.create_import_job(...) in the schema cache`.

- **Preferred:** run `supabase db push --linked` against the production project
  before the Vercel frontend deploy, then confirm with the readiness query above.
- **Emergency (SQL Editor):** paste the full migration files listed above in
  chronological order, then run `notify pgrst, 'reload schema';`.
- **Migration history:** if you applied SQL by hand, only run
  `supabase migration repair --status applied <version>` _after_ the readiness
  query confirms the functions actually exist — repairing history first records
  migrations as applied when they are not.

### 1.5 Notifications & Audit

- Emit Supabase channel events so the UI can display progress (`uploading → processing → completed`).
- Record heartbeat timestamps while validating chunks so ghost imports older than the stale cutoff can be failed and retried.
- Store a summary JSON payload per job with metrics: number of players inserted, duplicates skipped, buddy pairs confirmed, and orphan requests.
- Retain the raw CSV for 30 days; schedule a cleanup edge function to purge older files.

## 2. Field Availability Import Flow

### 2.1 Template Expectations

- Provide a downloadable CSV template with columns: `Location`, `Field`, `Subunit`, `Day`, `Start`, `End`, `Type`, `Capacity`, `Valid From`, `Valid Until`.
- Accept multiple rows per field to represent early/late season durations or split fields.
- Validate that `Type` is either `practice` or `game`; other values trigger a friendly error.

### 2.2 Processing Steps

1. Store the uploaded CSV under `imports/fields/<uuid>.csv` and create an `import_job` record.
2. Parse each row, normalizing times into ISO strings and converting `Capacity` to integers.
3. Upsert `locations` and `fields` using case-insensitive matching to avoid duplicates caused by inconsistent capitalization.
4. For rows with subunits, ensure a `field_subunits` entry exists (`field_id`, `label`).
5. Insert or update `practice_slots` or `game_slots` depending on the `Type` column. For practice slots, split rows when `Valid Until` is earlier than the season end to support daylight adjustments automatically.
6. Wrap inserts in a transaction so partially failing files roll back cleanly.

### 2.3 Validation Rules

- Reject overlapping slots on the same field/subunit with identical day/time ranges.
- Ensure `Capacity` is at least 1; default to 1 if blank.
- Verify that `Valid From` and `Valid Until` fall within the active season defined in `season_settings`.
- Provide warnings (not failures) when a field lacks lighting but the slot ends after sunset—use seasonal sunset heuristics from configuration.

### 2.4 Reporting & Feedback

- Summarize the number of practice vs. game slots inserted, updated, and skipped.
- Highlight fields missing subunits even though related divisions expect them.
- Update the `import_jobs` record with status (`ready_to_apply`, `completed`, `completed_with_warnings`, `needs_fix`, or `failed` for canceled staged imports) plus downloadable CSVs for warnings and errors.

## 3. Error Handling & Observability

- Centralize error codes so the UI can translate them into actionable tips (e.g., `UNKNOWN_DIVISION`, `OVERLAPPING_SLOT`).
- Send structured logs to Supabase Logflare (if enabled) with correlation ids derived from `import_job_id`.
- Track processing latency and row throughput metrics; alert when ingestion takes longer than a configured threshold (e.g., 2 minutes).

## 4. Security & Access Control

- Require admin authentication before allowing uploads.
- Scope Supabase Storage buckets with RLS policies so only admin users can read imported files.
- Ensure Edge Functions validate JWTs and confirm the requesting user is an admin or tenant admin for the target organization before starting work.

## 5. Next Implementation Tasks

- Add a team CSV promotion path.
- Add duplicate and unknown-division operator review surfaces beyond the current warning metadata.
