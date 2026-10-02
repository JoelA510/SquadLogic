/**
 * NWS gridpoint forecast parsing: the response shape, ISO-8601 `validTime`
 * intervals expanded to hourly UTC, and unit conversion to F / mph / %.
 *
 * Field names are the ones a live `GET /gridpoints/{wfo}/{x},{y}` returns
 * (confirmed against MTR/97,99 on 2026-10-02): `properties.updateTime`,
 * `gridId`, `gridX`, `gridY`, `elevation {unitCode, value}`, and per layer
 * `{uom, values: [{validTime: '<start>/<duration>', value}]}`.
 *
 * Refusals, each loud and coded (never a guess):
 * - a unit outside {@link LAYER_UNITS} (the reference's rule);
 * - an elevation in anything but metres, or missing (stricter than the
 *   reference, which ignored the unit and read a missing elevation as 0 m --
 *   approved deviation);
 * - a malformed or sub-hour duration;
 * - a required layer with no values.
 *
 * Null values are skipped, as the reference skips them; a gap they leave is
 * caught later, when an hour the screen needs is not in the expanded series.
 *
 * @module heat/gridpoint
 */

import { z } from 'zod';

import { HEAT_REASON, HeatError } from './reasonCodes.js';

/** Unit -> converter into F, mph or %. The reference's table, verbatim. */
export const LAYER_UNITS = Object.freeze({
  'wmoUnit:degC': (v) => (v * 9) / 5 + 32,
  'wmoUnit:degF': (v) => v,
  'wmoUnit:km_h-1': (v) => v * 0.621371,
  'wmoUnit:m_s-1': (v) => v * 2.236936,
  'wmoUnit:percent': (v) => v,
});

const HOUR_MS = 3600000;

const LayerSchema = z.object({
  uom: z.string().nullable().optional(),
  values: z.array(
    z.object({
      validTime: z.string(),
      value: z.number().nullable(),
    })
  ),
});

export const GridpointResponseSchema = z.object({
  properties: z.object({
    '@id': z.string().url().optional(),
    updateTime: z.string(),
    gridId: z.string().min(1),
    gridX: z.number().int(),
    gridY: z.number().int(),
    elevation: z.object({ unitCode: z.string(), value: z.number() }),
    temperature: LayerSchema,
    dewpoint: LayerSchema,
    windSpeed: LayerSchema,
    skyCover: LayerSchema,
    wetBulbGlobeTemperature: LayerSchema.optional(),
  }),
});

const INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * An ISO-8601 instant **with** an explicit offset, to epoch ms. A naive time is
 * refused rather than read in the host's zone.
 *
 * @param {string} text
 * @returns {number}
 */
export function parseIsoInstant(text) {
  const m = typeof text === 'string' ? INSTANT.exec(text.trim()) : null;
  if (!m) {
    throw new HeatError(
      HEAT_REASON.GRIDPOINT_INVALID,
      `not an ISO instant with an offset: ${String(text)}`
    );
  }
  const [, y, mo, d, h, mi, s, , sign, oh, om] = m;
  const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, s ? +s : 0);
  const probe = new Date(wall);
  if (probe.getUTCMonth() !== +mo - 1 || probe.getUTCDate() !== +d || +h > 23 || +mi > 59) {
    throw new HeatError(HEAT_REASON.GRIDPOINT_INVALID, `not a real calendar instant: ${text}`);
  }
  const offsetMin = sign ? (sign === '-' ? -1 : 1) * (+oh * 60 + +om) : 0;
  return wall - offsetMin * 60000;
}

const DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/;

/**
 * Whole hours in an ISO-8601 duration of days/hours. Minutes are refused
 * (the reference's "sub-hour duration not supported").
 *
 * @param {string} text
 * @returns {number}
 */
export function parseDurationHours(text) {
  const m = typeof text === 'string' ? DURATION.exec(text) : null;
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) {
    throw new HeatError(
      HEAT_REASON.GRIDPOINT_DURATION_UNSUPPORTED,
      `unsupported ISO-8601 duration ${JSON.stringify(text)}`
    );
  }
  const [days, hours, minutes] = [m[1], m[2], m[3]].map((x) => (x ? Number.parseInt(x, 10) : 0));
  if (minutes) {
    throw new HeatError(
      HEAT_REASON.GRIDPOINT_DURATION_UNSUPPORTED,
      `sub-hour duration not supported: ${JSON.stringify(text)}`
    );
  }
  return days * 24 + hours;
}

