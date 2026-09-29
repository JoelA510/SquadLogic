# 8.6 PR 3b, PR 11: enacting a repair recommendation (admin-only): plan

Status: **DRAFT for operator review.** This is a plan only. No production code,
tests or migrations are written until it is approved (CLAUDE.md §3, "Plan
before implementing on any task that touches ... persistence").

It refines row 11 of the approved 3b plan (`docs/PHASE_8_6_PR3B_PLAN.md:285`,
"Enact + override prompt, admin-only, ~600") under that plan's §2 "Enact"
(`:115-121`), §3 lock and override prompt (`:123-169`), §5 decisions 6, 7 and
10 (`:240-244`) and every "Notes carried forward" block (`:291-328`).

Every claim about current code was **statically reviewed** at `6700723`
(origin/main) and cites file:line on that commit. Nothing was executed and no
test was run for this plan. Open PR #501 (`fix/8.6-3b-adapter-existing-closures`,
head `55e3e04`) is assumed merged; §9 lists what depends on it.

## 0. What exists today, and the gaps PR 11 must close

| Piece | Today | Gap for enact |
|---|---|---|
| Panel | Read-only. Decline and undo run in memory (`PracticeRepairPanel.jsx:27-33`, `:86-88`) | No enact button, no dialog, no write |
| Panel model | `openPracticeRepair` runs adapter, repair and state once per open (`practiceRepairPanel.js:129-145`). `saveRefusalsOf` builds the whole-repair payload only to show refusals, then drops it (`:161-192`) | The payload covers **every** window, so it cannot be sent for one recommendation |
| Snapshot loader | Reads tables and the season's assignments, all or nothing (`usePracticeRepairSnapshot.js:25-89`) | It reads **no fingerprint** and **no `assigned_via`**, which the prompt must show (`practiceSupabase.js:409` already reads it) |
| Adapter payload | `buildPracticeRepairPayload` returns `plan`, `refused` and `payload` (null when anything is refused) (`repairAdapter.js:449-653`). `unlock` is always `[]` (`:62-65`, `:645`). New rows get `assigned_via: 'repair'` (`:573`) | Enact needs one entry, `assigned_via: 'recommendation'` (3b plan `:138-140`), and `unlock` from the prompt's answer |
| Blackouts | Every blackout exception is refused until PR 12 (`repairAdapter.js:52-60`, `:485-487`, `:596-617`) | §3 below |
| Tier-2 (cross-venue) | Stays in `timeTbd` and out of `plan` until it is enacted with `origin: 'approved-option'` (`repair.js:108-113`, `:1678-1680`) | So enact must build from the **recommendation**, never from `result.rehomed`. `saveRefusalsOf` already does this (`practiceRepairPanel.js:171-183`) |
| Decline state | `createRecommendationState(input, {enacted})` exists, but nothing fills `enacted` (`recommendations.js:93-111`). `open()` throws if a carried recommendation is no longer displaced or no longer a candidate (`:129-146`) | There is no function that re-bases a state onto a fresh input. The chain internals `open`/`reoffer` are module-private (`:117`, `:191`) |
| Writer | `persist_practice_schedule` v3 takes `unlock`, `closes`, `exceptions`, `withdraw_exceptions` and `base_fingerprint` (`20261002000000:99-108`). It checks the fingerprint under the season advisory lock (`:312-321`), enforces the lock (`:775-798`), writes one `practice.unlock_accepted` row per unlocked row with its before-image (`:811-833`), checks that no exception was lost (`:1102-1105`), refuses a mid-range daylight window (`:1106-1123`), writes `practice.saved` with `base_fingerprint` (`:1248-1264`) and returns the new `fingerprint` (`:1269-1287`) | `base_fingerprint` is **optional**: NULL skips the check (`:318`). No audit row carries recommendation metadata or declined pairs |
| Fingerprint | `practice_schedule_fingerprint(season)` hashes the season's rows (id, team, slot, range, source, `assigned_via`) and every exception's id and `withdrawn_at` (`20260929000000:179-204`). It is SECURITY INVOKER and granted to `authenticated` (`:183`, `:206`) | It does **not** cover slots, fields, `effective_to`, blackouts, closures or coach data (§4) |
| Edge | `PracticeRepairSchema` validates and passes the repair arguments through (`practice-persistence/index.ts:39-111`, `:224-243`). Admin gate at `:404-418` | **Every RPC error becomes HTTP 500** with the message (`:464-473`). A stale fingerprint cannot be told apart from a crash |
| Client | `persistPracticeRepair` rebuilds rows through `preparePracticePersistenceSnapshot` → `buildPracticeAssignmentRows` (`practicePersistenceClient.js:23-46`, `practicePersistenceSnapshot.js:102-107`) | The adapter already emits DB rows (`repairAdapter.js:624-634`). Rebuilding them loses `assigned_via` and the explicit ranges |
| Precedent | An approved option is re-judged because the world may have changed (`resolve/schemas.js:42-47`). A stale one is **not applied**, and the operator is asked again (`resolve/stages.js:1011-1034`) | This is the contract enact adopts |

