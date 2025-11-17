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

/**
 * Normalize Supabase-backed roster overrides into the `overrides` map consumed by
 * `deriveDivisionRosterConfigs`.
 *
 * Supabase rows can include season-specific overrides; when a `seasonId` is provided, the
 * helper prefers rows matching that season and falls back to seasonless entries when no
 * match exists. Rows tied to a different season are ignored so callers can pass the entire
 * table snapshot safely.
 *
 * @param {Array<Object>} rows - Supabase roster override records.
 * @param {{ seasonId?: string }} [options]
 * @returns {Record<string, { maxRosterSize: number, playableCount: number | null }>}
 */
export function buildOverridesFromSupabaseRows(rows, { seasonId } = {}) {
  if (!Array.isArray(rows)) {
    throw new TypeError('rows must be an array');
  }

  const normalized = {};

  rows.forEach((row, index) => {
    if (!row || typeof row !== 'object') {
      throw new TypeError(`rows[${index}] must be an object`);
    }

    const divisionId = selectSupabaseDivisionIdentifier(row, index);
    const rowSeasonId = normalizeOptionalString(row.seasonId ?? row.season_id);

    if (seasonId && rowSeasonId && rowSeasonId !== seasonId) {
      return;
    }

    const maxRosterSize = normalizeRosterSize(
      row.maxRosterSize ?? row.max_roster_size,
      `Supabase row for division ${divisionId}`,
    );
    const playableCount = row.playableCount ?? row.playable_count;
    const normalizedPlayableCount =
      playableCount === undefined || playableCount === null
        ? null
        : normalizePlayableCount(playableCount, divisionId);

    const candidate = {
      maxRosterSize,
      playableCount: normalizedPlayableCount,
      seasonId: rowSeasonId,
    };

    const existing = normalized[divisionId];
    if (!existing || shouldPreferCandidate({ existing, candidate, seasonId })) {
      normalized[divisionId] = candidate;
    }
  });

  for (const value of Object.values(normalized)) {
    delete value.seasonId;
  }

  return normalized;
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

function selectSupabaseDivisionIdentifier(row, index) {
  const identifiers = [row.divisionId, row.division_id, row.divisionCode, row.division_code]
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim());

  if (identifiers.length === 0) {
    throw new Error(`rows[${index}] is missing a division identifier`);
  }

  return identifiers[0];
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new TypeError('seasonId must be a string when provided');
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizePlayableCount(playableCount, divisionId) {
  const value = Number(playableCount);

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`invalid playableCount for division ${divisionId}`);
  }

  return Math.trunc(value);
}

function shouldPreferCandidate({ existing, candidate, seasonId }) {
  if (!existing) {
    return true;
  }

  const candidateMatchesSeason = Boolean(seasonId && candidate.seasonId === seasonId);
  const existingMatchesSeason = Boolean(seasonId && existing.seasonId === seasonId);

  if (candidateMatchesSeason && !existingMatchesSeason) {
    return true;
  }

  if (!existingMatchesSeason && candidate.seasonId === null && existing.seasonId) {
    return true;
  }

  return false;
}
