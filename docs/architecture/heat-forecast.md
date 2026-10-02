[← Back to Documentation Index](../README.md)

---

# Field Heat-Stress (WBGT) Forecast

> **Decision support only. On-site WBGT measurement always overrides it.**
> The screen says so before it shows a number.

For a game day, admins see the forecast Wet Bulb Globe Temperature (WBGT) at
each venue for each kickoff, with:

- the U.S. Soccer Recognize to Recover alert band (Green / Yellow / Orange / Red / Black);
- the regional air temperatures that would push each field into Red and into Black;
- a sources panel rendered from each row's provenance.

The model is a port of a Python reference (`scripts/heat/reference/cvsc_wbgt.py`,
with its tests). It is held to that reference by `tests/heatParity.test.js`.

## 1. Pieces and where they live

| Piece                 | Path                                                                      | Notes                                                                                                              |
| --------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Model (pure JS)       | `packages/core/src/heat/`                                                 | Barrel `heat/index.js`. No React, no `fetch`, no host time zone.                                                   |
| Generated SPA tables  | `packages/core/src/heat/spaTables.js`                                     | Written from pvlib by the generator. Never hand-edited.                                                            |
| Linke turbidity table | `packages/core/src/heat/data/linkeTurbidity-nws-0p5deg.bin`               | 328,320 B. See §4.                                                                                                 |
| Reference + generator | `scripts/heat/`                                                           | `generate_heat_reference.py` (needs `pip install pvlib h5py`). Not run in CI.                                      |
| Golden data           | `tests/fixtures/heat/heatReference.json`, `gridpoint-mtr-2026-10-03.json` | Generator output.                                                                                                  |
| NWS client            | `frontend/src/lib/nwsClient.js`                                           | Browser → api.weather.gov. See §5.                                                                                 |
| Turbidity loader      | `frontend/src/lib/turbidityTable.js`                                      | Lazy, same-origin, hashed asset; budgeted in `config/bundle-budget.json`.                                          |
| Hooks                 | `frontend/src/hooks/useHeatForecast.js`, `useOrgHeatSettings.js`          |                                                                                                                    |
| Screen                | `frontend/src/pages/HeatForecastPage.jsx`, `components/heat/`             | Route `/schedule/heat`.                                                                                            |
| Settings              | `components/settings/modules/HeatSafetyModule.jsx`                        | Settings → General → Heat Safety.                                                                                  |
| Persistence           | `supabase/migrations/20261006000000_org_heat_settings.sql`                | Table, RPC, audit action. Revert and smoke under `docs/sql/`; pgTAP in `supabase/tests/org_heat_settings_rpc.sql`. |
| Mock                  | `frontend/src/lib/mockHeatSettings.js`                                    | Mirrors the RPC's refusals.                                                                                        |
| CSP                   | `vercel.json`, [`csp.md`](../security/csp.md)                             | `connect-src https://api.weather.gov`.                                                                             |

**Access.** The page requires `MANAGE_ORGANIZATION` (admins), checked at the route, and the
`heat_forecast` org feature, which defaults to off. The nav item is hidden when either is
missing.

The settings are read by every member. They can be written only through the RPC, which
checks `is_org_admin`.

## 2. Rows

`buildHeatPlan` enumerates rows from the estate and the game run, never from the forecast.
A venue the forecast cannot serve is therefore still a row: it is refused, with a reason.

**Inputs**

- Live `locations` (with coordinates) and live, active `fields` (with `surface_type`).
  "Live" is judged by `isLiveOn` against the chosen date.
- The current game run's `game_assignments`. This is the same source the exports read
  (`useGameSummary` → `useGameAssignments`).
- `season_settings.timezone`. There is no org time zone; the season's clock is the clock.
  A season without one is refused rather than guessed.

**Which rows**

- **With games on the date:** one row per venue × surface × game window. Games that share all
  four values collapse into one row that lists their fields.
