# Plan: the scheduling grid's override prompt (operator ruling 2)

Status: **PROPOSED.** Docs only; no code changes. Follows #542
(`fix/grid-locked-override-message`), which made the grid's locked refusal
readable and changed nothing about what the grid saves. `lockedRowOf` below is
from #542.

Evidence labels, per CLAUDE.md: _read_ (statically reviewed), _executed_ (run,
output quoted), _test-verified_ (a committed test asserts it). Everything in
§1 is _read_ on `main` at 565e980 unless marked otherwise. Line numbers are
from that commit.

---

## 0. Headline

Ruling 2 says a locked practice moves only when "an admin accepts an explicit
override prompt". The enact flow has that prompt. The scheduling grid does
not. Today a manual override of a team that already has a saved practice is
always refused by writer v3, and the grid has no way to ask.

The proposal: when Apply would replace or re-range a locked row, the grid
opens a confirmation dialog **before** it sends anything. The dialog names
each team, the series being replaced and the new slot. The admin ticks one box
per team and picks a reason. The save then goes through `persistPracticeRepair`
with exactly those rows in `unlock`, each with that reason. The writer's
existing gate, audit and refusal do the rest. No migration, no Edge change,
no new RPC.

---

## 1. What exists today (_read_)

### 1.1 The writer's `unlock` contract

| Fact                                                                                                                          | Where                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| A save that deletes, re-ranges or moves an existing row refuses 22023 `assignment X is locked: <why>` unless X is in `unlock` | `supabase/migrations/20261002000000_practice_exceptions_daylight.sql:775-798` |
| The `<why>` values: payload lost its key; absent team's auto row; `closes`; withdrawn exception                               | same, `:783-791`                                                              |
| A new row that double-books its team (same weekday, overlapping minutes and range) refuses the same way                       | `:920-956` (the unlocked prune runs first, so an unlocked row makes room)     |
| `unlock` needs an org admin **with a uid**; else 42501                                                                        | `:274-284`                                                                    |
| Every unlock entry needs a non-blank reason; else 22023                                                                       | `:651-655`                                                                    |
| One `practice.unlock_accepted` audit row per unlocked row, with `reason` and the before-image                                 | `:811-833`                                                                    |
| `practice.saved` carries `unlocked_count`                                                                                     | `:1248-1264`                                                                  |
| The Edge validates `unlock: [{assignment_id: uuid, reason: 1..500 chars}]`                                                    | `supabase/functions/practice-persistence/index.ts:51-55`                      |
| A repair save maps the lock refusal to 409 `PRACTICE_ASSIGNMENT_LOCKED`; an ordinary save keeps a codeless 500                | `supabase/functions/_shared/practice-repair-errors.ts:26-38`                  |
| The client sends `unlock` only through `persistPracticeRepair`                                                                | `frontend/src/utils/practicePersistenceClient.js:23-46`                       |

### 1.2 The enact flow's ruling-2 confirmation

- `PracticeEnactDialog.jsx` **is** the prompt for one assignment
  (`:6-20`). It lists each row the write re-ranges or replaces with what happens
  to it (`:107-119`), then the replacement (`:120-122`), then one checkbox per
  team (`:126-148`). Confirm is disabled, with a visible reason wired through
  `aria-describedby`, until every box is ticked (`:55-63`, `:83-86`,
  `:149-151`). Focus goes to the heading on open and back to the opener on
  close, through `Modal` (`:19-20`, `:93-99`; `Modal.jsx:35-43`, `:68`).
- `unlock` is built in core from the adapter's `plan.unlockRequired`, and only
  when the answer is accepted (`packages/core/src/practice/enact.js:455-468`).
  Not accepted means no call at all.
- The enact reason is **generated** (`enact <key>: retirement of field <id>
from <D>`, `enact.js:496-498`): ids and a date, no free text, no PII.
- At Confirm the prompt is rebuilt from a fresh read and compared with the one
  shown; a difference is a `prompt-changed` stale, never a silent send
  (`frontend/src/utils/practiceRepairEnact.js:328-339`).

### 1.3 The grid

- **Staging** (`PracticeSchedulingPage.jsx:1029-1092`). An override replaces
  the team's CURRENT series only. A CLOSED series (its range ends before the
  team's latest series starts) stays in the payload by its key (#541,
  `:1048-1064`). Two or more current series collapse into one staged row: which
  weekday is meant is not guessed (`:1065-1077`).
- **Apply** (`:846-995`) sends the whole staged list through
  `persistPracticeScheduleReview`, or `persistPracticeRepair` when the run
  carries daylight exceptions (`:915-918`). It never sends `unlock`.
