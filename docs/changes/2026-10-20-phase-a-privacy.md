# Phase A: privacy and access

Status: **approved 2026-10-20**; A1 built (migration `20261020020000`); A2 built (`20261020030000`, `20261020040000`); A3 built (`20261021010000`, `20261021020000`) (AGENTS.md rule 14: persistence and authorization). It
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

## A3 as built (decided while building, 2026-10-21)

The caller search (*executed*: every `supabase.from(...)` on `players`, `coaches`,
`team_players`, `team_coach_assignments` and `profile_players` in `frontend/src`, every RPC the
frontend calls, and every Edge Function) found these non-admin readers. Admin pages (behind
`MANAGE_ORGANIZATION` or the admin home) keep direct table access and are not listed.

| Caller | Reads | Becomes |
| --- | --- | --- |
| `CoachDashboard` (`DashboardPage`) | every coach row, matched in the browser by user id, profile id **or email** | own row by `user_id` (own-row policy) and `get_my_coached_team_ids` |
| `CoachPreferenceRequests`, `usePracticeLightingOverrides` | own coach row by `user_id`; own assignments | unchanged: own-row policies |
| `ParentDashboard`, `RegistrationFlow`, the portal's "my players" | `profile_players` and the linked players | unchanged: own-children policies |
| Team portal roster (`useTeamPortal`) | `team_players` joined to players: names, gender, jersey, years played, rating, coaching interest | `get_team_roster`: names, jersey number, guardian contacts per the table |
| `TeamRecordPage` Staff tab | head coach row, `select('*')` | `get_team_staff`: every current coach, name, phone, email |
| `TeamRecordPage` calendar link | `teams.calendar_token` through the portal's `select('*')`: **any member reads any team's feed token** | `team_calendar_tokens`, readable per the table |
| `TeamAnalysisPage` (`/teams`) | the teaming workspace; coaches reach it through `VIEW_ALL_TEAMS` | admin-only route; coaches lose `VIEW_ALL_TEAMS` ("coaches see their own team only") |
| `ScoresPage`, `LeagueStandings` | `update_game_score` admits **any** coach for **any** game | admits a current coach of either team; the pages offer editing only there |
| `calendar-feed` (Edge Function, service role) | `teams.calendar_token` | `team_calendar_tokens` |

Decisions the plan left open:

1. **Guardian identity is `profile_players`.** In-app registration writes it; imported players
   have none. `link_my_guardian_records()` adds the missing half, mirroring
   `link_my_coach_record()`: after sign-in it links the caller to each player in their
   organizations whose imported guardian email or alternate email matches their verified auth
   email, case-insensitively. Idempotent and audited (`guardian.linked`). Without it, the guardian
   column of the table would admit only families who registered in the app.
2. **The contact card is three-state.** `profiles.share_contact` is NULL until the user saves the
   card, and imported data shows; `true` shows the card's phone and email; `false` shows nothing.
   A linked coach or guardian who never opens the card keeps the imported details they had.
3. **"Primary contact" is the first imported guardian contact** (the registration's guardian 1).
   It carries name, email and phone where imported; the alternate email is not shared.
4. **The coach directory is a section on the coach home**, so the flag gates something; it lists
   every coach with a current assignment, name, phone and email.
5. **Built as two PRs.** A3a is additive: identity helpers, guardian linking, contact card (A2c),
   the two flags, the server-side reads, and the callers moved onto them, with every table still
   readable as before. A3b restricts: the new policies, the calendar token table,
   `rotate_calendar_token` and `update_game_score`'s rule, `staging_*`, and the matrix rewrite.
   Between the two, nothing is hidden that a page still reads directly.
6. **A removed member keeps no read.** Every own-row branch (players, roster rows and their own
   `profile_players` links for a guardian, the coach row and assignments for a coach) also
   requires current membership, since the `profile_players` and `coaches.user_id` links outlive a
   removal.
7. **The restriction is enforced, not declared.** Postgres ORs permissive policies, so A3b's
   migration refuses to commit if any other `SELECT` or `ALL` policy is left on a restricted
   table. Production had exactly the one it drops on each (read 2026-10-21).
8. **A coach's Scores page asks the server for their games** (`home_team_id` or `away_team_id`
   in their coached teams) rather than filtering the league's latest 200 in the browser, and
   says so when the coached teams cannot be read.

## Not in Phase A

Medical, emergency or demographic fields of any kind; a guardian-side editor for imported
guardian contacts beyond the contact card; any public roster.
