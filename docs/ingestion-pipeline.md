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
2. Invoke an Edge Function (`process-registration-import`) with the storage path and a generated `import_job_id`.
3. Inside the function:
   - Stream-parse the CSV (e.g., using `@fast-csv/parse`) to avoid loading the entire file into memory.
   - Normalize guardian contacts into a JSON array (`[{ name, email, phone, primary }]`).
   - Build a map of `mutual_buddy_code → [playerIds]` to quickly detect reciprocal pairs.
   - For each row, stage inserts into a staging table `staging_players` that includes the `import_job_id` to handle concurrent jobs, with raw values and validation flags.

### 1.3 Validation Rules
- **Division mapping**: Use the `divisions` table to resolve `division_id`; record a validation error when the division name is unknown.
- **Duplicate detection**: Flag rows where `external_registration_id` already exists for the season.
- **Buddy reciprocity**: Mark buddy codes that appear only once so the admin can review them later.
- **Contact quality**: Require at least one guardian email or phone number.
- **Coach volunteer linkage**: When `Coach Volunteer = yes`, ensure a matching entry exists or create a stub in `coaches` with status `pending-confirmation`.

### 1.4 Commit Phase
1. If any row fails hard validation, leave the import job in `status = 'needs_fix'` and provide a downloadable CSV of errors.
2. When all rows pass:
   - Upsert into `players`, `coaches`, and related tables using SQL functions to ensure transactional safety.
   - Derive buddy pairings by writing to a helper table `player_buddies` (`player_id`, `buddy_player_id`, `source_import_job`).
   - Mark the import job as `status = 'completed'` and persist row counts, buddy statistics, and processing duration.

### 1.5 Notifications & Audit
- Emit Supabase channel events so the UI can display progress (`uploading → processing → completed`).
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
- Update the `import_jobs` record with status (`completed`, `completed_with_warnings`, or `needs_fix`) plus downloadable CSVs for warnings and errors.

## 3. Error Handling & Observability
- Centralize error codes so the UI can translate them into actionable tips (e.g., `UNKNOWN_DIVISION`, `OVERLAPPING_SLOT`).
- Send structured logs to Supabase Logflare (if enabled) with correlation ids derived from `import_job_id`.
- Track processing latency and row throughput metrics; alert when ingestion takes longer than a configured threshold (e.g., 2 minutes).

## 4. Security & Access Control
- Require admin authentication before allowing uploads.
- Scope Supabase Storage buckets with RLS policies so only admin users can read imported files.
- Ensure Edge Functions validate JWTs and confirm the requesting user has the `role = 'admin'` claim before starting work.

## 5. Next Implementation Tasks
- Scaffold the `import_jobs`, `staging_players`, and `player_buddies` tables in the first Supabase migration.
- Build typed DTOs and Zod schemas for CSV rows to guarantee consistent parsing in TypeScript.
- Draft Jest tests covering happy paths, duplicate detection, buddy validation, and overlapping slot rejection.
- Add roadmap tasks for building the admin UI upload screens once the backend pipeline is ready.
