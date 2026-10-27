# Play-up by request, flagged for admins; the waitlist exception

Status: **draft for owner approval** (AGENTS.md rule 14: team generation and persistence). Owner,
2026-10-27: "The play-up behavior should have a flag for admin(s) to ensure admins are aware of
all players requesting to play up. Many clubs have different rules, such as play-up only with a
parent of the play-up player(s) coaching the team, etc. So rather than restrict this outright,
default toward everyone playing in their own division, with play-up available as a mappable column
for the initial import (same with years of experience and skill level, in case the admin already
has those at time of initial import.)" And: "A buddy doesn't automatically remove a player from
the waitlist, unless it is a player requested specifically by a coach (such as their child's
buddy)." Code read at `origin/main` e655449 (_statically reviewed_).

## Today

- **Play-up is decided by a fixed rule** (`packages/core/src/playUp.js`, `applyPlayUpEligibility`):
  a player in a division older than their natural age is allowed there only when sanctioned (route
  A: their parent coaches that division; route B: a mutual buddy who is a coach's child belonging
  there); otherwise blocked and not placed (B2). Play-down is always blocked.
- **The import reads a play-up column but the teams never see it after the session.** The
  finalizer stores the GotSport question ("are you coaching so this player can play up a
  division?", or a `play_up` column) as text in `custom_attributes.play_up`
  (`20261101010000:478-547`). `players.play_up_requested` exists (boolean) but no import writes it,
  and the player patch cannot set it. Only the Teams page reads a `play_up_requested` value, from
  the file row during the import session (`TeamAnalysisPage.jsx:540`).
- **Years of experience and skill level are mappable at import already** (`years_played`,
  `skill_tier`, `skill_level`; `docs/architecture/gotsport-import-contract.md`), and an admin can
  edit them. Nothing to change there; E3c adds the later evaluations import.
- **Waitlist (#671):** a waitlisted player is held out of every team, buddy or not.

## Design

1. **Everyone plays in their own division by default.** A player whose division is older than
   their natural age is a play-up. Without a request, the Teams page places them in their own
   age division and lists them under a new **Play-up** section: "Registered in U12 but plays in
   U10 (no play-up request)". Nothing is blocked any more for an unrequested play-up.
2. **A requested play-up is honoured and always flagged.** `players.play_up_requested` becomes
   the stored request: the player import maps a play-up column to it (yes/true/1/x read as yes;
   anything else no), and an admin can set or clear it on the player (patch, audited). A
   requested player plays in the older division they registered for, and the **Play-up** section
   lists every one with the facts an admin needs for the club's own rules: natural age and
   division, the division they play in, whether a parent coaches that division (from the
   coach-to-child link), and whether a buddy is in it. Nothing is approved or refused by the app.
   A request with no older division to play in (registered in their own) is listed as "requested
   play-up, registered in their own division" for the admin to move.
3. **Play-down** (a division younger than natural age) is not honoured: the player is placed in
   their own division and listed, as today's flag says, but no longer held out.
4. **The fixed sanction rule goes** (routes A and B, the buddy sanction #671 adjusted, the
   `play_up_blocked` hold). Eligibility blocking remains only where a division cannot hold the
   player at all (no division for their age): listed, not placed, with the reason.
5. **Waitlist exception.** A waitlisted player comes off the waitlist only when a coach asked for
   them: the buddy (under the league's buddy rule) of a coach's linked child, the link coming from
   the coach import's child column (admin-only plan, S7). They are placed on the coach's team with
   that child and listed: "Taken off the waitlist: buddy of [child], Coach [name]'s child". Any
   other buddy of a waitlisted player does nothing. When the admin saves the teams, the player's
   status becomes active (audited, the existing status write).

## Persistence

One migration: the player finalizer writes `play_up_requested` from the play-up column (keeping
the text copy in `custom_attributes` only where an organization declared it as its own field);
`sanitize_player_patch` / `apply_player_patch` accept `play_up_requested` (boolean). md5 guards,
revert, smoke, pgTAP, harness plant, snapshot, as usual. Production has 0 players, so no backfill.

## Tests

- Core: unrequested play-up placed in own division and listed; requested play-up placed in the
  older division and listed with its facts (parent coaches / buddy there / neither); play-down
  placed in own division and listed; no-division player listed and not placed; the waitlist
  exception (a coach's child's buddy is placed with them; another buddy stays waitlisted; a
  waitlisted player with no coach link stays out); output unchanged for a league with no play-up,
  play-down or waitlisted player (B2 golden). Season fixture suite.
- pgTAP: the import stores `play_up_requested` from each accepted spelling; the patch sets and
  clears it and refuses a non-boolean.
- E2E (mock): import with a play-up column, generate, the Play-up section lists the requested
  player in the older division and an unrequested one in their own.

## Owner decisions (recommendation in each)

1. **Unrequested play-up**: place in their own division and list it (recommended), or keep them
   in the registered division and list it.
2. **Play-down**: place in their own division and list it (recommended), or honour it like a
   requested play-up.
3. **Waitlist exception**: the player comes off the waitlist when the teams are saved
   (recommended), or stays waitlisted on paper while placed.

## Order

After the admin-only PRs (the waitlist exception needs S7's coach-to-child link). One PR.
