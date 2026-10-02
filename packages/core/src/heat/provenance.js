/**
 * Provenance: what every computed heat row carries, and the catalogue the
 * sources panel renders from.
 *
 * Every URL and DOI here was checked on 2026-10-02: each URL returned 200 (the
 * T&F and MDPI DOIs redirect to publishers that answer 403 to non-browser
 * clients; their Crossref metadata matched the citation). Do not add an entry
 * without the same check -- an invented DOI is worse than none.
 *
 * @module heat/provenance
 */

import { HEAT_BANDS } from './bands.js';
import { TURBIDITY_TABLE } from './turbidity.js';

/**
 * The model identifier a row carries. Bump `version` whenever a constant,
 * algorithm or reference table changes a computed value.
 */
export const HEAT_MODEL = Object.freeze({
  id: 'squadlogic-heat-wbgt',
  version: '1.0.0',
  reference: 'cvsc_wbgt.py (Python reference, scripts/heat/reference/)',
  wbgt: 'Liljegren et al. 2008, natural wet bulb + 2-inch globe, 10 m -> 2 m wind by stability class',
  solarPosition:
    'NREL SPA (Reda & Andreas 2004), pvlib spa_python defaults (delta_t 67 s, 12 C refraction)',
  clearSky: 'Ineichen-Perez 2002 (pvlib defaults: Kasten-Young airmass, Spencer extraterrestrial)',
  turbidity: `${TURBIDITY_TABLE.id}: SoDa monthly Linke turbidity via pvlib, block-averaged to ${TURBIDITY_TABLE.resolutionDeg} degree`,
  cloud: 'Kasten-Czeplak 1980: GHI x (1 - 0.75 N^3.4)',
  surfaces: Object.freeze({
    grass: 'ground temperature = air temperature, albedo 0.23 (Liljegren)',
    turf: 'no-evaporation surface energy balance, albedo 0.10, air +1.5 F, dewpoint -1.8 F (Grundstein & Cooper 2020)',
  }),
});

/**
 * @typedef {Object} SourceEntry
 * @property {string} id
 * @property {'forecast'|'crosscheck'|'model'|'surface'|'variability'|'solar'|'thresholds'} group
 * @property {string} title - what the panel shows as the link text
 * @property {string} [citation] - full reference where there is one
 * @property {string} url
 * @property {string} [doi]
 * @property {Array<{ label: string, url: string }>} [also]
 */

