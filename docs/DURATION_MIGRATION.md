# Duration migration path — from one number to occupancy, play, block and warm-up

> **Status**: analysis only. **No migration is performed by the change that ships this
> document, and no SQL migration file is created.** This is the "show me the migration
> path before you write it" step of Prompt 1.2 of the scheduling build plan. It is the
> record of every place a duration currently lives, what that duration silently means
> today, what it would become under the occupancy/play/block model, and what would break
> on the way. Nothing below has been executed against a database.
>
> Companion reading: [`MODEL_GAPS.md`](MODEL_GAPS.md) GAP-09 (occupancy vs play time),
> GAP-10 (halftime as a range), GAP-11 (block and turnover), GAP-13 (format as a
> first-class attribute), GAP-14 (formats with no timing definition), GAP-27 (warm-up as
> schedulable occupancy), GAP-30 (wall-clock times and DST), GAP-31 (per-field cadence);
> and incidents 7 and 8 in [`fixtures/season-2026/README.md`](../fixtures/season-2026/README.md).

---

## 1. The one sentence that makes this necessary

Today a scheduled game is an interval: a start and an end, or a start and a single
`duration`. That one number is asked to mean four different things at once, and the four
are not equal:

| Quantity | Definition | 11v11 value |
| --- | --- | --- |
| **Ball in play** | `halves x half_duration` | 80 min |
| **Occupancy** | kickoff to final whistle = ball in play **+ halftime** | 85–90 min |
| **Block** | the per-field cadence the season is published on | 120 min |
| **Schedulable footprint** | warm-up start to end of turnover | 30 + 90 + 30 = 150 min |

Incident 7 is what happens when the first two are conflated: 11v11 was modelled as a flat
90 minutes, and had that 90 meant `2x45 + halftime` rather than `2x40 + halftime` several
published margins would have gone tight with nothing firing. Incident 8 is what happens
when the fourth is missing entirely: a team warming up on ground that overlaps a live game
was invisible, and the real answer to "earliest kickoff with a full 30-minute warm-up" on
the busiest date (3:25 PM) was set by a 9v9 game on the *overlapping* field, not by
anything on the field being warmed up on.

`fixtures/season-2026/game_formats.csv` is the source of truth for all four:

```text
Format,Program,Halves,Half min,Halftime min,Occupancy min,Block min,Turnover preferred,Turnover min
Minis,Minis (U5 intro),-,-,-,30,50,20,20
4v4,Micro (U5-U6),2,15,5,35,55,20,10
5v5,Junior (U7-U8),2,20,5,45,65,20,10
7v7,U9-U10,2,25,5,55,75,20,10
9v9,U11-U12,2,30,5,65,85,20,10
11v11,Select (U14-U19),2,40,5-10,85-90 (schedule as 90),120,30 (in block),20
```

Two facts fall straight out of that table and neither is currently representable:

1. **Halftime is a range for 11v11 (5–10), so occupancy is a range (85–90).** The corpus
   instructs scheduling at the worst case ("schedule as 90"), which means margins must be
   computed against 90 while the best case (85) is reported alongside — never instead.
2. **The declared block is `occupancy + turnover`, for every format.**
   `55-35 = 45-25 = 65-45 = 75-55 = 85-65 = 20` and `120-90 = 30`, exactly the
   `Turnover preferred` column each time (the 11v11 cell even says so: `30 (in block)`).
   **Warm-up is in no format's block.** That is the structural reason warm-up occupancy
   was invisible: the number everybody used as "the schedulable footprint" never contained
   it.

`Scrimmage` has **no row at all**. It must stay an explicit unknown, exactly as the fixture
loader and the facility graph already treat it (GAP-14); inventing a duration for it is the
one thing this migration must not do.

---

## 2. Inventory — every place a duration lives today

