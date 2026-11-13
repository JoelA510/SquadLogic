[← Back to Documentation Index](docs/README.md)
---

> [!NOTE]
> **Implementation Status: PARTIALLY COMPLETE**
>
> Output generation is implemented in `packages/core/src/outputGeneration.js` and the `OutputGenerationPanel` component:
>
> - ✅ CSV export generation (master schedule, per-team files)
> - ✅ Coach welcome email generation
> - ✅ Supabase Storage upload integration
> - ⏳ **Deferred**: `exceljs` is not used — exports are CSV only. TeamSnap API integration (`teamsnap-mapping.md`) was not implemented and is out of scope for v1.0.

# Output Generation & Integration Plan

This guide expands roadmap section 8 by defining how the system will produce deliverables for TeamSnap and league communications
once schedules are finalized. It assumes team, practice, game, and evaluation data already live in Supabase.

## Goals

- Produce a master schedule export covering rosters, practices, games, and key metadata in a spreadsheet-friendly format.
- Generate per-team packages (CSV/Excel + optional email draft) suitable for TeamSnap imports and coach outreach.
- Provide administrators with tooling to preview, download, and confirm outputs before sharing them externally.
- Maintain traceability so exports can be regenerated consistently after manual adjustments or reruns.
- Ensure exports only surface necessary information, redacting sensitive player data per the data governance principles in
  `docs/architecture/data-modeling.md`.

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
     libraries such as `papaparse` (CSV) and `exceljs` (XLSX). A lightweight precursor now exists in `src/outputGeneration.js`
     which returns CSV-friendly rows and helpers for master and per-team exports, providing a reference implementation ahead of
     the serverless function wiring.
   - Include metadata sheets/tabs summarizing generation time, source run IDs, evaluation status, and known warnings.
   - Store generated files in Supabase Storage under `exports/<season>/<job_id>/` with read access limited to admins.
4. **Delivery & Notifications**
   - Once files are stored, update `export_jobs.status = 'completed'` and emit Supabase Realtime events so the UI refreshes.
   - Provide download links in the UI; links should be signed URLs that expire within 24 hours.
   - For per-team exports, optionally bundle files into a ZIP archive for convenience using a streaming compressor to avoid
     exceeding serverless memory limits.

## Schedule reports (2026-11-07)

Three read-only views sit below the files on the Exports page (admin only; no migration; `packages/core/src/reports/`,
`frontend/src/components/reports/`; plan `docs/changes/2026-11-03-schedule-expansion.md`, 5.1 and 5.6): the **Day Sheet**
(a date and an optional venue, one row per saved game, the TIME TBD games apart; its rows are the master export's for the
same filter, one per game where the export writes one per team), a **coach's schedule** (games and practices across every
team the coach has, head and assistant, with a clash column and a marker for a coach on more than one team, counted from
the team list; practices are the weekly series, so the report says how many have temporary changes it does not apply, as the practice export does) and **Changes since publication** (a chosen baseline against the saved schedule, with the reasons recorded
when changes were allowed). Each has a CSV through the export's one cell writer. A game is identified by its teams, slot and
week (`reports/gameKey.js`), because a baseline records those and not which game is which: a moved game is one game no longer saved and one game new. The
audit read (`get_schedule_audit_log`) returns only the two Published actions, so a save or a cancel cannot be matched to a
game and the view says it does not record whether a game was cancelled or moved. The baseline is read through the existing
store hook, which gains `readBaseline` (`compareWithBaseline` now uses it), so the publication seam still has one caller.

**A baseline recorded at import (2026-11-13, PR 6b, task G5).** The games import can record the schedule it leaves as a
baseline (`docs/operations/ingestion-pipeline.md`, the games import). It makes the rows with `generateMasterExport` over
the inputs `masterExportInputs` maps from `useDashboardData`, the mapping the Exports page passes too, and records them
through the same hook's `publishBaseline`, so a schedule's baseline is the same rows whichever page recorded it (channel
`schedule import`). **An outside club has no rows of its own** in the master export, so a game against one is one row;
"Changes since publication" reads a row with no partner whose opponent is exactly one outside club of its division
(`teams.is_external`) as that game. Before this every such game was unreadable and the comparison was never a verdict
for a league with outside clubs.

## TeamSnap Integration Considerations

- Maintain a mapping of Supabase fields to TeamSnap import columns (referenced historically as `teamsnap-mapping.md`, see [**`docs/README.md`**](../README.md) for current active indices).
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
