# Phase A: privacy and access

Status: **approved 2026-10-20**; A1 built (migration `20261020020000`) (AGENTS.md rule 14: persistence and authorization). It
applies the owner's decisions of 2026-10-20 (`2026-10-20-core-roadmap.md`) to research items 1
and 2. It ships as three PRs, in this order; each is reviewed once before it opens.

## A1. No medical data (small)

**Today** (*statically reviewed*; production has 0 players, *executed*):
- the client filter (`gotsportCanonicalizer.js`) strips medical, emergency, physician and
  insurance columns before upload;
- "Conditions" and "Special Needs" pass it and land in `players.custom_attributes`;
- the column mapper's "Medical Info" option writes `players.medical_info`;
- the filter runs only in the browser, so a direct call to the import Edge Function stores
  whatever it is sent, in `staging_players.raw_payload` too.

**Change:**
1. One sensitive-header rule, shared by the client filter and the `import-validation` Edge
   Function. The Edge Function strips before it stores anything. The rule adds conditions,
   special needs, medication, diagnosis, disability and the `medical_info` header form.
2. The column mapper loses its "Medical Info" target, and `telemetryUtils` its reference.
3. The migration drops `players.medical_info` and `players.emergency_contacts`, and
   `finalize_import_job` stops writing them. Its body is replaced from the latest definition
   (`20260726000300`) with only those lines removed. The revert restores both.
4. The paperwork booleans (`medical_form_received`, `waiver_received`) stay.

**Tests:**
- a CSV carrying each sensitive header, uploaded through the UI path and through the Edge
  Function directly, leaves no trace in `players` (`custom_attributes` included) or in
  `staging_players`;
- the plant (the old filter) fails that test.

## A2. Identity: who the caller is (medium)

**Built as three PRs** (decided while building): A2a, staff are admins (migration
`20261020030000`); A2b, the profile column guard and `link_my_coach_record`; A2c, the contact card,
whose display rule ships with A3's server-side reads so no field is stored before something reads
it.

Access rules are only as good as knowing who is a coach, an admin or a guardian. Three gaps
come first:

1. **Coach accounts are linked.** No code sets `coaches.user_id`, so no signed-in coach has a
   coach identity. A `link_my_coach_record()` RPC, called after sign-in, links the caller's
   account to the coach row in their organization whose email matches their verified auth email,
   case-insensitively. It is idempotent, refuses a row already linked to another account, and is
   audited. Tests cover a match, no match, a row already linked to someone else, and a coach in
   another organization (never linked).
2. **Profiles can no longer self-edit `role` or `organization_id`** (*executed*: today they can).
   No server authorization reads them, but the UI and some settings modules trust them. Users may
   update only their own name, avatar and contact card (item 3), enforced by column privileges,
   with a test for each refused column.
3. **Staff are admins.** `is_org_admin` admits `staff`. Every policy and RPC that treats staff
   differently today is listed and aligned, and the frontend role map follows. A test asserts that
   staff and admins get the same answer from every admin RPC, enumerated from the catalogue.

**Contact card.** Each user gets a phone, an email and a "share my contact details" switch on
their profile, editable on the account page. Wherever the app shows a person's contact details,
a linked account's card wins over imported data, and a cleared or unshared card shows nothing.
That is how any user changes or removes their own details.

## A3. Who reads what (medium-large)

**Approach.** Admins and staff keep direct table access. Everyone else reads people's data only
through a few server-side reads that apply the rules below. That is fewer moving parts than
column-level grants, which would break every `select('*')` (an earlier review found more than a
dozen such callers).

| Data | Admin, staff | Current coach of the team | Guardian on the team | Other members |
| --- | --- | --- | --- | --- |
| Players on the team: names | yes | yes | yes | no |
| Players' guardian contacts | yes | yes (1.2) | primary contact of each teammate's guardian (1.3), unless the league restricts it to own children | no |
| Other player fields (DOB, registration history, custom attributes, notes) | yes | no | own children only | no |
| The team's coaches: name, phone, email | yes | yes | yes (1.5) | no |
| Other coaches' phone, email (coach directory) | yes | yes, unless the league disables it (1.5) | no | no |
| Team calendar link | yes | yes, and may rotate it | yes, read only | no |
| Set a game's score | yes | current coach of either team (item 2) | no | no |

**League settings.** Two organization flags, registered in the flag registry so the existing
settings page and audit trail carry them: "guardians see teammates' contact details" (default
on) and "coach directory" (default on). The server-side reads check them.

**Rules every read shares:**
- "Current coach" is a live `team_coach_assignments` row, judged on today's date in the
  team's season timezone (UTC when unset). It never uses `current_date`, which follows the caller's
  session zone.
- The lookups that map the caller to a coach or guardian run with definer rights, so restricting
  the tables does not lock out the people the rules admit. Every rule is tested in both
  directions: the person admitted gets the data, the person refused gets nothing.

**Calendar token.** The token moves out of `teams` into its own table, readable per the table
above. Moving it, rather than revoking one column, leaves every existing `teams` query working.
`rotate_calendar_token` gets the same rule, and the calendar feed reads the new table.

**Callers.** Every non-admin page that reads `players` or `coaches` moves to the server-side
reads. Known so far:
- the coach's own row: `CoachPreferenceRequests`, `usePracticeLightingOverrides` and
  `DashboardPage`, which use `link_my_coach_record`'s identity;
- `TeamRecordPage`'s Staff tab;
- the team portal;
- `ScoresPage` and `LeagueStandings`, which show score editing only where the caller may score.

Admin pages are unchanged. The plan's first task is a full search, and the list is completed
before any table is restricted.

**Found while building A1** (*executed*, production policies read 2026-10-20): `staging_players`
and `staging_import_rows` are readable by every organization member
(`is_org_member`), raw import payloads included. A3 narrows both to admins and staff.

**Tests:**
- `rls_policy_matrix.sql` (`:696-704`) is rewritten to the table above;
- pgTAP covers each row of the table, for every role, with the two settings on and off;
- the old policies are shown failing the new matrix;
- each migrated page has a test as a non-admin.

## Not in Phase A

Medical, emergency or demographic fields of any kind; a guardian-side editor for imported
guardian contacts beyond the contact card; any public roster.