Grepped for `duration`, `durationMinutes`, `slotMinutes`, `start`/`end` pairs,
`start_time`/`end_time`, `game_slots`, `AssignmentSchema`, and the practice engine.
`slotMinutes` **does not exist anywhere in the repo** — that name appears only in the build
plan; the equivalent concept is `PracticeSlot.durationMinutes` plus the implicit
`end - start` of every slot.

### 2.1 Domain types and schemas (in-memory)

> **Dated correction, 2026-09-19.** The two `schemas/index.js` rows below are
> stale: `z.coerce.date()` was replaced by `InstantSchema` when GAP-30 closed
> (#396, #398, #400), and it now **refuses** a zoneless timestamp instead of
> coercing one in the host zone. What the rows say about the _interval_ — that it
> cannot be open-ended, so a format with unknown timing still cannot validate —
> is unaffected, which is why they are corrected here rather than rewritten. §5.3
> below is likewise half-closed: the schema route is shut, and its warning to a
> backfill script that does not go through these schemas still stands.

| Site | What it holds today | What it silently means |
| --- | --- | --- |
| `packages/core/src/types.js` — `GameSlot {start, end, capacity, fieldId, priority}` | two ISO strings | `end` is "the field is free again", with no statement about whistles, halftime or turnover |
| `packages/core/src/types.js` — `PracticeSlot {start, end, capacity}` | two ISO strings | same |
| `packages/core/src/types.js` — `Event {start_time, end_time}` | two ISO timestamps | same, for the persisted calendar view |
| `packages/core/src/schemas/index.js` — `SlotSchema` | `start`/`end` as `z.coerce.date()`, refined `end > start`, `.passthrough()` | an interval that **cannot be open-ended**; a format with unknown timing cannot validate at all |
| `packages/core/src/schemas/index.js` — `AssignmentSchema` | `start`/`end` as `z.coerce.date()`, refined `end > start`, `.passthrough()` | the solver's output interval; this is the value that reaches persistence and ICS |
| `supabase/functions/_shared/schemas/scoring.ts` — second `SlotSchema` | `start`/`end` as `z.string().or(z.date())`, **no** `end > start` refine | a hand-ported copy that already disagrees with the core one (`docs/ARCHITECTURE.md` §1.1) |
| `supabase/functions/auto-scheduler/index.ts` — third `SlotSchema` | same again, plus `baseSlotId` | third copy |

### 2.2 Engines

| Site | Use of the interval |
| --- | --- |
| `packages/core/src/gameScheduling.js:250-257` | builds `slotRecords` with `start: new Date(slot.start)`, `end: new Date(slot.end)` |
| `packages/core/src/gameScheduling.js:671-683` (`hasCoachConflict`) | overlap predicate `start < a.end && end > a.start` — the only place a duration is *compared* rather than copied |
| `packages/core/src/gameScheduling.js:452-459` | emits assignments with `start`/`end` as `toISOString()` |
| `packages/core/src/autoScheduler.js:174` | the same overlap predicate on `slot.start`/`slot.end` |
| `packages/core/src/autoScheduler.js:219, 309, 481` | re-wraps slot ends into `Date` on every pass |
| `packages/core/src/gameValidation.js` (`checkSlotAvailability`) | compares `String(a.fieldId) === String(fieldId)`; not wired to the UI (`docs/ARCHITECTURE.md` §3.4) |
| `packages/core/src/gameMetrics.js` (`detectConflicts`) | interval overlap, breaking after the first hit |
| `packages/core/src/practiceSlotExpansion.js:186-198` | **the only explicit duration in the codebase**: `slot.durationMinutes` used as a fallback when `end` is absent, `endMinutes = startMinutes + trunc(durationMinutes)` |
| `packages/core/src/practiceSlotExpansion.js:225-239` | per-phase overrides may replace `endTime` **or** `durationMinutes` mid-season |
| `packages/core/src/practiceSupabase.js:134-140` | maps `durationMinutes ?? duration_minutes` off a persisted override row |
| `packages/core/src/practiceScheduling.js`, `practiceMetrics.js` | consume the already-expanded `start`/`end`; no duration of their own |

### 2.3 Fixture layer (already partly correct)

| Site | Today |
| --- | --- |
| `packages/core/src/fixtures/season2026Parsers.js:169-191` (`parseMinutesRange`) | already parses `85-90 (schedule as 90)` into `{min, max, scheduled, note, raw}` — the range survives the parse |
| `packages/core/src/fixtures/season2026Parsers.js:244-270` (`parseGameFormats`) | already carries halves, half minutes, the halftime range, occupancy, block and both turnover values |
| `packages/core/src/fixtures/season2026Parsers.js:298-303` (`scheduledOccupancyMinutes`) | returns the **worst-case occupancy**, or `null` for `Scrimmage` |
| `packages/core/src/fixtures/season2026Parsers.js:711-712` | `durationMinutes = scheduledOccupancyMinutes(...)`; `endMinutes = kickoffMinutes + durationMinutes` |

This is the ambiguity in miniature: the value is correct (worst-case occupancy) and the
field is named `durationMinutes`. A reader has no way to tell from the name whether
halftime is inside it.

### 2.4 Persistence

| Site | Today | Note |
| --- | --- | --- |
| `game_slots` (`supabase/migrations/20260331000000_definitive_schema.sql:548-562`) | **two parallel time representations in one table**: `start`/`"end"` (`timestamptz`) *and* `slot_date` + `start_time`/`end_time` (`date`/`time`), plus `capacity smallint DEFAULT 1` and `week_index` | nothing declares which pair wins |
| `game_slots` (`supabase/migrations/20251208000000_consolidated_schema.sql:167-179`) | the earlier shape: `slot_date`, `start_time`, `end_time` **NOT NULL**, `CHECK (end_time > start_time)`, `UNIQUE (field_id, slot_date, start_time)` | the CHECK is what makes an unknown footprint unstorable |
| `games` (`…definitive_schema.sql:583-600`) | `start_time timestamptz` and **no end column at all** | the game's own duration is only recoverable through `game_slot_id` |
| `practice_slots` (`…:500-510`) | `start_time`/`end_time` as `time`, `CHECK (end_time > start_time)` | |
| `supabase/seed.sql:62`, `…20251208000001_seed_data.sql:63` | `settings` JSONB carries `practice_duration_minutes: 75` | a duration stored as an untyped org setting |
| `supabase/migrations/20260503030000_repair_game_persistence_rpc.sql` | game-persistence RPC payloads round-trip slot start/end | any column change lands here |
| `supabase/migrations/20260503070000_field_import_apply_rollback.sql:252-284` | import path validates `end > start` and rejects rows where either is NULL | second place an unknown footprint is impossible |

### 2.5 Output and integrations

| Site | Today |
| --- | --- |
| `supabase/functions/calendar-feed/index.ts:147-154` | builds `DTEND` from `${date}T${slot.end_time}Z` — the published end families see |
| `supabase/functions/calendar-feed/index.ts:167-168` | `endDt = new Date(slot.end_time || slot.start_time)` — **a missing end silently becomes a zero-length calendar event** |
| `packages/core/src/outputGeneration.js`, `frontend/src/components/OutputGenerationPanel.jsx:94-110` | falls back to `assignment.end`, else `date` + `endTime` |
| `frontend/src/pages/GameSchedulingPage.jsx:90` | `row.end ?? buildDateTime(row.slot_date, row.end_time)` |
| `frontend/src/hooks/useTeamPortal.js:146`, `frontend/src/pages/PracticeSchedulingPage.jsx:93-108` | read `end_time` straight through to display |
| `frontend/src/lib/mockSupabaseClient.js:250, 268` | seeds `end_time: '19:30'` |

---

## 3. What each site becomes

The target model gives every format four derived values instead of one:

```text
ballInPlay  = halves x halfMinutes                       (a scalar; null when a format has no halves)
occupancy   = ballInPlay + halftime                      (a RANGE when halftime is a range)
block       = declared per-field cadence                 (= occupancy + turnover, in this corpus)
schedulable = [kickoff - warmup, occupancyEndWorst + turnover]
```

and one explicit non-value: **unknown footprint**, for a format with no timing row.

| Site | Becomes |
| --- | --- |
| `GameSlot.end` / `Assignment.end` | **stays exactly what it is: the worst-case occupancy end.** Redefining `end` to include turnover or warm-up would move every already-published end time and change `DTEND` for every family — incident 1's failure mode with a different trigger. The new quantities are added *beside* it, never on top of it. |
| `GameSlot` / `Assignment` | gain `format` (GAP-13), and derived-not-stored `occupancyBestCaseEnd`, `blockEnd`, `warmupStart`. Only `format` needs to be persisted; the rest are functions of `format + kickoff + policy`. |
| `SlotSchema` / `AssignmentSchema` `end > start` refine | must become NULL-tolerant (`end === null || end > start`) if unknown-footprint rows are ever to validate. Until then, unknown-footprint rows stay outside the schema, as the fixture loader already keeps them. |
| The three Zod copies | must move **together**, or an Edge Function will accept a slot the core rejects. This is the strongest argument for generating the Deno copies rather than editing them. |
| `hasCoachConflict` / `autoScheduler:174` / `gameMetrics.detectConflicts` | keep using occupancy for *people* (a coach is free at the final whistle) but must use the **schedulable** window for *ground*. These are two different overlap questions that today share one predicate. |
| `practiceSlotExpansion.durationMinutes` | is genuinely a duration and stays one — practices have no halves, no halftime and no warm-up requirement. It should be renamed to `occupancyMinutes` for consistency, or left alone; it is the one place the single number is honest. |
| `season2026Parsers.durationMinutes` | is renamed to make its meaning legible (`scheduledOccupancyMinutes`), keeping `durationMinutes` as an alias for one release so no fixture test breaks in the same change that renames it. |
| `game_slots` | gains `format_id` (FK to a new `game_formats` reference table) and, if unknown footprints are to be storable, `end_time` becomes nullable with the CHECK rewritten as `end_time IS NULL OR end_time > start_time`. `capacity` becomes derivable from the facility graph and should be deprecated, not extended (`docs/ARCHITECTURE.md` §1.4 already records it contradicting the field model). |
| a new `game_formats` table | one row per format: `halves`, `half_minutes`, `halftime_min_minutes`, `halftime_max_minutes`, `occupancy_min_minutes`, `occupancy_max_minutes`, `occupancy_scheduled_minutes`, `block_minutes`, `turnover_preferred_minutes`, `turnover_min_minutes`, `turnover_in_block boolean`. Every column nullable **except** the format key, so `Scrimmage` can exist as a row that declares nothing. |
| warm-up | **derived, not stored.** A warm-up window is a pure function of kickoff and the warm-up policy; persisting it creates a second copy that drifts the first time a kickoff moves. The exception — a warm-up that must happen somewhere other than the match pitch — is a real booking and belongs in whatever table holds non-game reservations (GAP-17), never in `game_slots`, whose `UNIQUE (field_id, slot_date, start_time)` and `capacity` counting both assume a game. |
| `calendar-feed` `DTEND` | stays occupancy-worst-case: families are told when the game ends, not when the turnover does. The `end_time || start_time` fallback must become an explicit skip-with-reason, because a zero-length calendar event is exactly the silent failure this whole model exists to eliminate. |
| org `settings.practice_duration_minutes` | unaffected in meaning, but it is the precedent to *not* follow: a duration in an untyped JSONB blob has no way to say "range", "unknown" or "which of the four". |

---

## 4. Backfill

`format` is the pivot, and it is the hard part.

- **The corpus has it**: both schedule CSVs carry a `Format` column.
- **The database does not.** Backfilling it means inferring format from division, and
  GAP-13 records that this is not generally possible — `Select` covers both `11v11` league
  slots and `Scrimmage` rows, and the two have different footprints (one of which is
  unknown).
- Therefore the backfill is: **map where a division→format mapping is explicitly supplied
  by the operator; leave `NULL` everywhere else; treat `NULL` as unknown footprint rather
  than defaulting to anything.** A default here would re-create incident 7 at the scale of
  the whole database.
- Existing `end_time` values must **not** be recomputed from the new format table. They are
  the published record. The migration's job is to *explain* them, and a reconciliation
  report — "row X has format 9v9, whose scheduled occupancy is 65, but its stored end is 70
  minutes after its start" — is the correct output, not an UPDATE.

---

## 5. What would break

1. **Publication parity.** Any change that recomputes `end` from a format table rewrites
   times families already have. Incident 1 is the whole reason the corpus exists. The
   migration must be additive and must ship with a diff report proving zero published
   times moved.
2. **`CHECK (end_time > start_time)` and the `NOT NULL` on `end_time`** in
   `20251208000000_consolidated_schema.sql:172-177` — unknown-footprint rows cannot be
   inserted today. Relaxing the CHECK relaxes it for every row, so it must be paired with a
   `format_id IS NULL OR …` guard or an explicit `footprint_unknown boolean`.
3. **`z.coerce.date()` plus host timezone (GAP-30).** Any backfill that round-trips a
   wall-clock time through `Date` on a differently-configured machine can move it. All
   arithmetic in the new model is minutes-past-midnight with `YYYY-MM-DD` dates and no
   `Date` construction, matching `packages/core/src/facility/` — the backfill script must
   obey the same rule or it will corrupt data silently rather than failing.
4. **Three Zod slot schemas.** Changing one and not the others produces an Edge Function
   that accepts what the core rejects, or vice versa.
5. **`game_slots.capacity`.** Once blocks and the facility graph both exist, capacity is
   over-determined; leaving it writable guarantees it will eventually disagree with the
   graph.
6. **`calendar-feed`'s `end_time || start_time` fallback.** The moment `end_time` becomes
   nullable, that line starts emitting zero-length events for every unknown-footprint row
   instead of failing.
7. **The overlap predicate is used for two different questions.** Widening the interval it
   receives (to include warm-up and turnover) would make coach-conflict detection reject
   legitimate back-to-back assignments. Ground overlap and person overlap must be given
   different windows, or one of them will be wrong.
8. **`practiceSlotExpansion`'s `durationMinutes`.** It is load-bearing and correct; a
   blanket rename of every `duration` identifier in the repo would break the persisted
   override rows read by `practiceSupabase.js:134`, which accept both `durationMinutes`
   and `duration_minutes`.

---

## 6. Sequencing

1. **In-memory model first, no persistence** — `packages/core/src/timing/`, built on the
   Phase 1.1 facility graph, consuming what `parseGameFormats()` already produces. Warm-up
   becomes a real `FacilityBooking` that flows through the existing overlap machinery.
   *(This is the step that ships with this document. It creates no table and writes
   nothing.)*
2. **Format as a first-class attribute** (GAP-13) on the in-memory fixture and slot types.
3. **`game_formats` reference table + `game_slots.format_id`**, additive, nullable, with
   the reconciliation report from §4 and no UPDATE to any existing `end_time`.
4. **Solver consumes blocks and the schedulable window** (GAP-11, GAP-31), replacing
   hand-supplied slots with block-derived cadence.
5. **Publication-parity guard** wired into CI before any of steps 3–4 is allowed to write.

---

## 7. What ships with this document

The `packages/core/src/timing/` module, and nothing else:

- no SQL migration file,
- no change to `game_slots`, `games`, `practice_slots` or any RPC,
- no change to `gameScheduling.js`, `autoScheduler.js` or `gameMetrics.js`,
- no frontend change,
- no rename of any existing `duration` identifier.

The module is additive and in-memory, exactly as `packages/core/src/facility/` was in
Phase 1.1. Everything in §3 and §4 above remains unimplemented and unverified against a
database.