## 1. The enact flow

One click per recommendation. Each step names the module that performs it.
"New" marks a function PR 11 adds.

| # | Step | Module |
|---|---|---|
| 1 | Admin clicks **Enact** on one row. For a retirement this opens the override prompt (§2). Non-admins see the button disabled with a visible reason, as in #444 | `PracticeRepairPanel.jsx` `Recommendations` (`:103`) → new `components/scheduling/PracticeEnactDialog.jsx` |
| 2 | On **Confirm**, mint `enactKey` (uuid v4) once for this confirmed intent. A retry of the same intent reuses it | new `frontend/src/utils/practiceRepairEnact.js` `enactPracticeRecommendation({client, send, state, recommendation, shown, answer, enactKey})` |
| 3 | **Fresh read, fingerprint first.** Call `rpc('practice_schedule_fingerprint')`, **then** read the rows. Any write after the fingerprint read makes the writer refuse. Also read `assigned_via` and PR #501's closures | `usePracticeRepairSnapshot.js` `loadPracticeRepairSnapshot` (extended: returns `fingerprint`, keeps all-or-nothing) |
| 4 | Adapt the fresh rows, with `baseFingerprint` = the fingerprint from step 3 | core `buildPracticeRepairInput` (`repairAdapter.js:153`, `:341`), unchanged |
| 5 | **Re-base** the session state (recommendations, Δ, enacted) onto the fresh input (see "Re-validate" below) | new core `rebaseRecommendationState(state, freshInput)` in `practice/recommendations.js`. It must live there because it reuses the private `open`/`reoffer` |
| 6 | **Re-judge** the one recommendation: its series is still displaced, its `to` is still one of its candidates, and `marginal(S, to, R∖{S}, coachDays(R∖{S}))` is not null. Then compare what the admin was shown against the fresh judgement: `to` (all four shape fields), `tier`, `origin` and `objective.counts`, exactly. Any difference → **stale: nothing is sent**, the dialog shows old against new and asks again (`stages.js:1033-1034`) | new core `judgeEnact(rebased, assignmentId, shown)` in new `practice/enact.js` |
| 7 | **Plan the write** for that one entry: `buildPracticeRepairPayload(adapted, {representation, lossDate, rehomed:[S] or [], timeTbd:[] or [S]})`, with `assigned_via: 'recommendation'` on the new row. `unlock` is filled only from the prompt's ticked rows, never from `unlockRequired` automatically. A `null` payload (any refusal) **refuses the enact**: nothing is sent | new core `buildEnactPayload(adapted, judged, answer)` in `practice/enact.js`. It calls the adapter's builder, which gains one optional `assignedVia` argument (default `'repair'`, so the panel's refusal preview does not change) |
| 8 | Build the enact record (§5), Zod-validated, strict | new core `PracticeEnactRecordSchema` + `buildEnactRecord` in `practice/enact.js`, exported from `practice/index.js` |
| 9 | **Send**: the adapter's DB rows go **verbatim** as `snapshot.payload.assignmentRows`, with `repair` and `enact` bodies, and `runMetadata.runId = enactKey` | new `persistPracticeEnact` in `utils/practicePersistenceClient.js`. It does not call `preparePracticePersistenceSnapshot` |
| 10 | Edge validates `enact` (strict Zod twin of the core schema). It requires `repair.baseFingerprint`, and calls the new RPC as the user | `supabase/functions/practice-persistence/index.ts` (extended) |
| 11 | In one transaction: take the season lock, check idempotency, call `persist_practice_schedule` (which checks the fingerprint, the lock and the unlock audit), check that only S was touched, and write the `practice.recommendation_enacted` audit row | new migration: `public.enact_practice_recommendation(...)` (§5) |
| 12 | **After success**, read fresh again (steps 3-4). Add S to `enacted`, and re-base. Recommendations that are now inadmissible are released through the chain rule. The panel announces the result in a `role="status"` region | `practiceRepairEnact.js` → `rebaseRecommendationState` |

**Why the series joins the enacted set and is locked.** The lock needs no new
code. The new row is an ordinary `practice_assignments` row with
`assigned_via = 'recommendation'`, and writer v3 refuses to delete, re-range or
move any existing row without `unlock` (`20261002000000:775-798`). After a
retirement enact the closed row ends at D-1, so the fresh repair skips it
(`repair.js:575`), and the new row is a frozen occupant. `enacted` in the
session state then only records that its absence is expected (see below).

**Re-validate and release (`rebaseRecommendationState`).** The rule is
deterministic, with no DB:

1. For each carried series in `enacted`: it **must be absent** from the fresh
   displaced set. If it is still present, the write did not land as planned,
   and the call throws. It is never ignored.
2. If a carried series that is not enacted is missing from the fresh displaced
   set, or the fresh set holds a series the state never had, the season changed
   elsewhere. The state is **not** re-based piecemeal. It is reopened with
   `createRecommendationState(freshInput, {enacted})`. Δ pairs whose series
   still exist are carried over, and a new finding says so (§6 witness 17).
   Nothing is dropped silently: the reopened list is the repair's own complete
   list.
3. Otherwise, walk the carried placements in the search's own order
   (`context.order`). Keep each one whose `to` is still a candidate and whose
   marginal against the kept ones is not null, within the budget. Each one that
   fails is **released**. Its series S goes TIME TBD, and its shape X is offered
   through the existing `reoffer(work, enacted, S, X)`, with S barred from X for
   the first hop only, exactly as a decline. Then S takes the decline fallback:
   its cheapest admissible free candidate outside Δ. A release is **not** a
   decline: (S, X) does not join Δ. With no fallback, S's reason is the one
   `repairPracticeLoss(freshInput)` gives S. That is the sibling's contract, so
   no new reason is invented.
4. Any release stamps `PRACTICE_REPAIR_RECOMMENDATION_LOCAL` (already
   registered, `reasonCodes.js:220`, `:294`) and appends a chain record with
   `kind: 'release'`.

**The change budget.** An enacted series leaves the displaced set, so its
published-time change would stop counting against `changeBudget`
(`repair.js:864`), and enacting one at a time would bypass the budget. The
re-base therefore passes `changeBudget − (time changes already enacted this
session)`. Today the panel passes no options (`practiceRepairPanel.js:131-141`),
so the budget is null and this is latent. It is still witnessed (§6, 18).
Enacts from an earlier panel session are not counted, and the panel says so.
This limit is declared, not enforced.

## 2. Retirement enact: the confirmation dialog **is** the ruling-2 prompt

A retirement enact always re-ranges or replaces a locked row
(`repairAdapter.js:532-546`), so the dialog is the override prompt of 3b plan
`:162-169` for that one assignment.

**The dialog lists**, for the recommendation's team, each row in
`plan.unlockRequired`: weekday, time, ground, range and `assigned_via` (from
the fresh read). It also says exactly what happens to each row:

- **"closed"** (`closes re-ranges it`): the range becomes `[from, D-1]`.
- **"removed and replaced"** (`the payload no longer carries its key`): the
  row starts on or after D.

Then it shows what replaces the row: the new row `[D, until]` on the
recommended weekday, time and ground, **or** "TIME TBD from D, reason ...".
Last comes the count of published practices that could change: the weekday
occurrences of the row in `[D, until]`, computed by the core occurrence
expander the feed uses (`practiceRangeBounds`, `repairAdapter.js:74`).

There is one checkbox per team, as in the plan (`:167`). Enact covers one
series, so there is exactly one team. **Confirm** stays disabled until the box
is ticked. The disabled state has a visible reason, and focus goes to the
dialog heading on open and back to the row's button on close (WCAG 2.2 AA,
CLAUDE.md §9).

