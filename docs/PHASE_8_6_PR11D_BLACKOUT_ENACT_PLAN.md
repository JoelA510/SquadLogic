# 8.6 PR 3b, PR 11d: enacting a blackout recommendation (admin-only): plan

Status: **DRAFT, awaiting operator answers (§8).** No code is changed by this
plan. CLAUDE.md §3 requires a plan and approval before any solver, domain or
persistence change, and 11d touches all three.

It refines row 11d of the approved PR 11 plan
(`docs/PHASE_8_6_PR11_ENACT_PLAN.md:460`, "Blackout enact: the loader and
adapter read live exceptions; the button is enabled, D, P reads, ~500"). It
works under:

- that plan's operator answer Q1: blackout enact comes "after PR 12 **and**
  after the adapter reads live `practice_exceptions`" (`:23`, `:219-238`);
- its record note "PR 11d adds `"blackout"`" (`:353`);
- the PR 12 plan's answer Q8: "PR 11d lifts the adapter's refusals. The
  writer's daylight refusal comes out in a separate migration after 12b-12d
  merge and Q6 is settled" (`docs/PHASE_8_6_PR12_READERS_PLAN.md:495-502`,
  `:552`);
- the 3b plan's table and loss rules (`docs/PHASE_8_6_PR3B_PLAN.md:52-75`)
  and its decision 6 ("enacted exceptions stay locked, flagged 'cause
  changed'; withdrawn only via the override prompt", `:238`).

Every claim about current code was **statically reviewed** at `d076819`
(origin/main, after #527) and cites file:line on that commit. **Nothing was
executed.** No test was run, no script was run and no database was queried
for this plan. The PR bodies of #521, #525 and #527 were read through the
GitHub API.

## 0. Summary

- **Four layers refuse a blackout enact today:** the adapter, core enact, the
  client and UI, and the wrapper RPC (§1.1). The writer does **not** refuse
  one. Its only mid-range refusal is for the two daylight TIME TBD reasons.
- **Nothing on the enact path reads live exceptions as occupancy.** The
  snapshot loader reads them, but only for the dialog's count, and without
  the relocated slot or the cause (§1.2).
- **A 10th pending production migration is needed.** The wrapper
  `enact_practice_recommendation` is retirement-only in four places, so it
  needs a `CREATE OR REPLACE`. The writer is unchanged (§2.4).
- **The PR 12 readers handle both mid-range cases** (§3). Four gaps sit next
  to them, and 11d is the first PR that can reach them. The main one (G1):
  a move to another weekday can **silently lose practices**, because the
  repair never checks that the new weekday falls inside the window.
- **Overlap: refuse, do not split** (§4, Q2). Staleness is covered by the
  fingerprint for exceptions, and by a new blackout commit gate for the
  blackout row itself.
- **Split into four PRs**, about 1,950 lines in total (§6).

## 1. Current behaviour

### 1.1 Where a blackout enact is refused today

| # | Layer | Where | What it does |
|---|---|---|---|
| A1 | Adapter, payload | `packages/core/src/practice/repairAdapter.js:65-73` (contract), `:641-657` (`planException`), `:752-773` (the blackout arm) | Every blackout exception lies inside its unclosed row, so `from > rowLastDay` is never true (`:646`). It is refused as `MID_RANGE_WINDOW` or `WINDOW_INSIDE_ROW`, and `payload` is `null` (`:795-797`) |
| A2 | Adapter, representation | `repairAdapter.js:607-612` | A blackout result must be `override`. This is correct and stays |
| C1 | Core enact, the gate | `packages/core/src/practice/enact.js:127-136` | `retirementCommitOf` returns `BLACKOUT_NOT_ENACTABLE` for any other loss kind |
| C2 | Core enact, the payload | `enact.js:264-266` | `buildEnactPayload` refuses before anything else. It also hard-codes `representation: 'split'` and `lossDate` (`:284-295`), so it cannot build a blackout write even with the refusal removed |
| C3 | Core enact, the record | `enact.js:369-381` | `PracticeEnactRecordSchema.cause.kind` is `z.literal('retirement')`. `loss.until`, `start_minutes` and `end_minutes` are `z.null()`, and `reason` is `z.literal('retirement')`. `stored_effective_to` is required. The unlock reason regex names a retirement (`:355-357`), and so do `prompt.rows[].effect` (`:418`) and `buildEnactRecord` (`:512-524`) |
| E1 | Edge twin | `supabase/functions/_shared/practice-enact-record.ts:53`, `:63-72` | The same literals, held key-for-key by `tests/practiceEnactSchemaDrift.test.js` |
| U1 | Client, the button | `frontend/src/utils/practiceRepairEnact.js:83-90` | `enactGateOf` disables every non-retirement row as `ENACT_GATE.BLACKOUT`, and appends the panel's save refusals to the reason |
| U2 | Client, the flow | `practiceRepairEnact.js:225`, `:290-292` | `judgeOnFreshRead` runs `retirementCommitOf`, which refuses a blackout (C1). So a button forced enabled still sends nothing (PR 11 witness 12) |
| U3 | Client, the plan and prompt | `practiceRepairEnact.js:116-128` (`enactPlanOf`, `split`), `:149-201` (`enactPromptOf`) | The prompt lists only `plan.unlockRequired` rows (`:167`). A blackout write unlocks nothing (§2.5), so its prompt would list no rows and count **0** practices |
| U4 | UI | `frontend/src/components/scheduling/PracticeRepairPanel.jsx:114-116` (static text), `:443` (the gate), `:592-621` (`dialogFor` reads `loss.field` and `storedDate`); `PracticeEnactDialog.jsx:69` (title "`<field>` retires after `<date>`") | The dialog is worded for a retirement only |
| U5 | Mock writer | `frontend/src/lib/mockPracticeEnact.js:10-13`, `:138-176` | The retirement cause and the commit gate are mirrored, so E2E cannot enact a blackout |
| W1 | Wrapper RPC | `supabase/migrations/20261004000000_enact_practice_recommendation.sql:60` (declared), `:167` (`cause.kind` must be `retirement`), `:207-224` (commit gate on `fields.effective_to`), `:295-299` (S must be closed or superseded), `:337-345` (a `time_tbd` must add 0 rows and 1 exception; a `rehome` exactly 1 new row), `:348` (writes `stored_effective_to`) | A blackout is refused at `:167`. Even without that line, `:295-299` would refuse it: a blackout enact neither closes nor replaces S |
| W2 | Writer, `persist_practice_schedule` | `supabase/migrations/20261002000000_practice_exceptions_daylight.sql:1106-1123` | **Refuses only a daylight-reason TIME TBD** (`tbd_reason IN ('past-sunset','sunset-unknown')`, `:1115`) whose window ends before its row does. A mid-range `relocated` window, or a mid-range TIME TBD with any other reason, is admitted (PR 12 plan D1, `:404-408`) |

There is also a **launcher that must not be left enabled.** The blackout
editor opens the panel from its unsaved draft (`BlackoutEditor.jsx:178-196`,
`id: editing?.id ?? 'draft'`). It passes **no** `preview` prop (`:463-465`),
and `PracticeRepairLauncher` defaults `preview` to `false`
(`PracticeRepairLauncher.jsx:24`). Today U1 is the only thing keeping Enact
off in that draft. Removing U1 without adding a blackout commit gate (§2.6)
would enable Enact on a blackout that has not been saved.

### 1.2 What reads live `practice_exceptions`, and what does not

| Reader | Reads exceptions? | Detail |
|---|---|---|
| Snapshot loader `loadPracticeRepairSnapshot` | **Yes, for the count only** | `frontend/src/hooks/usePracticeRepairSnapshot.js:62-71`: columns `id, assignment_id, window, kind, tbd_reason, withdrawn_at`, org-scoped (`:88`), live and withdrawn. It does **not** read `practice_slot_id`, `cause_kind` or `cause_id`, which 11d needs |
| Enact prompt count `enactPromptOf` | Yes | `practiceRepairEnact.js:158-189` runs `applyPracticeExceptions` and counts only `series` dates from D (#525, W17) |
| Adapter `buildPracticeRepairInput` | **No** | It reads `practiceAssignments`, slots, closures and coaches (`repairAdapter.js:172-388`). `rows.practiceExceptions` is ignored. `context` carries no exceptions (`:356-363`) |
| Repair `repairPracticeLoss` | **No** (no input for it) | Occupancy is `frozen` series and `undatedOccupants` (`repair.js:650-707`, `:822-839`) |
| Re-base `rebaseRecommendationState` | No, but it depends on the adapter | It throws if an enacted series is still displaced (`recommendations.js:453-459`). A blackout enact leaves S's row unchanged, so S **stays** displaced on the fresh read. Today the first successful blackout enact would throw here |
| Fingerprint `practice_schedule_fingerprint` | Yes: ids and `withdrawn_at` | `20260929000000_practice_writer_v3_lock_by_default.sql:192-198` |
| Auto-scheduler lock load | **`time_tbd` only** | `supabase/functions/_shared/engines/practice-lock.ts:272-276` (`.eq('kind','time_tbd')`). A relocated target slot is not seen as occupied (gap G2, §3) |
| Feed, portal, RSVP (R4-R7) | Yes | §3 |
| Exports (R9), player record (R10) | Count only / no | Series-level by answer Q6 (PR 12 plan `:549-550`) |
| Booking guard, retire dry-run, blackout-editor booking preview (X13) | **No** | PR 12 plan `:118`, D5 `:417-421` (gap G3) |

## 2. What 11d must change, by layer

### 2.1 The adapter reads live exceptions

`buildPracticeRepairInput` gains `rows.practiceExceptions`. It is required
when supplied by the loader: an absent array is a partial read, never "none",
which is the `enactPromptOf` precedent (`practiceRepairEnact.js:155-160`).

**Rules, adopted from `applyPracticeExceptions` (`packages/core/src/utils/practiceExceptions.js`) so that no third contract appears:**

1. **Live** means `withdrawn_at == null`. The adapter filters them **itself,
   whatever the caller selected**. The loader reads withdrawn rows too
   (`usePracticeRepairSnapshot.js:63-64`). A row with no `withdrawn_at` key is
   unreadable and refuses the input, never "live". (Helper `:19-22`,
   `:258-259`.)
2. **Scope.** Only exceptions whose `assignment_id` is a snapshot row are
   applied. An exception naming an unread row refuses the input. The loader
   reads the organization, not the season (`:88`), so the adapter narrows to
   the season's rows first and names what it dropped in `declared`. This is
   the adapter's "names an unread field" rule (`repairAdapter.js:489-492`).
3. **Windows** are read by `practiceRangeBounds`, the one parser. An open or
   unreadable window refuses the input, because the helper would show those
   dates TIME TBD (rule 6) and the repair cannot price them.
4. **A live window that covers all of S ∩ loss window, caused by this loss**
   (`cause_kind = 'blackout'`, `cause_id = loss.blackout.id`) means S is
   **enacted for that window**. S is left out of the displaced set, so
   `rebaseRecommendationState` rule 1 holds after a blackout enact. The
   adapter passes S to the repair with that window taken out: as frozen
   ground outside the window, and as no ground inside it.
5. **A live `relocated` window is a frozen occupant** of its relocated slot
   over window ∩ the row's range (Q9 clip). This needs one **solver-input
   addition**: optional `occupants: [{ id, teamId, slotId, from, until }]` in
   `PracticeRepairInputSchema`, merged into `frozen` in `repair.js:703-707`.
   Occupants are never displaced and never recommended. This is the S part of
   11d, and it runs the season-2026 fixture suite.
6. **A live `time_tbd` window occupies no ground.** The row's own slot is not
   freed over the window. That is conservative (it may under-use a slot, and
   never double-books) and it is declared.
7. **Every other meeting of a planned write with a live window is refused**
   (§4). This covers both loss kinds: 11d changes the retirement path too.

`declared.exceptions` records `{ supplied, rowsRead, live, withdrawn,
applied, occupants, enactedWindows, outOfSeason }`. The panel prints it next
to `declared.closures` (`PracticeRepairPanel.jsx:542-548`).

### 2.2 Blackout loss windows (mid-range, maybe with minutes)

**No storage change is needed for minutes.**

- The window is `loss ∩ series range` in whole days (`repair.js:677-678`).
- Minutes decide only **whether** a series is displaced (`hitsLossMinutes`,
  `repair.js:347-354`, `:704`) and which candidates a closure refuses
  (`:617-618`).
- A practice row has one slot, so it has one practice on each date. A
  whole-day window on the row therefore means exactly "this row's practice
  on these dates". `practice_exceptions` has no minutes column
  (`20260929000000:108-146`), and it needs none.

The adapter's exception payload already carries only the window
(`repairAdapter.js:759-772`). The **record** is what must admit minutes:
`cause.loss.until` becomes a date, and `start_minutes`/`end_minutes` become
`Minutes | null`, both or neither (Q1).

### 2.3 The payload, `kind: 'blackout'`

**Core `enact.js` changes:**

- `retirementCommitOf` → **`causeCommitOf(freshRows, loss)`**. There is one
  gate per kind, and the retirement arm is unchanged. The blackout arm (§2.6)
  returns `{ committed, refusal, causeId, stored }`, where `stored` is the
  stored blackout row's scope, dates, minutes and reason.
- `buildEnactPayload` branches on `cause.kind`:
  - For a blackout it calls `buildPracticeRepairPayload(adapted,
    {representation: 'override', rehomed: [{assignmentId, window, to}] or [],
    timeTbd: [{assignmentId, window, reason}] or []}, {assignedVia:
    'recommendation'})`. The `window` is the fresh recommendation's own
    window, never the loss's.
  - `unlockRequired` is empty for a blackout (§2.5), so `unlock` is `[]`.
- New refusal `PRACTICE_ENACT_REFUSAL.BLACKOUT_UNCOMMITTED` /
  `BLACKOUT_CHANGED`. `BLACKOUT_NOT_ENACTABLE` is **deleted, not left
  parsed-and-unread** (CLAUDE.md §3).

**The adapter's A1 refusals are lifted for a blackout exception.** Five new
named refusals replace them, each of which leaves `payload: null`:

| Refusal | When | Why |
|---|---|---|
| `LIVE_EXCEPTION_OVERLAP` | The planned window meets a live window on the same row | The EXCLUDE constraint (`20260929000000:144-146`) would raise 23P01. Refuse first, and loudly (§4) |
| `CLOSE_CUTS_LIVE_EXCEPTION` | A retirement's `closes` would leave a live window reaching past the new last day | The helper clips a relocated window to the row (rule 5), so its dates after D-1 would vanish. Trimming it is decision 6's withdrawal |
| `DAYLIGHT_MID_RANGE` | A TIME TBD with `past-sunset` or `sunset-unknown` whose window ends before its row does | Adopts the writer's own refusal (`20261002000000:1115-1122`) instead of letting it 22023 (Q3) |
| `RELOCATION_LOSES_PRACTICES` | The relocated slot's weekday has fewer dates in window ∩ range than the series' own weekday | Gap G1 (§3, Q6) |
| `RELOCATED_TARGET_LOST` | Not a payload refusal: a live relocated occupant on the lost ground over the loss window | It cannot be repaired without a withdrawal (decision 6). The panel shows it as its own row, "cannot be repaired here", and it is never dropped (Q8) |

`MID_RANGE_WINDOW` and `WINDOW_INSIDE_ROW` then have no producer. They and
their `SAVE_REFUSAL_TEXT` entries (`practiceRepairPanel.js:64-73`) are
deleted in the same PR.

**The record** (`PracticeEnactRecordSchema` and its Edge twin) becomes a
discriminated union on `cause.kind`. The top-level key set stays the same, so
the wrapper's `c_keys` (`20261004000000:97-101`) is unchanged.

```jsonc
"cause": {
  "kind": "blackout",
  "id": "<field_blackouts uuid>",
  "loss": { "from": "YYYY-MM-DD", "until": "YYYY-MM-DD", "surface_ids": ["<uuid>"],
            "start_minutes": 1020, "end_minutes": 1140,       // or both null
            "reason": "maintenance" },                          // the enum, never the note
  "stored": { "field_id": "<uuid>" | null, "location_id": "<uuid>" | null,
              "blackout_from": "YYYY-MM-DD", "blackout_until": "YYYY-MM-DD",
              "start_minutes": 1020, "end_minutes": 1140, "reason": "maintenance" }
},
"decision": { "kind": "relocate" | "time_tbd", ... },   // "rehome" stays retirement-only
"prompt": { "rows": [{ "assignment_id": "<uuid>", "assigned_via": "auto",
                       "effect": "temporarily moved" | "temporarily TIME TBD",
                       "range_after": null,
                       "window": "[YYYY-MM-DD,YYYY-MM-DD]" }], ... },
"unlock": [],
"writes": { "closes": [], "new_rows": [], "exceptions": 1 }
```

`decision.kind: 'relocate'` is new rather than reusing `rehome`. The wrapper
checks each kind's write shape separately (§2.4), and a single word meaning
"new row" for one cause and "exception" for the other is how a sibling check
ends up wrong.

### 2.4 The wrapper RPC and the writer

**The writer is unchanged.**

- Adding an exception is not in the lock set (`20261002000000:779-791`), so a
  blackout enact needs no `unlock`.
- Its only mid-range refusal is the daylight one (W2), which the adapter
  adopts (`DAYLIGHT_MID_RANGE`).
- Lifting W2 is **not** 11d's job (PR 12 answer Q8). See Q3.

**The wrapper needs a new migration**, `CREATE OR REPLACE FUNCTION
public.enact_practice_recommendation`, with the same signature. It would be
version `20261006000000` or later: above `20261005000000` (#527), as
`scripts/ci/migrationVersions.mjs` requires.

**This is the 10th pending production migration.** #527 was the 9th
(`docs/PHASE_8_PROGRESS.md:7393`, `:7401`; #527's body). `deploy-migrations`
allows at most `MAX_PENDING_MIGRATIONS` (default 5, `scripts/ci/migrationGuard.mjs:28`),
so the operator must work down the queue or raise the limit for one run
(Q9).

The changes, all confined to the non-retirement arm except where marked:

| Step | Today | 11d |
|---|---|---|
| 3 (`:167`, `:173`) | `cause.kind` must be `retirement`; `decision.kind` in (`rehome`, `time_tbd`) | `cause.kind` in (`retirement`, `blackout`). Retirement admits `rehome`/`time_tbd`; blackout admits `relocate`/`time_tbd` |
| 2a (`:207-224`) | Retirement commit gate | Blackout arm: `SELECT ... FROM field_blackouts WHERE id = cause.id AND organization_id = v_org_id **FOR SHARE**`. None → 22023 "blackout X is not saved". Any of scope, `blackout_from`, `blackout_until`, minutes or `reason` differing from `cause.stored` **or** from `cause.loss` → 22023 "blackout X changed". `loss.surface_ids` must equal `{field_id}` or every field of `location_id` (the adapter's `fieldsOfLocation`, `repairAdapter.js:415-420`). `FOR SHARE` blocks `admin_update_field_blackout` / `admin_delete_field_blackout` until commit (Q10) |
| 7 (`:295-299`) | S must be closed or superseded | Blackout arm: `closed`, `unlocked`, `superseded` and new rows must all be **empty**. `exceptions_recorded` must be exactly 1, on S, with `cause_kind = 'blackout'`, `cause_id = cause.id`, `"window" = series.window`, `kind` = `relocated` for `relocate` (with `practice_slot_id` = the record's slot) or `time_tbd` (with `tbd_reason` = `decision.tbd_reason`). Anything else → 22023, and the whole call rolls back |
| 7 (`:337-345`) | Counts per retirement kind | Blackout counts as above. The retirement counts are unchanged |
| 8 (`:348`) | Writes `stored_effective_to` | Blackout: writes `cause.stored` as the gate **read** it |

Revert: `docs/sql/<version>_revert.sql` restores the `20261004000000` body,
checked by an md5 of `prosrc` (the #527 precedent). Smoke:
`docs/sql/<version>_smoke.sql`. pgTAP: `supabase/tests/enact_blackout.sql`.

**Edge.** `practice-persistence` passes the union twin through. The PR 11
error mapping (`_shared/practice-repair-errors.ts`) is unchanged: the new
22023 refusals get the same response the retirement gate's 22023 gets today.

### 2.5 The UI: reusing the ruling-2 confirmation

The 3b plan's override prompt fires for "a retirement enact that closes a
row, or withdrawing an enacted exception" (`PHASE_8_6_PR3B_PLAN.md:162-169`).
A blackout enact does neither: it **adds** an exception to a locked row
without re-ranging it, and the writer asks for no `unlock` (§2.4). It still
moves published practices of a locked series. So the plan reuses the **same
dialog and the same shape** (Q4):

- **Heading:** "Enact: `<ground>` closed `<from>` to `<until>`[, `HH:MM`-`HH:MM`]",
  built from the **stored** row (§2.6), never the draft.
- **One row:** S's row (weekday, time, ground, range, `assigned_via`), with
  the effect "keeps its range; its practices from `<w.from>` to `<w.until>`
  are temporarily moved to ..." or "... are temporarily TIME TBD, because
  ...".
- **The count** (§2.7).
- **One checkbox per team.** Confirm stays disabled until it is ticked, with
  the visible reason.
- **Nothing extra is sent.** The payload's `unlock` is `[]`. Sending an
  unlock would write a `practice.unlock_accepted` row claiming a lock was
  broken, which would be false. The tick is recorded as `prompt.accepted:
  true` in the enact record.
- The focus rules are those of 11c (`PracticeEnactDialog.jsx`, WCAG 2.2 AA).

The code that changes for this:

- `enactPromptOf` takes the plan's `exceptions` as prompt rows for a
  blackout, not only `unlockRequired` (U3).
- `enactGateOf`: the `BLACKOUT` arm is replaced by the blackout commit gate
  and the `preview` arm (U1).
- `PracticeRepairPanel.dialogFor` branches on `loss.kind` (U4).
- `PracticeEnactDialog` takes a `heading` prop in place of the hard-coded
  "retires after" (U4).
- The mock writer mirrors §2.4 (U5).

### 2.6 The blackout commit gate (Q5)

This is the Q3 answer of PR 11 applied to blackouts. **Enact only a saved
blackout, and only as it is saved.**

- **Core `causeCommitOf`, blackout arm.**
  - Find the fresh `fieldClosures` row with `source = 'field_blackouts'` and
    `id = loss.blackout.id`. The loader already reads the view
    (`usePracticeRepairSnapshot.js:57-61`).
  - None, or the id `'draft'` → `BLACKOUT_UNCOMMITTED`.
  - Scope, dates, minutes or reason differing from the loss →
    `BLACKOUT_CHANGED`.
  - The view has `closes_field_id` and `closes_location_id`, not
    `field_id`, so the gate maps them.
- **The editor's launcher is always a preview.** `BlackoutEditor.jsx:463-465`
  passes `preview`, and every Enact button there is disabled with the reason
  "Save the blackout first: enacting moves practices, and this blackout is
  not saved yet."
- **The post-commit entry point.** `BlackoutsPage.jsx` gains a "Repair
  practices" launcher on each stored row, next to its Edit button
  (`:252-255`). The loss is built from the **stored** row.
- **SQL.** The wrapper checks again (§2.4, step 2a).

So the disabled button is not the only gate: the check runs in the panel
gate, on the fresh read, and in SQL.

### 2.7 The enact counts

- **The dialog's "published practices that could change".** For a blackout,
  this is the `series` dates of S inside the recommendation's window, after
  live exceptions are applied. It uses the same helper call as #525
  (`practiceRepairEnact.js:176-189`), bounded by `[w.from, w.until]` in place
  of `[D, until]`.
  - With `LIVE_EXCEPTION_OVERLAP` refusing (§4), no date in the window is
    already changed. The helper is still run: it defends the case, and it is
    not claimed as coverage.
  - For a relocation, the dialog also states "N practices on `<weekday>` move
    to M on `<weekday>`" (G1, Q6).
- **"Series enacted off this field"** (`frontend/src/utils/practiceEnactCount.js:42-50`).
  It filters audit rows by `cause.id` and `stored_effective_to`, not by
  `cause.kind`. Once blackout rows exist it must also require `cause.kind ===
  'retirement'`. That adopts the sibling contract, rather than relying on
  uuids never colliding across tables.
- **Optional (Q11): "series enacted off this blackout".** The edit and delete
  confirmations on `BlackoutsPage` gain the same count, from
  `practice.recommendation_enacted` rows with `cause.kind = 'blackout'` and
  `cause.id` equal to the blackout. This is decision 6's "cause changed" flag
  in its smallest form. It is declared: nothing is withdrawn.

## 3. Interaction with the PR 12 readers

Mid-range blackout windows are exactly the case PR 12 made safe to show.
Each reader was statically reviewed against both cases on `d076819`.

| Reader | Mid-range `relocated` | Mid-range `time_tbd` | Evidence |
|---|---|---|---|
| Core helper (all readers) | Series dates in W are removed. Relocated-weekday dates in **W ∩ range** are added, with the new slot's times and ground | Every row-weekday date in W becomes a dated TIME TBD with `code = tbd_reason` | `packages/core/src/utils/practiceExceptions.js:177-185` (rule 4), `:193-201` (rule 5), `:258-259` (withdrawn), `:346-385` (overlap → CONFLICT) |
| Feed (R4/R5) | A timed VEVENT from the relocated slot, SUMMARY `Practice (moved) - <team>`, DESCRIPTION "because of a field closure" (`cause_kind: 'blackout'`), UID `<assignment>_<date>` | A dated all-day TENTATIVE VEVENT, counted in the CALDESC | `supabase/functions/_shared/calendar/teamFeed.ts:75-80` (select with `cause_kind` and the slot), `:196-216` (live, org-scoped, capped read); `icsFeed.ts:454` (twin), `:522-535` (TBD), `:538-575` (moved), `:351` (wording); #521 body |
| Portal (R2/R3) | "Practice (moved)" at the new time and place, one "Moved from" line; RSVP open | "Time TBD on `<date>`: `<reason>`"; RSVP hidden | `frontend/src/hooks/useTeamPortal.js:9-15`, `:211-216`, `:473`, `:497-500`; `TeamRecordPage.jsx:57`, `:68`, `:268`, `:292`; #525, #527 bodies |
| RSVP (R6/R7) | Accepted only on the relocated slot's weekday inside the window **and** the bounded row range. The original date is refused 22023 | Refused 22023 | `supabase/migrations/20261005000000_rsvp_applied_practice_calendar.sql:186-209`, `:211-262`; mock `frontend/src/lib/mockSupabaseClient.js:1359`; #527 body |

**Confirmed:** the feed, the portal and RSVP all handle a mid-range relocated
window and a mid-range TIME TBD window. These are statically reviewed
conclusions. 12b-12d each proved theirs with a seeded mid-range case (#521:
"a mid-range TBD, a move to another weekday, a same-day move"; #525: "a move
to another weekday, a mid-range TBD"; #527: "a live relocated window, a live
mid-range TIME TBD window"). This plan ran none of them.

**Gaps.** None of these is a reader bug. Each is a case 11d is the first PR
able to reach.

- **G1: a relocation can lose practices, silently.**
  - Rule 5 removes the series' own weekday dates in W and adds the new
    weekday's dates in W ∩ range. That is correct for what is stored.
  - But the repair never checks that a **candidate's** weekday falls in the
    window. `againstFrozen` tests overlap only (`repair.js:822-839`). The
    series itself is checked (`:681`), but its candidates are not.
  - Example: a one-day blackout on a Tuesday. A same-venue Thursday candidate
    is free, at the cost of `changedWeekday = 1`. If it is enacted, the
    Tuesday practice is removed and no Thursday falls inside `[Tue, Tue]`.
  - Unequal windows lose practices the same way. `[Tue d1, Tue d8]` holds two
    Tuesdays but one Wednesday.
  - Every reader faithfully shows the loss, and none reports it. That breaks
    CLAUDE.md §3, "never silently drop". 11d refuses such a relocation
    (`RELOCATION_LOSES_PRACTICES`, §2.3). The solver-side fix is Q6.
- **G2: the auto-scheduler does not see a relocated slot as occupied.**
  - It reads only `time_tbd` exceptions (`practice-lock.ts:272-276`).
  - Its locked rows hold their slot for the whole season, but a relocated
    target slot with no row of its own is free to it. An ordinary run could
    place an unassigned team there, and that team would collide with the
    moved practice during the window.
  - 11d is the first in-app writer of `relocated` rows. See Q7.
- **G3: the booking guard, the retire dry-run and the blackout editor's
  booking preview do not count relocated exceptions** (PR 12 plan X13, D5).
  - A later retirement or blackout of the target ground misses the moved
    practice in its dry-run.
  - Its repair **does** see it after 11d, through `RELOCATED_TARGET_LOST`
    (§2.3).
  - The guard itself is declared, not changed.
- **G4: the exports (R9) and the player record (R10) stay series-level**
  (answer Q6).
  - Blackout windows make them wrong in-app for the first time. Until now,
    mid-range rows were reachable only by a hand-built Edge call.
  - The export states the count (#525). The player record states nothing.
  - Declared.

## 4. Overlap and concurrency

The EXCLUDE constraint forbids two overlapping live windows on one
assignment (`20260929000000:144-146`). The helper defends the state anyway
(rule 7, CONFLICT) but does not make it reachable.

| Case | What 11d does |
|---|---|
| **Two blackouts on one row, windows disjoint** | Both are enactable. Each is its own panel and its own loss. The second panel reads the first's exception live: its relocated target is an occupant (§2.1 rule 5), and the row's own slot over the first window is not freed (rule 6) |
| **Two blackouts on one row, windows overlapping** | **Refuse** the second enact: `LIVE_EXCEPTION_OVERLAP`, and the panel shows it (Q2). Splitting W2 \ W1 into up to two exceptions would be representable, but in the overlap the practice is already moved, possibly onto ground B2 also closes, and deciding that needs decision 6's withdrawal. A split is a follow-up |
| **The same blackout re-opened after an enact** | S's live window with `cause = (blackout, B.id)` covers S ∩ loss, so S is **enacted for that window** and not displaced (§2.1 rule 4). `rebaseRecommendationState` then holds (`recommendations.js:453-459`) |
| **A blackout on a row with a retirement tail TIME TBD** | The retirement closed the row at D-1 and recorded `[D, until]` after it. The blackout window is loss ∩ the row's range, so it ends by D-1 (`repair.js:677-678`) and never meets the tail. It is enactable. The team is timed until D-1, moved or TBD in the window, and TBD from D. A daylight window that **starts inside** its row (PR 12 D2) would meet it, and is refused `LIVE_EXCEPTION_OVERLAP` |
| **A retirement enact on a row with a live blackout exception** | `closes` would cut a live window that reaches past D-1 → `CLOSE_CUTS_LIVE_EXCEPTION`. A tail TBD meeting a live window → `LIVE_EXCEPTION_OVERLAP`. Both are new refusals on the retirement path, from 11d-1 on |
| **A later loss hits a relocated target** | `RELOCATED_TARGET_LOST`: a panel row "cannot be repaired here", Enact disabled, and never dropped (Q8) |

**Staleness (`PRACTICE_SCHEDULE_STALE`).**

- **Covered.** The fingerprint hashes every exception's id and `withdrawn_at`
  (`20260929000000:192-198`). A blackout enact, or any exception write, from
  another tab between the fingerprint read and the commit changes it. The
  writer raises 40001 under the season lock, the Edge maps it to `409
  PRACTICE_SCHEDULE_STALE`, and the client re-judges and never re-sends
  (PR 11 plan §4, `practiceRepairEnact.js:343-355`). Nothing new is needed.
- **Not covered, then gated.** `field_blackouts` is not in the fingerprint
  (PR 11 answer Q5). An edit or delete of the blackout between the click and
  the commit is caught by the wrapper's blackout gate, which re-reads the row
  under the season lock `FOR SHARE` (§2.4). The fresh read at click time
  catches it earlier, as `BLACKOUT_CHANGED`.
- **Declared.** `admin_update_field_blackout` and `admin_delete_field_blackout`
  do not take the practice season lock. `FOR SHARE` makes them wait for an
  in-flight enact. An edit **after** the enact commits leaves an exception
  whose cause changed: decision 6's flagged state. 11d only counts it
  (§2.7, Q11).
- **Idempotency** is unchanged: it is keyed on the enact audit row
  (`20261004000000:230-241`).

## 5. Witnesses and plants

- Every subject set is enumerated from the **seeded input**: the snapshot
  rows × the blackout window, the seeded exception rows, and the roster.
  None is enumerated from the output under test.
- Every fixture asserts that it exercised data, with at least one of each:
  - a displaced series-window;
  - a live relocated exception;
  - a live mid-range TIME TBD;
  - a withdrawn exception;
  - a retirement tail TBD;
  - a partial-day blackout.
- **Meta-plant (all rows):** move the blackout off every series. Each
  exercise assertion must turn red.

| # | Guarantee | Test | Plant that must turn it red |
|---|---|---|---|
| B1 | Withdrawn exceptions never apply, whatever the caller selected | `tests/practiceRepairAdapterExceptions.test.js`: the seed passes withdrawn rows unfiltered | Drop the adapter's own `withdrawn_at` filter |
| B2 | A relocated window occupies its slot | Same: a candidate equal to a live relocated slot over an overlapping window is never recommended; the subject set is every (series, candidate) pair from the seed | Skip `occupants` |
| B3 | An enacted window is not displaced again | Same, plus `practiceRecommendations.test.js`: re-open the same blackout after a seeded enact; the re-base does not throw and S is absent | Ignore `cause_id` |
| B4 | Overlap is refused, never written | Same: every seeded (live window, planned window) pair on one row that overlaps gives `LIVE_EXCEPTION_OVERLAP` and `payload: null`. pgTAP: forcing the payload through gives 23P01 and zero rows changed | Drop the overlap check (the adapter emits the payload) |
| B5 | A retirement never cuts a live window | Adapter test over the seed's rows × retirement dates | Drop `CLOSE_CUTS_LIVE_EXCEPTION` |
| B6 | No relocation loses a practice (G1) | For every seeded relocation: target-weekday dates in W ∩ range ≥ series dates in W, or it is refused. The subject set is the repair's **candidates** for the seed, not its choices | Drop the count check (the Tuesday one-day seed then writes a relocation to Thursday) |
| B7 | A daylight mid-range TBD never reaches the writer | Adapter test: `past-sunset` mid-range gives `DAYLIGHT_MID_RANGE`. pgTAP: sent anyway, 22023 (the writer's own) | Drop the refusal (the writer still catches it; the adapter test goes red) |
| B8 | Only a saved blackout is enacted | `practiceEnact.test.js` (`causeCommitOf`): `'draft'` id, a missing row and each changed field → refusal. pgTAP: the wrapper with no row, and with each column changed, gives 22023 and zero changed rows or audit rows. Panel: opened from `BlackoutEditor`, every Enact button disabled with the reason | Plant A: drop the wrapper's blackout gate. Plant B: compare the loss to itself. Plant C: remove `preview` from the editor launcher |
| B9 | The wrapper writes exactly one exception on S and nothing else | dbharness: every pre-enact row unchanged, no new row, one exception with the right cause, window, kind and slot | Accept `exceptions_recorded >= 1` |
| B10 | Blackout rows are audited atomically | dbharness: force the audit insert to fail, and the exception rolls back | Move the audit after the writer's commit (Edge) |
| B11 | A blackout edit racing an enact cannot slip past the gate | dbharness: two sessions; the update blocks on `FOR SHARE` until the enact commits, and the wrapper's re-read runs under the lock | Drop `FOR SHARE` (the update commits between the read and the insert) |
| B12 | The readers show the enacted window | One E2E, `practice_repair_enact_blackout.feature`: enact a relocation and a TIME TBD, then as a parent see "Practice (moved)" and "Time TBD on". The seed carries `organization_id`, and the assertions are DOM only | Enact writes `cause_kind: null` (the feed wording test in `ics-feed_test.ts` also goes red) |
| B13 | The dialog's count is true | `practiceRepairEnact.test.js`: the count equals the seeded series dates in W, computed by hand | Count `[D, until]` (the retirement bound) |
| B14 | The un-retire count ignores blackout enacts | `practiceEnactCount` test: a blackout row whose `cause.id` equals the field id is not counted | Drop the `cause.kind` filter |
| B15 | Core and Edge record schemas agree | `tests/practiceEnactSchemaDrift.test.js`, extended to the union | Add `stored` to one arm only |
| B16 | Retirement enact is unchanged except for the new refusals | The existing 11a-11c suites pass unmodified. The season-2026 fixture suite passes on 11d-1 (solver input) | Merge `occupants` into `displaced` |

**Each meta-assertion is shown able to fail in the PR that adds it.** Every
"≥ 1 of each" check is run once against the meta-plant, and it must go red.
B4's forced-payload pgTAP arm defends the unreachable 23P01 state (D2). It is
not claimed as coverage.

## 6. Size and split

The estimate is about **1,950 lines**, against the PR 11 plan's ~500
(`:460`). The ~500 assumed only "the loader and adapter read live exceptions;
the button is enabled". It did not count the wrapper migration, the blackout
commit gate, G1 or G2.

| PR | Contents | Touches | Size |
|---|---|---|---|
| **11d-1** core | Adapter: live exceptions (§2.1), the five refusals (§2.3), `declared.exceptions`. Repair: `occupants` input. Loader: three more exception columns (`practice_slot_id, cause_kind, cause_id`). `enact.js`: `causeCommitOf`, the blackout payload, the record union. Delete `BLACKOUT_NOT_ENACTABLE`, `MID_RANGE_WINDOW` and `WINDOW_INSIDE_ROW`. Witnesses B1-B7, B13 (core part), B15 (core), B16, season fixture | S, D | ~750 |
| **11d-0** auto-scheduler lock (Q7) | `practice-lock.ts` also loads live `relocated` exceptions and holds their slots as occupied, season-wide (the locked-row contract). Deno mirror and Vitest arms | S | ~200 |
| **11d-2** persistence | Wrapper migration (§2.4) + revert + smoke + pgTAP. Edge union twin. Mock writer mirror. B8 (SQL), B9-B11 | P | ~550 |
| **11d-3** UI | `enactGateOf`, `enactPromptOf`, `dialogFor`, dialog `heading`. The editor launcher as a preview. The `BlackoutsPage` stored-row launcher. `practiceEnactCount` kind filter. Optional Q11 count. E2E. B8 (client), B12, B13 (client), B14 | — | ~450 |

**Order:** 11d-1 → (11d-0 ∥ 11d-2) → 11d-3.

- 11d-1 alone enables nothing. It adds refusals and occupancy to the
  retirement path, and production holds no exception rows today
  (PR 12 plan `:557-560`).
- 11d-3 turns the button on. It must not merge before 11d-0 and 11d-2 have
  merged **and** the 10th migration has deployed. Otherwise the button
  reaches a wrapper that refuses at `:167`, which is loud but broken.

## 7. Declared, not enforced

- **D1.** The writer still admits mid-range `relocated` rows and non-daylight
  `time_tbd` rows from any caller (PR 12 D1). The only guards are the adapter
  and, for an enact, the wrapper's only-S check.
- **D2.** Overlapping live windows are unreachable (EXCLUDE). The adapter
  refusal and the helper's CONFLICT rule both defend a state the database
  forbids. They are declared as defence, not as coverage.
- **D3.** A live `time_tbd` window does not free the row's own slot for other
  series (§2.1 rule 6). This is conservative: it may under-use a slot.
- **D4.** The relocated practice's coach days are approximated. The occupant
  adds its weekday; the original weekday is not removed within the window.
- **D5.** G3: the booking guard and the retire dry-run do not count
  relocated exceptions.
- **D6.** G4: the exports and the player record stay series-level.
- **D7.** A blackout edited or deleted **after** an enact leaves its
  exceptions live and locked (decision 6). 11d does not withdraw them. Q11
  shows a count at most.
- **D8.** `field_blackouts` is not in the fingerprint (PR 11 Q5). The
  wrapper's `FOR SHARE` re-read closes the click-to-commit window for the
  blackout row only. Slots, fields and coaches remain as PR 11 declared them.
- **D9.** The un-retire count and any blackout count are read from the audit
  log. An enact whose exception was later withdrawn is still counted.
- **D10.** G1's solver-side fix is not in 11d unless Q6 says so. The repair
  may still **recommend** a relocation that loses practices. 11d only refuses
  to write it, and the panel shows the refusal.
- **D11.** 11d changes the enact-flow wiring, so `tests/unwiredLayerImporters.test.js`
  and `tests/practiceReaderCensus.test.js` must still pass. The adapter
  reading exceptions makes it a census **reader**: it is registered as
  `series-only (declared)`, not `applies`, because it makes no dates.

## 8. Questions for the operator

**Q1. Partial-day (minutes) blackouts: enact them in 11d?**

*Recommendation (not an answer):* **yes.**

- Minutes decide only which series are displaced (`repair.js:347-354`) and
  which candidates are refused. A row has one practice per date, so the
  whole-day exception window is exact.
- No column is added. The record carries the minutes.
- A move to the same ground at a later time on the same day is an ordinary
  same-venue candidate, if the repair finds it free.

**Q2. Two live windows on one row: refuse or split?**

*Recommendation (not an answer):* **refuse** (`LIVE_EXCEPTION_OVERLAP`), loud
and shown in the panel.

- A split (W2 \ W1, up to two exceptions) is representable.
- But in the overlap the practice is already moved, possibly onto ground the
  second blackout also closes. Resolving that needs decision 6's withdrawal,
  which is out of scope.
- Splitting would be a follow-up with its own plan.

**Q3. Is lifting the writer's mid-range daylight refusal
(`20261002000000:1106-1123`) in scope?**

*Recommendation (not an answer):* **no.**

- PR 12 answer Q8 gives it its own migration. 11d adopts the refusal in the
  adapter (`DAYLIGHT_MID_RANGE`), so a daylight-reason blackout TIME TBD is
  refused in the panel and never reaches a 22023.
- 12b-12d have merged and Q6 is answered, so that migration may now be
  planned. Folding it in would make 11d-2 carry two function replacements,
  and would add an 11th pending migration if it were split out.

**Q4. Does the blackout enact need its own confirmation wording?**

*Recommendation (not an answer):* **yes, in the same dialog and the same
ruling-2 shape** (§2.5).

- The heading names the stored ground, dates and times. The one row says
  "keeps its range; practices from X to Y are temporarily moved to ... / are
  TIME TBD". It shows the count, and the one per-team tick is required.
- It sends **no `unlock`**. No lock is broken, and an `unlock_accepted` audit
  row would say otherwise.

**Q5. A blackout commit gate: enact only a saved blackout, equal to what was
shown, with the editor's draft launcher always a preview and a new launcher
on the stored row?**

*Recommendation (not an answer):* **yes**, the PR 11 Q3 answer applied to
blackouts (§2.6).

**Q6. G1, a relocation that loses practices: where is it fixed?**

*Recommendation (not an answer):*

- **In 11d:** the adapter refuses `RELOCATION_LOSES_PRACTICES` when the new
  weekday has fewer dates in W ∩ range than the old one. The dialog states
  both counts when they differ upward.
- **As a follow-up solver PR** (with the fixture suite): the repair filters
  such candidates, so it stops recommending them.

**Q7. G2, the auto-scheduler and relocated slots: fix in 11d?**

*Recommendation (not an answer):* **yes, as 11d-0, merged before the button
is enabled.**

- 11d is the first in-app writer of `relocated` rows.
- Holding their slots season-wide matches the existing locked-row contract:
  it never double-books, and it may under-use a slot.

**Q8. A later loss that hits a relocated target: what does its panel show?**

*Recommendation (not an answer):*

- Treat the move as an occupant, so no other series lands on it.
- List it as its own row, "cannot be repaired here: its temporary move lands
  on the closed ground; withdrawing a saved change is not available yet",
  with Enact disabled.
- Never drop it.

**Q9. The 10th pending production migration.**

*Recommendation (not an answer):* **accept it.**

- It is one `CREATE OR REPLACE` of the wrapper, with the writer unchanged.
- Deploy it after the queue is worked down, or with `MAX_PENDING_MIGRATIONS`
  raised for one run.
- 11d-3 must not merge before it is deployed.

**Q10. Lock the cause row `FOR SHARE` in the wrapper?**

*Recommendation (not an answer):* **yes, for the blackout arm.** Also, as a
declared departure from 11b, for the retirement arm's `fields` read in the
same `CREATE OR REPLACE`. It costs one clause each, and it closes the edit
race that PR 11 left to the click-to-commit declaration.

**Q11. Show "N series enacted off this blackout" on the blackout edit and
delete confirmations?**

*Recommendation (not an answer):* **yes, as a count only** (the un-retire
precedent). Withdrawing is decision 6's prompt, which is not in 11d.
