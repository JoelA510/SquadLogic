# Phase C: field and venue permits

Status: **C1 and C2 built (one PR; see "As built (C1)" and "As built (C2)"); C3 not started.**
Drafted 2026-10-22 against `origin/main` at `6a22d29`; re-verified 2026-10-27 against `c74d7d3`
(see "Step 0 corrections"). The roadmap orders C after B, which has shipped. Owner's words:
"managing fields, including storing permits so a coach can produce one when asked". Ships as three
PRs (C1 database, C2 admin, C3 coach), each reviewed once before it opens; C1 and C2 went together.

- [x] C1 (see "As built (C1)")
- [x] C2 (see "As built (C2)")
- [ ] C3

**Owner rules for this phase (2026-10-26), answered.**

- **Permits never block anything.** No import, scheduling run, publish or export is refused or gated
  for a missing, expiring or expired permit. Held by `tests/permitsBlockNothing.test.js` (what can
  read a permit, in the frontend, the core package and the Edge Functions) and by an assertion in
  `supabase/tests/facility_permits.sql` (which database functions can).
- **Warn when a field has no permit.** A field (or its venue) with no current permit that has a file
  shows a warning on the admin's Fields page, in the field's card, and as a count on the admin home,
  beside the expiring (30 days) and expired warnings. "Current" is a permit with a file whose status
  is `valid` or `expiring`; a field that is retired, inactive or at a retired venue needs none.
- Recommendations 2-6 below are taken as written and listed under "Calls for the owner" in the PR.

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

