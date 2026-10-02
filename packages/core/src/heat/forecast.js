/**
 * The heat-forecast composer: which rows the screen shows for a game day, and
 * the computed (or refused) value of each.
 *
 * ## Rows
 *
 * {@link buildHeatPlan} turns the active estate and the current game run into
 * rows. With games on the date: one row per venue x surface x game window
 * (games sharing all four collapse into one row that lists their fields). With
 * no games that day: one row per venue x surface x hour, 08:00-17:00 (the
 * reference's default hours). Rows are enumerated from the estate, never from
 * the forecast, so a venue the forecast cannot serve is still a row -- refused,
 * with a reason.
 *
 * ## Game windows (approved rule)
 *
 * A game is judged on every local hour it overlaps, and the row takes the
 * values of the hour with the highest WBGT (ties: the earliest). Each hour is
 * evaluated the reference's way, at :00. If any overlapped hour cannot be
 * computed, the row is refused: a maximum over hours it could not see is not a
 * maximum.
 *
 * ## Refusals
 *
 * Nothing is dropped and nothing is substituted. A row the model cannot compute
 * carries `status: 'refused'` and a {@link HEAT_REASON} code; a row that was
 * computed on less than the full window (no end time, past midnight) carries a
 * note with the same kind of code.
 *
 * The season's clock is `season_settings.timezone`, read through
 * `resolveZonedInstant`; the host's zone is never read.
 *
 * @module heat/forecast
 */

import { resolveZonedInstant, seasonCalendarDate } from '../timing/seasonClock.js';

import { heatBand, roundHalfEven, triggerTargets } from './bands.js';
import { clearSkyGhi, cloudReducedGhi } from './clearSky.js';
import { parseIsoInstant } from './gridpoint.js';
import { buildHeatProvenance } from './provenance.js';
import { HEAT_REASON, HeatError } from './reasonCodes.js';
import { normalizeSurface } from './schemas.js';
import { altitudeToPressurePa, solarPosition } from './solarPosition.js';
import { lookupLinkeTurbidity, turbidityCovers } from './turbidity.js';
import { airTrigger, fieldWbgt, stationPressureHpa } from './wbgt.js';

const HOUR_MS = 3600000;

