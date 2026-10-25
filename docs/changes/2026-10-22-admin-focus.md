# Admin focus: removals, data minimisation, coach view and exports

Status: **approved by the owner 2026-10-22**, with the recommended decisions and the additions under
"Decisions" (AGENTS.md rule 14: persistence, the domain model and roles).
It turns the owner's 2026-10-22 scope decisions (`docs/product.md`) into eight PRs. Every claim
about main (`c15c3b2`) is _statically reviewed_ unless marked _executed_; the inventories behind it
cite file and line for each item and are summarised here, not repeated.

## The owner's decisions (2026-10-22)

- Remove the in-app registration flow and the admin Registration Forms and Compliance pages.
- Remove the guardian view, and availability marking (RSVP).
- Guardian contact details are not stored; leagues keep them on their registration platform.
- Birthdates are read at import for teaming and dropped after teaming; play-up stays as an
  optional import flag.
- Coaches see their own schedule, the team names and coach names in their division (no contact
  details), and the permits for the fields they use.
- Admins and coaches export schedules as CSV and XLSX, and ICS where cheap.

## What production holds (_executed_, read-only, 2026-10-22)

| Object                                 | Rows  | Note                                                                                                                                                                                                                    |
| -------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `organization_members`                 | 1     | one admin; no coach, parent or player accounts                                                                                                                                                                          |
| `players`                              | 0     | nothing promoted                                                                                                                                                                                                        |
| `coaches`                              | 130   | every row has a phone and a `custom_attributes` holding the export's unmapped columns: both guardians' names, addresses, emails and phones, the child's name and birth date, the coach's own birth date, payment status |
| `staging_players`                      | 1,153 | one job, 2026-10-13, every row with a birth date (purged at 30 days, `20260416000002`)                                                                                                                                  |
| `staging_import_rows`                  | 130   | the coach job, 2026-06-12; **never purged**                                                                                                                                                                             |
| registrations, forms, RSVPs, team chat | 0     |                                                                                                                                                                                                                         |
| `profile_players` (guardian links)     | 0     |                                                                                                                                                                                                                         |

So the stored personal data today is the coach import's catch-all and the two staging tables, not
players or guardians. That is fixed first (R0).

## Why the order matters (hazards the inventories found)

- **Unmapped columns are kept.** Both finalizers store every column they do not map in
  `custom_attributes` (`finalize_import_job`, latest `20261020020000:254-279`;
  `finalize_coach_import_job`, `20260726000300:738-743`), and the sensitive-column filter has no
  pattern for guardian, address, phone or email. A denylist cannot keep up with an export the league
  does not control: R0 turns both imports into **allowlists**.
- **Admins' player reads share policies with guardians.** `players_select_admin_or_guardian` and
  `team_players_select_admin_or_guardian` (`20261021020000:54,64`) reference `profile_players`;
  dropping that table with CASCADE drops the whole policies, admin arm included. R3 replaces the
  policies before it drops anything.
- **RSVP is wired into team deletion and the team page.** `admin_delete_team` (latest
  `20261021030000:168-189`) deletes and counts `event_rsvps`, and its pgTAP catalogue check fails if
  a cascaded table has no counter; `useTeamPortal.js:266-273` throws when the RSVP read fails, which
  takes the team page down for coaches and admins. R2 rewrites both first.
- **Reports read registrations.** `/admin/reports` (`EnterpriseDashboard.jsx:84-135`) reads
  `view_compliance_stats`, a view over `registrations`; R1 removes the chart with the view.
- **"Registration" is also an import word.** `job_type = 'registration'`, `external_registration_id`
  and `registration_history` belong to the GotSport import and stay; removals go by inventory, never
  by grep-and-delete.
- **Kept behaviour is tested as a parent.** The team-page practice-change E2E features, calendar
  sync and `teamPortalPracticeExceptions.test.jsx` sign in as a parent; pgTAP uses `parent` as its
  generic non-admin. Each moves to a coach persona in the PR that removes the role (R3).
- **Audit history stays readable.** `audit_log.action` references `audit_actions`, so the retired
  actions' rows stay in `audit_actions` while old audit rows exist; R0 scrubs personal values from
  existing `audit_log.metadata`.

## PRs

