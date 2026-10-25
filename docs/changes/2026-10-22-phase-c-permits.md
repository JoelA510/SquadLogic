# Phase C: field and venue permits

Status: **draft for owner approval** (AGENTS.md rule 14: persistence, authorization, a new Storage
bucket). Drafted 2026-10-22 against `origin/main` at `6a22d29`. The roadmap orders C after B, and
B's plan (`2026-10-22-phase-b-teaming.md`) ships in the same PR; building C waits for B unless the owner reorders. Owner's words:
"managing fields, including storing permits so a coach can produce one when asked". Ships as three
PRs (C1 database, C2 admin, C3 coach), each reviewed once before it opens.

## What exists today (_statically reviewed_ unless marked)

- **Facility tables.** `locations`, `fields`, `field_subunits`, each with `organization_id`
  (`20260331000000_definitive_schema.sql:308-361`); `fields.effective_to` and `fields.active`
  (`20260906000000:95-101`); `locations.effective_to`, `field_subunits.effective_to`
  (`20260911000000:179-183`). Reads: one `is_org_member` SELECT policy each; no write policy
  (`20260504060000_admin_facility_mutation_rpcs.sql:19-31`).
- **Writes are admin RPCs** that check `is_org_admin` and audit through
  `record_audit_event(org, 'settings.updated', <type>, id, {setting:'facility.<type>', operation,
...})` (`20260504060000:83-92`). `admin_delete_field` (latest body
  `20260909000000:544`) refuses with every booking it would take unless `p_confirm`, built from
  `field_bookings()` (`:627-643`), which `admin_retire_field` shares. There is **no location delete
  RPC** and no client delete on `locations` (searched `supabase/migrations`, `frontend/src`).
- **Storage.** `exports` is private, with org-folder policies: first path segment must be a UUID
  (CASE, so a bad name is a 42501, not a 22P02), members SELECT, admins INSERT and DELETE, no
  UPDATE (`20261017000000_exports_bucket.sql:67-115`); pgTAP `storage_exports_bucket.sql` (17).
  The path builder is `exportObjectPath` (`packages/core/src/storageSupabase.js`). Nothing in the
  repo calls `createSignedUrl` or `getPublicUrl`. The harness stand-in has
  `storage.buckets.file_size_limit`, `allowed_mime_types` and `storage.objects.metadata`
  (`scripts/dbharness/prelude.sql:75-93`).
- **Who a coach is.** A live `team_coach_assignments` row of the caller's linked coach, judged on
  the team's season date: `team_local_today`, `is_current_team_coach`, `coached_team_ids_of`,
  `get_my_coached_team_ids` (`20261021010000_server_side_reads.sql:161-263`). The coach directory
  admitted "an admin, or anyone with a current coached team" (`:557-560`) until R4 of
  `2026-10-22-admin-focus.md` (`20261025010000`) dropped it. An `organization_members`
  role of `coach` with no assignment is not a coach to the server.
- **UI.** `/fields` is admin-only (`App.jsx:260-265`); `FieldManagementPage.jsx` (924 lines) has a
  venues section (`:415`) and per-field detail (`:591`), data through `useFields.js`. Coaches see
  fields only as names in schedules (`useTeamPortal.js:21`, `TeamRecordPage.jsx:303`); the coach
  home is `CoachDashboard` (`DashboardPage.jsx:581-753`).
- **Mock.** Facility RPCs are mirrored at `mockSupabaseClient.js:3579-3640` (admin check, audit
  helper); Phase A reads live in `mockServerSideReads.js` and table policies in
  `mockReadPolicies.js:31`. The mock has **no `storage` member** (top-level keys: auth, from,
  channel, removeChannel, rpc, functions); exports bypass it (`OutputGenerationPanel.jsx:54,784`).