/** @type {Readonly<Record<string, SourceEntry>>} */
export const HEAT_SOURCES = Object.freeze({
  'nws-api': {
    id: 'nws-api',
    group: 'forecast',
    title: 'NOAA National Weather Service API, gridpoint forecast',
    url: 'https://api.weather.gov',
    also: [
      { label: 'API documentation', url: 'https://www.weather.gov/documentation/services-web-api' },
    ],
  },
  'nws-wbgt': {
    id: 'nws-wbgt',
    group: 'crosscheck',
    title: "NWS's own WBGT forecast (select Wet Bulb Globe Temperature)",
    url: 'https://digital.weather.gov',
    also: [
      {
        label: 'Operational since June 2022',
        url: 'https://www.weather.gov/news/220106-wet-bulb-globe',
      },
    ],
  },
  liljegren2008: {
    id: 'liljegren2008',
    group: 'model',
    title: 'Liljegren et al. 2008 (WBGT model)',
    citation:
      'Liljegren JC, Carhart RA, Lawday P, Tschopp S, Sharp R. Modeling the Wet Bulb Globe Temperature Using Standard Meteorological Measurements. J Occup Environ Hyg. 2008;5(10):645-655.',
    doi: '10.1080/15459620802310770',
    url: 'https://doi.org/10.1080/15459620802310770',
  },
  grundstein2020: {
    id: 'grundstein2020',
    group: 'surface',
    title: 'Grundstein & Cooper 2020 (turf vs grass)',
    citation:
      'Grundstein A, Cooper E. Comparison of WBGTs over Different Surfaces within an Athletic Complex. Medicina. 2020;56(6):313.',
    doi: '10.3390/medicina56060313',
    url: 'https://doi.org/10.3390/medicina56060313',
  },
  singh2024: {
    id: 'singh2024',
    group: 'surface',
    title: 'Singh et al. 2024 systematic review (synthetic grass thermal environment)',
    citation:
      'Singh G, Peterson B, Jay O, Stevens CJ. The effect of synthetic grass sports surfaces on the thermal environment: A systematic review. Int J Biometeorol. 2024;68(7):1235-1252.',
    doi: '10.1007/s00484-024-02679-5',
    url: 'https://link.springer.com/article/10.1007/s00484-024-02679-5',
  },
  pryor2017: {
    id: 'pryor2017',
    group: 'variability',
    title: 'Pryor et al. 2017 (on-site vs modeled WBGT)',
    citation:
      'Pryor JL, Pryor RR, Grundstein A, Casa DJ. The Heat Strain of Various Athletic Surfaces: A Comparison Between Observed and Modeled Wet-Bulb Globe Temperatures. J Athl Train. 2017;52(11):1056-1064.',
    doi: '10.4085/1062-6050-52.11.15',
    url: 'https://doi.org/10.4085/1062-6050-52.11.15',
  },
  reda2004: {
    id: 'reda2004',
    group: 'solar',
    title: 'Reda & Andreas 2004 (NREL Solar Position Algorithm)',
    citation:
      'Reda I, Andreas A. Solar position algorithm for solar radiation applications. Solar Energy. 2004;76(5):577-589.',
    doi: '10.1016/j.solener.2003.12.003',
    url: 'https://doi.org/10.1016/j.solener.2003.12.003',
  },
  ineichen2002: {
    id: 'ineichen2002',
    group: 'solar',
    title: 'Ineichen & Perez 2002 (clear-sky model)',
    citation:
      'Ineichen P, Perez R. A new airmass independent formulation for the Linke turbidity coefficient. Solar Energy. 2002;73(3):151-157.',
    doi: '10.1016/S0038-092X(02)00045-2',
    url: 'https://doi.org/10.1016/S0038-092X(02)00045-2',
  },
  kastenyoung1989: {
    id: 'kastenyoung1989',
    group: 'solar',
    title: 'Kasten & Young 1989 (relative airmass)',
    citation:
      'Kasten F, Young AT. Revised optical air mass tables and approximation formula. Appl Opt. 1989;28(22):4735-4738.',
    doi: '10.1364/AO.28.004735',
    url: 'https://doi.org/10.1364/AO.28.004735',
  },
  kasten1980: {
    id: 'kasten1980',
    group: 'solar',
    title: 'Kasten & Czeplak 1980 (cloud reduction of GHI)',
    citation:
      'Kasten F, Czeplak G. Solar and terrestrial radiation dependent on the amount and type of cloud. Solar Energy. 1980;24(2):177-189.',
    doi: '10.1016/0038-092X(80)90391-6',
    url: 'https://doi.org/10.1016/0038-092X(80)90391-6',
  },
  'pvlib-linke': {
    id: 'pvlib-linke',
    group: 'solar',
    title:
      'Linke turbidity climatology (SoDa / Remund et al. 2003) as distributed with pvlib, block-averaged to 0.5 degree',
    url: 'https://pvlib-python.readthedocs.io/en/stable/reference/generated/pvlib.clearsky.ineichen.html',
    also: [
      {
        label: 'pvlib lookup_linke_turbidity',
        url: 'https://pvlib-python.readthedocs.io/en/stable/reference/generated/pvlib.clearsky.lookup_linke_turbidity.html',
      },
      {
        label: 'Extraterrestrial irradiance (Spencer), pvlib get_extra_radiation',
        url: 'https://pvlib-python.readthedocs.io/en/stable/reference/generated/pvlib.irradiance.get_extra_radiation.html',
      },
    ],
  },
  pvlib2023: {
    id: 'pvlib2023',
    group: 'solar',
    title: 'pvlib python (reference implementation the solar code is ported from)',
    citation:
      'Anderson KS, Hansen CW, Holmgren WF, Jensen AR, Mikofski MA, Driesse A. pvlib python: 2023 project update. J Open Source Softw. 2023;8(92):5994.',
    doi: '10.21105/joss.05994',
    url: 'https://doi.org/10.21105/joss.05994',
  },
  'us-soccer-rtr': {
    id: 'us-soccer-rtr',
    group: 'thresholds',
    title: 'U.S. Soccer Recognize to Recover Heat Guidelines',
    url: 'https://www.recognizetorecover.org/environmental',
    also: [
      {
        label: 'Heat Guidelines poster (PDF)',
        url: 'https://r2rsoccer.squarespace.com/s/1609024-Heat-Guidelines-8f44.pdf',
      },
    ],
  },
});

