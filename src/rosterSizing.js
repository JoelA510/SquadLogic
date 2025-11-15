const DEFAULT_BUFFER = 2;

/**
 * Parse the playable roster size from a format string like "7v7" or "9V9".
 *
 * @param {string} playFormat - Format describing on-field players per side.
 * @returns {number}
 */
export function parsePlayableCount(playFormat) {
  if (typeof playFormat !== 'string') {
    throw new TypeError('playFormat must be a string');
  }

  const trimmed = playFormat.trim();
  if (!trimmed) {
    throw new Error('playFormat cannot be empty');
  }

  const match = trimmed.match(/(\d+)\s*v\s*(\d+)/i);
  if (!match) {
    throw new Error(`unable to parse playable count from format: ${playFormat}`);
  }

  const playable = Number.parseInt(match[1], 10);
  if (!Number.isFinite(playable) || playable <= 0) {
    throw new Error(`invalid playable count extracted from format: ${playFormat}`);
  }

  return playable;
}

/**
 * Calculate the recommended maximum roster size given the playable headcount.
 * The baseline formula follows the roadmap guidance of `2 * playable - 2`.
 *
 * @param {number} playableCount - Number of players per side on the field.
 * @param {{ buffer?: number, minimum?: number }} [options]
 * @returns {number}
 */
export function calculateMaxRosterSize(playableCount, { buffer = DEFAULT_BUFFER, minimum } = {}) {
  if (!Number.isFinite(playableCount) || playableCount <= 0) {
    throw new TypeError('playableCount must be a positive number');
  }
  if (!Number.isFinite(buffer) || buffer < 0) {
    throw new TypeError('buffer must be a non-negative number');
  }
  if (minimum !== undefined && (!Number.isFinite(minimum) || minimum <= 0)) {
    throw new TypeError('minimum must be a positive number when provided');
  }

  const baseline = playableCount * 2 - Math.min(buffer, playableCount);
  if (baseline <= 0) {
    throw new Error('calculated baseline roster size must be positive');
  }

  const rosterSize = Math.max(baseline, minimum ?? 0);
  return Math.trunc(rosterSize);
}

/**
 * Build a division configuration map with derived roster sizes.
 *
 * Each division entry can provide one of the following data points (in order of precedence):
 *   1. An override entry in the `overrides` map keyed by id, code, or name.
 *   2. An explicit `maxRosterSize` value on the division record itself.
 *   3. A `playableCount` value or a `playFormat` string (e.g., `7v7`).
 *
 * @param {Array<Object>} divisions - Raw division metadata.
 * @param {{ overrides?: Record<string, { maxRosterSize: number }> }} [options]
 * @returns {Record<string, { maxRosterSize: number, playableCount: number | null, source: string }>} -
 *   Map keyed by division identifier containing the derived roster size and context.
 */
export function deriveDivisionRosterConfigs(divisions, { overrides = {} } = {}) {
  if (!Array.isArray(divisions)) {
    throw new TypeError('divisions must be an array');
  }
  if (typeof overrides !== 'object' || overrides === null) {
    throw new TypeError('overrides must be an object');
  }

  const configs = {};

  for (const division of divisions) {
    if (!division || typeof division !== 'object') {
      throw new TypeError('each division entry must be an object');
    }

    const identifier = selectDivisionIdentifier(division);
    const override = findOverride(overrides, division, identifier);

    if (override) {
      const maxRosterSize = normalizeRosterSize(override.maxRosterSize, `override for ${identifier}`);
      configs[identifier] = {
        maxRosterSize,
        playableCount: override.playableCount ?? null,
        source: 'override',
      };
      continue;
    }

    if (division.maxRosterSize !== undefined) {
      const maxRosterSize = normalizeRosterSize(division.maxRosterSize, `division ${identifier}`);
      configs[identifier] = {
        maxRosterSize,
        playableCount: division.playableCount ?? null,
        source: 'division-record',
      };
      continue;
    }

    const playableCount = resolvePlayableCount(division, identifier);
    const maxRosterSize = calculateMaxRosterSize(playableCount);
    configs[identifier] = {
      maxRosterSize,
      playableCount,
      source: 'formula',
    };
  }

  return configs;
}

function selectDivisionIdentifier(division) {
  const candidates = [division.id, division.code, division.slug, division.name].filter(
    (value) => typeof value === 'string' && value.trim().length > 0,
  );

  if (candidates.length === 0) {
    throw new Error('division entry is missing an identifier');
  }

  return candidates[0];
}

function findOverride(overrides, division, identifier) {
  const keys = [identifier, division.id, division.code, division.slug, division.name]
    .filter((value) => typeof value === 'string' && value.trim().length > 0);

  for (const key of keys) {
    if (Object.hasOwn(overrides, key) && overrides[key]) {
      return overrides[key];
    }
  }

  return null;
}

function normalizeRosterSize(value, context) {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(`invalid maxRosterSize provided by ${context}`);
  }
  return Math.trunc(size);
}

function resolvePlayableCount(division, identifier) {
  if (division.playableCount !== undefined) {
    const playable = Number(division.playableCount);
    if (!Number.isFinite(playable) || playable <= 0) {
      throw new Error(`invalid playableCount for division ${identifier}`);
    }
    return Math.trunc(playable);
  }

  if (division.playFormat) {
    return parsePlayableCount(division.playFormat);
  }

  throw new Error(`division ${identifier} is missing roster sizing data`);
}