- **Permits so far.** The blackout reason `'permit'` (`20260906000100_field_blackouts.sql:69`) and,
  not mentioned in the roadmap, a domain-only projector of permit _reservations_ from the season
  fixture (`packages/core/src/fieldAdmin/projectors/permits.js`, `PermitWindowSchema` at
  `fieldAdmin/schemas.js:242`). It is not persisted and no frontend file imports it. Phase C stores
  the permit _document_; linking reservations to it is later work.
- **Phone constraints.** No service worker or PWA plugin. CSP (`vercel.json:25`) allows the
  Supabase host in `connect-src`, but not in `frame-src`, and `object-src 'none'`: no inline PDF
  embed. A new-tab navigation to a signed URL is not governed by either.

## Design

**Data.** `facility_permits`: `id`, `organization_id` (FK, cascade), `issuer` (text, 1-200),
`permit_number` (text, nullable, at most 100: numbers keep leading zeros), `valid_from`, `valid_to`
(dates, inclusive, `CHECK valid_to >= valid_from`), `notes` (at most 2000), `file_path`,
`file_name`, `file_mime`, `file_size` (all null until a file is attached; `CHECK file_path LIKE
organization_id || '/' || id || '/%'`), `created_by`, `created_at`/`updated_at` (`now()` defaults,
per the UTC idiom guard `tests/utcNowIdiom.test.js`). `facility_permit_scopes`: `permit_id` (FK,
cascade), `organization_id`, `location_id` or `field_id` (FK, cascade; `CHECK
num_nonnulls(location_id, field_id) = 1`; unique per permit; both FKs indexed). A permit covers one
venue, one field, or several of either. Sub-surfaces are not a scope (nothing books onto them,
`20260911000000:182`).

**Access.** SELECT on both tables: `is_org_admin(org)` (staff included) OR
`is_current_org_coach(org)`, a new definer helper = EXISTS in `coached_team_ids_of(org, auth.uid())`.
No INSERT/UPDATE/DELETE policy: writes go through RPCs only. Guardians, players, outsiders, anon:
nothing.

**RPCs** (definer, `is_org_admin`, Zod-mirrored validation in SQL, audited as `settings.updated` /
`facility_permit` / `setting: 'facility.permit'`): `admin_create_facility_permit(org, issuer,
number, valid_from, valid_to, notes, location_ids[], field_ids[])` (every scope id must belong to
`org`, at least one scope); `admin_update_facility_permit(org, permit, ...)` (replaces the scope set,
audits previous and current); `admin_set_facility_permit_file(org, permit, object_path)` (the object
must exist in `storage.objects` under `<org>/<permit>/`, with `metadata` mimetype allowed and size
within the limit; returns the previous path; audits `file_attached` or `file_replaced`);
`admin_delete_facility_permit(org, permit)` (returns the file path; audits the full row).
`get_facility_permits(org)`: admin or current coach, else 42501; returns each permit with scope
names, a `retired` flag per scope, and `status` / `days_left` computed against
`org_local_today(org)` (the active season's `timezone`, UTC when unset or unreadable, the
`team_local_today` contract). Until E1 enforces one active season, the helper is deterministic
when an organization has several: the newest active row by `created_at`, then `id`; pgTAP sets two
active seasons in zones whose dates differ and asserts the status follows that row. Production has
one active season (_executed_, 2026-10-22).

**Storage.** Private bucket `facility-permits`, `file_size_limit` 10 MiB, `allowed_mime_types` PDF,
JPEG, PNG. Path `<org>/<permit>/<random uuid>.<ext>`. Policies: INSERT by an admin of folder 1 when
folder 2 is a permit of that org; DELETE by an admin; SELECT by an admin, or by a current coach only
for a name that is some permit's live `file_path` (a coach cannot list replaced or orphaned files);
no UPDATE (upload with `upsert: false`). Files open by a signed URL made on tap, 120 s expiry, in a
new tab, with a separate "Download" (`download` option). Upload order: create row, upload, attach;
on a failed attach the client removes the upload (the exports all-or-nothing pattern); on replace or
delete the client removes the old object after the RPC commits, a failure logged with the path.

