# Output Generation & Integration Plan

This guide expands roadmap section 8 by defining how the system will produce deliverables for TeamSnap and league communications
once schedules are finalized. It assumes team, practice, game, and evaluation data already live in Supabase.

## Goals
- Produce a master schedule export covering rosters, practices, games, and key metadata in a spreadsheet-friendly format.
- Generate per-team packages (CSV/Excel + optional email draft) suitable for TeamSnap imports and coach outreach.
- Provide administrators with tooling to preview, download, and confirm outputs before sharing them externally.
- Maintain traceability so exports can be regenerated consistently after manual adjustments or reruns.
- Ensure exports only surface necessary information, redacting sensitive player data per the data governance principles in
  `docs/data-modeling.md`.

## Export Architecture
1. **Export Requests**
   - Create an `export_jobs` table with columns: `id`, `type` (`master`, `team`), `status`, `requested_by`, `payload` (JSON of
     filters), `storage_path`, `created_at`, `completed_at`, and `error_details`.
   - Trigger exports via serverless functions (`generate-master-export`, `generate-team-exports`) invoked from the admin UI.
2. **Data Assembly Layer**
   - Use Supabase SQL views to pre-join `teams`, `team_players`, `practice_assignments`, and `games` into flattened datasets
     optimized for export.
   - Support versioned export schemas by including a `schema_version` field in `export_jobs` and gating transformations based on
     that version to avoid breaking TeamSnap templates when fields change.
3. **File Generation**
   - Implement a shared TypeScript utility that accepts the flattened datasets and outputs both CSV and XLSX variants using
     libraries such as `papaparse` (CSV) and `exceljs` (XLSX).
   - Include metadata sheets/tabs summarizing generation time, source run IDs, evaluation status, and known warnings.
   - Store generated files in Supabase Storage under `exports/<season>/<job_id>/` with read access limited to admins.
4. **Delivery & Notifications**
   - Once files are stored, update `export_jobs.status = 'completed'` and emit Supabase Realtime events so the UI refreshes.
   - Provide download links in the UI; links should be signed URLs that expire within 24 hours.
   - For per-team exports, optionally bundle files into a ZIP archive for convenience using a streaming compressor to avoid
     exceeding serverless memory limits.

## TeamSnap Integration Considerations
- Maintain a mapping of Supabase fields to TeamSnap import columns; document this in the repository (`docs/teamsnap-mapping.md`,
  to be created once TeamSnap templates are confirmed).
- Allow administrators to choose between bulk import (single master CSV) or individual team files depending on TeamSnap's
  requirements for the season.
- Validate exports against sample TeamSnap imports using automated tests that load the generated CSV and confirm mandatory
  columns exist (`Team Name`, `Coach Email`, `Event Date`, etc.).
- Capture TeamSnap import success feedback manually in the UI (checkbox or notes) until API automation is explored.

## Email Drafting Workflow
1. **Template Management**
   - Store email templates in `season_settings` (`coach_email_subject`, `coach_email_body_template`) with handlebars-style
     placeholders (`{{team_name}}`, `{{practice_summary}}`, `{{game_summary}}`).
   - Provide a UI editor with preview so admins can tweak copy before sending.
2. **Draft Generation**
   - When generating team exports, produce a parallel email draft JSON containing subject/body rendered with schedule data.
   - Present drafts in the UI with a "Copy to clipboard" button and a "Send mailto" link prefilled with the coach's address.
   - Integrate optional transactional email APIs (e.g., Resend) behind a feature flag for future automation.
3. **Audit & Tracking**
   - Record when an email draft is generated, copied, or sent via API in an `email_log` table for traceability.
   - Allow admins to mark emails as sent manually if they use their own mail client.

## Admin Interface Requirements
- Add an "Exports" page summarizing recent `export_jobs`, their statuses, file sizes, and expiration timers for download links.
- Provide filters to regenerate exports by division, team, or date range when only part of the season needs updating.
- Surface evaluation status badges (e.g., "Evaluation: Passed" or "Warnings") next to export buttons to encourage resolving
  findings before distribution.
- Offer bulk download of team packages and inline previews of CSV headers to build trust before coaches receive files.

## Testing & Quality Assurance
- Unit tests for export formatters ensuring column order and headers match TeamSnap templates.
- Snapshot tests capturing sample CSV/XLSX outputs using seeded data to catch regressions.
- Integration tests that run the full export flow end-to-end within a temporary Supabase project (or local emulator), verifying
  files upload correctly and signed URLs work.
- Spellcheck and link validation on email templates to maintain professionalism.

## Future Enhancements
- Automate TeamSnap API uploads once credentials and rate limits are validated.
- Provide calendar subscription feeds (iCal) generated alongside exports for parents and coaches.
- Support multilingual email templates driven by player/coach language preferences.
- Add analytics tracking export downloads and email engagement to inform adoption.
