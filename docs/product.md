# SquadLogic: product

Last changed: 2026-10-22 · Status: **draft for owner confirmation** (drafted with the demo-mode plan,
`docs/changes/2026-10-22-demo-mode.md`, from AGENTS.md sections 1-2, the README and the owner's
decisions of 2026-10-20 and 2026-10-22; nothing here is new policy until the owner confirms it).

## Mission

SquadLogic turns a youth recreational league's completed registration export (GotSport, Byga and
similar) into balanced teams and conflict-aware game and practice schedules, so the league's
volunteer administrators spend their season on the league rather than on spreadsheets. It is an
administrators' tool: registration, payments and family communication stay on the league's own
registration platform (owner, 2026-10-22).

## Users

| User                                  | Comes to                                                                                                                                                                                                     | Can't be assumed to                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| League administrator (admin or staff) | Import a registration export, form teams (or keep teams already formed elsewhere), add late players, set fields and permits, schedule games and practices (coach preferences considered), publish and export | Know SQL or CSV formats, or have time; they are volunteers |
| Prospective league (demo visitor)     | Try the product on a ready-made placeholder league for 30 minutes, without an account                                                                                                                        | Want to give an email address, or know how to self-host    |

Players, guardians, coaches and the public are **not** users: nobody but league administrators
(admin or staff, in one organization or several) signs in, and there are no coach, family or
public pages. Coaches are imported data that administrators manage: they anchor teams, are
assigned to them and appear in the administrators' exports. Administrators send schedules to
coaches and families themselves (exports: CSV, XLSX, ICS, or a team's calendar link), using the
contacts their registration platform holds (owner, 2026-10-27;
`docs/changes/2026-10-27-admin-only.md`).

## Non-goals

- Public club websites or a CMS; billing, payments or merchandise; sponsor management; storing
  documents about people (waivers, IDs, birth certificates); AI assistants — AGENTS.md section 2,
  the hard exclusions.
- Registration: forms, windows and submissions happen on the league's registration platform; the
  in-app registration flow is removed (owner, 2026-10-22).
- Guardian accounts, family views, availability marking (RSVP), and paperwork compliance tracking
  — removed (owner, 2026-10-22).
- Medical or emergency information — dropped by owner decision 2026-10-20 (Phase A1).
- Converting a demo league into a real one — the demo's data are placeholders.

## Constraints

- **Minors' data, minimised:** players are stored with name, division, team and the import's
  optional play-up flag; birthdates are read at import for teaming and dropped after teaming;
  guardian names and contact details are never stored. Coaches are stored with name and email
  (the import's key and an administrator's contact; no coach signs in); only administrators see coach contact details. Every read goes through RLS;
  no real personal data in the repository — AGENTS.md section 2; owner, 2026-10-22.
- **Hosting on free plans:** Supabase Free (500 MB database before read-only, 50,000 monthly
  active users, 1 GB storage) and Vercel Hobby (100 deployments a day) — `docs/operations/ci-cd.md`
  and Supabase's usage docs, checked 2026-10-22.
- **The input is a registration export** whose columns the league does not control; the import
  adapts to it, not the other way round — the GotSport exports in `fixtures/`.
- **One officially hosted deployment** (named only in deployment configuration); anyone may run
  their own from the repository — owner, 2026-10-22.

## Glossary

| Term        | Means                                                                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Season      | One league year's schedule window and settings (`season_settings`).                                                                                                                    |
| Program     | A named group of divisions within a season (for example Junior: U7-U8 boys and girls) that teaming groups by; admins create, edit, delete and merge them — owner, 2026-10-22; Phase E. |
| Division    | An age group and gender (for example U12 girls) that teams form within; in at most one program, which admins change.                                                                   |
| Age group   | A player's natural age with the league's cutoff (August 1 in the example league).                                                                                                      |
| Cohort      | A practice-only team in a division that plays no games (the U4 cohorts).                                                                                                               |
| Demo league | A private, 30-minute copy of the placeholder league in `fixtures/demo-2026`.                                                                                                           |

## History

| Date       | Change                                                                                                                                                                         | Why                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| 2026-10-22 | First version, drafted for owner confirmation                                                                                                                                  | `prompts/plan-change.md` plans against this file; none existed |
| 2026-10-22 | Admin-focused scope: no registration, guardian view, RSVP or compliance; guardian contacts not stored; birthdates dropped after teaming; coach view narrowed; schedule exports | Owner, 2026-10-22                                              |