**Expiry.** `status`: `not_yet_valid`, `valid`, `expiring` (`days_left` 0-30), `expired`.
`valid_to` is the last valid day. Shown on the admin home (a count), on `/fields` per permit, and on
the coach home and `/permits`, as text plus an icon, never colour alone.

**Field retire and delete.** Retiring a field or venue leaves its permits untouched; the scope reads
"retired". `admin_delete_field` lists each permit scoped to the field in its refusal (`kind:
'permit'`, `disposition: 'unlinked'`); on confirm the scope row cascades and the permit stays, since
the document outlives the ground. A permit left with no scope shows "no field" to admins.

## C1. Database (medium)

**Today:** nothing stores a permit; see above.
**Change:** migration `<ts>_facility_permits.sql`: both tables, policies, helpers, the five RPCs,
the bucket and its three policies; `admin_delete_field` re-created from `20260909000000:544` with
only the permit listing added. `docs/sql/<ts>_revert.sql` restores that body and drops the rest (the
bucket is dropped only when empty: `storage.protect_delete()` refuses SQL deletes of objects);
`docs/sql/<ts>_smoke.sql` checks the policies, grants, CHECKs and lists orphaned objects.
**Tests** (pgTAP; personas seeded as `server_side_reads.sql` does: admin, staff, current coach,
former coach, coach-role member with no assignment, parent, Org B admin, anon):

> Since R3 (`20261024010000`, `docs/changes/2026-10-22-admin-focus.md`) there is no `parent` role:
> the parent persona below, in pgTAP and in E2E, is to be read as the coach-role member with no
> assignment, and the "redirected from `/permits`" case needs a role without `VIEW_FIELD_PERMITS`,
> which none has until R6. To settle when this phase is built.

- `supabase/tests/facility_permits.sql`: SELECT returns Org A's permit to admin, staff and the
  current coach, and nothing to the other five; every direct INSERT/UPDATE/DELETE is refused; each
  RPC refuses a non-admin (42501), a scope in another org, `valid_to < valid_from`, no scope, and
  writes exactly one audit row per success; `get_facility_permits` status at `valid_to` = today
  (`expiring`, 0), today+30 (`expiring`), today+31 (`valid`), yesterday (`expired`), with the season
  timezone set so local and UTC dates differ; `admin_delete_field` refuses listing the permit, and on
  confirm the permit survives with no scope.
- `supabase/tests/storage_facility_permits_bucket.sql`: private, with the size and type limits; admin
  uploads under a real permit folder; a coach is refused upload; a coach reads the live file and not
  a replaced one; Org B and the parent read nothing; non-UUID folder is 42501; no UPDATE policy.
- Plants: the matrix run against an `is_org_member` SELECT policy (the parent cell fails) and against
  a folder-only coach SELECT (the replaced-file cell fails); `definer_function_grants.sql` extended:
  anon cannot execute the new RPCs.
  **Risks:** the `admin_delete_field` body copy drifts from the latest definition (the harness md5
  check and `field_delete_booking_guard.sql` stay green unchanged). **Unchanged:** facility reads for
  members; every existing RPC signature; `rls_policy_matrix.sql` (its 26 tables are not touched).

## C2. Admin: record, upload, warn (medium)