**The `unlock` payload.** It has one entry per `unlockRequired` row of this
entry, and only when the box is ticked:

```json
[{ "assignment_id": "<the series' row id>",
   "reason": "enact <enactKey>: retirement of field <fieldId> from <D>" }]
```

The reason is **generated**: ids and a date only, no free text, no PII. The
writer requires a non-empty reason of at most 500 characters
(`index.ts:45-47`, `20261002000000:651-654`). If the box is not ticked, no call
is made. There is no path that sends `closes` without the matching `unlock`.
Even if one were built, the writer refuses it with 22023 (`:795-797`).

**The audit** is atomic with the write:

- `practice.unlock_accepted`, one row per unlocked row, with `reason` and the
  full before-image. The writer already writes this (`20261002000000:811-833`).
- `practice.exception_recorded` for a TIME TBD tail window (`:1240-1246`).
- `practice.saved` with `unlocked_count`, `closed_count` and `base_fingerprint`
  (`:1248-1264`).
- New: `practice.recommendation_enacted` (§5), which carries the prompt as it
  was shown and the `unlock` answer.

## 3. Blackouts under the adapter ruling

Every blackout window is an exception on its **unclosed** row, and the adapter
refuses every exception whose window still meets its row
(`repairAdapter.js:485-491`, `:596-617`). So the blackout `payload` is always
`null` until readers apply exceptions (PR 12).

