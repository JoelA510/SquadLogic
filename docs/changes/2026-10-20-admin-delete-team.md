# `admin_delete_team` refuses a team whose practices have exceptions (23503)

Status: **plan, for owner approval** (AGENTS.md rule 14: persistence). Requested by the owner
2026-10-20. Source: Codex review on #605 (the `persistence-rpc-layer.md` row), recorded in the
resume queue's flagged backlog.

## What is wrong

`admin_delete_team(p_team_id)` (migration `20260613000003`, unchanged since) checks the caller is
an org admin, runs `DELETE FROM public.teams WHERE id = p_team_id`, then audits `team.deleted`.
The delete cascades to `team_players`, `game_assignments`, `practice_assignments`, RSVPs and
messages, and to every `games` row in which the team is home or away (`games.home_team_id` and
`games.away_team_id` are both `ON DELETE CASCADE`), and sets `players.team_id` to null. So a team
delete also removes its opponents' games.

Migration `20260929000000` (practice writer v3) added `practice_exceptions` with
`assignment_id ... REFERENCES practice_assignments(id) ON DELETE RESTRICT`, on purpose: its header
says "any path that deletes an overridden series ... a team or organisation delete ... is a loud
23503, never an orphan". So deleting a team whose practice series carries any exception row (a
relocation or a TIME TBD window, live or withdrawn) fails:

- the whole transaction rolls back (nothing is deleted, nothing is audited);
- `TeamAnalysisPage.handleDeleteTeam` shows `Failed to delete team: update or delete on table
  "practice_assignments" violates foreign key constraint ...`, which tells an admin nothing they
  can act on, and there is no screen that removes a team's exceptions first.

**Evidence.** *Executed* (read-only, production catalogue, 2026-10-20): walking every foreign key
reachable from `teams` through `ON DELETE CASCADE`, the only `RESTRICT`/`NO ACTION` constraint on
the path is `practice_exceptions_assignment_fk`. So this is the one blocker; nothing else in the
cascade refuses. *Statically reviewed*: the RPC body, the v3 header, and
`TeamAnalysisPage.jsx:1180-1194`. Not reproduced against a database yet (the pgTAP below does that).

The sibling already solved the same problem one level down: `admin_cancel_practice_assignment`
(v3) withdraws the series' live exceptions, audits each `practice.exception_withdrawn`, deletes
every exception row while archiving it into its run's `scheduler_runs.results.archived_exceptions`
and into the audit row, and only then deletes the assignment. AGENTS.md: adopt the sibling's
contract rather than invent a third.

## Options

1. **Do the sibling's work for every practice series of the team, in the same transaction**, then
   delete the team. One audit row per withdrawn exception (as cancel writes), and `team.deleted`
   gains the counts and ids of what went with the team.
2. **Refuse clearly instead**: detect exceptions first and raise a named error
   (`TEAM_HAS_PRACTICE_EXCEPTIONS`, with the affected series), so the admin knows to cancel those
   practices first. Small, but there is no UI path for "cancel this team's practices", so the
   admin is still stuck.
3. **Change the foreign key to `ON DELETE CASCADE`.** Rejected: it undoes v3's deliberate guard
   for every other path (a raw delete or an organisation delete would orphan history silently).

**Recommendation: option 1.** It is what the sibling already does, it keeps the RESTRICT guard for
every other path, and the archive keeps the exception history the guard exists to protect.

## Design (option 1)

A new migration replaces `admin_delete_team(uuid)` (same signature, so callers and grants are
unchanged):

1. Load the team `FOR UPDATE`; refuse unknown (`P0002`) and non-admin (`42501`), as today. The
   row lock is held to the end of the transaction. Without it, a `persist_practice_schedule` save
   that commits between step 2 and step 4 could add a new exception, and the delete would hit
   the same 23503. The plan confirms that the practice writer takes a conflicting lock on the
   team (or its assignments) before it inserts an exception; if it does not, step 2 locks the
   team's `practice_assignments` rows `FOR UPDATE` too. A two-session test (a save waiting on
   the open delete) shows the save waits or fails cleanly, and the delete succeeds.