1. **Answered by admin-focus R6 (2026-10-25), built in C1: which coaches see permits.** A coach
   reads a permit only for a field where a team they currently coach has a game or a practice (or
   for that field's venue). The original recommendation, below, is superseded.
   _Original:_ **Blocking (shapes C1's policies): which coaches see permits.** Recommend every current coach of
   the organization sees every permit (the owner's "visible to admins and coaches"). Alternative:
   only permits for venues the coach's teams are booked at, which needs a bookings join in the
   policy and breaks for a coach sent to an unscheduled field.

   > **Since R6 of `2026-10-22-admin-focus.md` (2026-10-25), the approved plan decides this:** its
   > R6 row reads "permits for the fields of their scheduled events (Phase C's coach read narrowed
   > to those fields)", and its "Effect on the other plans" says a coach sees permits for the
   > fields their team plays or practises on, not every permit in the organization. So C1's coach
   > read (`get_facility_permits`, the `facility_permits` and `facility_permit_scopes` SELECT
   > policies and the storage SELECT policy) must be narrowed to permits scoped to a field, or to
   > the venue of a field, where a team the caller currently coaches has a game (`games` on a
   > `game_slots` field) or a practice (`practice_assignments` on a `practice_slots` field) in the
   > season, not `is_current_org_coach`. R6 built no permit surface because no permit table exists
   > yet; the coach home (`CoachDashboard`, `frontend/src/pages/DashboardPage.jsx`) is where C3's
   > "Field permits" card goes, beside the schedule card, and the pgTAP matrix needs a coach of a
   > team scheduled elsewhere who reads nothing.

2. Guardians: recommend **no** access; a coach produces the permit.
3. File types and size: recommend PDF, JPEG, PNG, 10 MiB; no HEIC.
4. Warning lead time: recommend a fixed 30 days, not a league setting (add one if asked).
5. Retention: recommend expired permits stay until an admin deletes them; delete removes the row
   and file, and the audit row keeps the metadata. No automatic purge.
6. Offline: recommend no offline app in Phase C; "Download" saves the file to the phone, and the
   page shows number, issuer and dates as text.

## Step 0 corrections (against main c74d7d3, 2026-10-27)

Re-verified before any code; none needed a design call. Each is recorded here and the section it
corrects is left as written.

- **Versions.** Main's latest migration is `20261101020000` (E2); C1 is `20261102010000`. Phase B,
  the admin-focus R0-R7, the demo D2-D5 and E1-E2 have all merged.
- **Facilities are organization-level.** `locations` and `fields` carry no season column, so a
  permit is an organization's, not a season's. "The season" in the R6 narrowing is the team's own:
  `coached_team_ids_of` already judges a coach's assignment on the team's season date. A completed
  season's team a coach still holds (an open-ended assignment) still counts; closing those is E3's.
- **One active season (E1).** The plan's `org_local_today` tie-break among several active seasons
  and its two-active-seasons pgTAP case are not needed: a partial unique index allows one. The helper
  still orders by `created_at`, `id`, harmlessly.
- **The `exports` pattern holds, with one addition: the demo fence.** D3 (`20261030010000`) altered
  the `exports` and `raw-imports` insert policies to add `AND NOT is_demo_org(folder)`, because the
  demo purge cannot clean a storage object. The `facility-permits` insert policy carries the same
  fence, and `supabase/tests/storage_facility_permits_bucket.sql` holds a demo admin's upload refused.
  `supabase/tests/demo_sessions.sql`'s two lists of client-callable functions name the new RPCs and
  the three policy helpers.
- **`admin_delete_field`'s latest body is `20260909000000:544`** (md5 `51c2d435...`), as the plan
  said; nothing has replaced or altered it since, and the new migration refuses to run on any other.
  The md5 ignores carriage returns, as #668 made `20261101010000`'s do: production has stored a
  CRLF body before.
- **Two older smokes encode closure lists and had to be told.** `20260907000000_smoke.sql` derives
  the cascade closure from `fields` (14 tables, now 15) and the `field_id` family (7 tables, now 8),
  and `20260909000000_smoke.sql` the tables referencing `locations`: `facility_permit_scopes` joins
  each, declared **not a booking** (a scope is the link to a permit that stays), with the reason.
  A field-import rollback that removes an empty venue also removes that venue's scope rows; the
  permit stays.
- **The harness's storage stand-in** (`scripts/dbharness/prelude.sql`) returns every segment from
  `storage.foldername`, Supabase's only the folders; the policies match the whole name against the
  full `<org>/<permit>/<uuid>.<ext>` shape and read only folder 1 and 2 inside a CASE that tested it.
- **`get_facility_permits` returns an object** `{today, lead_days, permits}`, not an array: the
  client needs the organization's own day to judge a field's coverage and does not guess it.
- **The pgTAP "parent" persona** is the coach-role member with no assignment (R3 removed the role);
  a "redirected from `/permits`" case waits for C3 and R6's permission set.
- **Investigation notes closed.** `reconcile_prod_rls_drift()` is a one-off migration function, not
  run against later policies. `get_settings_audit_log` returns every `settings.updated` row, so
  `facility.permit` rows show on the Settings audit page without a filter change (statically
  reviewed). The mock had no `storage` member; C2 adds one.

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

## As built (C1)

- **Migration `20261102010000_facility_permits`** (revert and smoke under `docs/sql/`): `facility_permits`
  (id, organization_id, issuer, `permit_number` text, inclusive `valid_from`/`valid_to`, notes, the
  four file columns all-or-none with the path inside `<org>/<permit>/`, a 10 MiB and PDF/JPEG/PNG
  CHECK, `created_by` without a foreign key to `auth.users`) and `facility_permit_scopes` (a permit's
  venue or field, one target per row, unique per permit, composite reference to the permit's
  organization). Both: row level security, one SELECT policy, no write policy or grant, nothing for
  anon.
- **The coach read, narrowed (owner decision 1 / R6).** Internal `coach_field_ids_of(org, user)` = the
  fields of the games (through the slot) and practices (through the practice slot) of the teams the
  user currently coaches. Three policy helpers `authenticated` must execute (a policy runs with the
  caller's privileges) ask about the caller only: `coach_covers_permit_scope`,
  `coach_reads_facility_permit`, `coach_reads_facility_permit_file`. A coach reads a permit if some
  scope names one of those fields or their venue, sees only those scopes, and reads in storage only the
  permit's live `file_path`. `get_facility_permits` gives an admin or staff member everything, a
  current coach the narrowed set (an empty list, not an error, when their team is scheduled
  elsewhere), anyone else 42501.
- **Five definer RPCs**, `TimeZone=UTC`, one audit row each (`settings.updated` / `facility_permit` /
  `setting: 'facility.permit'`, operations `created`, `updated`, `file_attached`, `file_replaced`,
  `deleted`): create, update (replaces the scope set), set file (the object must exist in the bucket
  under this permit's folder with an allowed type and size, read from `storage.objects.metadata`;
  returns the previous path; refuses the object that is already the file, because the caller deletes
  the previous one), delete (returns the file path), read. Status is one SQL function
  (`facility_permit_status`); `org_local_today` is the active season's timezone, UTC when unset.
- **Bucket `facility-permits`**: private, 10 MiB, PDF/JPEG/PNG, three policies: admin INSERT (full
  path shape, the permit exists in that organization, not a demo), admin DELETE, SELECT for an admin
  or the coach of a scheduled field's live file. No UPDATE. The migration touches `storage.buckets`
  and `storage.objects` policies exactly as `20261017000000` does and no `auth` object.
- **`admin_delete_field`** rebuilt behind an md5 guard: permits scoped directly to the field join
  `affected` (`kind: 'permit'`, `disposition: 'unlinked'`); `reason` is `bookings_exist` while a booking
  is on the ground and `permits_linked` when only permits are. A venue's permit is not listed.
- **Verification (executed here):** `supabase/tests/facility_permits.sql` (100) and
  `storage_facility_permits_bucket.sql` (28) under **real pgTAP 1.3.3** loaded into a scratch cluster
  built by the harness's prelude and every migration; `demo_sessions.sql`, `definer_function_grants.sql`,
  `field_delete_booking_guard.sql`, `programs.sql`, `one_active_season.sql`, `staff_is_admin.sql`,
  `rls_policy_matrix.sql` and `facility_admin_rpcs.sql` unchanged but for the lists named above. The
  harness (smoke, revert with a seed that counts 3 permits, 2 files, 4 scopes and leaves a non-empty
  bucket, catalogue snapshot). Plants M52: "a coach reads a permit for any field once they coach a
  scheduled team", "a coach can read a replaced file", "anyone can create a permit", each caught by the
  smoke and by pgTAP (the full `prove.sh` sweep is a multi-hour run and was not run; the anchors
  pre-flight and the three plants applied by hand were).
- **Untested against production:** `admin_set_facility_permit_file` reads `storage.objects` from a
  definer owned by `postgres`; that role needs SELECT on it (Supabase grants it). The first upload in
  production is the proof; C3's real-backend scenario is the place to make it a test.

## As built (C2)

- **Core** `packages/core/src/facility/permits.js` (registered in `facility/index.js`):
  `PermitInputSchema`, `PermitFileSchema` (type allowlist, 10 MiB, magic bytes `%PDF-`, `FFD8FF`,
  `89504E47`), `permitObjectPath`, `permitStatus` (the SQL's twin on the organization's day),
  `fieldsWithoutPermit` and `permitWarnings` (enumerated from the fields, not the permits).
- **Hook** `useFacilityPermits` (read, create, update, replace file, delete, signed URL) and
  `usePermitWarnings` (the admin home). Upload order: create the row, upload, attach; a failed attach
  removes the upload; after a replace or delete commits the old object is removed and a failure is
  logged with its path. A file that fails after the permit saved says so and keeps the permit.
- **UI.** A Permits section on `/fields` (warnings, list, add/edit dialog with a venue/field picker,
  replace/add file, open and download by a 120 s signed link made on tap, delete with a confirmation
  that returns focus to Add permit), a permit line on each field card ("No current permit" or "Permit:
  Expires in 12 days", text beside an icon), the delete-field confirmation naming the permits it
  unlinks, and three lines on the admin home's Needs attention. Errors are `role="alert"`; a file is
  checked the moment it is chosen and Save waits for the check.
- **Mock twin** `frontend/src/lib/mockFacilityPermits.js`: the five RPCs with the SQL's refusals and
  audit rows, the two tables' read policies (in `RESTRICTED_TABLES`), a `storage` member for the bucket
  (policies, 10 MiB, types, no upsert over an object, demo fence), and the permit rows in the mock's
  `admin_delete_field`. Its header lists what is not mirrored (bytes live in memory, signed URLs are
  `data:` URLs that never expire).
- **Tests:** `tests/facilityPermits.test.js`, `mockFacilityPermits.test.js`,
  `FieldManagementPermits.test.jsx`, `permitText.test.jsx`, `permitsBlockNothing.test.js`; E2E
  `tests/e2e/features/field_permits.feature` (4 scenarios). `FieldManagementPage.test.jsx` and
  `facility_management.feature` pass unedited.
- **Not built (C3):** `VIEW_FIELD_PERMITS`, `/permits`, the coach home card, the real-backend scenario.

### Review round (Codex, #669)

- **An attach whose answer is lost** no longer deletes a live object. A refusal that carries a
  Postgres or PostgREST `code` is confirmed and the upload is removed; a transport failure is
  uncertain, so the permit is re-read and the upload is deleted only if its stored `file_path`
  is not that upload. If the re-read also fails the upload is kept and the admin is told.
- **A list read for an organization that is no longer active** is dropped (a generation counter and the
  active org), and the list shown is always the active organization's.
- **An older file check** that resolves last no longer replaces the newest selection or clears
  `checking` (a selection counter in the dialog).
- **Inline styles** in the permit dialog and section are token-based classes in `styles/page.css`.
- Tests: `tests/facilityPermitsRaces.test.jsx` (8, each fails without its fix).