**What enact shows for a blackout recommendation in PR 11:** the row, its
recommendation or TIME TBD, and decline and undo, as today. **Enact** is shown
**disabled**, and its visible reason is the refusal the panel already computes
(`SAVE_REFUSAL_TEXT`, `practiceRepairPanel.js:57-66`), for example "the window
lies inside its practice series, and schedules cannot show a temporary change
yet". The orchestration (step 7) also refuses a `null` payload. The disabled
button is therefore not the only gate (§6, 12).

**Recommendation: ship PR 11 retirement-only. Do not wait for PR 12.**

- *For shipping now:* retirements are the case with an existing admin flow. The
  panel already opens from the retirement preview
  (`RetireEstateNodeDialog.jsx:242-250`), and a retirement's tail windows are
  persistable today (the writer and adapter contract, `repairAdapter.js:576-591`).
  The persistence path (wrapper RPC, audit, idempotency, stale handling) then
  lands and is proven on one arm. PR 12 stays small and reader-only.
- *For waiting:* one enact PR proven on both arms, and no disabled button
  in production. But blackout enact needs **more than PR 12**. The adapter
  reads no `practice_exceptions` today (`repairAdapter.js:155-366`), so after a
  blackout enact the fresh re-judge would still see the enacted series as
  displaced, and would see its relocated slot as free. Another recommendation
  could then land on it. Waiting would add that work to PR 11 as well.
- **Therefore:** PR 11 is retirement-only. A follow-up, **PR 11d "blackout
  enact"**, comes after PR 12. It teaches the loader and adapter to read live
  exceptions (a `relocated` exception is a frozen occupant of its slot over its
  window; a series with a live exception over a window is enacted for that
  window), and it enables the blackout button. Decision 6 (withdraw only via
  the prompt) and `withdraw_exceptions` stay out of PR 11: it always sends `[]`.

## 4. Concurrency

**A stale fingerprint gives a loud refusal and a re-judge prompt, never a
silent overwrite.**

- *Base always sent.* The new RPC refuses a NULL `base_fingerprint` (22023,
  "an enact is never blind"). This closes the writer's NULL-skips-the-check
  path for enact only (`20261002000000:318`).