- **The lock toggle** (`handleToggleLock`, `:997-1013`) rewrites `source`
  between `auto` and `manual` in the staged list. The writer upserts by
  `(team, slot, range)` and sets `source = EXCLUDED.source` (`20261002000000:1041-1053`),
  so a toggle re-keys nothing and is never refused. Under v3 `source` decides
  only one thing: an absent team's `auto` rows are prune candidates and its
  `manual` rows are retained (`:767`). Both are locked either way. The
  auto-scheduler locks every season row whatever its source (`:669-673`). The
  list still titles the button "Unlock slot (allow algorithm to change)"
  (`PracticeAssignmentList.jsx:54-58`). That title is false under ruling 2.
- **Permissions.** `canManageSchedule` (MANAGE_SCHEDULE or MANAGE_ORGANIZATION)
  may stage (`:446-449`). `canApplySchedule` (MANAGE_ORGANIZATION) may Apply
  (`:456`). The Edge re-checks org admin (`index.ts:436-449`), and the RPC
  runs as the caller, so `auth.uid()` is the signed-in admin.
- **Witnesses already on `main`** (_test-verified_):
  `tests/gridCurrentPracticeRows.test.jsx:428-473` pins the prune set of an
  override, including the two-weekday case. `supabase/tests/practice_grid_current_rows.sql:283-358`
  runs the real writer: refused without `unlock`, accepted with the current
  series unlocked, closed series kept by key.

---

## 2. The design

### 2.1 When the prompt opens

At Apply, before any call, the page computes **`unlockRequired`**: every
season row (`seasonRows`, the read the lock set already uses) that the staged
payload would make the writer prune. This is the transcription the #541 test
already pins (`writerPruneSet`), and it has both of the writer's arms
(`20261002000000:717-773`):

- for a season team in the payload, each stored row whose
  `(team, slot, canonical range)` key the payload does not carry;
- for a season team absent from the payload, each of its `auto` rows.