/**
 * A gridpoint layer as an hourly series keyed by UTC epoch ms, in F/mph/%.
 *
 * @param {{ uom?: string|null, values?: Array<{ validTime: string, value?: number|null }> }} layer
 * @param {string} name - for messages
 * @returns {Map<number, number>}
 */
export function expandLayer(layer, name) {
  const uom = layer?.uom;
  if (typeof uom !== 'string' || !Object.hasOwn(LAYER_UNITS, uom)) {
    throw new HeatError(
      HEAT_REASON.GRIDPOINT_UNIT_UNEXPECTED,
      `${name}: unexpected unit ${JSON.stringify(uom ?? null)}`,
      {
        layer: name,
        uom: uom ?? null,
      }
    );
  }
  const conv = LAYER_UNITS[uom];
  /** @type {Map<number, number>} */
  const out = new Map();
  for (const item of layer.values ?? []) {
    const slash = item.validTime.indexOf('/');
    const startText = slash === -1 ? item.validTime : item.validTime.slice(0, slash);
    const durText = slash === -1 ? '' : item.validTime.slice(slash + 1);
    if (item.value === null || item.value === undefined) continue;
    const start = parseIsoInstant(startText);
    const hours = parseDurationHours(durText);
    for (let k = 0; k < hours; k += 1) out.set(start + k * HOUR_MS, conv(item.value));
  }
  if (out.size === 0) {
    throw new HeatError(HEAT_REASON.GRIDPOINT_LAYER_EMPTY, `${name}: no values in gridpoint data`, {
      layer: name,
    });
  }
  return new Map([...out.entries()].sort((a, b) => a[0] - b[0]));
}

/**
 * @typedef {Object} ParsedGridpoint
 * @property {{ id: string|null, updateTime: string, updateTimeMs: number,
 *   gridId: string, gridX: number, gridY: number, elevationM: number }} meta
 * @property {{ temperature: Map<number, number>, dewpoint: Map<number, number>,
 *   windSpeed: Map<number, number>, skyCover: Map<number, number>,
 *   nwsWbgt: Map<number, number>|null }} layers
 */

/**
 * Validate and expand a gridpoint response.
 *
 * @param {unknown} json
 * @returns {ParsedGridpoint}
 */
export function parseGridpoint(json) {
  const parsed = GridpointResponseSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HeatError(
      HEAT_REASON.GRIDPOINT_INVALID,
      `gridpoint response is missing or malformed at properties path "${issue.path.join('.')}": ${issue.message}`
    );
  }
  const p = parsed.data.properties;
  if (p.elevation.unitCode !== 'wmoUnit:m') {
    throw new HeatError(
      HEAT_REASON.GRIDPOINT_UNIT_UNEXPECTED,
      `elevation: unexpected unit ${JSON.stringify(p.elevation.unitCode)}`,
      { layer: 'elevation', uom: p.elevation.unitCode }
    );
  }
  const wbgtLayer = p.wetBulbGlobeTemperature;
  return {
    meta: {
      id: p['@id'] ?? null,
      updateTime: p.updateTime,
      updateTimeMs: parseIsoInstant(p.updateTime),
      gridId: p.gridId,
      gridX: p.gridX,
      gridY: p.gridY,
      elevationM: p.elevation.value,
    },
    layers: {
      temperature: expandLayer(p.temperature, 'temperature'),
      dewpoint: expandLayer(p.dewpoint, 'dewpoint'),
      windSpeed: expandLayer(p.windSpeed, 'windSpeed'),
      skyCover: expandLayer(p.skyCover, 'skyCover'),
      // Optional cross-check, read only when NWS sends at least one value. The
      // reference expanded any non-empty list, so an all-null layer would have
      // refused the whole venue over a column that is display-only; here it
      // reads as absent, and the column says "not supplied".
      nwsWbgt:
        wbgtLayer && wbgtLayer.values.some((v) => v.value !== null)
          ? expandLayer(wbgtLayer, 'wetBulbGlobeTemperature')
          : null,
    },
  };
}
