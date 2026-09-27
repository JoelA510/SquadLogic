# 8.9 — Season phases, sunset, and the DST cliff: approved plan

Status: **APPROVED by the operator 2026-09-27.** This is the plan every 8.9 PR
is briefed against; a PR that departs from it says so in its body. Drafted by a
plan agent from `0abb4cb`. Tags: file:line = verified by reading on that commit
(re-verify before relying on it); *[exec]* = executed read-only; *[unverified]*.
Spec: `docs/PHASE_8_PLAN.md` §8.9 (line 428).

## Operator rulings

- **2026-09-24 — "use the best available data/formula."** Sunset is *computed*
  with the NOAA solar-position algorithm (the NOAA spreadsheet/solcalc
  equations, zenith 90.833°). Nothing is fetched at runtime. Real schedules use
  per-venue coordinates stored in the **database**; they never enter the repo
  and nothing geocodes.
- **2026-09-24 — corpus correction.** `fixtures/season-2026/sunsets.csv` rows
  11/07/2026 and 11/14/2026 become **4:49 PM** and **4:41 PM** (were 4:44 and
  4:35). Evidence *[exec]*, supervisor and plan agent independently: a
  single-location NOAA fit to the 11 pre-DST rows has max error ~1.05 min; the
  two post-DST rows sat 5.1–5.2 and 6.3–6.4 min early; the best 13-row fit is
  3.1–3.2 min; the DST-adjusted weekly drop through the DST week was 15 min
  against 9–12 either side. The corrected values are later, so no legality can
  regress (every legality predicate is monotone in the limit).
- **2026-09-27 — practices at unlit fields never run past sunset, and the
  margin is sunset itself.** An unlit practice must **end at or before sunset**;
  the civil twilight between sunset and dusk is the teardown window for
  equipment. So the practice margin is **0 minutes before sunset**. Games keep
  their existing margin (15, per the fixture README and `sunsetMarginRule`).
  This answers open decision D1 (the rule is hard, not a warning) and replaces
  D6 (no per-season margin column: one named core constant,
  `PRACTICE_SUNSET_MARGIN_MINUTES = 0`, with its Deno twin pinned equal by the
  drift test).

## 0. Findings that shape 8.9

**F1. Under the ruling, the practice corpus goes dark wholesale in autumn — and
that is 8.9's job, not a data error.** Every venue in `facility_geometry.json`
is `lit: False` except Summit HS *[exec]*; practice-only venues are `lit: null`
(`facility/adapters/season2026PracticeGeometry.js:131-151`), treated
conservatively as unlit. Every `practice_grid.csv` venue's latest practice ends
19:00 *[exec]*; Alder Park permits keep 18:00–20:00 weekday windows into
Nov/Dec *[exec]*. With end ≤ sunset, a 19:00 end stops being legal once sunset
falls before 19:00 (late September); after DST ends (11/01) every grid slot
fails. The fixture sweep must assert an **independently derived, non-empty**
violation set — never zero, never a baseline copied from output. Phases,
compression and the DST survival report (§3) are how the season adapts; the
auto-scheduler post-pass turns what cannot be saved into TIME TBD.

**F2. No live path checks sunset today.** `gameScheduling.js`,
`practiceScheduling.js`, `autoScheduler.js`, `practiceMetrics.js`,
`_shared/engines/*.ts` and `game-persistence/index.ts` have zero
"sunset"/"daylight" hits *[exec]*. Sunset is enforced only in core evaluation:
the date-keyed calendar (`availability/calendar.js:186-206, 337-354`),
`sunsetConstraint` (`availability/kickoff.js:418-476`) and `sunsetMarginRule`
(`ruleEngine/rules.js:802-822`), all fed by `sunsets.csv`.

## 1. The sunset computation

- **Core:** new `packages/core/src/timing/solar.js` beside `seasonClock.js`.
  Pure `sunsetOnDate({ date, latitude, longitude, timeZone })` →
  `{ minutes (fractional, season wall clock), code }`. UTC offset from the IANA
  zone at that date via the existing season-clock helpers *[unverified: exact
  helper]* — never a hardcoded US rule, never a host-zone read. Evaluate at the
  approximate sunset instant and iterate 2–3 times, as solcalc does. No sunset
  (acos argument outside [-1, 1]) → `null`, code `SUNSET_UNDEFINED_AT_LATITUDE`;
  never clamp. Enforcement uses `floor` (the earlier minute — conservative).
  Register in `timing/index.js`.