/** The sources the model itself depends on, in the order the panel lists them. */
const MODEL_SOURCE_IDS = Object.freeze([
  'liljegren2008',
  'grundstein2020',
  'singh2024',
  'pryor2017',
  'reda2004',
  'ineichen2002',
  'kastenyoung1989',
  'kasten1980',
  'pvlib-linke',
  'pvlib2023',
]);

/**
 * @typedef {Object} ForecastSource
 * @property {string} pointsUrl
 * @property {string} gridpointUrl
 * @property {string} retrievedAt - ISO instant the gridpoint response arrived
 */

/**
 * @typedef {Object} HeatProvenance
 * @property {{ sourceId: 'nws-api', crosscheckSourceId: 'nws-wbgt', pointsUrl: string,
 *   gridpointUrl: string, gridId: string, gridX: number, gridY: number,
 *   updateTime: string, retrievedAt: string, elevationM: number }} forecast
 * @property {typeof HEAT_MODEL & { sourceIds: ReadonlyArray<string> }} model
 * @property {{ category: 1|2|3, categorySource: 'configured'|'default', sourceId: 'us-soccer-rtr',
 *   bands: ReadonlyArray<readonly [string, number]>, note: string|null }} thresholds
 */

/**
 * @param {{ gridpoint: import('./gridpoint.js').ParsedGridpoint, source: ForecastSource,
 *   category: 1|2|3, categorySource: 'configured'|'default' }} input
 * @returns {HeatProvenance}
 */
export function buildHeatProvenance({ gridpoint, source, category, categorySource }) {
  return {
    forecast: {
      sourceId: 'nws-api',
      crosscheckSourceId: 'nws-wbgt',
      pointsUrl: source.pointsUrl,
      gridpointUrl: source.gridpointUrl,
      gridId: gridpoint.meta.gridId,
      gridX: gridpoint.meta.gridX,
      gridY: gridpoint.meta.gridY,
      updateTime: gridpoint.meta.updateTime,
      retrievedAt: source.retrievedAt,
      elevationM: gridpoint.meta.elevationM,
    },
    model: { ...HEAT_MODEL, sourceIds: MODEL_SOURCE_IDS },
    thresholds: {
      category,
      categorySource,
      sourceId: 'us-soccer-rtr',
      bands: HEAT_BANDS[category],
      note:
        category === 2
          ? 'Category 2 poster lists Black as >89.8 F in its table and >89.9 F in its text; the stricter 89.8 F is used.'
          : null,
    },
  };
}

/**
 * Every source id the given rows' provenance names, deduplicated, in catalogue
 * order -- what the sources panel lists. Throws on an id the catalogue lacks,
 * so a provenance record can never point at a citation nobody can see.
 *
 * @param {ReadonlyArray<HeatProvenance>} provenances
 * @returns {SourceEntry[]}
 */
export function sourcesForProvenance(provenances) {
  const ids = new Set();
  for (const p of provenances) {
    ids.add(p.forecast.sourceId);
    ids.add(p.forecast.crosscheckSourceId);
    for (const id of p.model.sourceIds) ids.add(id);
    ids.add(p.thresholds.sourceId);
  }
  const order = Object.keys(HEAT_SOURCES);
  return [...ids]
    .map((id) => {
      if (!Object.hasOwn(HEAT_SOURCES, id))
        throw new Error(`provenance names unknown source "${id}"`);
      return HEAT_SOURCES[id];
    })
    .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}