- **With no games that day:** one row per venue × surface × hour, 08:00–17:00 (the
  reference's default hours).

**Game windows (approved rule).**

- A game is judged on every local hour it overlaps.
- Each hour is evaluated the reference's way, at :00.
- The row shows the values of the hottest hour (ties go to the earliest), including that
  hour's triggers.
- If any overlapped hour cannot be computed, the row is refused. A maximum over hours it
  could not see would not be a maximum.
- A game with no end time is judged on its kickoff hour only, and the row carries a note.
- A game that runs past midnight is judged on its hours that fall on the chosen date, and
  the row carries a note.

**Surfaces.** `fields.surface_type` is free text and is matched case-insensitively:

| Stored value    | Result                                    |
| --------------- | ----------------------------------------- |
| `grass`, `turf` | Computed                                  |
| `indoor`        | Refused: the outdoor model does not apply |
| Empty           | Refused                                   |
| Anything else   | Refused                                   |

**Refusal codes** (`HEAT_REASON`). Every refused row carries one of these:

| Group           | Codes                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| Venue and field | coordinates missing; outside the turbidity table; field unknown or retired; surface missing, indoor or unknown |
| Clock           | season time zone unavailable                                                                                   |
| Forecast        | NWS unavailable; forecast gap; response invalid; unexpected unit; unsupported duration; empty layer            |
| Model           | dewpoint above air; did not converge; non-physical                                                             |
| Game time       | unreadable times; past midnight; no end time                                                                   |

## 3. The port: what is the reference's and what is not

**Verbatim from the reference:**

- every Liljegren constant and iteration;
- the 10 m → 2 m stability-class wind reduction;
- the low-sun zenith clamps and the 0.85 × top-of-atmosphere GHI cap;
- the turf model (no-evaporation energy balance, albedo 0.10, air +1.5 °F, dewpoint −1.8 °F,
  storage by local hour);
- grass (ground temperature = air, albedo 0.23);
- the Kasten-Czeplak cloud reduction;
- the trigger bisection (search 40–125 °F, 50 steps);
- the station pressure formula;
- the unit table.

**Solar position.** NREL SPA (Reda & Andreas 2004), ported from pvlib's `spa.py`. The periodic
terms are generated from pvlib, never typed by hand. It uses pvlib's defaults as the reference
reaches them:

- pressure from `alt2pres(gridpoint elevation)`;
- 12 °C for refraction;
- **ΔT = 67 s.** `spa_python` defaults `delta_t=67.0`, so the reference does not use pvlib's
  ΔT polynomial. An early port used the polynomial and drifted by 1e-4°; matching the default
  closed it.

Parity is 2e-12° of zenith over 160 random samples (night and low sun included). This module is
deliberately separate from `timing/solar.js` (NOAA sunset, operator ruling 2026-09-24).

**Clear sky.** Ineichen-Perez as pvlib's `Location.get_clearsky(model='ineichen')` runs it:

- Kasten-Young airmass on the apparent zenith;
- absolute airmass from altitude pressure;
- Spencer extraterrestrial irradiance, with the day of year in UTC.

Parity is within 1e-6 W/m² across zenith 0–91°, three elevations, three days and three
turbidities.

**Approved deviations from the reference.** None of these moves a stated golden value.

1. **The band is assigned after rounding to 0.1 °F.** The reference banded the unrounded value,
   so 76.149 printed as "76.1 Yellow". Rounding is Python's `round` (exact binary value, ties to
   even).
2. **Linke turbidity comes from a 0.5° table** (§4).
3. **Elevation must be `wmoUnit:m`.** The reference ignored the unit. A missing elevation is
   refused; the reference read it as 0 m.
4. **Game windows use the hottest overlapped hour** (§2). The reference only knew whole hours.
5. **A missing hour is a refused row, not a whole-venue exception.** `computeHeatRows` refuses
   per row. The reference's throw is covered by its ported test.
6. **HTTP 429 is retried once, after 6 s** (§5). The reference failed on every 4xx.

**Smaller choices, stated:**

- An NWS WBGT layer whose values are all null reads as absent. The reference would have
  refused the whole venue over a display-only column.
- An hour that starts off a whole UTC hour (half-hour time zones) takes the NWS hour that
  contains it. No US zone does this.

**Thresholds** (`heat/bands.js`). These are from the U.S. Soccer Heat Guidelines poster,
verified 2026-10-02:

| Category | Green | Yellow | Orange | Red   | Black |
| -------- | ----- | ------ | ------ | ----- | ----- |
| 1        | ≤76.1 | ≤81.0  | ≤84.1  | ≤86.2 | >86.2 |
| 2        | ≤79.8 | ≤84.6  | ≤87.7  | ≤89.8 | >89.8 |
| 3        | ≤82.1 | ≤87.0  | ≤90.0  | ≤92.0 | >92.0 |

- The poster's own ranges have 0.1 °F gaps (for example, Cat 1 Green <76.1 and Yellow
  76.3–81.0). Closing each band at its upper bound closes those gaps.
- For Cat 2, the poster's table says Black >89.8 and its text says >89.9. The code uses 89.8 and
  says so in the row's provenance.
- The Red trigger solves for Orange's upper bound + 0.1. The Black trigger solves for the
  Red/Black boundary.

## 4. The one substitution: Linke turbidity

pvlib's Ineichen model looks up a monthly Linke turbidity (TL) climatology: 15.6 MB, 1/12°,
global. That cannot ship to a browser.