- **Daylight provider** in `availability/`: `buildAvailabilityCalendar` gains an
  optional per-venue daylight source. Precedence: a date-keyed table record
  (authoritative for the corpus) → computed per-venue coordinates → unknown.
  Both present and > 2 min apart → finding `SUNSET_SOURCES_DISAGREE`. Missing
  data reuses `SUNSET_UNKNOWN` (`kickoff.js:437-446`) with
  `details.cause = 'venue-coordinates-missing'` — no third code. Update
  `SunsetRecord`'s "stores, not computes" comment (`availability/types.js:47-52`)
  and GAP-06 (`docs/MODEL_GAPS.md:79, 166`).
- **Deno twin** `supabase/functions/_shared/timing/solar.ts`, line for line (the
  Edge cannot import core: `auto-scheduler/index.ts:9-15`). Two drift controls:
  (a) `tests/solarDrift.test.js` imports both arms in Vitest (precedent
  `scoringEngineDrift.test.js:52-53`) over latitudes -60…60, several longitudes,
  every day of 2026, zones America/New_York, America/Los_Angeles, Europe/London,
  Australia/Sydney, plus polar nulls — exact equality; (b) shared vectors
  `_shared/timing/solar.vectors.json` read by Vitest and a new
  `_shared/tests/solar_test.ts`, which `scripts/deno-mirror-tests.sh` runs under
  UTC and America/Los_Angeles (`deno-mirror-tests.sh:19-24, 49`).
- **Golden test** `tests/solar.test.js`: coordinates are **fitted at test time
  from the 11 pre-DST corpus rows only** (no coordinates committed — the fitted
  point lands on a real, specific-looking place, is degenerate along a ridge,
  and its longitude depends on the assumed zone). All 11 rows must match within
  ~1.1 min; the two corrected rows are out-of-sample and must match within
  1 min; negative control: the old 4:44/4:35 must be > 1 min away (they are
  ~5.2/6.4). Fallback only if test-time fitting is impractical: a 1-decimal pair
  labelled "FITTED to sunsets.csv, not a location".
- **Season timezone**: `season_settings.timezone`
  (`20251214000002*:6`; writer/validation `20260913000000_season_timezone_writer.sql:59-64, 98-103`);
  the Edge reads it via `readSeasonTimezone` (`_shared/timing/seasonSettings.ts:79-90`,
  used at `auto-scheduler/index.ts:429-450`). Venues use the season zone;
  per-venue zones are out of scope. A venue across a zone line is still right,
  because sunset is converted onto the season's wall clock, the clock practices
  use.

## 2. Coordinates

No coordinates exist today: `locations` is `id, name, address,
lighting_available, created_at, updated_at` (`20251208000000_consolidated_schema.sql:111-119`)
plus `organization_id` (`20251216000000_facility_multi_tenancy.sql:11-12`); no
lat/long/PostGIS anywhere in `supabase/migrations` *[exec]*. The venue join
exists: `practice_slots.field_id` → `fields.location_id`.

**Migration `<ts>_location_coordinates.sql`** (timestamp later than every
migration on `main` at merge time): nullable `latitude`/`longitude
numeric(7,4)`, CHECK both-or-neither, CHECK ranges, `coordinates_set_at`,
`coordinates_set_by`. **Admin RPC** `admin_set_location_coordinates(p_location_id,
p_latitude, p_longitude)` following `admin_create_location`
(`20260504060000:39, 353-363`): SECURITY DEFINER, pinned `search_path`, org-admin
check on the location's org, both-or-neither (NULL/NULL clears), out of range →
22023, rounds to **2 decimals** (~1.1 km; sunset error < 0.05 min — data
minimisation), audit row `location.coordinates_set` with before/after, REVOKE
PUBLIC, GRANT authenticated. RLS: members already have SELECT on locations
("Locations: members select", `20260504060000:19-22`); coordinates are less
sensitive than `address`, which members already read — no new policy (confirm
advisor output). `docs/sql` revert + smoke (non-admin refused, other org
refused, half pair refused, out of range refused, audit present, clear works);
`prove.sh` plants anchored in the live body (strip admin check, drop range
check, drop audit, drop both-or-neither CHECK), each turning a smoke red;
census entries. Frontend: a Zod-validated lat/long form on facility admin;
nothing geocodes, nothing is fetched.

**A venue with no coordinates** on unlit or undeclared ground: every practice
occurrence there gets `SUNSET_UNKNOWN` (cause `venue-coordinates-missing`),
counted in `daylightUnknownOccurrences`, never ALLOWED. Lit venues need none.
The Edge reports each affected slot and **flags rather than refuses** (D4): at
rollout no venue has coordinates, so refusing would block live scheduling on
day one; revisit once the admin UI ships.

