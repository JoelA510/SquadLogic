# SquadLogic: product

Last changed: 2026-10-22 · Status: **draft for owner confirmation** (drafted with the demo-mode plan,
`docs/changes/2026-10-22-demo-mode.md`, from AGENTS.md sections 1-2, the README and the owner's
decisions of 2026-10-20 and 2026-10-22; nothing here is new policy until the owner confirms it).

## Mission

SquadLogic turns a youth recreational league's registration export (GotSport and similar) into
balanced teams and conflict-aware game and practice schedules, so the league's volunteer
administrators spend their season on the league rather than on spreadsheets.

## Users

| User                                  | Comes to                                                                                                                               | Can't be assumed to                                                                         |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| League administrator (admin or staff) | Import registrations, form teams, schedule games and practices, publish, manage fields and permits                                     | Know SQL or CSV formats, or have time; they are volunteers                                  |
| Coach                                 | See their team, its roster and contacts (as the access table allows), schedules and permits (view only), and enter their team's scores | Be at a desk: they use a phone at the field                                                 |
| Guardian                              | See their child's team, schedule and RSVP                                                                                              | Have an account before they are invited, or read anything but their own child's information |
| Prospective league (demo visitor)     | Try the product on a ready-made placeholder league for an hour, without an account                                                     | Want to give an email address, or know how to self-host                                     |

Players are minors and are **not** users: they never sign in. The public is not a user either (no
public club pages).

## Non-goals

- Public club websites or a CMS; billing, payments or merchandise; sponsor management; storing
  documents about people (waivers, IDs, birth certificates); AI assistants — AGENTS.md section 2,
  the hard exclusions.
- Medical or emergency information — dropped by owner decision 2026-10-20 (Phase A1); only the
  paperwork booleans remain.
- Converting a demo league into a real one — the demo's data are placeholders.

## Constraints

- **Minors' data:** store only what scheduling and communication need (name, email, role, team);
  every read goes through RLS; no real personal data in the repository — AGENTS.md section 2.
- **Hosting on free plans:** Supabase Free (500 MB database before read-only, 50,000 monthly
  active users, 1 GB storage) and Vercel Hobby (100 deployments a day) — `docs/operations/ci-cd.md`
  and Supabase's usage docs, checked 2026-10-22.
- **The input is a registration export** whose columns the league does not control; the import
  adapts to it, not the other way round — the GotSport exports in `fixtures/`.
- **One officially hosted deployment** (named only in deployment configuration); anyone may run
  their own from the repository — owner, 2026-10-22.

## Glossary

| Term        | Means                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Season      | One league year's schedule window and settings (`season_settings`).                                                |
| Program     | A registration product spanning divisions (for example Junior: U7-U8 boys and girls) — owner, 2026-10-22; Phase E. |
| Division    | An age group and gender (for example U12 girls) that teams form within; each is in one program.                    |
| Age group   | A player's natural age with the league's cutoff (August 1 in the example league).                                  |
| Cohort      | A practice-only team in a division that plays no games (the U4 cohorts).                                           |
| Demo league | A private, hour-long copy of the placeholder league in `fixtures/demo-2026`.                                       |

## History

| Date       | Change                                        | Why                                                            |
| ---------- | --------------------------------------------- | -------------------------------------------------------------- |
| 2026-10-22 | First version, drafted for owner confirmation | `prompts/plan-change.md` plans against this file; none existed |
