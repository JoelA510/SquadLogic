# Plan: team and game saves write their audit row in the same transaction

Approved by the owner on 2026-10-18, with every recommendation as written.

Status: **APPROVED** (§10, every recommendation as written). Persistence and a
schema change, so plan first (`AGENTS.md` rule 14); the migration is applied by
CI on merge, never by hand. Resume queue, Wave 2 ("write each audit row in the
same transaction as its save"). Built by two PRs (Q1): the `create_import_job`
`file_name` fix (§3.4), then the rest (branches
`claude/vibrant-allen-hr7y7s-importfilename` and
`claude/vibrant-allen-hr7y7s-audittxn`).

Evidence labels, per `AGENTS.md` rule 4: _read_ (statically reviewed),
_executed_ (run, output quoted), _test-verified_ (a committed test asserts it).
Repository state: `main` at `cab8ce1`.

---

## 0. Headline

`team-persistence` and `game-persistence` save through a `SECURITY DEFINER`
RPC called with the **service-role** client, then, after that transaction has
committed, write `team.saved` / `game.saved` with a second RPC as the caller
(`recordAuditNow`). Three consequences:

- **A save can land without its audit row**, and the only trace is a
  `console.error` (`_shared/auth.ts:231-233`), not BetterStack.
- **Production has never recorded either action**: `audit_log` holds 29 rows,
  none `team.saved` or `game.saved` (_executed_, §2). Before #577 every Edge
  audit write failed (`user_id NOT NULL` under the service role); production
  has 0 teams and 0 games, so no save has run since.
- **The RPC's own admin check is skipped**: both exempt `service_role`, so the
  Edge's early check is the only gate (the shape #64 fixed for practice).
- **Any member can save the game schedule.** `game-persistence` has no
  `verifyOrgAdmin` (its default roles include `authenticated`), and
  `persist_game_schedule` checks only `is_org_member`, while `authenticated`
  may execute it (production, read back). On a scratch build of the migration
  set, a **coach** of the organization called it and wrote a run and a game
  assignment; the same coach calling `persist_team_schedule` was refused 42501
  "caller is not an admin" (_executed_, §1.1). Calling the RPC as the user
  would keep that hole, so the admin check comes with this change (Q6).

The practice writer already does this right, and it is the contract to adopt:
`practice-persistence` calls `persist_practice_schedule` **as the user**, and
the RPC writes `practice.saved` (and its per-row audits) with
`record_audit_event` inside its own transaction
(`20260929000000:1227-1290`; `practice-persistence/index.ts:487-495`).

The proposal (§3): the same for teams and games. Each RPC writes its audit row
before it returns; a failed audit write **rolls the save back** and the Edge
answers 500 "Nothing was saved", logged to BetterStack with `logFailure`. The
Edge calls both RPCs with the user's client and drops its own audit call. The
audit writes that stay after the fact (auto-scheduler, fairness-scoring,
import-validation) report a failure through `logFailure` too.

---

## 1. What exists today (_read_, then _executed_ where marked)

|                 | Team save                                                                                                       | Game save                                                                   | Practice save (the sibling)                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| RPC             | `persist_team_schedule(jsonb, jsonb, jsonb) RETURNS uuid`, latest `20260923000000` (about 700 lines)            | `persist_game_schedule(jsonb, jsonb) RETURNS uuid`, latest `20260503030000` | `persist_practice_schedule(...) RETURNS jsonb`, `20260929000000`                                                      |
| Called with     | service-role client (`team-persistence/index.ts:120`, `:383`)                                                   | service-role client (`game-persistence/index.ts:164`, `:370`)               | the user's client (`practice-persistence/index.ts:495`)                                                               |
| RPC admin check | skipped for `service_role`                                                                                      | skipped for `service_role`                                                  | applies                                                                                                               |
| `created_by`    | from `run_data.created_by` under the service role (the Edge sends `'system'`, which the cast turns into `NULL`) | the same                                                                    | `auth.uid()`                                                                                                          |
| Audit           | after commit, `recordAuditNow` as the user: `team.saved`, `resource_type 'team'`, `{ team_count }` (`:396-401`) | the same, `game.saved`, `{ game_count }` (`:379-384`)                       | inside the RPC: `practice.saved` on `scheduler_run` with the run id, plus one row per superseded series and exception |
| Audit failure   | `console.error`, request succeeds                                                                               | the same                                                                    | the save fails with it                                                                                                |

`recordAuditNow` (`_shared/auth.ts:222-235`) swallows every error into
`console.error`. Its other callers: `auto-scheduler` (9), `fairness-scoring`
(1), `import-validation` (1). The owner decided on 2026-10-14 that **a failed
audit write does not fail the request** (plan, Discovered, #577); that decision
was about these after-commit writes, where the save has already happened.

Production (_executed_, read-only, 2026-10-17):

- `md5(prosrc)` of `persist_team_schedule`, `persist_game_schedule`,
  `persist_practice_schedule`, `create_import_job` and `record_audit_event`
  equals the fresh build's (the harness build of `docs/operations/schema-drift-2026-10.md`),
  so the wholesale copies below start from what production runs;
- `audit_log` by action: `import.started` 5 (all carrying `file_name`),
  `import.completed` 9, `player.*` 5, `feature_flags.updated` 4,
  `settings.*` 5, `organization.onboarded` 1; no `team.saved`, `game.saved`
  or `practice.saved`;
- `team.saved` and `game.saved` are registered in `audit_actions`.

### 1.1 The coach witness (_executed_, scratch build)

The harness build of `supabase/migrations/` (bare PostgreSQL 16 and
`scripts/dbharness/prelude.sql`), `supabase/tests/_fixtures.sql` and the setup
of `supabase/tests/game_persistence_rpc.sql`, inside `BEGIN ... ROLLBACK`,
acting as Charlie (the fixtures' coach of Org A):

```
coach member role: coach
is_org_admin as coach: false
persist_game_schedule as coach returned a1111111-1111-1111-1111-00000000da09
game_assignments written: 1
team save as coach refused: 42501 caller is not an admin of organization a1111111-...
```

Not run against production (it would write). Production's grants are the same:
`has_function_privilege('authenticated', ..., 'EXECUTE')` is true for both RPCs
and false for `anon` (read back). The Edge path is _read_: `game-persistence`
checks the role list and membership, never admin.

---

## 2. Why a transaction, not a retry

An after-commit audit write has two outcomes the caller cannot tell apart
from the response: saved and audited, or saved and not. "Every state-altering
action is written to `audit_log`" (`AGENTS.md`, Audit Immutability) can only
hold if the two commit together. Inside the RPC, the audit row is one more
`INSERT` in the transaction that writes the run, the teams and the roster, so
either all of it is in the database or none of it is, and the response says
which.

---

## 3. The design

### 3.1 The migration, `<next version>_audit_in_save_transaction.sql`

Both functions are **replaced wholesale** from their latest revisions (lesson
11): `persist_team_schedule` from `20260923000000`, `persist_game_schedule` from
`20260503030000`. Signatures and `RETURNS uuid` are unchanged, so no `DROP`
and no caller breaks. The changes inside each:

1. **The actor.** After the organization is resolved and before any write:
   `IF auth.uid() IS NULL THEN RAISE EXCEPTION 'persist_team_schedule needs a
signed-in caller to audit the save' USING ERRCODE = '42501'; END IF;` (Q2).
   The `service_role` exemption from the admin check is removed with it, so
   `is_org_admin(v_org_id)` gates every call; `created_by` is `auth.uid()`.
2. **The audit row**, last, after every write and before `RETURN`:

   ```sql
   BEGIN
       PERFORM public.record_audit_event(
           v_org_id, 'team.saved', 'scheduler_run', v_persisted_run_id,
           jsonb_build_object(
               'season_settings_id', v_season_settings_id,
               'team_count', jsonb_array_length(teams),
               'team_player_count', jsonb_array_length(team_players)));
   EXCEPTION WHEN OTHERS THEN
       RAISE EXCEPTION 'audit write failed, nothing was saved: %', SQLERRM
           USING ERRCODE = 'SLA01', DETAIL = SQLSTATE;
   END;
   ```

   The `game.saved` twin carries `game_count`. Re-raising aborts the whole
   transaction, so the save rolls back with it; the marker code `SLA01` (a
   custom class, never raised elsewhere) lets the Edge tell an audit failure
   from any other refusal, and `DETAIL` keeps the original SQLSTATE. This
   catches every error and rethrows every one, so nothing is swallowed
   (rule 11).

3. **`persist_game_schedule` checks `is_org_admin`**, not `is_org_member`, at
   both of its membership checks, matching `persist_team_schedule` (Q6).
4. Grants unchanged (`authenticated`, `service_role`); a service-role caller now
   gets the 42501 above.

`resource_type` becomes `scheduler_run` with the run id, as `practice.saved`
does, instead of `team`/`game` with no id (Q4).

### 3.2 The Edge Functions

- `team-persistence` and `game-persistence` call their RPC with
  `createUserClient(req, supabaseUrl, anonKey)`, as `practice-persistence`
  does, and delete their `recordAuditNow` call. `team-persistence`'s
  `verifyOrgAdmin` stays as the early 403, and `game-persistence` gains the same
  call (it has none today).
- On an RPC error with code `SLA01`: `logFailure(logCtx, 'Team save rolled
back: its audit row could not be written', error)` and 500
  `{ status: 'error', code: 'AUDIT_WRITE_FAILED', message: 'Nothing was saved:
the audit record could not be written. Try again; if it keeps failing, report
it.' }`. Every other error keeps today's path (`logFailure`, 500).
- The clients (`teamPersistenceClient`, `gamePersistenceClient`) show that
  message; the outcome is known (nothing saved), so no re-read is triggered
  (#576's `isUnknownPersistenceOutcome` does not include it).

### 3.3 The after-the-fact audit writes

`recordAuditNow(userClient, params, logCtx?)` gains an optional failure
context and, when given one, reports a failed write with
`logFailure(ctx, 'Audit write failed: <action>', error)` instead of
`console.error` alone. The 11 remaining call sites pass their handler's
`logCtx`. The request still succeeds (the owner's 2026-10-14 decision stands
for these). A Deno test pins that a failing `record_audit_event` reaches
`logFailure` with the action, and that no call site is left without a context
(a source scan, as `tests/edgeAuditActions.test.js` scans actions).

### 3.4 `create_import_job` and `file_name` (Q1)

The SQL audit `import.started` stores the uploaded file's name
(`20260522130000`), which the owner ruled out for the Edge's import audits on
2026-10-14. The fix: replace `create_import_job` wholesale without
`'file_name'` in the audit metadata (the name still forms `storage_path`, which
`importDeferredActions.js:30` reads back, so `p_file_name` stays), and drop
`file_name: file.name` from `ImportContext`'s `import-validation` body
(`ImportContext.jsx:806`), which that function no longer reads
(`import-validation/index.ts:469`). Recommended as **its own small PR and
migration, ahead of this one** (Q1): it needs no plan, and tying it to a
plan-gated change only delays it. The five production rows that carry a file
name are left to the 180-day retention (`prune_old_audit_logs`), not rewritten
(Q5).

---

## 4. Revert and smoke (`docs/sql/`)

- **`<version>_revert.sql`**: `CREATE OR REPLACE` of both functions exactly as
  `20260923000000` and `20260503030000` define them (copied, not retyped), so a
  revert restores the service-role path; the Edge is reverted with the PR.
- **`<version>_smoke.sql`**, inside `BEGIN ... ROLLBACK`, with an admin's JWT
  claims set:
  1. a team save returns a run id and leaves exactly one `team.saved` row with
     `resource_id` = that id and `user_id` = the claim's `sub`; the same for a
     game save;
  2. **atomicity**: with `team.saved` deleted from `audit_actions` inside the
     transaction, the save raises `SLA01` and leaves no `scheduler_runs` row
     and no team; the same for games;
  3. a call with no `sub` (the service role) raises 42501 and writes nothing;
     a coach's game save raises 42501 and writes nothing (§1.1, inverted);
  4. each function still has `SECURITY DEFINER` and `search_path = public`.

  The harness runs the forward migration, the smoke and the revert on a fresh
  build (`dbharness.yml`).

---

## 5. Tests

- **pgTAP** (`supabase/tests/team_persistence_rpc.sql`,
  `game_persistence_rpc.sql`): the smoke's four cases as assertions, plus the
  admin gate now applying to every caller.
- **The existing service-role cases are rewritten, not left to pass by
  accident.** `team_persistence_rpc.sql:237-340` calls as `service_role` and
  expects 42501 for a cross-organization division and similar refusals. After
  the change a service-role call is refused with 42501 for having no actor, so
  those assertions would pass for the wrong reason. Each moves to an admin's
  claims and pins its message (`throws_ok(..., '42501', '<message>', ...)`),
  and one new case pins the no-actor refusal by its own message.
- **Deno**: the two handlers call their RPC with the user client (a source pin,
  as `practice-persistence`'s is), map `SLA01` to `AUDIT_WRITE_FAILED` with a
  `logFailure` call, and no longer call `recordAuditNow`.
- **Real-backend E2E** (`tests/e2e/real-backend/`): the team sync scenario reads
  one `team.saved` row for its run through the admin's session. This is the
  M4.1 follow-up ("the real-backend import scenario asserts that an `audit_log`
  row exists") extended to teams.
- **Plants**, each shown caught: P1 the audit `PERFORM` removed (smoke 1,
  pgTAP, E2E); P2 the `EXCEPTION` block swallowing instead of re-raising (smoke
  2); P3 the no-actor guard removed (smoke 3); P4 an Edge left on the service
  client (Deno pin, and smoke 3 through the real-backend job); P5 `logFailure`
  not called on `SLA01` (Deno); P6 the game RPC back on `is_org_member` (the
  coach case in smoke 3 and pgTAP).

---

## 6. Rollout

1. The `file_name` PR (Q1), if taken separately.
2. This PR: migration, revert, smoke, the two Edge Functions, `recordAuditNow`,
   the clients' message, tests. CI applies the migration on merge
   (`deploy-migrations`), then deploys the Edge Functions
   (`deploy-edge-functions` runs after it), so for a few minutes the old Edge
   code calls the new RPC with the service role and is refused 42501. With 0
   teams and 0 games in production, nothing is lost; the window is stated in the
   PR.
3. After deploy, read-only: one `team.saved` row after the owner's next sync.

## 7. Risks

- **The deploy window** above (old Edge, new RPC): refused saves, no partial
  ones. Ordering the Edge deploy first would leave the reverse window (new
  Edge, old RPC: saves with no audit row), which is worse.
- **A hollow pgTAP pass**: handled by pinning messages (§5).
- **A bigger copy than change**: 700 lines copied for about 25 changed; the
  revert and the harness make a copy error visible.
- **Drift**: the RPCs equal the fresh build today (§1); the drift
  investigation's other findings do not touch them.

## 8. Size

Migration about 1,100 lines (two wholesale copies), revert the same, smoke
about 120; Edge about 60; `recordAuditNow` and its call sites about 40; tests
about 300. One PR, effort M.

## 9. Rollback

Merge a forward migration that applies the revert script's definitions (CI is
the only writer), and revert the Edge and client changes in the same PR.

---

## 10. Questions for the owner

**Q1. The `create_import_job` `file_name` fix: its own PR and migration, ahead
of this one?**
_Recommendation:_ yes. It is ready now and needs no plan; it replaces one small
function and removes one body field. Folding it in saves one migration run but
holds it behind this plan's approval.

**Q2. A save with no signed-in caller (the service role) is refused, rather
than saved unaudited as the practice writer allows?**
_Recommendation:_ refuse. After this change no production caller of either RPC
lacks a user, and a state change with no actor is exactly what the audit rule
forbids. The practice writer's "unaudited, but reported" branch needs a `jsonb`
return to report it; these RPCs return a `uuid`, and changing that breaks their
shape for no caller.

**Q3. An audit failure fails the save (rolled back, 500, logged), for these two
writers only, while the after-the-fact audits keep the 2026-10-14 rule (logged,
the request succeeds)?**
_Recommendation:_ yes. The 2026-10-14 decision was about a write after the save
had committed, where failing the request would misreport a save that happened.
Inside the transaction there is no such state: the save either commits with its
audit row or not at all, and the response says so.

**Q4. `team.saved` and `game.saved` recorded on `scheduler_run` with the run id
(as `practice.saved` is), instead of `team`/`game` with no id?**
_Recommendation:_ yes. It names what was saved, and no reader filters these
actions by `resource_type` today (no production row exists).

**Q5. Leave the five production `import.started` rows that carry a file name to
the 180-day retention?**
_Recommendation:_ yes. The audit log is append-only by rule; the rows age out by
about 2027-04-11. Rewriting audit history to remove a field is a bigger breach
of that rule than the field.

**Q6. Saving the game schedule requires an organization admin, in the RPC and
in `game-persistence`, as the team and practice saves already do?**
_Recommendation:_ yes, in this PR. Today any member, a coach or a parent
included, can overwrite the season's games by calling the RPC directly
(_executed_ on a scratch build, §1.1). The RPC is being replaced wholesale here
anyway, and calling it as the user without this check would leave the hole on
the main path too.