**Venues > 50 miles apart** fall out of per-venue computation; the operator's
clustering idea is unnecessary. For scale, 50 miles of longitude at 40°N is
~0.94° ≈ 3.8 min of sunset.

## 3. What 8.9 constrains

- **G1 Daylight.** An unlit practice occurrence **ends at or before sunset**
  (margin 0, ruling 2026-09-27), checked per date. Games keep their margin.
- **G2 DST as a named season event**, derived from the zone's offset change.
  The `Note` column (parsed, `fixtures/season2026Parsers.js:432`, read by
  nothing) becomes a cross-check that the derived 2026-11-01 matches (D12).
- **G3 DurationPhase schedule**: an ordered `(effective_from, duration)` list
  with the derivation shown and overrides allowed. Output is the
  `seasonPhases`/`seasonOverrides` that `expandPracticeSlotsForSeason` already
  takes (`practiceSlotExpansion.js:13-45`) — no second mechanism.
- **G4 Compression report**: hold-starts (flag every slot still ending past
  sunset) and cascade (a proposal routed through the 8.8 changelog, never
  applied).
- **G5 DST survival report**: per unlit slot, does it survive at any phase
  duration; if not, what fixes it (a lit field, an earlier start, another
  night).

| Consumer | After 8.9 |
|---|---|
| Core games (`kickoff.js`, `sunsetMarginRule`) | Enforced as today; table source; provider added |
| Live game path | **Declared, not enforced** (F2); stated in the registry (D7) |
| New core `practice/daylight.js` evaluator over materialised occurrences | Enforced in core evaluation; registry claim, exercise counters, attribution kind `sunset` with the numbers (for 8.10) |
| Core `practiceScheduling.js` / `autoScheduler.js` | Unchanged; stated unenforced (the live scheduler is the Deno twin) |
| Deno auto-scheduler | Enforced by a post-pass; optimising toward surviving slots is declared, not optimised (D11) |
| `practice/repair.js` | Candidate gate; enforced in the module, not live until 3b wires it |

**Auto-scheduler post-pass (PR 6).** Slots carry `fieldId` and
`effectiveFrom`/`effectiveUntil` (`PracticeSchedulingPage.jsx:156-184`); the
Edge reads coordinates and `lighting_available` from the DB by `fieldId` (never
from the request body). For each **new placement** it computes the first date
that breaks the limit, truncates the range there (D8), and makes the remainder
TIME TBD with reason and date, audited. **Reconciliation with 3b ruling 2
(lock everything assigned):** the post-pass applies only to placements the run
itself produces; an existing locked row that violates daylight is *reported*
and its fix is proposed (changelog / override prompt), never applied silently.

Nothing is silently dropped: every output check derives its universe from the
input roster and the slot × date expansion, never from the output (the #444
`teams_without_practice` precedent).

## 4. Witnesses (each shown red by its plant before it counts)

| # | Witness | Plant |
|---|---|---|
| W1 | Corrected rows within 1 min; old values > 1 min away | Revert the CSV rows; separately, zenith 90.833 → 90 |
| W2 | Core and Edge solar agree exactly on the grid | Change one Edge coefficient |
| W3 | Deno mirror in both zones | Edge uses `getTimezoneOffset()` — exactly one zone goes red |
| W4 | Fixture sweep: evaluator's flagged set = an independent derivation (grid × dates × sunset × lighting), non-empty | **Disable the evaluator** (early `return []` / unregister) |
| W5 | `unlitPracticeOccurrencesExamined > 0` and `practicesExamined` = count from roster/grid | Mark every venue lit (examined → 0); enumerate from output (red on a dropped team) |
| W6 | Venue without coordinates flagged, counted, not ALLOWED; lit venues exempt | Provider defaults to a far-future sunset |
| W7 | Edge: every input team assigned or TIME TBD with reason; truncated ranges sum to the full span | Drop one TBD entry; drop the truncated tail |
| W8 | Two synthetic venues 1.5° longitude apart: a slot legal at one, illegal at the other | Collapse the provider to the first venue |
| W9 | Edge ignores body coordinates | Read coordinates from the body |
| W10 | `repair.js` refuses a past-sunset re-home; "none dropped" stays green | Remove the gate |
| W11 | DST event derived from the zone = the `Note` 11/01 | Hardcode offset -5 (11 pre-DST rows go 60 min off) |
| W12 | Phase transition = first date the last unlit end exceeds the limit | `>` where `≥` is meant |
| W13 | Cascade proposals only produce 8.8 changelog entries | Auto-apply |
| W14 | DB smoke and census for the coordinates plants | The plants in §2 |
| W15 | Practice margin is 0: an occurrence ending exactly at `floor(sunset)` is legal, one minute later is not; the constant equals its Deno twin | Margin 15; twin 15 while core 0 |