A closed series is re-sent by its key (#541), so it is never in this set. The
second arm is empty whenever the grid's read is complete, since the grid sends
every season row. It is computed anyway, so a missed row is caught here and
not refused late by the writer.

- Empty: Apply behaves exactly as today. No dialog, same call.
- Non-empty: the dialog opens. Nothing is sent until Confirm.

**Only what an override replaced is unlockable.** Each row in
`unlockRequired` must be a current series of a team the admin staged in this
session. The page records staged team ids in `handleStageManualAssignment`. A
row outside that set (a team the admin did not touch, or an absent team's
`auto` row) makes the dialog refuse with a named reason. It never unlocks it.
A closed series cannot reach this check (above). Its protection is the
staging rule, witnessed by W1 and W8c. This is the grid's equivalent of the enact's stray check
(`enact.js:419-428`).

### 2.2 What the dialog says

A new `GridOverrideDialog.jsx` beside `PracticeEnactDialog.jsx`, built on the
same `Modal` and the same tick-and-reason pattern. It does not reuse the enact
dialog itself, whose props are retirement-specific (Q5). Per team:

- **Replacing:** each row in `unlockRequired` for that team, as weekday,
  time, field and inclusive range (the format the refusal message already
  uses, `lockedRowOf`).
- **With:** the staged row, as weekday, time, field and the range it will be
  saved with.
- **Kept:** any closed series of that team, labelled "history, unchanged".
  It is shown so the admin can see it is not being touched.
- One checkbox: "Replace and lock <Team>'s practice as shown".

Then one reason control (Q3), the Confirm button (disabled with a visible
reason until every box is ticked and a reason is chosen), and Cancel.

### 2.3 What is sent

`persistPracticeRepair` with:

- `assignments`: the staged payload, **unchanged** from today;
- `unlock`: one entry per `unlockRequired` row, `{ assignment_id, reason }`,
  and nothing else;
- `exceptions`: the daylight exceptions, as today, when the run has any;
- `closes: []`, `withdrawExceptions: []`;
- `baseFingerprint`: **only if Q4 says yes**, read when the dialog opens.
  Without it, the call carries no fingerprint, as the grid's saves do today.

Not ticked or cancelled: nothing is sent, and the staged review stays as it
was. A non-admin never sees the dialog: Apply is already admin-only.

At Confirm the page recomputes `unlockRequired` from the current state. If it
differs from what the dialog showed, it does not send, and it reopens the
dialog with the new list. This follows the enact's `prompt-changed` rule.

### 2.4 The two-live-weekday case

A team with two current series (say Monday and Wednesday) collapses into one
staged row today, so `unlockRequired` holds **both**. The dialog says so
plainly: "Replacing Monday 17:00-18:00 and Wednesday 17:00-18:00 with Friday
17:00-18:00". The admin either accepts both or cancels. Choosing which weekday
to replace is a staging change, not a prompt change. It is Q2.

### 2.5 The lock toggle

It stays a **label** and is **not** the unlock entry point. Two reasons:

1. It sets `source`, which the writer stores and the auto-scheduler ignores.
   An "unlock" there would promise a later save or run that the writer still
   refuses.
2. The ruling asks for a prompt at the moment of change, naming what changes.
   A toggle sets a flag ahead of time, with no replacement to name.

The implementing PR corrects its titles to "Mark as manual choice" and
"Mark as automatic", and keeps `aria-pressed`. The "allow algorithm to change" text is
removed. Q1 asks whether to remove the toggle instead.

### 2.6 The auto-scheduler review Apply path

It shares `handleApplySchedule`. The scheduler places only teams with no
current row (`:581-610`, refused by name otherwise), so its `unlockRequired`
is empty and it never opens the dialog. The computation runs on both paths
anyway. If a future change made the scheduler replace a locked row, the dialog
would open, or the stray check would refuse. It would not be refused late by
the writer. A unit witness pins that the review path computes an empty set
(§4, W5).

### 2.7 Audit

No new event. The writer already writes one `practice.unlock_accepted` per row,
with the reason and the before-image, in the same transaction
(`:811-833`), and `practice.saved` carries `unlocked_count`. A grid
reason is told apart from an enact reason by its prefix (`grid override ...`
against `enact ...`, Q3). An enact also writes `practice.recommendation_enacted`,
which records the prompt as shown. The grid would have no equivalent. That gap
is declared (§5) and is Q6.

### 2.8 Permissions

- Staging stays `canManageSchedule`. Apply, and so the dialog, stays
  `canApplySchedule` (org admin).
- The writer's own gate (admin **with a uid**) is the real check. The client
  never decides that a uid exists; it only hides a dialog a non-admin could
  not use.
- A 42501 from the gate is shown as its own message ("Only an organization
  admin can replace a saved practice"), not as the locked message.

### 2.9 Accessibility (WCAG 2.2 AA)

- `Modal` gives `role="dialog"`, `aria-modal`, Escape to close and focus
  restore (`Modal.jsx:84-85` for the role, `:35-70` for the focus effect,
  which saves focus at `:39`, moves it at `:43` and restores it at `:68`). Focus goes to the dialog heading on open
  (`initialFocusRef`, as the enact does), and back to Apply on close.
- One labelled checkbox per team inside a `fieldset` and `legend`. The reason
  control is a labelled `select` (Q3). If there is free text, it is a labelled
  `textarea` with a visible character count.
- Confirm's disabled reason is visible text, linked by `aria-describedby`.
  Ticking a box must not move focus (the enact's stable `onClose`,
  `PracticeEnactDialog.jsx:46-54`).
- A refusal after Confirm is shown inside the dialog with `role="alert"`. Focus
  stays in the dialog.
- Design tokens and component classes only: `.modal`, `.field`, `.cbx`,
  `.select`, `.btn`. Checked in both themes.

---

## 3. Size estimate

| Piece                                                            | Est. LOC |
| ---------------------------------------------------------------- | -------- |
| `unlockRequired` and stray check, pure, in `frontend/src/utils/` | 70       |
| `GridOverrideDialog.jsx`                                         | 150      |
| Page wiring: staged-team set, open, confirm, send, recompute     | 80       |
| Lock-toggle titles                                               | 10       |
| Unit and component tests (W1-W7)                                 | 350      |
| pgTAP additions (W8)                                             | 120      |
| E2E scenario                                                     | 60       |

About 240 lines of product code and 530 lines of tests. One PR. No migration,
no Edge change, no mock-writer change (the E2E routes the Edge, as
`tests/e2e/steps/scheduling_and_overrides.ts:50` does today).

---

## 4. Witnesses and plants

Every subject set is enumerated from the **seed** (roster, stored rows), never
from what the page staged or sent.

- **W1 `unlockRequired` equals the writer's prune set.** Use the #541 seeds
  (re-home with closed series, retained manual, two live weekdays). Compare
  with `writerPruneSet` from the stored rows and the payload. The closed series
  is never in it.
- **W2 Dialog content.** It names each team, each replaced series, the new
  slot and the kept history, from the seed.
- **W3 Nothing sent unaccepted.** With a box unticked, or no reason, or
  Cancel, `fetch` is never called.
- **W4 Exactly those rows.** On Confirm, `body.repair.unlock` ids equal W1's set.
  Each reason equals the chosen one. `assignments` is byte-identical to
  today's payload for the same staging.
- **W5 Review path.** An auto-scheduler review computes an empty set and opens
  no dialog.
- **W6 Stray refusal.** A season row of an untouched team in the prune set
  refuses by name and sends nothing.
- **W7 Recompute.** A change between open and Confirm reopens the dialog and
  does not send.
- **W8 pgTAP through the real writer.** Extend `practice_grid_current_rows.sql`,
  driving the payload the grid builds (JS twin W4):
  - (a) accepted with `unlock` naming the replaced current series;
  - (b) refused 22023 `is locked` without it;
  - (c) the closed series untouched: same id, range and source;
  - (d) one `practice.unlock_accepted` row per unlocked row, its `reason`
    equal to the sent one;
  - (e) two live weekdays: accepted with both unlocked, refused with only one;
  - (f) a non-admin uid with `unlock` refused 42501.

  Per the operator rule, this is run by CI, not the local DB harness.

**Plants**, each shown to fail its witness before the PR is opened:

- P1 add the closed series to `unlock` (W1, W8c);
- P2 send `unlock` without a tick (W3);
- P3 drop the second weekday from `unlock` (W4, W8e);
- P4 a blank reason (W3, and the writer's 22023 at `:651-655`);
- P5 skip the stray check (W6);
- P6 skip the recompute (W7).

Meta: W1's seeds must each yield a non-empty prune set. A seed that yields
none fails loudly.

---

## 5. Declared, not enforced (after this PR)

- **The window between Confirm and the save.** It is covered only if Q4
  adds `baseFingerprint`. Without it, a concurrent save by another admin is
  caught only when its rows change the prune set the writer computes.
- **The dialog as the only prompt.** The writer checks that `unlock` is
  present, has a reason and comes from an admin. It cannot check that a
  dialog was shown. Any admin client that sends `unlock` passes. The same is
  true for the enact.
- **No record of the prompt as shown.** Unlike `practice.recommendation_enacted`,
  nothing stores what the grid dialog displayed (Q6).
- **The lock toggle.** After §2.5 it is an honest label. It still enforces
  nothing, and its new title no longer claims it does.
- **Choosing a weekday.** Two live weekdays are replaced together (Q2).

---

## 6. Questions for the operator

1. **The lock toggle: relabel or remove?** It sets `source`, which v3 ignores
   for locking.
   _Recommendation (not an answer):_ relabel it as provenance ("manual
   choice" / "automatic") in the implementing PR. Remove it later if nothing
   reads `source` for display.
2. **Two live weekdays: replace both, or let the admin choose one?**
   _Recommendation (not an answer):_ replace both, stated plainly in the
   dialog, for this PR. A per-weekday pick changes staging, and #541
   deliberately left that unguessed. It can follow as its own small PR.
3. **The reason: generated, picked, or free text?**
   _Recommendation (not an answer):_ a short picklist (for example field
   change, coach request, conflict fix, other) rendered into a generated
   reason, `grid override <runId>: <code>`. No free text, matching the enact's
   no-PII reason and CLAUDE.md's data-minimisation rule.
4. **Send `baseFingerprint`?**
   _Recommendation (not an answer):_ yes. Read
   `practice_schedule_fingerprint` when the dialog opens, as the repair panel
   does. A 40001 then reopens the dialog on a fresh read rather than unlocking
   a row the admin did not see.
5. **A new `GridOverrideDialog`, or generalise `PracticeEnactDialog`?**
   _Recommendation (not an answer):_ a new component on the same `Modal` and
   pattern. Generalising the enact dialog while 11d is in flight risks the
   enact's pinned prompt record. Extract a shared piece once both are stable.
6. **Record the prompt as shown, as the enact does?**
   _Recommendation (not an answer):_ not in this PR. `practice.unlock_accepted`
   already holds each row's before-image and reason. A
   `practice.grid_override_accepted` event would need its own strict schema and
   a writer change. Revisit if an audit review asks what the admin was shown.
7. **Should the stray check refuse, or widen the dialog to list the stray row?**
   _Recommendation (not an answer):_ refuse. A row the admin did not stage is
   not an override they chose, and ruling 2 asks for a prompt about the change
   being made.
