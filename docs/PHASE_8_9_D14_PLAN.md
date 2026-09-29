# 8.9 D14: compression strategy, 10-minute step, portable-lighting override (PLAN, APPROVED 2026-09-29)

Operator ruling, 2026-09-29: "Allow the moves to be either shortening of practices OR moving
practices earlier, with the default behavior being a shortening of 10 minutes to each practice
slot. Allow override as sometime coaches can work out portable lighting, too."

Nothing is built. The line references were read on `e6e1d35`.

## Reading of the ruling

- **Two strategies per unlit slot.**
  - SHORTEN: the start stays and the duration drops.
  - SHIFT_EARLIER: the duration stays and the start moves earlier. `seasonOverrides[phase].startTime` is already read by `practiceSlotExpansion.js:224-229`.
- **The 10 minutes is a ladder step.** A slot's duration on a date is `D0 - 10k`. D0 is the slot's own length; k is the smallest number of steps that makes the practice end by sunset. k never decreases, and it stops at a minimum length.
  - Today's code floors the remaining room to the step (`durationPhases.js:170-173`), and the default step is 1 (`schemas.js:360`). That is why the corpus went 60 -> 31 min.
  - Example: a 75-minute slot that needs 1 minute becomes 65 under the ladder. Today's rule with a 10-minute step gives 70.
- **Per slot, not per venue.** Today every slot at a venue shares one cap (`durationPhases.js:384, 420-451`), so a 17:00 slot is cut because the 18:00 slot needed it.
- **Portable-lighting override.** An approved date window on one slot exempts those dates from the daylight limit and from compression. Nothing else changes.

## Override design

- **Who:** coaches request and admins approve (3b ruling 3). Admins may also set one directly. The request/approve flow copies `coach_practice_preferences` (`20260927000000`).
- **Storage:** a new table, `practice_lighting_overrides`.
  - Columns: `practice_slot_id`, a `window` daterange, `kind = 'portable-lighting'`, and `status` (requested / approved / rejected / withdrawn), plus who decided and when.
  - An EXCLUDE constraint stops two approved windows overlapping on one slot.
  - Every change is audited, access is under RLS, and the migration ships with revert and smoke scripts, harness plants and census entries.
- **Why not simpler options:**
  - A request-body field would break W9.
  - `practice_slots` has no lighting column or date range.
  - A per-surface lighting flag would light every slot on the field, on every date.
- **The Edge post-pass (#480)** reads approved rows from the database as the caller through RLS. A failed read refuses the run. A partial read only removes exemptions, so it fails safe.
- **The repair gate (#479)** treats a shape as exempt only when every slot with that shape is overridden for the window.
- **Counting:** an exempt date is not judged, so it needs no coordinates. It has its own counter, never merged into the lit counter.

## Witnesses (each shown red by its plant before it counts)

| # | Witness |
|---|---|
| W16 | The default is the 10-minute ladder (60 -> 50 when 1 minute is needed) |
| W17 | The ladder starts from the slot's own length (75 -> 65) |
| W18 | Phases only ever get shorter, by 10k, and never go below the minimum |
| W19 | A slot below the minimum is held out as TIME TBD with its date |
| W20 | SHIFT_EARLIER never starts before the earliest-start floor |
| W21 | SHIFT_EARLIER keeps the slot's duration |
| W22 | A shifted slot never overlaps an earlier slot on the same surface and night |
| W23 | An override exempts only its own window |
| W24 | Only approved overrides exempt |
| W25 | Lighting claimed in the request body is ignored |
| W26 | A failed override read refuses the run |
| W27 | Drift pins between the core and Edge copies |
| W28 | The exempt count matches an independent derivation and is non-zero |
| W29 | Repair honours an override only when every slot with the shape has one |
| W30 | Database smoke tests: a non-coach request, self-approval, overlapping approved windows and a missing audit row are each refused |

## PR split

| PR | Contents | Kind | Size |
|---|---|---|---|
| A | Core ladder, strategies, floors, overrides as input to durationPhases, daylight and repair, and the G4/G5 report changes | domain | ~750 |
| B | The `practice_lighting_overrides` migration, RPCs, audit, RLS, revert and smoke, plants, census and Zod schema | persistence | ~700 |
| C | The Edge override read, the exemption, and drift pins (needs B) | solver | ~400 |
| D | The coach request form and the admin approval queue | UI | ~350 |

## Supervisor-recommended defaults (unless you rule otherwise)

1. One phase can take more than one 10-minute step. Sunset moves about 60 minutes in the DST week, so single steps could not keep up.
2. Cuts are per slot.
3. Shift-earlier also moves in 10-minute steps. Admins choose each slot's strategy, with shorten as the default. If shortening would go below the minimum, shift-earlier is tried automatically when the floor allows; otherwise the slot is TIME TBD.
4. An override covers the whole slot (every team sharing it). It has no lights-off time, which is stated as declared but not enforced.
5. Coaches request and admins approve; admins may also set an override directly.
6. The Edge **proposes** shortening or shifting and does not apply it. D8's truncate-to-TIME-TBD stays for now; applying needs a stored "retimed" representation, which would be a later PR E.
7. Repair keeps refusing partly-legal candidates.
8. G3 stays core-only until the UI PR.

## Operator answers (2026-09-29)

- **Minimum practice length: 40 minutes.** Shortening stops at 40. Below it the slot shifts earlier if the floor allows; otherwise it is TIME TBD with its date.
- **Earliest-start floor: `season_settings.school_day_end`** (default 16:00, Mon-Thu). SHIFT_EARLIER is refused, never assumed, when the floor is unknown.
- **All supervisor-recommended defaults above: approved.**

## Open questions for the operator (answered above)

- The minimum practice length. Nothing in the repo sets it.
- The earliest-start floor for shift-earlier. Candidates: `season_settings.school_day_end` (default 16:00, Mon-Thu), permit opening times, or the earliest start already planned on the field.