## 5. The fixture change

Edit `fixtures/season-2026/sunsets.csv` (11/07 → 4:49 PM, 11/14 → 4:41 PM; keep
the Note column and schema) and add "Sunset corrections — operator ruling
2026-09-24" to `fixtures/season-2026/README.md` (method, evidence, no
coordinates committed, corpus names no timezone — a US DST rule is implied;
tests use America/New_York, `tests/gameSchedulingSeasonClock.test.js:26`).

Expected moves (`tests/feasibilityApi.test.js`), each exactly ±6 on 11/14:
`:514` `16*60+35` → `16*60+41`; `:517-518` `14*60+50` → `14*60+56`; `:524`
`205` → `199`; `:525` `220` → `214`; `:571` `15*60+5` → `15*60+11`; prose at
`:554-555, :658`. **Needs execution:** `tests/reserveCapacity.test.js:1007-1025`
(`bareMinimumDates`, `slotsLostVsBest = 3` — moves only if a slot end falls in
(989, 994] on 11/07 or (980, 986] on 11/14) and any of the 29 corpus-loading
suites whose search enumerates kickoffs on those dates.

**Proof each diff is exactly the correction:** run the full suite before and
after; for every changed assertion add a restore control — a test-only calendar
override putting back 989/980 on those two dates only must reproduce main's
value exactly. A diff the restore control does not reverse is a defect.

Does not move (4:44 PM there is an arbitrary DST-edge clock time, not a
sunset): `seasonClockVectors.test.js:172-222`,
`gameSchedulingSeasonClock.test.js:21-120`,
`schedulerDisabledSeasonClockTwin.test.js:53, 66`,
`publicationParity.test.js:1822-1824`. Checksums are compared within a run, not
pinned. Annotate, do not rewrite, PHASE_8_PLAN's "75-minute drop … 4:44 PM"
(now 70) and GAP-06.

## 6. PR split (plan-first PRs are solver/domain/persistence)

| PR | Contents | Kind | Size |
|---|---|---|---|
| 1 | Core `solar.js`, golden test, fixture correction, README ruling, updated expectations with restore controls | domain | ~600 |
| 2 | Edge `solar.ts`, vectors JSON, Deno test, Vitest drift test | parity | ~400 |
| 3 | Coordinates migration, RPC, audit, revert/smoke, plants, census, Zod | persistence | ~650 |
| 3b | Facility admin coordinates form | UI | ~250 |
| 4 | Daylight provider, DST season event, `practice/daylight.js`, registry claim, fixture sweep (W4/W5), margin constant (W15) | domain | ~800 |
| 5 | DurationPhase derivation, compression strategies, survival report, changelog routing | domain | ~800 |
| 6 | Auto-scheduler: DB read, truncation + TIME TBD for new placements, audit | solver | ~600 |
| 7 | `repair.js` daylight gate | solver | ~300 |
| 8 | Progress documentation | docs | small |

**Cross-plan sequencing with 3b** (`docs/PHASE_8_6_PR3B_PLAN.md`): land 3b PR 7
(auto-scheduler lock) before 8.9 PR 6, and 3b PR 5 before 8.9 PR 7.

## 7. Decisions (all resolved 2026-09-27)

| # | Decision | Resolved as |
|---|---|---|
| D1 | Autumn darkness in the corpus | Hard rule for unlit fields (operator); the corpus violation set is real and handled by phases/compression/TIME TBD |
| D2 | Rounding | `floor` of sunset for enforcement |
| D3 | Fixture coordinates | None committed; fitted at test time from the 11 pre-DST rows |
| D4 | Missing coordinates on unlit ground at the Edge | Flag, count, banner; never pass; do not refuse yet |
| D5 | Undeclared lighting | Conservative, as today (`kickoff.js:329-339`) |
| D6 | Practice margin | **0 before sunset** (operator); a core constant with a pinned Deno twin, no DB column |
| D7 | Live game path sunset | Out of 8.9; stated unenforced |
| D8 | Partly-legal weekly slots | Truncate at the first illegal date; remainder TIME TBD |
| D9 | Coordinate precision | 2 decimals |
| D10 | Source precedence | Table wins where present; `SUNSET_SOURCES_DISAGREE` above 2 min |
| D11 | Optimising toward surviving slots | Deferred; declared, not optimised |
| D12 | The `Note` column | Read as the DST cross-check (W11) |

Every PR: `/code-review` before opening; the season-2026 fixture suite when it
touches domain types, constraints or solver stages; each new guarantee shown red
by its plant.
