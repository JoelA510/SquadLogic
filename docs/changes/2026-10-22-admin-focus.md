# Admin focus: removals, data minimisation, coach view and exports

Status: **draft for owner approval** (AGENTS.md rule 14: persistence, the domain model and roles).
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

Each PR: migration, `docs/sql/<v>_revert.sql` and `_smoke.sql`, pgTAP, the mock twin, Vitest and
E2E where the UI changes, `supabase/catalog-snapshot.json` regenerated, docs in the same PR. A revert
restores structure, never deleted personal data (stated in each revert's header).

| PR                                                | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Tests (each proven against a planted defect)                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R0** Data minimisation at import, and the purge | Player and coach imports keep an **allowlist** of canonical fields; everything else is dropped in `import-validation` and again in each finalizer (callable directly). Player allowlist: name, external registration id, age group, gender, division, team placement columns (Team Name/Age/Gender), play-up, buddy request, years played. Coach allowlist: name, sign-in email, external registration id, requested division, years coached, child's name/gender/birth date **only to resolve the coach's player and then discarded**, playing up, preferred co-coach. Staging rows are deleted when their job finalizes or fails, and a daily job deletes any older than 24 hours. Migration: every `coaches.custom_attributes` reduced to the allowlist; `coaches.phone` and `contact_info` dropped (decision 2); both staging tables emptied; personal values removed from existing `audit_log.metadata`. | pgTAP: a finalize with a `Guardian 1 Mobile Phone Number` column stores it nowhere (catalogue scan of every jsonb and text column of the touched tables); staging is empty after finalize; the purge leaves zero coach keys outside the allowlist. Vitest: the demo fixture's coach and player files through both normalizers keep only allowlisted keys. |
| **R1** Registration flow and Compliance           | Routes `/register/:formId` and the Registration Forms page; `submit_registration`, `admin_create_registration_form`, `admin_update_registration_form`; tables `registration_forms`, `registrations`; `view_compliance_stats` and the Reports chart; `players.paid`, `waiver_received`, `medical_form_received` (decision 1) and their patch paths; `get_team_portal_medical_status`; `coach_update_player_compliance`; the Compliance page and nav badge. Players `submit_registration` created stay (none in production).                                                                                                                                                                                                                                                                                                                                                                                    | pgTAP: the functions and tables are absent; `definer_function_grants.sql` drops its anon `submit_registration` assertion; Reports renders without the axis. E2E: `registration_compliance.feature` deleted; `reporting.feature` updated.                                                                                                                  |
| **R2** RSVP and team chat                         | `admin_delete_team` and its mock rewritten without `event_rsvps` first; `useTeamPortal` stops reading RSVPs; then `event_rsvps`, `upsert_team_event_rsvp`, the RSVP UI, `team_messages` and `create_team_message` (chat is family communication; decision 5). `practiceReaderCensus` drops the RSVP reader.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | pgTAP `admin_delete_team_exceptions.sql` passes with the new cascade set; the team page renders for a coach with the tables gone.                                                                                                                                                                                                                         |
| **R3** Guardian view and roles                    | New `players` / `team_players` SELECT policies (admins; a coach for their own teams' players' names only) **before** dropping `profile_players` and `link_my_guardian_records`; guardian arms out of `get_team_roster`, `get_team_staff` and the calendar-token policy; the `guardian_contact_sharing` setting; roles `parent` and `player` removed from members, invites and role checks (none in production); the parent dashboard and nav; pgTAP and E2E personas moved to a coach.                                                                                                                                                                                                                                                                                                                                                                                                                        | pgTAP `rls_policy_matrix.sql` with the coach persona: an admin reads all players, a coach only names on their teams, nobody else any; inviting a `parent` is refused.                                                                                                                                                                                     |
| **R4** Contact surfaces                           | `players.contact_info` and `guardian_contacts` dropped; the contact card columns on `profiles` and `set_my_contact_card`; `get_coach_directory`; contact fields out of `get_team_staff`; the coach leads path keeps name and email only. Admins see coach email (sign-in) in Coaches.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | pgTAP: no read a coach can call returns an email or phone (catalogue of the coach-callable functions' result columns).                                                                                                                                                                                                                                    |
| **R5** Birthdates                                 | The import stores the player's **natural age** (the age group the export states, or computed at import with the season's cutoff) and never `date_of_birth`; `resolveNaturalAge` reads it; `finalize_import_job` promotes rows without a stored birth date; teaming in the browser still reads the file's birth dates during the import session. Migration drops `players.date_of_birth` and `birth_year` (0 rows today). Decision 3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Core unit: play-up eligibility from natural age equals the DOB result on the season fixture (`fixtures/season-2026/`, full suite); pgTAP: no column named like birth or dob on `players`, `coaches` or staging.                                                                                                                                           |
| **R6** Coach view                                 | Coaches lose `MANAGE_SCHEDULE` and the admin scheduling pages; the coach home shows their own schedule (games and practices), a new `get_my_division_teams()` (team names and coach names in their divisions, no contacts) and permits for the fields of their scheduled events (Phase C's coach read narrowed to those fields); the broken "My Team" nav link fixed; practice preferences stay (decision 4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Vitest per page for the coach role; pgTAP: `get_my_division_teams` returns no contact column and nothing outside the coach's divisions. E2E: coach journey.                                                                                                                                                                                               |
| **R7** Exports                                    | Admins: all-teams and per-team schedule as CSV (exists) and XLSX, per-team ICS download. Coaches: their teams' schedule as CSV, XLSX and ICS. No email or phone column in any coach export (the admin "Coach Emails" column stays admin-only). XLSX needs one dependency (decision 6), flagged in the PR.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Vitest: the export's rows equal the schedule's events (planted: an event dropped); the coach export has no contact column; the ICS parses and round-trips its events.                                                                                                                                                                                     |

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

## Decisions

1. `players.paid`: _recommended_ drop with the compliance flags (payments are a non-goal; the
   import fills it from the export today).
2. Coach phone: _recommended_ not stored (contacts live on the registration platform; the email
   stays because coaches sign in with it).
3. Birthdates: _recommended_ never stored server-side; a stored natural age replaces them. The
   owner's "dropped after teaming" is met at import, since teaming reads the file in the browser.
   The alternative, store and clear after a roster is published, needs a trigger on publish and
   re-imports restore the date (`finalize_import_job:428`).
4. Coach practice preferences: _recommended_ kept (the owner named them as a scheduling input).
   Coach score entry and standings: _recommended_ admin-only. Lighting requests from coaches:
   _recommended_ admin-only.
5. Team chat: _recommended_ removed with RSVP (with no families signed in, it has no audience).
6. XLSX library: chosen at R7 against the dependency policy (a release older than `.npmrc`'s
   wait, no high advisory); CSV and ICS need none.

## Docs updated across the PRs

AGENTS.md section 2 (data rules), `docs/agents-reference.md`, `README.md`,
`docs/security/rls-policies.md`, `docs/architecture/gotsport-import-contract.md` (its "dropped"
list is false today for guardian addresses, phones and the coach's birth date),
`docs/architecture/data-modeling.md`, `docs/architecture/frontend-architecture.md`,
`docs/architecture/persistence-rpc-layer.md`, `docs/operations/ENVIRONMENT.md` (`TEST_PARENT_EMAIL`),
the Phase A decisions and the core roadmap.