/** Local hours shown when no game is scheduled that day (the reference's default). */
export const NO_GAME_HOURS = Object.freeze([8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);

/**
 * A forecast older than this at retrieval is flagged stale. NWS publishes no
 * fixed gridpoint refresh cycle: NDFD mosaics office grids hourly and offices
 * re-issue several times a day. Twelve hours is a judgement, not an NWS number.
 */
export const STALE_AFTER_HOURS = 12;

/**
 * @param {number} updateTimeMs
 * @param {number} retrievedAtMs
 * @param {number} [maxAgeHours]
 * @returns {{ stale: boolean, ageHours: number }}
 */
export function forecastAge(updateTimeMs, retrievedAtMs, maxAgeHours = STALE_AFTER_HOURS) {
  const ageHours = (retrievedAtMs - updateTimeMs) / HOUR_MS;
  return { stale: ageHours > maxAgeHours, ageHours };
}

const pad2 = (n) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` one day after `date`. */
function nextDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return `${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}-${pad2(next.getUTCDate())}`;
}

/**
 * The instant each local hour of `date` starts, on the season's clock.
 *
 * @param {string} date
 * @param {string} timeZone
 * @returns {{ hours: Array<number|null>, dayStartMs: number, dayEndMs: number }}
 */
export function localDayHours(date, timeZone) {
  const at = (d, time) => {
    const { iso, findings } = resolveZonedInstant({
      date: d,
      time,
      timeZone,
      label: 'heat forecast hour',
    });
    return { ms: iso === null ? null : parseIsoInstant(iso), findings };
  };
  const midnight = at(date, '00:00');
  if (midnight.ms === null) {
    const f = midnight.findings[0];
    throw new HeatError(HEAT_REASON.TIMEZONE_UNAVAILABLE, f ? f.message : `no clock for ${date}`, {
      timingCode: f ? f.code : null,
    });
  }
  const hours = [];
  for (let h = 0; h < 24; h += 1) hours.push(h === 0 ? midnight.ms : at(date, `${pad2(h)}:00`).ms);
  const end = at(nextDate(date), '00:00');
  if (end.ms === null) {
    throw new HeatError(HEAT_REASON.TIMEZONE_UNAVAILABLE, `no clock for the day after ${date}`);
  }
  return { hours, dayStartMs: midnight.ms, dayEndMs: end.ms };
}

/**
 * Local `HH:MM` of an instant within the day table, or `null` outside it.
 *
 * @param {number} ms
 * @param {{ hours: Array<number|null> }} day
 */
function localLabel(ms, day) {
  for (let h = 23; h >= 0; h -= 1) {
    const start = day.hours[h];
    if (start !== null && ms >= start && ms < start + HOUR_MS) {
      return `${pad2(h)}:${pad2(Math.floor((ms - start) / 60000))}`;
    }
  }
  return null;
}

/**
 * @typedef {Object} HeatVenue
 * @property {string} id
 * @property {string} name
 * @property {number|null} latitude
 * @property {number|null} longitude
 */

/**
 * @typedef {Object} HeatField
 * @property {string} id
 * @property {string} name
 * @property {string} locationId
 * @property {string|null} surfaceType - free text, as stored
 */

/**
 * @typedef {Object} HeatGame
 * @property {string} id
 * @property {string} fieldId
 * @property {string|null} start - ISO instant with offset
 * @property {string|null} end - ISO instant with offset, or null
 */

/**
 * @typedef {Object} HeatPlanItem
 * @property {string} key
 * @property {string} venueId
 * @property {string} venueName
 * @property {string|null} surfaceRaw
 * @property {'grass'|'turf'|null} surface
 * @property {string[]} fieldNames
 * @property {string[]} gameIds
 * @property {{ kind: 'game', startMs: number, endMs: number|null, startLabel: string|null,
 *   endLabel: string|null } | { kind: 'hour', localHour: number }} window
 * @property {{ code: string, message: string }|null} refusal - known before any forecast
 * @property {Array<{ code: string, message: string }>} notes
 */

/**
 * @param {ReturnType<typeof normalizeSurface>} n
 * @param {string|null} raw
 * @returns {{ code: string, message: string }|null}
 */
function surfaceRefusal(n, raw) {
  if (!('reason' in n)) return null;
  if (n.reason === 'indoor') {
    return {
      code: HEAT_REASON.SURFACE_INDOOR,
      message: 'Indoor field: the outdoor WBGT model does not apply.',
    };
  }
  if (n.reason === 'missing') {
    return {
      code: HEAT_REASON.SURFACE_MISSING,
      message: 'Field has no surface type; set Grass or Turf.',
    };
  }
  return {
    code: HEAT_REASON.SURFACE_UNKNOWN,
    message: `Surface "${raw}" is neither grass nor turf; the model has no treatment for it.`,
  };
}

/**
 * Which rows the screen shows for `date`.
 *
 * @param {{ date: string, timeZone: string|null|undefined, venues: HeatVenue[], fields: HeatField[],
 *   games: HeatGame[] }} input
 * @returns {{ mode: 'games'|'hours', items: HeatPlanItem[], day: ReturnType<typeof localDayHours> }}
 */
export function buildHeatPlan({ date, timeZone, venues, fields, games }) {
  if (typeof timeZone !== 'string' || !timeZone.trim()) {
    throw new HeatError(
      HEAT_REASON.TIMEZONE_UNAVAILABLE,
      'The season has no timezone; set it in Settings before reading a heat forecast.'
    );
  }
  const day = localDayHours(date, timeZone);
  const venueById = new Map(venues.map((v) => [v.id, v]));
  const fieldById = new Map(fields.map((f) => [f.id, f]));

  /** @type {Map<string, HeatPlanItem>} */
  const grouped = new Map();
  /** @type {HeatPlanItem[]} */
  const loose = [];

  for (const game of games) {
    let startMs = null;
    let endMs = null;
    let timeError = null;
    try {
      startMs = parseIsoInstant(game.start ?? '');
      endMs = game.end ? parseIsoInstant(game.end) : null;
      if (endMs !== null && endMs <= startMs) timeError = 'ends at or before it starts';
    } catch {
      timeError = `has an unreadable time (${String(game.start)} - ${String(game.end)})`;
    }
    // An unreadable kickoff cannot be placed on any day; it is listed under the
    // requested date rather than lost, with the reason.
    if (startMs !== null && seasonCalendarDate(startMs, timeZone) !== date) continue;
    const field = fieldById.get(game.fieldId);
    const venue = field ? venueById.get(field.locationId) : undefined;
    if (!field || !venue) {
      loose.push({
        key: `game:${game.id}`,
        venueId: venue?.id ?? '',
        venueName: venue?.name ?? '(unknown venue)',
        surfaceRaw: field?.surfaceType ?? null,
        surface: null,
        fieldNames: field ? [field.name] : [],
        gameIds: [game.id],
        window: { kind: 'game', startMs: startMs ?? 0, endMs, startLabel: null, endLabel: null },
        refusal: {
          code: HEAT_REASON.FIELD_UNKNOWN,
          message: field
            ? "The game's field belongs to a venue that is not in the active estate."
            : 'The game names a field that is not in the active estate (retired or deleted).',
        },
        notes: [],
      });
      continue;
    }
    const n = normalizeSurface(field.surfaceType);
    if (timeError) {
      loose.push({
        key: `game:${game.id}`,
        venueId: venue.id,
        venueName: venue.name,
        surfaceRaw: field.surfaceType,
        surface: n.surface,
        fieldNames: [field.name],
        gameIds: [game.id],
        window: {
          kind: 'game',
          startMs: startMs ?? 0,
          endMs: null,
          startLabel: null,
          endLabel: null,
        },
        refusal: { code: HEAT_REASON.GAME_TIME_UNREADABLE, message: `The game ${timeError}.` },
        notes: [],
      });
      continue;
    }
    const surfaceKey =
      n.surface ??
      `raw:${String(field.surfaceType ?? '')
        .trim()
        .toLowerCase()}`;
    const key = `game:${venue.id}|${surfaceKey}|${startMs}|${endMs ?? ''}`;
    const existing = grouped.get(key);
    if (existing) {
      if (!existing.fieldNames.includes(field.name)) existing.fieldNames.push(field.name);
      existing.gameIds.push(game.id);
      continue;
    }
    /** @type {Array<{ code: string, message: string }>} */
    const notes = [];
    if (endMs === null) {
      notes.push({
        code: HEAT_REASON.GAME_END_UNKNOWN,
        message: 'No end time recorded; only the kickoff hour is judged.',
      });
    } else if (endMs > day.dayEndMs) {
      notes.push({
        code: HEAT_REASON.GAME_EXTENDS_PAST_DAY,
        message: 'The game runs past midnight; only hours on this date are judged.',
      });
    }
    grouped.set(key, {
      key,
      venueId: venue.id,
      venueName: venue.name,
      surfaceRaw: field.surfaceType,
      surface: n.surface,
      fieldNames: [field.name],
      gameIds: [game.id],
      window: {
        kind: 'game',
        startMs: /** @type {number} */ (startMs),
        endMs,
        startLabel: localLabel(/** @type {number} */ (startMs), day),
        endLabel: endMs === null ? null : localLabel(endMs, day),
      },
      refusal: surfaceRefusal(n, field.surfaceType),
      notes,
    });
  }

  let items = [...grouped.values(), ...loose];
  let mode = /** @type {'games'|'hours'} */ ('games');

  if (items.length === 0) {
    mode = 'hours';
    for (const venue of venues) {
      const own = fields.filter((f) => f.locationId === venue.id);
      if (own.length === 0) {
        items.push({
          key: `venue:${venue.id}`,
          venueId: venue.id,
          venueName: venue.name,
          surfaceRaw: null,
          surface: null,
          fieldNames: [],
          gameIds: [],
          window: { kind: 'hour', localHour: NO_GAME_HOURS[0] },
          refusal: { code: HEAT_REASON.SURFACE_MISSING, message: 'Venue has no active fields.' },
          notes: [],
        });
        continue;
      }
      /** @type {Map<string, { raw: string|null, n: ReturnType<typeof normalizeSurface>, names: string[] }>} */
      const bySurface = new Map();
      for (const f of own) {
        const n = normalizeSurface(f.surfaceType);
        const k =
          n.surface ??
          `raw:${String(f.surfaceType ?? '')
            .trim()
            .toLowerCase()}`;
        const entry = bySurface.get(k) ?? { raw: f.surfaceType, n, names: [] };
        entry.names.push(f.name);
        bySurface.set(k, entry);
      }
      for (const [k, entry] of bySurface) {
        for (const h of NO_GAME_HOURS) {
          items.push({
            key: `hour:${venue.id}|${k}|${h}`,
            venueId: venue.id,
            venueName: venue.name,
            surfaceRaw: entry.raw,
            surface: entry.n.surface,
            fieldNames: entry.names,
            gameIds: [],
            window: { kind: 'hour', localHour: h },
            refusal: surfaceRefusal(entry.n, entry.raw),
            notes: [],
          });
        }
      }
    }
  }

  const windowStart = (it) =>
    it.window.kind === 'game' ? it.window.startMs : (day.hours[it.window.localHour] ?? 0);
  items = items.sort(
    (a, b) =>
      a.venueName.localeCompare(b.venueName) ||
      windowStart(a) - windowStart(b) ||
      String(a.surface ?? a.surfaceRaw).localeCompare(String(b.surface ?? b.surfaceRaw))
  );
  return { mode, items, day };
}

/**
 * @typedef {Object} VenueForecast
 * @property {import('./gridpoint.js').ParsedGridpoint} [gridpoint]
 * @property {import('./provenance.js').ForecastSource} [source]
 * @property {{ code?: string, message: string }} [error]
 */

/**
 * @typedef {Object} HeatRow
 * @property {string} key
 * @property {string} venueId
 * @property {string} venueName
 * @property {'grass'|'turf'|null} surface
 * @property {string|null} surfaceRaw
 * @property {string[]} fieldNames
 * @property {string[]} gameIds
 * @property {HeatPlanItem['window']} window
 * @property {'computed'|'refused'} status
 * @property {{ code: string, message: string }|null} reason
 * @property {Array<{ code: string, message: string }>} notes
 * @property {number|null} usedHour - local hour whose values the row shows
 * @property {Array<{ localHour: number, wbgtF: number }>} hourly
 * @property {{ airF: number, dewpointF: number, windMph: number, skyCoverPct: number }|null} inputs
 * @property {number|null} wbgtF
 * @property {'Green'|'Yellow'|'Orange'|'Red'|'Black'|null} band
 * @property {number|null} redTriggerF - null when even 125 F air does not reach Red, or refused
 * @property {number|null} blackTriggerF
 * @property {boolean} redUnreachable
 * @property {boolean} blackUnreachable
 * @property {number|null} nwsWbgtF - NWS's own WBGT for the used hour, when supplied
 * @property {import('./provenance.js').HeatProvenance|null} provenance
 */

/**
 * Compute every row of a plan.
 *
 * @param {{ plan: ReturnType<typeof buildHeatPlan>, venues: HeatVenue[], category: 1|2|3,
 *   categorySource: 'configured'|'default', forecasts: Record<string, VenueForecast>,
 *   turbidity: import('./turbidity.js').TurbidityTable }} input
 * @returns {HeatRow[]}
 */
export function computeHeatRows({ plan, venues, category, categorySource, forecasts, turbidity }) {
  const venueById = new Map(venues.map((v) => [v.id, v]));
  const targets = triggerTargets(category);
  /** @type {Map<string, { wbgtF: number, inputs: NonNullable<HeatRow['inputs']>, ghi: number,
   *   zen: number, pHpa: number, nwsWbgtF: number|null }>} */
  const hourCache = new Map();
  /** @type {Map<string, { red: number|null, black: number|null }>} */
  const triggerCache = new Map();

  const refused = (item, reason, extra = {}) => ({
    key: item.key,
    venueId: item.venueId,
    venueName: item.venueName,
    surface: item.surface,
    surfaceRaw: item.surfaceRaw,
    fieldNames: item.fieldNames,
    gameIds: item.gameIds,
    window: item.window,
    status: /** @type {const} */ ('refused'),
    reason,
    notes: item.notes,
    usedHour: null,
    hourly: [],
    inputs: null,
    wbgtF: null,
    band: null,
    redTriggerF: null,
    blackTriggerF: null,
    redUnreachable: false,
    blackUnreachable: false,
    nwsWbgtF: null,
    provenance: null,
    ...extra,
  });

  return plan.items.map((item) => {
    if (item.refusal) return refused(item, item.refusal);
    const venue = venueById.get(item.venueId);
    const lat = venue?.latitude;
    const lon = venue?.longitude;
    if (
      typeof lat !== 'number' ||
      typeof lon !== 'number' ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon)
    ) {
      return refused(item, {
        code: HEAT_REASON.COORDINATES_MISSING,
        message: 'Venue has no coordinates; enter latitude and longitude on the Fields page.',
      });
    }
    if (!turbidityCovers(lat, lon)) {
      return refused(item, {
        code: HEAT_REASON.TURBIDITY_OUT_OF_COVERAGE,
        message: 'Venue is outside the shipped Linke turbidity table (15-72 N, 180-60 W).',
      });
    }
    const fc = forecasts[item.venueId];
    if (!fc || fc.error || !fc.gridpoint || !fc.source) {
      return refused(item, {
        code: HEAT_REASON.FORECAST_UNAVAILABLE,
        message: fc?.error?.message ?? 'No NWS forecast was retrieved for this venue.',
      });
    }
    const gp = fc.gridpoint;
    const provenance = buildHeatProvenance({
      gridpoint: gp,
      source: fc.source,
      category,
      categorySource,
    });
    const surface = /** @type {'grass'|'turf'} */ (item.surface);

    // The hours this row judges.
    /** @type {number[]} */
    let hoursToJudge = [];
    if (item.window.kind === 'hour') {
      hoursToJudge = [item.window.localHour];
    } else {
      const { startMs, endMs } = item.window;
      for (let h = 0; h < 24; h += 1) {
        const hs = plan.day.hours[h];
        if (hs === null) continue;
        const overlaps =
          endMs === null
            ? startMs >= hs && startMs < hs + HOUR_MS
            : hs < endMs && hs + HOUR_MS > startMs;
        if (overlaps) hoursToJudge.push(h);
      }
    }
    if (hoursToJudge.length === 0) {
      return refused(
        item,
        {
          code: HEAT_REASON.GAME_TIME_UNREADABLE,
          message: "The game overlaps no hour on this date's clock.",
        },
        { provenance }
      );
    }

    const evaluate = (h) => {
      const cacheKey = `${item.venueId}|${surface}|${h}`;
      const hit = hourCache.get(cacheKey);
      if (hit) return hit;
      const hourStart = /** @type {number} */ (plan.day.hours[h]);
      // NWS series are keyed on whole UTC hours.
      const key = Math.floor(hourStart / HOUR_MS) * HOUR_MS;
      const L = gp.layers;
      const missing = ['temperature', 'dewpoint', 'windSpeed', 'skyCover'].filter(
        (n) => !L[n].has(key)
      );
      if (missing.length) {
        const keys = [...L.temperature.keys()];
        throw new HeatError(
          HEAT_REASON.FORECAST_GAP,
          `Forecast does not cover ${pad2(h)}:00 (${new Date(key).toISOString()}; missing ${missing.join(', ')}). ` +
            `Gridpoint data runs ${new Date(keys[0]).toISOString()} to ${new Date(keys[keys.length - 1]).toISOString()}.`
        );
      }
      const elev = gp.meta.elevationM;
      const sp = solarPosition({
        epochMs: hourStart,
        latitude: lat,
        longitude: lon,
        elevationM: elev,
        pressurePa: altitudeToPressurePa(elev),
      });
      const tl = /** @type {number} */ (lookupLinkeTurbidity(turbidity, lat, lon, hourStart));
      const clear = clearSkyGhi({
        epochMs: hourStart,
        apparentZenithDeg: sp.apparentZenith,
        altitudeM: elev,
        linkeTurbidity: tl,
      });
      const inputs = {
        airF: /** @type {number} */ (L.temperature.get(key)),
        dewpointF: /** @type {number} */ (L.dewpoint.get(key)),
        windMph: /** @type {number} */ (L.windSpeed.get(key)),
        skyCoverPct: /** @type {number} */ (L.skyCover.get(key)),
      };
      const ghi = cloudReducedGhi(clear, inputs.skyCoverPct);
      const zen = (sp.apparentZenith * Math.PI) / 180;
      const pHpa = stationPressureHpa(elev);
      const wbgtF = fieldWbgt(
        surface,
        inputs.airF,
        inputs.dewpointF,
        inputs.windMph,
        ghi,
        zen,
        h,
        pHpa
      );
      const nws = L.nwsWbgt?.get(key);
      const result = { wbgtF, inputs, ghi, zen, pHpa, nwsWbgtF: nws === undefined ? null : nws };
      hourCache.set(cacheKey, result);
      return result;
    };

    /** @type {Array<{ localHour: number, wbgtF: number }>} */
    const hourly = [];
    let best = null;
    let bestHour = -1;
    try {
      for (const h of hoursToJudge) {
        const r = evaluate(h);
        hourly.push({ localHour: h, wbgtF: r.wbgtF });
        if (best === null || r.wbgtF > best.wbgtF) {
          best = r;
          bestHour = h;
        }
      }
    } catch (err) {
      if (err instanceof HeatError) {
        return refused(item, { code: err.code, message: err.message }, { provenance, hourly });
      }
      throw err;
    }
    const b = /** @type {NonNullable<typeof best>} */ (best);

    const tKey = `${item.venueId}|${surface}|${bestHour}|${category}`;
    let triggers = triggerCache.get(tKey);
    if (!triggers) {
      const { dewpointF, windMph } = b.inputs;
      triggers = {
        red: airTrigger(surface, targets.red, dewpointF, windMph, b.ghi, b.zen, bestHour, b.pHpa),
        black: airTrigger(
          surface,
          targets.black,
          dewpointF,
          windMph,
          b.ghi,
          b.zen,
          bestHour,
          b.pHpa
        ),
      };
      triggerCache.set(tKey, triggers);
    }

    return {
      key: item.key,
      venueId: item.venueId,
      venueName: item.venueName,
      surface: item.surface,
      surfaceRaw: item.surfaceRaw,
      fieldNames: item.fieldNames,
      gameIds: item.gameIds,
      window: item.window,
      status: /** @type {const} */ ('computed'),
      reason: null,
      notes: item.notes,
      usedHour: bestHour,
      hourly,
      inputs: b.inputs,
      wbgtF: b.wbgtF,
      band: heatBand(b.wbgtF, category),
      redTriggerF: triggers.red,
      blackTriggerF: triggers.black,
      redUnreachable: triggers.red === null,
      blackUnreachable: triggers.black === null,
      nwsWbgtF: b.nwsWbgtF,
      provenance,
    };
  });
}

/**
 * The values a row displays, rounded as the reference prints them: inputs to
 * whole units, WBGT and triggers to 0.1 F, Python's half-even rule.
 *
 * @param {HeatRow} row
 */
export function heatRowDisplay(row) {
  if (row.status !== 'computed' || !row.inputs || row.wbgtF === null) return null;
  return {
    airF: roundHalfEven(row.inputs.airF),
    dewpointF: roundHalfEven(row.inputs.dewpointF),
    windMph: roundHalfEven(row.inputs.windMph),
    skyCoverPct: roundHalfEven(row.inputs.skyCoverPct),
    wbgtF: roundHalfEven(row.wbgtF, 1),
    redTriggerF: row.redTriggerF === null ? null : roundHalfEven(row.redTriggerF, 1),
    blackTriggerF: row.blackTriggerF === null ? null : roundHalfEven(row.blackTriggerF, 1),
    nwsWbgtF: row.nwsWbgtF === null ? null : roundHalfEven(row.nwsWbgtF, 1),
  };
}