The generator block-averages it to 0.5° over the NWS forecast box (15–72 N, 180–60 W):
12 × 114 × 240 uint8 (20 × TL, pvlib's encoding) = 328,320 bytes. pvlib's day-of-year
interpolation between month middles is kept exactly.

A venue outside the box is refused, never given a neighbour's value. Guam and American Samoa
are outside it.

**Measured effect** (pvlib 0.16.1):

|                              | TL difference (0.5° vs native) |
| ---------------------------- | ------------------------------ |
| CONUS median                 | 0.025                          |
| CONUS p95                    | 0.18                           |
| CONUS p99                    | 0.38                           |
| CONUS worst cell (mountains) | 1.7                            |

How WBGT responds to TL, at the reference site:

| TL           | Canyon 08:00 | 11:00 | 14:00 | 13:00 Black trigger |
| ------------ | ------------ | ----- | ----- | ------------------- |
| 3.0          | 62.1         | 77.4  | 80.9  | 94.4                |
| 3.26 (pvlib) | 61.7         | 77.3  | 80.9  | 94.6                |
| 3.5          | 61.3         | 77.2  | 80.8  | 94.7                |

- That is roughly 0.8 °F per unit of TL at low sun, and 0.1–0.2 °F at midday.
- So the p95 table error costs ≤0.15 °F at low sun. At the worst mountain cells it is up to
  about 1.4 °F at low sun.
- On the fixture day (Oct 3) the 0.5° cell and pvlib's native cell agree exactly after uint8
  rounding (3.2615). The parity goldens therefore cannot see this substitution. The ten US
  sample points in `heatSolar.test.js` do: every one is within 0.5 TL of pvlib.
- A 1° table (38 KB gzipped) was rejected: p95 0.28, worst 2.0.
- **Open:** pvlib is BSD-3, but the redistribution terms of the underlying SoDa data are
  unverified (see ROADMAP open items).

## 5. NWS API (checked live 2026-10-02)

**CORS**

- `GET /points/{lat},{lon}` and `GET /gridpoints/{wfo}/{x},{y}` answer
  `access-control-allow-origin: *`.
- With only `Accept: application/geo+json` the request is CORS-simple, so there is no
  preflight.
- The preflight would allow only `API-Key, User-Agent`. The client must never send
  `Feature-Flags`.
- Verified in Chromium 141 with the page served under the production CSP. The old policy
  refused the fetch; the new one allows it. Problem bodies are readable.

**Client identification**

- The NWS docs say: "A User Agent is required … This string can be anything", and that this
  "will be replaced with an API key in the future".
- An empty User-Agent got 403; a browser User-Agent got 200.
- Browsers send their own User-Agent and a script cannot replace it, so the app cannot identify
  itself beyond that.

**Fields read**

- `/points`: `properties.forecastGridData`, `gridId`, `gridX`, `gridY`.
- `/gridpoints`:
  - `properties.updateTime`, `gridId`, `gridX`, `gridY`, `@id`;
  - `elevation {unitCode: 'wmoUnit:m', value}`;
  - the `temperature` (degC), `dewpoint` (degC), `windSpeed` (km_h-1) and `skyCover` (percent)
    layers, each `{uom, values: [{validTime: '<ISO start>/<ISO duration>', value}]}`.
  - In October `wetBulbGlobeTemperature` comes back as `{uom: null, values: []}`.
- Errors are `application/problem+json` (`title`, `detail`, `status`).
- Caching headers: gridpoint `max-age=3600`, points `max-age=86400`.

**Client behaviour** (`nwsClient.js`)

- The points → grid mapping is cached per coordinate pair for 24 h (memory + sessionStorage).
  NWS asks clients to re-check it periodically.
- 5xx and network failures: 3 attempts, 2 s then 4 s apart.
- 429: one retry after 6 s.
- Any other 4xx fails at once with the problem `detail`.
- A `forecastGridData` that is not an `api.weather.gov/gridpoints/...` URL is refused.
- One gridpoint request is made per distinct grid cell.
- Gridpoints are fetched with `cache: 'no-store'`, so the recorded retrieval time is real.
- A fetched gridpoint is reused within the page for 10 min (`GRIDPOINT_REUSE_MS`), so stepping
  through dates does not refetch it. A reused response keeps its original retrieval time, so the
  stale check stays truthful. **Refresh** forces a refetch, and a failed fetch is never reused.

**Stale.** A forecast is flagged stale if its `updateTime` is more than **12 h** older than
retrieval (`STALE_AFTER_HOURS`). NWS publishes no fixed gridpoint refresh cycle: NDFD mosaics
office grids hourly, and offices re-issue several times a day. Twelve hours is a judgement, not
an NWS number.

## 6. Provenance

Every computed row carries `provenance`:

- **`forecast`:** source id, cross-check source id, points and gridpoint URLs, `gridId`/`gridX`/
  `gridY`, `updateTime`, `retrievedAt`, elevation.
- **`model`:** `HEAT_MODEL` (id `squadlogic-heat-wbgt`, version, and identifiers for the WBGT,
  solar position, clear sky, turbidity table, cloud and surface models), plus the ids of every
  literature source.
- **`thresholds`:** category, `configured` or `default`, source id, the band bounds, and the
  Cat 2 note.

The sources panel calls `sourcesForProvenance(rows)`. It lists exactly the catalogue entries
(`HEAT_SOURCES`) the rows name, and throws on an id the catalogue lacks. Every URL and DOI in the
catalogue was checked on 2026-10-02:

- each URL returned 200;
- the Taylor & Francis and MDPI DOIs redirect to publishers that answer 403 to non-browser
  clients, and their Crossref metadata matched the citation.

The organisation's governing-body links (`organization_heat_settings.guidance_links`) are listed
under their own heading. They are configured by an admin, never hard-coded.

## 7. Settings

`organization_heat_settings` holds one row per organisation. It is written only by
`admin_set_org_heat_settings`, which audits `settings.heat_updated`.

- No row means Category 1, and the screen says "default; not configured".
- A failed read is an error, never a silent Category 1.

Client validation (`OrgHeatSettingsSchema`), the mock arm and the SQL share one URL rule: https,
a dotted host, no whitespace. `tests/heatSettings.test.js` reads the migration's regex and shows
it decides the same cases.

## 8. Verification

| What                      | How                                                                                                                                                                                                    | Status                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Model vs Python reference | `heatParity.test.js`: the stated goldens end to end (±0.6 °F, triggers included); all 96 site-hours with category 1-3 triggers at 1e-6 °F on the shipped table; ≤0.6 °F against pvlib native turbidity | Executed: worst differences 2e-13 °F (WBGT) and 4e-11 °F (triggers) |
| Reference's own tests     | `heatModel.test.js` (ported) plus the edge cases                                                                                                                                                       | Executed                                                            |
| SPA, clear sky, turbidity | `heatSolar.test.js`                                                                                                                                                                                    | Executed                                                            |
| Composer                  | `heatForecast.test.js`                                                                                                                                                                                 | Executed                                                            |
| NWS client                | `nwsClient.test.js`                                                                                                                                                                                    | Executed                                                            |
| Migration                 | `scripts/dbharness/run.sh` on Postgres 16 (all migrations, smoke claims, revert counting what it destroys) and 8 `prove.sh` plants                                                                     | Executed: harness OK, 8/8 plants caught                             |
| pgTAP                     | `supabase/tests/org_heat_settings_rpc.sql`                                                                                                                                                             | Written; not run here (needs the Supabase test stack)               |
| E2E                       | `tests/e2e/features/heat_forecast.feature`: stubbed NWS (the reference fixture), fixed clock                                                                                                           | Executed: 4/4                                                       |
| Live NWS                  | Chromium probe under the production CSP; client + core against the live MTR gridpoint                                                                                                                  | Executed 2026-10-02                                                 |

**Goldens.** Regenerated by the generator from pvlib 0.16.1:

| Site           | Hour  | Value                     |
| -------------- | ----- | ------------------------- |
| Canyon (turf)  | 11:00 | WBGT 77.3                 |
| Canyon (turf)  | 14:00 | WBGT 80.9                 |
| Canyon (turf)  | 13:00 | Black trigger 94.6 °F air |
| Vannoy (grass) | 08:00 | WBGT 62.0                 |
| Vannoy (grass) | 14:00 | WBGT 80.0                 |

The brief quoted 94.5 for the Black trigger; the reference prints 94.6, inside ±0.6.

## 9. Limits

- NWS does not forecast solar radiation. GHI is clear-sky reduced for sky cover; smoke and haze
  are not modeled.
- Below about 2 mph the model is very wind-sensitive. Sheltered fields can run several °F above
  these numbers (Pryor et al. 2017).
- Wind is NWS's 10 m sustained wind.
- The Liljegren port follows the published reference algorithm. It is not a line-by-line diff
  of the original C source (the reference's own caveat).

**Out of scope** (ROADMAP open items):

- recording on-site WBGT readings;
- heat-triggered notifications;
- automatic Red/Black game modifications.

**Regenerating.** `pip install pvlib h5py`, then `python3 scripts/heat/generate_heat_reference.py`.
Bump `HEAT_MODEL.version` whenever a computed value changes.