Each PR: migration, `docs/sql/<v>_revert.sql` and `_smoke.sql`, pgTAP, the mock twin, Vitest and E2E
where the UI changes, `supabase/catalog-snapshot.json` regenerated, docs in the same PR. A revert
restores structure, never deleted personal data (stated in each revert's header).

| PR                                                | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Tests (each proven against a planted defect)                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R0** Data minimisation at import, and the purge | Player and coach imports keep an **allowlist** of canonical fields; everything else is dropped in `import-validation` and again in each finalizer (callable directly). Player allowlist: name, external registration id, age group, gender, division, team placement columns (Team Name/Age/Gender), play-up, buddy request, years played, waitlist status (the teaming gate), and the coaching-lead flag (`willing_to_coach`; Phase B B6). The coach-lead capture that copied a volunteering guardian's name and email into a coach row stops. Coach allowlist: name, sign-in email, external registration id, requested division, years coached, child's name/gender/birth date **only to resolve the coach's player and then discarded**, playing up, preferred co-coach. Staging rows are deleted when their job finalizes or fails, and a daily job deletes any older than 24 hours. Migration: every `coaches.custom_attributes` reduced to the allowlist; `coaches.phone` and `contact_info` dropped (decision 2); both staging tables emptied; personal values removed from existing `audit_log.metadata`. | pgTAP: a finalize with a `Guardian 1 Mobile Phone Number` column stores it nowhere (catalogue scan of every jsonb and text column of the touched tables); staging is empty after finalize; the purge leaves zero coach keys outside the allowlist. Vitest: the demo fixture's coach and player files through both normalizers keep only allowlisted keys. |
| **R1** Registration flow and Compliance           | Routes `/register/:formId` and the Registration Forms page; `submit_registration`, `admin_create_registration_form`, `admin_update_registration_form`; tables `registration_forms`, `registrations`; `view_compliance_stats` and the Reports chart; `players.paid`, `waiver_received`, `medical_form_received` (decision 1) and their patch paths; `get_team_portal_medical_status`; `coach_update_player_compliance`; the Compliance page and nav badge. Players `submit_registration` created stay (none in production).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | pgTAP: the functions and tables are absent; `definer_function_grants.sql` drops its anon `submit_registration` assertion; Reports renders without the axis. E2E: `registration_compliance.feature` deleted; `reporting.feature` updated.                                                                                                                  |
| **R2** RSVP and team chat                         | `admin_delete_team` and its mock rewritten without `event_rsvps` first; `useTeamPortal` stops reading RSVPs; then `event_rsvps`, `upsert_team_event_rsvp`, the RSVP UI, `team_messages` and `create_team_message` (chat is family communication; decision 5). `practiceReaderCensus` drops the RSVP reader.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | pgTAP `admin_delete_team_exceptions.sql` passes with the new cascade set; the team page renders for a coach with the tables gone.                                                                                                                                                                                                                         |
| **R3** Guardian view and roles                    | New `players` / `team_players` SELECT policies (admins; a coach for their own teams' players' names only) **before** dropping `profile_players` and `link_my_guardian_records`; guardian arms out of `get_team_roster`, `get_team_staff` and the calendar-token policy; the `guardian_contact_sharing` setting; roles `parent` and `player` removed from members, invites and role checks (none in production); the parent dashboard and nav; pgTAP and E2E personas moved to a coach.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | pgTAP `rls_policy_matrix.sql` with the coach persona: an admin reads all players, a coach only names on their teams, nobody else any; inviting a `parent` is refused.                                                                                                                                                                                     |
| **R4** Contact surfaces                           | `players.contact_info` and `guardian_contacts` dropped; the contact card columns on `profiles` and `set_my_contact_card`; `get_coach_directory`; contact fields out of `get_team_staff`; `upsert_coach_leads` and the coach-leads code are removed (R0 stopped calling them). Admins see coach email (sign-in) in Coaches.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | pgTAP: no read a coach can call returns an email or phone (catalogue of the coach-callable functions' result columns).                                                                                                                                                                                                                                    |
| **R5** Birthdates                                 | The import stores the player's **natural age** (the age group the export states, or computed at import with the season's cutoff) and never `date_of_birth`; `resolveNaturalAge` reads it; `finalize_import_job` promotes rows without a stored birth date; teaming in the browser still reads the file's birth dates during the import session. Migration drops `players.date_of_birth` and `birth_year` (0 rows today). Decision 3. Also takes B2's hand-off: the durable-player query selects the natural age and the page test generates from stored players only (`2026-10-22-phase-b-teaming.md`, As built (B2)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Core unit: play-up eligibility from natural age equals the DOB result on the season fixture (`fixtures/season-2026/`, full suite); pgTAP: no column named like birth or dob on `players`, `coaches` or staging.                                                                                                                                           |
| **R6** Coach view                                 | Coaches lose `MANAGE_SCHEDULE` and the admin scheduling pages; the coach home shows their own schedule (games and practices), a new `get_my_division_teams()` (team names and coach names in their divisions, no contacts) and permits for the fields of their scheduled events (Phase C's coach read narrowed to those fields); the broken "My Team" nav link fixed; practice preferences stay (decision 4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Vitest per page for the coach role; pgTAP: `get_my_division_teams` returns no contact column and nothing outside the coach's divisions. E2E: coach journey.                                                                                                                                                                                               |
| **R7** Exports                                    | Admins: all-teams and per-team schedule as CSV (exists) and XLSX, per-team ICS download. Coaches: their teams' schedule as CSV, XLSX and ICS. No email or phone column in any coach export (the admin "Coach Emails" column stays admin-only). XLSX needs one dependency (decision 6), flagged in the PR.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Vitest: the export's rows equal the schedule's events (planted: an event dropped); the coach export has no contact column; the ICS parses and round-trips its events.                                                                                                                                                                                     |

R0 goes first and alone: it is the only one that changes what production stores today. R1 and R2
can run in parallel; R3 follows R2; R4 follows R3; R5, R6 and R7 after. At most two PRs are open
at once (AGENTS.md section 11).

## Effect on the other plans

- **Demo mode:** the seed goes through R0's allowlists, so the fixture's placeholder guardian
  columns are dropped at import, which the demo can show. No guardian preview was planned.
- **Phase B (teaming):** buddy requests name players, not guardians, and stay. Play-up eligibility
  reads natural age (R5). Keeping teams formed outside SquadLogic (the export's Team Name, Team Age
  and Team Gender) is added to Phase B; R0 keeps those columns for it.
- **Phase C (permits):** a coach sees permits for the fields their team plays or practises on, not
  every permit in the organization.
- **Phase E:** already revised (no registration).

## Decisions (owner, 2026-10-22: all as recommended, plus the additions)

1. `players.paid` is dropped (R1). **Waitlist status stays** as the gate: a player is imported
   waitlisted or active within their division, and an admin moves a player off the waitlist to make
   them eligible for teaming.
2. Coach phone is not stored (R0); the email stays because coaches sign in with it.
3. Birthdates are never stored server-side; a stored natural age replaces them (R5).
4. Coach practice preferences stay. **Lighting is admin-only, with no coach requests.** **Score
   entry and standings are admin functions, each enabled by the league in its settings** (a
   feature flag, off by default; R6).
5. Team chat is removed with RSVP (R2).
6. The XLSX library is chosen at R7 against the dependency policy.

## As built (R0)

- **Coach allowlist.** The coach finalizer reads only full name, email, status, the multi-team flag
  and certifications, so the coach import keeps those plus first and last name (D1 composes the
  full name from them). The plan's draft list also named registration id, requested division,
  years coached and the child's columns: nothing reads them, so they are dropped. Keeping a coach
  with their child (`coach_team_requests`) has no writer today; when Phase B builds one, it adds
  the child's name and birth date to the allowlist to resolve the player and stores only the link.
- **Coach-lead capture stops; the lead signal stays.** The capture copied a volunteering guardian's
  name and email into a coach row; with guardian contacts gone it could only warn. The player's
  `willing_to_coach` flag is the coaching lead Phase B (B6) spreads across teams; the leads RPC
  and table go in R4.
- **Staging retention.** Staged rows are kept until their job finishes (buddy pairing reads them
  after finalize), then deleted by the purge and a 30-day retention job for coach staging like the
  player one, not deleted at finalize.

## As built (R1)

- **Two more RPCs than the row names.** `admin_delete_registration_form` and
  `admin_update_registration_medical_status` wrote the dropped tables, so they went too (seven
  functions in all). The tables' policies and triggers are dropped by name before the tables.
- **Replaced, not dropped:** `sanitize_player_patch` and `apply_player_patch` lose the three flags
  (a patch naming one is refused 22023), and `finalize_import_job` is copied from R0's body
  without `paid`.
- **The Reports page** loses its Compliance axis and the Network Readiness tile, which displayed
  that axis's value.
- **The `medical_forms` flag** leaves the settings catalogue and its default; its key stays in
  `FEATURE_FLAGS` so a stored value still parses (skill `squadlogic-feature-guardians`).
- **The sensitive-column filter's "Payment Status" exception** goes with `paid`, its only reader:
  every payment column is stripped before upload (browser and Edge copies).
- **Kept:** the retired actions' `audit_actions` rows; every GotSport "registration" name.
- **The Reports page's "Organization Readiness" radar**, left as is in R1: with the Compliance
  axis gone, none of its three axes read organization data (Staffing was a stub ratio, Balance and
  Skill Variability constants). Removed in a follow-up PR (owner, 2026-10-22).
- **Harness:** older smokes at head stop exercising dropped objects (the throttle smoke now checks
  they stay gone), so the six M28 throttle plants are retired; the M30 plant is re-aimed at this
  migration's `finalize_import_job`; the revert check compares a catalogue fingerprint of every
  dropped or replaced object with a build at `20261022010000`.

## As built (R2)

- **Migration `20261022030000`.** `admin_delete_team` is replaced first, from its latest body
  (`20261021030000`) with the RSVP delete and the `event_rsvps_deleted` and `team_messages_deleted`
  counters removed. It still locks the team's games `FOR UPDATE`, which keeps the game ids and
  count it records equal to the rows the cascade removes. Then `upsert_team_event_rsvp`,
  `create_team_message`, the two read policies, the `event_rsvps_set_timestamp` trigger and both
  tables are dropped by exact name, with no CASCADE. The `team.rsvp_updated` and
  `team.message_created` audit actions stay registered for old audit rows.
- **Not in the plan, forced by the drop.** `reconcile_prod_rls_drift()` named the chat table's read
  policy in its spec, so after the drop it would have failed. It is replaced from its latest body
  (`20261021020000`) without that table, and its smoke now counts 19 policies and 10 broad tables.
  Its comment is restated with the new spec. `team_messages` also leaves the `supabase_realtime`
  publication where it is a member. The revert
  puts it back where that publication exists, as `20251217000000` did. A comment in
  `persist_team_schedule` still names both tables. It is left alone, because changing it would mean
  replacing that function.
- **The team page.** `useTeamPortal` reads neither table, opens no realtime channel, and drops
  `myPlayers` (the caller's own children, used only for RSVP). `get_team_roster` still returns
  `is_my_child`, which nothing reads any more; R3 takes it out with the guardian arms. `TeamRecordPage` shows the schedule at
  full width, with no RSVP column and no chat panel. The unused `rsvp_event` permission is
  removed. No feature flag, nav entry, notification, Edge Function or calendar code named either
  table.
- **Tests.**
  - pgTAP: `admin_delete_team_exceptions.sql` reads the new cascade set (seven tables) off the
    catalogue, and fails if `team.deleted` has a counter for a table that does not exist.
  - pgTAP: `rsvp_and_team_chat_removed.sql` checks that the objects are gone. As the team's
    current coach, it also checks that every read the team page makes still returns its row.
  - Vitest: `teamPortalPracticeExceptions.test.jsx` renders the page for a coach with both tables
    refused (`PGRST205`), and checks that neither table is read and no channel is opened.
  - E2E: Pillar 2's "Communicating with Parents" becomes a coach scenario: the schedule shows,
    with no RSVP or chat.
  - Removed: `team_communication.feature`, the RSVP checks in `team_portal_practice_changes.feature`,
    the RSVP case table and its three arms, and the mock RPC tests.
  - `practiceReaderCensus` drops the RSVP reader.
- **Harness.** The smokes of `20261005000000` and `20261021030000` now run at head without RSVPs:
  the RSVP cases and races are reduced to checking that the objects stay gone. The four M21 plants
  and three M35 RSVP plants are retired. The M14, M34-reconcile and M35-delete plants are re-aimed
  at `$M39`, the live definitions, and new M39 and R39 plants are added. The revert is checked by
  a catalogue fingerprint.

## As built (R3)

- **Migration `20261024010000`, in this order.** A guard refuses to run while any member or invite
  holds `parent` or `player` (an access decision for an admin, not a migration), and a NOTICE counts
  the guardian links and stored `guardian_contact_sharing` values it leaves behind. Then the admin
  read is created on its own (`players_select_admin`, `team_players_select_admin`:
  `is_org_admin(organization_id)`, so admins, tenant_admins and staff) **before** the two
  admin-or-guardian policies are dropped; the calendar-token policy loses its guardian arm (ALTER
  POLICY); `get_team_roster` is dropped and recreated (its result loses `is_my_child`, which
  CREATE OR REPLACE cannot do; grants and comment restated) and `get_team_staff` replaced, both
  from their `20261021010000` bodies without the guardian arm; then `link_my_guardian_records()`,
  `is_team_guardian(uuid)`, `guardian_contacts_view(uuid, jsonb, boolean)`, the
  `profile_players_select_own_or_admin` policy and `profile_players` are dropped by exact name with
  no CASCADE; then the roles. A closing check refuses to commit if `players` or `team_players` has
  any other read policy, if the admin one is missing, or if any function or policy still names a
  dropped object. Planting the old team_players policy left in place makes the table drop fail
  (`M41 the admin-or-guardian read is left on team_players`), which is the CASCADE hazard caught.
- **"Names only" for a coach is enforced by the roster read, not by a table policy.** Row
  security chooses rows, not columns, and a column grant would bind every `authenticated` caller,
  admins included (the admin pages read `players` with `select *`). So a coach keeps no direct
  read of `players` or `team_players` (the guardian arm never admitted one), and
  `get_team_roster` gives a current coach `first_name`, `last_name`, `preferred_name` and
  `jersey_number`; `guardian_contacts` is `[]` and gender, years played, rating and coaching
  interest are NULL. **Two calls for the owner:** the jersey number is kept for a coach (not a
  name, but a team-sheet field); and the coach's guardian contacts are cut here rather than in R4,
  because the R3 row says "names only" (production holds no players, so nothing a coach saw
  changes today). Admins read guardian contacts as imported: with no guardian accounts no contact
  card can apply, so `guardian_contacts_view` went and its admin projection is inline.
- **The roles are text CHECK constraints, not an enum**, so no type is rebuilt:
  `organization_members_role_check` is now admin, coach, staff, tenant_admin;
  `organization_invites_role_check` admin, coach, staff. `create_org_invite` and
  `admin_change_member_role` are their latest repo bodies (`20260421034626`, `20261020030000`)
  with only the role list changed (22023 for parent or player). Production's `create_org_invite`
  differs from its file only by the file's comments (read 2026-10-24); the revert restores the
  file's text.
- **Kept.** The `guardian.linked` audit action; the `guardian_contact_sharing` key in
  `FEATURE_FLAGS` (out of the catalogue and the defaults, as R1 did for `medical_forms`);
  `players.guardian_contacts`, the contact card, `set_my_contact_card`, `get_coach_directory` and
  `get_team_staff`'s contact columns (all R4). `team_players.role = 'player'` and the
  `organization_schemas` entity type `player` are not membership roles and are untouched.
- **Production, read-only, 2026-10-24** (catalogue and counts only, through the SQL endpoint):
  every object the migration drops or replaces exists as the repo builds it (md5 of each function
  body and policy expression compared with a local build at `20261023010000`: equal, except
  `create_org_invite`, comments only, and `is_org_member` and `redeem_org_invite`, which the
  migration does not touch); the dependents of `profile_players` are exactly the three policies
  named above, and `is_team_guardian`'s exactly the calendar-token policy; no view, trigger or
  publication names `profile_players`; `profile_players` 0 rows, `players` 0, `team_players` 0,
  `team_calendar_tokens` 0, `organization_invites` 0, `organization_members` 1 (admin), members or
  invites holding `parent` or `player` 0, organizations storing `guardian_contact_sharing` 0,
  `guardian.linked` audit rows 0; ledger at `20261023010000`.
- **The UI.** No `parent` or `player` in `ROLES` (and the `view_own_team` permission only they held
  is gone); a membership still carrying either is granted nothing. The parent home, its nav and
  the Family label go; the coach is the only flat nav; the role preview offers a coach only;
  members and invites offer admin, coach and staff (`ASSIGNABLE_ROLES`, the server's whitelist);
  `OrganizationContext` no longer calls the guardian link. A membership still carrying a removed
  role (a cached one, or a row written before the migration) gets Home only and a notice that it
  has no role, not the admin shell. The mock twin follows the SQL; a demo sign-in seeds a
  membership only for an account named for a role that exists (admin, coach, staff), so an old
  `parent@` lands with no organization. **Not mirrored in the mock:** the role CHECKs on a
  direct table write, and `admin_change_member_role`'s audit metadata keys (pre-existing).
- **Tests.**
  - pgTAP: `guardian_view_removed.sql` (objects gone, with a control; the admin read alone and
    still reading; the coach's reads; no `is_my_child`; both role checks; parent refused).
    `rls_policy_matrix.sql`: the parent persona becomes a second coach of Org A (every cell as
    before but `players` and `team_players`, which a parent read for their own child),
    `profile_players` leaves the subjects (23 tables), and eight assertions cover the roster read
    (admin every column, coach names only, another team's coach, the outsider and Org B's admin
    refused) and the roles (parent and player invites 22023, a parent member 23514). Run on
    `origin/main`, the names-only and the three role assertions fail; the refusals and the admin
    read hold there too, as they should. `restricted_reads.sql`, `server_side_reads.sql`,
    `identity_guards.sql` and `staff_is_admin.sql` move their parent personas to a coach-role
    member and drop the guardian cases.
  - Smokes run at head: `20261003000000`, `20261004000000`, `20261005000000`, `20261020030000`
    and `20261020040000` use a coach who coaches no team where they used a parent;
    `20261018030000` counts 23 tables and 79 policies, and its member reads no player;
    `20261021010000` and `20261021020000` lose the guardian link, guardian reads and sharing cases
    (the contact card is checked on a coach through `get_team_staff`).
  - Vitest: the mock reads, read policies, invites and member role change refuse the removed
    roles; a stale parent or player role is granted nothing; no parent preview is offered (fails
    on the old `TopBar`); `teamPortalPracticeExceptions.test.jsx` renders as a coach.
  - E2E: `calendar_sync`, `team_portal_practice_changes` and `privacy_server_reads` sign in as the
    team's coach (a shared step, "I coach the ... team, which has the player ..."); the privacy
    scenario checks the coach sees names and no guardian contact (it showed every contact before);
    the blackout repair checks the team's coach sees the change. **Retired:** the read-only
    scenario of `rbac_multi_tenancy.feature` (no role is read-only until R6 takes
    `MANAGE_SCHEDULE` from coaches; R6 brings it back as the coach's). **Changed:** the score
    entry scenario of `visual_rbac_enforcement.feature` signs in as a coach and checks the game of
    two teams the coach does not coach offers no score entry. `auth_setup` refuses a parent or
    player persona rather than running it as an admin; `TEST_PARENT_EMAIL` goes from CI and
    `.env.test.example`.
- **Harness.** The revert is checked by a catalogue fingerprint against a build at
  `20261023010000`. Nine guardian plants retire with the objects they mutated (six in
  `20261021010000`, three policies in `20261021020000`); the roster, calendar-token and
  staff-demotion plants are re-aimed at `$M41`, the live definitions; ten M41 plants (two of them
  refused by the migration itself: a widened admin read, and the old team_players policy left in
  place, which makes the table drop fail) and three R41 plants are added. Each new or re-aimed
  plant was applied by hand and the harness run: each failed with its expected check.
- **Found for later PRs, not done here.** R4: the player record's Guardians tab and the roster's
  guardian contacts component (admin-only now), the contact card, the "guardian(s) volunteered to
  coach" line. R6: a coach still holds `MANAGE_SCHEDULE`, so sees practice and game edit controls
  and score entry for their own games (the retired read-only scenario); the role preview finds its
  coach by `profiles.role`, which nothing sets (production's four profiles all read `user`), so it
  never offers a preview there. Phase C's plan uses a parent persona (noted in that plan).

## As built (R4)

- **Migration `20261025010000`, in this order.** A NOTICE counts what the drops destroy (players
  with a contact or guardian contact, saved contact cards, coach interest rows, import jobs
  holding a `coach_leads` summary, organizations storing `coach_directory`). `get_team_staff` is
  dropped and recreated (its result loses `phone` and `email`, which CREATE OR REPLACE cannot do)
  from its `20261024010000` body without the contact card join: coach id, name, role, and status
  to admins and staff. `get_team_roster` is dropped and recreated the same way without
  `guardian_contacts`. `get_organization_members` admits admins and staff only. Then
  `get_coach_directory` and `set_my_contact_card` are dropped, and the contact card: the checks
  `profiles_contact_phone_check` and `profiles_contact_email_check` and the columns
  `contact_phone`, `contact_email` and `share_contact`. The player writers are replaced from
  their latest bodies with only the contact lines removed: `sanitize_player_patch` (a patch naming
  `guardian_contacts` is refused 22023 like any unknown key), `apply_player_patch`,
  `admin_bulk_update_players` (its now unreachable bulk refusal of the key),
  `finalize_import_job` and `minimise_import_people_data` (its coach half and its list of audit
  metadata keys to redact are unchanged). Then `players.contact_info` and
  `players.guardian_contacts` are dropped. Last the coach leads: `upsert_coach_leads`,
  `set_import_job_coach_lead_summary`, the table's policy and org-scope trigger, the table
  `coach_interested_programs`, and the trigger's function. Every drop names its object with no
  CASCADE. Each copied body was extracted from its file and its md5 checked equal to the build's
  before it was edited. A closing check refuses to commit while any `public` function (comments and
  string literals stripped), view or policy names a dropped object, or while any function
  `authenticated` may execute returns a column, or rows of a table with a column, named like an
  email, a phone, a contact or a guardian, other than `get_organization_members` and
  `get_settings_audit_log`.
- **Not in the R4 row, forced by its test.** `get_organization_members` admitted any member
  (`is_org_member`) and returns every member's sign-in email, so a coach could read them all. Its
  only caller is the Members page, behind `MANAGE_ORGANIZATION`; it now checks `is_org_admin`
  (admins, tenant admins and staff), same body otherwise. Production has one member, the admin, so
  nobody loses a read today. The mock twin follows.
- **"No read a coach can call returns an email or phone", as enforced.** The catalogue is every
  `public` function `authenticated` may EXECUTE (from the grants, not from the functions R4
  touched), judged by its result column names and by the columns of a table whose rows it
  returns; it must be exactly the two admin reads, and pgTAP calls both as a coach and expects a
  refusal. Declared blind spot: a function returning `jsonb` or a bare `record`. Read 2026-10-25,
  every such function a coach may call that mentions an email or phone is admin-gated
  (`finalize_coach_import_job`, `rollback_coach_import_job`, `admin_set_season_timezone`) or
  returns no contact (`link_my_coach_record`: a status and the coach id). Direct table reads are
  outside this catalogue: a coach reads only their own `coaches` and `profiles` rows; see "Found
  for later PRs" for the two member-readable tables.
- **Calls for the owner.**
  - `interested` stays a coach status (admins set it; a coach import still promotes it to
    `active`). The plan names `upsert_coach_leads` "and the coach-leads code"; the status is also
    the Coaches page's "Interested" filter and bulk action and the coach import's promotion, and
    no lead is captured any more, so it now means "said they would coach". Its column comment is
    restated. Production holds no `interested` coach.
  - `coaches.phone` and `coaches.contact_info` stay. R0's row said they would be dropped; R0
    emptied them instead (no phone stored, `contact_info` the sign-in email), and the R4 row does
    not name them. Dropping them means replacing the coach finalizer and its rollback. Nothing
    returns either to a coach. The Coaches page still has a Phone column, always blank (production:
    0 coaches with a phone).
  - The team page's Staff tab shows names and roles to admins too; admins find a coach's
    sign-in email on the Coaches page (the R4 row's wording).
  - The coaching-interest line (the "guardian(s) volunteered to coach" R3 handed over) stays as a
    count: `willing_to_coach` is the coaching lead Phase B reads. It reads "N player(s) on this
    roster have a family member willing to coach" and names nobody.
  - `org_flag(uuid, text, boolean)` stays, with no caller now: it is the internal settings
    helper, and R6's score entry and standings settings are the next readers.
- **Kept.** The `profile.contact_card_updated` audit action; the `coach_directory` key in
  `FEATURE_FLAGS` (out of the catalogue and the defaults, as R1 and R3 did); `coaches.email`;
  `organizations.contact_info` (the league's own settings: its timezone); the coach import's
  `contact_info` writes. A comment in `admin_delete_coaches` still names the dropped table; it is
  left alone, because changing it would mean replacing that function.
- **Production, read-only, 2026-10-25** (catalogue and counts only, through the SQL endpoint, once
  the ledger read `20261024010000`): the md5 of every function body the migration drops or
  replaces equals a local build at `20261024010000` (`get_team_staff`, `get_team_roster`,
  `get_organization_members`, `get_coach_directory`, `set_my_contact_card`,
  `sanitize_player_patch`, `apply_player_patch`, `admin_bulk_update_players`,
  `finalize_import_job`, `minimise_import_people_data`, `upsert_coach_leads`,
  `enforce_coach_interested_programs_org_scope`), as do their security, volatility, SET clauses,
  results and `anon`/`authenticated` EXECUTE, except
  `set_import_job_coach_lead_summary`, which production holds with a different body (it is dropped
  by signature, so the body does not matter). Two functions R4 does not touch differ too:
  `admin_update_player` (production's names no contact column) and `get_settings_audit_log`
  (production's is still admin-gated). Exactly the functions the build names as using a dropped
  object do so in production too, and the same five use `contact_info` (coaches and
  organizations). No view, policy or publication names a dropped object. The dependents of the
  five dropped columns are their two checks and two defaults, and of `coach_interested_programs`
  its policy, trigger, keys, indexes and defaults. Counts: `players` 0 (none with a contact or
  guardian contact), `profiles` 4 (0 cards saved), `coach_interested_programs` 0, `coaches` 130
  (0 `interested`, 0 with a phone), import jobs with a `coach_leads` summary 0, organizations
  storing `coach_directory` 0, `profile.contact_card_updated` audit rows 0, members other than
  admins 0, `email_log` 0.
- **The UI.** The player record has no Guardians tab; the roster shows no guardian contacts; the
  Staff tab shows no email or phone; the account page has no contact card
  (`ContactCardSettings.jsx` and `utils/contactCard.js` deleted); the coach home has no coach
  directory; the Coaches page stops reading `coach_interested_programs` (a coach's programs are the
  divisions of their teams; the "from <player>" note and its search key go); `utils/coachLeads.js`,
  unused since R0, is deleted. The mock twin follows the SQL (removed RPCs fall through to the
  client's PGRST202 refusal).
- **Tests.**
  - pgTAP: `contact_surfaces_removed.sql` (19): the objects are gone, with a control; the
    catalogue equals the two admin reads; a coach is refused both; the staff read is names and
    roles; an admin still reads member and coach sign-in emails; a `guardian_contacts` patch is
    refused. Run against `origin/main` it fails the catalogue (the staff, roster and directory
    reads, and `admin_create_player` and `admin_update_player`, which returned `players` rows with
    the contact columns) and the coach's member-list refusal. `coach_leads.sql` is deleted;
    `server_side_reads.sql` (17), `rls_policy_matrix.sql`, `import_allowlist.sql`,
    `finalize_import_reimport_coalesce.sql` (the guardian preservation case becomes the preferred
    name, the same coalesce), `import_rpc_readiness_contract.sql` (9) and
    `guardian_view_removed.sql` (its control read `get_coach_directory`) lose their contact cases.
  - Smokes run at head: the new `20261025010000` smoke (the scan and the catalogue each shown to
    fire on a planted probe; the reads; the player writers run without the columns; posture).
    `20261021010000`, `20261022010000` and `20261024010000` lose their contact, card and directory
    cases; `20261021040000` counts 37 pinned functions (`upsert_coach_leads` was one).
  - Vitest: the account page offers no contact card, the player record no Guardians tab, the coach
    home no directory (whatever a stored `coach_directory` says), and the team page no contact on
    the roster or the staff (each fails on `origin/main`); the mock reads return no contact; the
    mock member list refuses a coach (fails on `origin/main`); the tombstone census pins 21 sites.
    The roster and staff fixtures still carry contacts, as the database returns them until CI
    applies the migration after the frontend ships.
  - E2E: `privacy_server_reads.feature` checks a coach sees no phone or email link and loses the
    contact card scenario; `contact_surfaces.feature` is new: an admin sees a coach's sign-in email
    on the Coaches page and no guardians on a player record; a coach is offered no contact card and
    no coach directory.
- **Harness.** The revert is checked by a catalogue fingerprint against a build at
  `20261024010000` (41 rows). The purge, patch helper, finalizer, roster, staff and member plants
  that aimed at bodies R4 replaces are re-aimed at `$M42`; the directory plant ("the directory
  ignores its setting"), the roster guardian-contact plant and the unshared-card plant retire with
  what they mutated. Eight M42 plants (three refused by the migration itself: an email column put
  back on the staff read; the purge still writing `guardian_contacts`; and `players.contact_info`
  left in place, which leaves `admin_create_player` and `admin_update_player` returning rows with a
  contact column) and three R42 plants are added. Each new or re-aimed plant was applied by hand
  in its own copy of the tree and the harness run: each failed with its expected check.
- **Found for later PRs, not done here.** `email_log` (no reader or writer in the app; 0 rows) is
  readable by any member (`email_log_select_member`) and carries `recipient_email`.
  `organizations.contact_info` is member-readable; it holds the league's settings (its timezone),
  not a person's, but nothing stops a contact being written there. `coaches.phone` and
  `coaches.contact_info` (above). Production's `admin_update_player` and `get_settings_audit_log`
  bodies differ from the repo's (drift; neither leaks a contact). R5: `finalize_import_job` has
  been copied whole three times now (R0, R1, R4); R5 copies it again. R6: `org_flag` is ready for
  the score entry and standings settings. R7: the catalogue check covers RPCs only; a coach export
  built in the browser from tables a coach can read is covered by R7's own test.

## Docs updated across the PRs

AGENTS.md section 2 (data rules), `docs/agents-reference.md`, `README.md`,
`docs/security/rls-policies.md`, `docs/architecture/gotsport-import-contract.md` (its "dropped" list
is false today for guardian addresses, phones and the coach's birth date),
`docs/architecture/data-modeling.md`, `docs/architecture/frontend-architecture.md`,
`docs/architecture/persistence-rpc-layer.md`, `docs/operations/ENVIRONMENT.md`
(`TEST_PARENT_EMAIL`), the Phase A decisions and the core roadmap.