- *Read order.* The fingerprint is read **before** the rows (step 3). A write
  that lands between them therefore makes the base stale, never a stale plan
  with a fresh base.
- *Detection.* The writer compares under the season advisory lock
  (`:311-321`) and raises 40001.
- *Edge mapping* (new, only for calls that carry `repair`, so ordinary saves
  keep today's responses):

  | Error | HTTP response |
  |---|---|
  | `40001` | `409 {status:'stale', code:'PRACTICE_SCHEDULE_STALE'}` |
  | `22023` + "is locked" | `409 {code:'PRACTICE_ASSIGNMENT_LOCKED'}` |
  | `42501` | `403` |
  | other `22023` | `422` |
  | anything else | `500`, as today |

  The message is kept. Today every error is 500 (`index.ts:464-473`).
- *Client.* On `PRACTICE_SCHEDULE_STALE`, the client repeats steps 3-6 and shows
  a `role="alert"`: "The season changed since this was shown." Then one of:
  "It still stands; enact again?", or the old and new recommendation side by
  side. It **never** retries the write automatically. A second write needs a
  second click and a new `enactKey`.
- *Declared, not enforced.* The fingerprint does not cover slots, fields,
  `effective_to`, blackouts, #501's closures or coach data (`20260929000000:186-203`).
  A change to those between step 3 and the commit is not detected. The
  re-judge at click time reads them fresh, so the exposure is the few seconds
  from click to commit. The dialog footnote and the audit
  (`fingerprint_covers`) state this limit. Widening the fingerprint is an open
  question (§8, Q5).

**A double-click is idempotent.**

- *Client.* The button is disabled with `aria-busy` while a call is in flight.
  `enactKey` is minted once per confirmed intent.
- *Server.* The run id **is** `enactKey`. The new RPC takes the writer's own
  advisory lock first. Postgres transaction-level advisory locks are re-entrant
  within a transaction, so the inner writer call does not deadlock. It then
  looks for `scheduler_runs.id = enactKey` with
  `parameters->>'enact_key' = enactKey`. If one exists, it returns
  `{idempotent: true, run_id, fingerprint: <current>}` and writes nothing.
  Without this, the second call would be refused 40001, which is loud but
  wrong for a double-click.
- *Two tabs.* Two tabs mint two keys. The second tab gets 40001, re-judges,
  finds S no longer displaced, and shows "this practice changed since the panel
  opened". It never makes a second write.

## 5. Audit (decision 10: the enact audit records declined pairs)

**Where.** A new **SECURITY INVOKER** RPC in a new migration (timestamp later
than every migration on main at merge time):

```
public.enact_practice_recommendation(
  run_data jsonb, assignments jsonb, unlock jsonb, closes jsonb,
  exceptions jsonb, base_fingerprint text, enact jsonb) RETURNS jsonb
```

The RPC does these steps, in order:

1. Refuse unless `auth.uid()` is set and `is_org_admin(org)` (42501).
2. Refuse a NULL `base_fingerprint` (22023).
3. Validate the `enact` shape and require `run_data.id = enact.enact_key`.
4. Take `pg_advisory_xact_lock` with the writer's key (`20261002000000:311-314`).
5. Check idempotency (§4).
6. Call `persist_practice_schedule(run_data, assignments, false, unlock, closes,
   exceptions, '[]', base_fingerprint)`.
7. Check the result touched only S: `closed` and `unlocked` ⊆ {S}, and every
   recorded exception is on S. Otherwise raise 22023, so the whole call rolls
   back.
8. Write `record_audit_event(org, 'practice.recommendation_enacted',
   'practice_assignment', S, <metadata>)`.
9. Return the writer's result plus `{enact_audited: true}`.

The migration ships with a revert, a smoke script under `docs/sql/`, and
pgTAP/dbharness tests.

*Why a wrapper and not the alternatives:*

- *`run_data.parameters`:* stored in the same transaction, but on
  `scheduler_runs`, which a re-save with the same run id overwrites
  (`20261002000000:383-388`). It is not the immutable audit log.
- *An Edge call to `record_audit_event` after the RPC:* a separate
  transaction, so a failed audit would leave an unaudited enact.
- *A full copy of the writer (LESSONS #11, `docs/LESSONS_LEARNED.md:62-65`):*
  about 1,300 lines to add one audit row. The wrapper leaves the writer
  byte-identical.

**The exact metadata** (`PracticeEnactRecordSchema`, strict, in core). The Edge
holds a strict twin, pinned key-for-key by a drift test, because the Deno side
cannot import core (3b plan `:212`). The metadata holds ids, enums, dates and
numbers only. The one free-text field is the generated unlock reason.

```jsonc
{
  "schema_version": 1,
  "enact_key": "<uuid>",               // = run_id
  "run_id": "<uuid>",
  "season_settings_id": "<uuid>",
  "cause": {
    "kind": "retirement",              // PR 11d adds "blackout"
    "id": "<field uuid>",
    "loss": { "from": "YYYY-MM-DD", "until": null, "surface_ids": ["<uuid>"],
              "start_minutes": null, "end_minutes": null, "reason": "retirement" },
    "committed": false                 // the retirement preview (§8 Q3)
  },
  "series": {
    "assignment_id": "<uuid>", "team_id": "<uuid>",
    "from": { "surface_id": "<uuid>", "weekday": "TUE", "start_minutes": 1080, "duration_minutes": 90 },
    "window": { "from": "YYYY-MM-DD", "until": "YYYY-MM-DD" }
  },
  "decision": {
    "kind": "rehome",                  // or "time_tbd"
    "to": { "surface_id": "<uuid>", "weekday": "THU", "start_minutes": 1080, "duration_minutes": 90 },
    "tier": "same-venue",              // "cross-venue" | null
    "origin": null,                    // "approved-option" for cross-venue (repair.js:1678-1680)
    "tbd_reason": null,
    "objective": { "total": 3, "counts": { "changedWeekday": 1 } },
    "coach_overlaps": ["<coach uuid>"],
    "coach_days_worsened": 0
  },
  "rejudge": { "stands": true, "shown_counts": { "changedWeekday": 1 } },
  "declined": [                        // decision 10: ALL of Δ at enact time, not only S's
    { "assignment_id": "<uuid>", "to": { "surface_id": "<uuid>", "weekday": "WED",
                                          "start_minutes": 1020, "duration_minutes": 90 } }
  ],
  "chains": [                          // every decline / undo / release of the session, summarised
    { "kind": "decline", "assignment_id": "<uuid>", "hops": 2, "stopped_by": "no-gain" }
  ],
  "local": true,                       // any chain => PRACTICE_REPAIR_RECOMMENDATION_LOCAL
  "enacted_before": ["<uuid>"],        // earlier enacts of this panel session
  "prompt": {                          // the override prompt as shown and answered
    "rows": [{ "assignment_id": "<uuid>", "assigned_via": "auto",
               "effect": "closed", "range_after": "[YYYY-MM-DD,YYYY-MM-DD)" }],
    "published_practices_affected": 7,
    "accepted": true
  },
  "unlock": [{ "assignment_id": "<uuid>", "reason": "enact <uuid>: retirement of field <uuid> from YYYY-MM-DD" }],
  "writes": { "closes": [{ "assignment_id": "<uuid>", "last_day": "YYYY-MM-DD" }],
              "new_rows": [{ "team_id": "<uuid>", "practice_slot_id": "<uuid>",
                             "effective_date_range": "[YYYY-MM-DD,YYYY-MM-DD]" }],
              "exceptions": 0 },
  "base_fingerprint": "<md5>",
  "result_fingerprint": "<md5>",       // filled by the RPC from the writer's return
  "fingerprint_covers": "practice_assignments+practice_exceptions",
  "solver": { "strategy": "exact", "proven_optimal": true,
              "daylight_supplied": true, "closures_supplied": true }
}
```

The per-row before-images are **not** repeated. They live in the
`practice.unlock_accepted` rows of the same `run_id`. Declines and releases are
still not persisted on their own (decision 10). They appear only inside the
enact that followed them.

## 6. Witnesses

Each subject set is enumerated from the roster, the pre-enact snapshot, or the
calls the test itself made, never from the output under test. Each row names
the plant that must turn it red. Every fixture also asserts that it exercised
data: at least one displaced series, at least one decline where relevant, and
at least one release where relevant. Each of those assertions has its own
plant that makes it vacuous: the fixture's loss is moved off every series, and
the meta-assertion must go red.

| # | Guarantee | Test | Plant that must turn it red |
|---|---|---|---|
| 1 | Enact never writes a shape other than the one shown | `tests/practiceEnact.test.js`: the fresh input puts a frozen row on X, and the Edge spy sees 0 calls | `judgeEnact` returns `stands: true` unconditionally |
| 2 | A compromise change is stale (approved-option) | Same: cross-venue recommendation with a fresh coach overlap | Compare `to` only, not `objective.counts` |
| 3 | The re-judge uses a fresh read | `tests/practiceRepairEnact.test.js`: the client mock's second read differs, and the sent `baseFingerprint` is read #2's | Reuse `opened.adapted` from panel open |
| 4 | Fingerprint is read before rows | Same, with the call order recorded; plus dbharness: a write between the two reads gives 40001 | Read the fingerprint after the rows |
| 5 | Stale is loud, never an overwrite | dbharness: stale base gives 40001, and zero rows and zero audit rows changed. Edge: 409 `PRACTICE_SCHEDULE_STALE`. UI: `role="alert"`, fetch count 1 | Edge retries without `base_fingerprint` |
| 6 | An enact is never blind | pgTAP: NULL base gives 22023 | Drop the NULL check in the wrapper |
| 7 | Double-click is idempotent | dbharness: two calls with the same key give one write set, one enact audit row, and a second `idempotent: true`. UI: two clicks give one fetch | Remove the idempotency lookup (the second call returns 40001) |
| 8 | Admin-only | pgTAP: a coach or staff caller gives 42501. Edge: 403. UI: disabled with a reason | Remove `is_org_admin` from the wrapper |
| 9 | Unlock only what the prompt accepted | `practiceEnact.test.js`: no answer gives `unlock: []`. Unticked gives Confirm disabled and 0 fetches | `buildEnactPayload` copies `unlockRequired` into `unlock` |
| 10 | Only the enacted series changes | dbharness: every pre-enact snapshot row other than S is unchanged in id, slot, range and `assigned_via`. S is closed at D-1. There is exactly one new row or one tail exception | Build the payload from the whole state |
| 11 | The enacted row is marked and locked | dbharness: `assigned_via = 'recommendation'`. A later ordinary save omitting it refuses 22023 | Emit `'repair'`, or omit `assigned_via` |
| 12 | No blackout write in PR 11 | `practiceRepairEnact.test.js`: every blackout series-window (displaced set from snapshot × window) gives a `null` payload and 0 fetches, even with the button forced enabled | Send `plan` when `payload` is null |
| 13 | The audit records all of Δ | `practiceEnact.test.js`: the `declined` list equals the pairs the test declined (≥2, across 2 series). pgTAP: the audit row exists and passes the schema twin | Record only S's own declines |
| 14 | The audit is atomic with the write | dbharness: force the audit insert to fail, and every write rolls back | Move the audit to the Edge after the RPC |
| 15 | The wrapper touches only S | pgTAP: a payload whose `closes` names another row gives 22023, rolled back | Drop the only-S check |
| 16 | After a re-base no two recommendations clash | `practiceRecommendations.test.js`: the independent clash predicate (3b plan `:252`) over recommendations and the fresh frozen rows | Keep inadmissible recommendations |
| 17 | The re-base releases exactly the inadmissible ones | Same: the brute-force released set (candidate gone, or marginal null) over the carried recommendations | Release all; release none |
| 18 | No series lost in a re-base or reopen | Same: every carried series and every fresh-displaced series appears exactly once | Filter out released series |
| 19 | The change budget spans enacts | Same: budget 1, two displaced, enact one, and the other cannot change a published time | Re-base with the original budget |
| 20 | An enacted series still displaced is loud | Same: a fresh input where the write "did not land" throws | Ignore enacted ids |
| 21 | Ordinary saves are unchanged | Edge test: a call without `repair` keeps today's 500 mapping and key set (`tests/practiceWriterV3.test.js` pin) | Map errors for all calls |
| 22 | Edge and core enact schemas agree | `tests/practiceEnactSchemaDrift.test.js`: identical key sets and enums (the `practiceWriterV3` source-pin precedent) | Add a key to one arm only |
| 23 | The prompt's count is true | `PracticeEnactDialog` test: the count equals occurrences in `[D, until]` from the core expander over the fixture row | Count weeks, not weekday occurrences |

Also for every PR: `/code-review` before opening, and the season-2026 fixture
suite for 11a, which changes `recommendations.js` (a solver stage).

## 7. Size and split

The estimate is about 2,100 lines against the plan's ~600. That is over the
~800 line limit, so the work splits into three PRs. 11a and 11b can run in
parallel; 11c needs both.

| PR | Contents | Touches | Size |
|---|---|---|---|
| **11a** core | `rebaseRecommendationState` (`recommendations.js`). New `practice/enact.js` (`judgeEnact`, `buildEnactPayload`, `PracticeEnactRecordSchema`, `buildEnactRecord`). The adapter's optional `assignedVia`. Barrel exports. Witnesses 1-2, 9, 13, 16-20 | S, D | ~750 |
| **11b** persistence | Migration `enact_practice_recommendation` + revert + smoke. pgTAP/dbharness 5-8, 10-11, 14-15. Edge `enact` body, Zod twin, error mapping (21), drift test (22) | P | ~700 |
| **11c** UI | Loader fingerprint + `assigned_via`. `persistPracticeEnact`. `practiceRepairEnact.js`. `PracticeEnactDialog.jsx`. The panel's enact button and disabled reasons. Mock-client handlers for the new RPC. E2E `practice_repair_enact.feature` (retirement: enact, stale, non-admin). Witnesses 3-4, 12, 23 | — | ~650 |
| 11d (after PR 12) | Blackout enact: the loader and adapter read live exceptions; the button is enabled | D, P reads | ~500 |

## 8. Open questions for the operator

Q1. **Ship PR 11 retirement-only, with blackout enact as PR 11d after PR 12?**
Recommended default: **yes**. Retirements are persistable today. Blackout
enact also needs the adapter to read live exceptions, which is more than
PR 12's readers.

Q2. **Where does the enact audit row come from?** Options: a thin invoker
wrapper RPC `enact_practice_recommendation` (new migration, writer unchanged),
a full copy of the writer (LESSONS #11, ~1,300 lines), or an Edge
`record_audit_event` after the RPC (not atomic). Recommended default: **the
wrapper RPC**.

Q3. **May an admin enact during the retirement preview, before the retirement
is committed?** The panel opens from the dry-run preview, with the dialog's
date (`RetireEstateNodeDialog.jsx:242-250`). If the admin then changes the date
or cancels the retirement, the enacted series stays moved and locked. Recommended
default: **allow it in the preview.** The dialog says the retirement is not yet
committed, and the audit records `cause.committed: false` and the date used.

Q4. **Is the unlock reason generated (ids and date only) or typed by the
admin?** Recommended default: **generated**, so there is no free text in the
audit and no PII.

Q5. **Should `practice_schedule_fingerprint` be widened** to cover slots,
fields and `effective_to`, blackouts and closures (a migration)? Recommended
default: **no, not in PR 11.** The re-judge at click time reads them fresh.
The remaining exposure is the click-to-commit latency, and it is declared in
the dialog and the audit.

## 9. Dependency on PR #501

PR #501 adds `closures` to the repair and has the loader read `field_closures`
and the `effective_to` columns, all or nothing. Enact inherits both, because
step 3 **is** that loader. Without #501, the fresh re-judge would accept a
shape an existing blackout or retirement closes on some date, and enact would
persist it. **PR 11a/11c must be rebased on #501 and must not merge before
it.** #501 does not widen the fingerprint (Q5), and its
`declared.closures` block goes into the audit's `solver.closures_supplied`.