2. For every `practice_assignments` row of the team: withdraw its live exceptions
   (`withdrawn_at = now()`, `withdrawn_by = auth.uid()`), audit each as
   `practice.exception_withdrawn` with reason `team_deleted`, delete all its exception rows and
   append them to their run's `results.archived_exceptions`. This is a set-based version of
   `admin_cancel_practice_assignment`'s three steps (no per-row RPC call, so one admin check).
3. Delete the RSVPs the cascade would miss. `event_rsvps.reference_id` is polymorphic, with no
   foreign key. When this team's games cascade away, the opposing team's RSVPs to those games are
   left pointing at nothing. So, for the game ids captured before the delete, delete every RSVP
   with `event_type = 'game'`, in the team's organization, whose `reference_id` is one of them,
   whichever team it belongs to, and count it in the audit (`event_rsvps_deleted` covers both).
   The `event_type` filter matters: `reference_id` also holds practice-assignment ids, and the two
   tables' ids are not disjoint by construction. The pgTAP includes a practice RSVP whose
   `reference_id` equals a deleted game's id, and asserts it survives.
4. `DELETE FROM teams` as today; the cascade now has nothing to stop it.
5. `team.deleted`'s metadata records everything the delete takes with it, not only the name and
   division it records today. The counts are taken before the delete, in the same transaction:
   - a count for each table the cascade empties: `practice_assignments_deleted`,
     `game_assignments_deleted`, `team_players_deleted`, `event_rsvps_deleted`,
     `team_messages_deleted` and `team_coach_assignments_deleted` (coaching history included);
   - `games_deleted`, as a count and the ids, since each deleted game also removes a fixture from
     another team's schedule;
   - `withdrawn_exception_ids` and `archived_exceptions`.

   The plan re-walks the foreign keys from `teams` at build time (as the evidence above did), and
   a pgTAP assertion fails if a cascading table has no counter.

Uses `now()`, not `timezone('utc', now())` (see the companion plan
`2026-10-20-utc-now-idiom.md`).

## Decisions for the owner

1. **Option 1 vs 2** (recommended: 1).
2. **Should deleting a team that has a published or locked schedule need a second confirmation?**
   Today the UI's `window.confirm` is the only guard, and the RPC deletes locked practice rows and
   published games with the team. The field and venue retirement RPCs refuse with an affected-row
   list unless `p_confirm => true`. Recommendation: **not in this change**. Keep the signature, and
   record the counts in the audit row (step 5). Adding `p_confirm` and a preview dialog is a
   separate UI change if you want it.

## Tests

- pgTAP (`supabase/tests/admin_delete_team_exceptions.sql`): a team with one series carrying a
  live relocation and a withdrawn TIME TBD row. Then:
  - the delete succeeds;
  - the team, its assignments and its exceptions are gone;
  - each live exception has a `practice.exception_withdrawn` audit row;
  - `team.deleted` carries every count and the archived rows, each non-zero on the fixture: a
    rostered player, an RSVP, a message, a past coach assignment, and a game against another
    team (which is gone, and named in `games_deleted`);
  - the opposing team's RSVP to that game is gone too, and counted;
  - the run's `archived_exceptions` holds both rows.

  Plus a control: a non-admin is refused and nothing changes.
- **Plant:** run the same file against the old function body. It must fail with 23503.
- Mock client (`mockSupabaseClient.js` `admin_delete_team`): also tombstone the team's
  `practice_exceptions`, so the mock cannot pass a delete the real RPC refuses. The existing
  `tests/mockDeleteTombstones.test.js` gains the exceptions table.
- E2E: none new (the delete flow has no scenario today; the pgTAP is the proof).
- `docs/sql/<version>_revert.sql` restores the 20260613000003 body; `_smoke.sql` calls it on a
  seeded team with an exception. Catalogue snapshot regenerated; migration harness run.

## Risks

- Deleting a team now always succeeds for an admin, including one with live overrides that a
  family may be relying on. That is the point of the request, and the audit row records exactly
  what went.
- The cascade also deletes the opposing teams' games. That is today's behaviour, not a change,
  but it strengthens decision 2: a preview listing those games is the natural input to a
  `p_confirm`.
- The set-based withdrawal must match the sibling's archive shape exactly
  (`results.archived_exceptions` entries are the raw rows). A test compares the two paths on the
  same fixture.

Size: one migration, its revert and smoke files, one pgTAP file, and the mock and its test.
No UI change, unless decision 2 says otherwise.
