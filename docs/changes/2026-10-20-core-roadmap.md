# Core roadmap after the owner's decisions (2026-10-20)

Status: **order approved 2026-10-20**; each phase that touches persistence, the domain model or the
solver gets its own short plan before it is built (AGENTS.md rule 14). Phase A is built
(`2026-10-20-phase-a-privacy.md`); the plans for B to E are written (2026-10-22) and await
approval.

## The product's core, in the owner's words

Teaming (recommended values per program from the number registered, adjustable, with warnings when
teams would have too few or too many players), scheduling practices and games, and managing fields,
including storing permits so a coach can produce one when asked. Work outside that core is kept
minimal.

## Decisions recorded

On the five research defects (`2026-10-20-research-defects.md`):

| # | Decision |
| --- | --- |
| 1.1 | **No medical information in the app.** Medical, emergency-contact, physician and insurance data are out of scope: dropped at import and removed from the schema. Coaches get that from the registration platform (GotSport, TeamSnap, Byga). Paperwork *booleans* (`medical_form_received`, `waiver_received`) stay: they are status flags, not medical data (AGENTS.md §2 allows boolean toggles). |
| 1.2 | A team's coaches see its players' guardian contacts. Own team only. |
| 1.3 | A team's guardians see the **names and primary contact** of the players on their team (carpooling). A league setting restricts this to their own children. |
| 1.4 | `staff` is treated as an admin. |
| 1.5 | The team's coaches' contact details are shown to that team's guardians, coaches and admins. Coaches also see **other coaches'** phone and email (equipment returns and the like). A league setting disables the coach directory. Every user can edit or remove their own contact details. |
| 3 | Missing paperwork **flags**; it never blocks a placement. |
| 5.1 | As recommended: divisions with their configuration, forms as closed drafts, the timezone. |
| 5.2 | One active season. Within it, an organization can run **several programs at once** (for example competitive and recreational for the same ages). League admins see field reservations across all programs. |
| 5.3 | Blackouts do not recur. |
| Registration | A per-program registration window, set by club admins and optional. It defaults to opening May 1 of the following year, and is easy to change per program. |

## What the investigation found (*statically reviewed*, production read-only where noted)

- **Medical data mostly never arrives**, but not entirely. The client filter strips medical,
  emergency, physician and insurance columns before upload. However:
  - "Conditions" and "Special Needs" pass the filter into `players.custom_attributes`;
  - the column mapper's "Medical Info" option writes `players.medical_info`.

  Production has 0 players (*executed*), so removal loses nothing.
- **Buddy requests do not reach team generation.** The import stores `players.buddy_request` (a
  name), but `TeamAnalysisPage.toGeneratorPlayer` emits no buddy field, so the generator's buddy
  evaluator never sees one. The `player_buddies` table is built only from codes. Only the
  TeamBuilder auto-balance matches buddies by name.
- **Coach accounts are never linked.** Coach features identify a coach by `coaches.user_id`, and
  no code ever sets it. A signed-in coach has no coach identity.
- **Profiles are self-editable without a column guard** (*executed*): a user can set their own
  `profiles.role` and `organization_id`. No server-side authorization reads either column, so this
  is not an escalation, but the UI and some settings modules trust them.
- **Team-size diagnostics exist but are never shown.** The generator computes
  `teamsBelowMinRoster` and `capacityViolations`, and the page shows only config-consistency
  errors.
- **Programs are division names**, computed in the UI. There is no program column, no
  registration dates, and nothing stored for permits (the only mention is a blackout reason).

## Order

| Phase | What | Why this position | Plan |
| --- | --- | --- | --- |
| **A** | Privacy and access: drop medical data, the access rules above with their two league settings, self-editable contact details, coach account linking, the profile column guard, score authorization, calendar token | Must precede real users; the cheapest it will ever be | `phase-a-privacy.md` (this PR) |
| **B** | Teaming: buddy requests reach the generator; eligibility flags and unplaced players (item 3); recommended team counts per program and visible too-few/too-many warnings | The core flow; buddies are silently broken today | `2026-10-22-phase-b-teaming.md` |
| **C** | Fields: permit records per field or venue (issuer, dates, scope, file), visible to admins and coaches, with an expiry warning | Core; nothing exists yet | `2026-10-22-phase-c-permits.md` |
| **D** | Scheduling: home/away balance (item 4); the `admin_delete_team` and UTC-idiom plans already merged | Correctness fixes in the core flow | `admin_delete_team` and the UTC idiom are built (#632, #633); item 4: `2026-10-22-phase-d-home-away.md` |
| **E** | Seasons and programs: rollover (item 5), a program attribute on divisions, per-program registration windows, one active season | Needed before next registration (default May 1) | `2026-10-22-phase-e-seasons.md` |

**UI-only work** in the core needs no plan and can go first: showing the team-size warnings the
generator already computes. It runs alongside A.

## Out of scope by this decision

No new medical, emergency or demographic fields; no document storage beyond facility permits.
AGENTS.md §2.3 ("no file uploads for waivers, IDs, birth certs") is about documents on people.
Permits are documents on facilities, and this PR adds a sentence saying so, so a future agent does
not refuse the Phase C work.