**Today:** `/fields` has no permit surface.
**Change:** `packages/core/src/facility/permits.js` (registered in `facility/index.js`):
`PermitInputSchema`, `PermitFileSchema` (type allowlist, size, magic bytes `%PDF-`, `FFD8FF`,
`89504E47`, since the bucket trusts the declared type), `permitObjectPath` (the `exportObjectPath`
contract), `permitStatus(validFrom, validTo, today, leadDays)`. A "Permits" section on
`FieldManagementPage` and a field's detail: list, add/edit dialog (issuer, number, dates, scopes,
notes, file), replace file, delete with confirm; the delete-field dialog shows the unlinked permits;
the admin home counts expiring and expired permits. Mock: `frontend/src/lib/mockFacilityPermits.js`
(the five RPCs with the SQL's refusals and audit rows), `facility_permits` in `RESTRICTED_TABLES`,
and a `storage` member (`from(bucket).upload/remove/createSignedUrl/download`, files as data URLs,
the bucket rules mirrored); its header lists what is not mirrored.
**Tests:** `tests/facilityPermits.test.js` (schema edges, path refusals, status boundaries incl. the
timezone case, magic-byte mismatch); `tests/mockFacilityPermits.test.js` (each refusal, a coach
upload refused, a signed URL for an unreferenced object refused); `tests/FieldManagementPermits.test.jsx`
(errors announced via `role="alert"`, focus returns to the trigger, a 12 MiB file refused before
upload, a failed attach removes the upload); E2E `tests/e2e/features/field_permits.feature`: an
admin adds a permit with a PDF, replaces it, and sees "Expires in 12 days".
**Unchanged:** existing `/fields` flows (`FieldManagementPage.test.jsx`,
`facility_management.feature` pass unedited); exports' `MOCK_UPLOAD` path.

## C3. Coach: produce it at the field (small-medium)

**Today:** coaches have no route to facility data beyond names.
**Change:** a `VIEW_FIELD_PERMITS` permission for admin, staff and coach roles; `/permits`, a
single-column page (venue, field, issuer, number, dates, status) with "Open" and "Download"
buttons of at least 44 px; a "Field permits" card on `CoachDashboard` with the expiring and expired
ones and a link. Admin role preview reads with the admin's session, as the directory does.
**Tests:** `tests/coachPermitsPage.test.jsx` (the server's 42501 shows "not available", not an empty
list; a failed signed URL is announced); E2E in `field_permits.feature` at a 390x844 viewport: a
coach sees the warning and opens the file, a parent going to `/permits` is redirected; a real-backend
scenario (`tests/e2e/real-backend/features/real_backend_permits.feature`): the coach's signed URL
returns 200, the parent's `createSignedUrl` is refused, an upload declared `text/html` is refused by
the bucket. **Unchanged:** `privacy_server_reads.feature` (the coach directory is gone since R4,
`20261025010000`).

## Owner decisions (recommendations)

1. **Blocking (shapes C1's policies): which coaches see permits.** Recommend every current coach of
   the organization sees every permit (the owner's "visible to admins and coaches"). Alternative:
   only permits for venues the coach's teams are booked at, which needs a bookings join in the
   policy and breaks for a coach sent to an unscheduled field.
2. Guardians: recommend **no** access; a coach produces the permit.
3. File types and size: recommend PDF, JPEG, PNG, 10 MiB; no HEIC.
4. Warning lead time: recommend a fixed 30 days, not a league setting (add one if asked).
5. Retention: recommend expired permits stay until an admin deletes them; delete removes the row
   and file, and the audit row keeps the metadata. No automatic purge.
6. Offline: recommend no offline app in Phase C; "Download" saves the file to the phone, and the
   page shows number, issuer and dates as text.

## Investigation notes (unverified)

- Whether hosted Supabase's Storage enforces `allowed_mime_types` from the declared Content-Type
  only, and whether signing needs the caller's SELECT policy: assumed from Supabase docs, to be
  proved by C3's real-backend scenario before C3 merges.
- Whether `reconcile_prod_rls_drift()` (`20261021020000:222`) must list the new tables'
  policies; it allowlists member writes, and these tables have none.
- Whether the Settings audit trail page shows `facility.permit` rows without a filter change.
- iOS Safari's conversion of camera photos to JPEG on upload; and how organization deletion should
  remove permit files (an org cascade leaves objects behind; no in-app path deletes an org).
- _Executed_: `npx vitest run tests/storageSupabase.test.js tests/mockReadPolicies.test.js` (31
  passed) on this checkout, as a baseline for the modules C2 extends.
