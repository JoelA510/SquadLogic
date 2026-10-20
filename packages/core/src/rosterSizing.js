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
 * @param {{ overrides?: Record<string, Object> }} [options]
 * @returns {Record<string, Object>} -
 *   Map keyed by division identifier containing the derived roster size and context.
 */
export function deriveDivisionRosterConfigs(divisions, { overrides = {} } = {}) {
  if (!Array.isArray(divisions)) {
    throw new TypeError('divisions must be an array');
  }
  if (typeof overrides !== 'object' || overrides === null) {
    throw new TypeError('overrides must be an object');
  }

  const configs =
    /** @type {Record<string, { maxRosterSize: number, playableCount: number | null, source: string }>} */ ({});

  for (const division of divisions) {
    if (!division || typeof division !== 'object') {
      throw new TypeError('each division entry must be an object');
    }

    const identifier = selectDivisionIdentifier(division);
    const override = findOverride(overrides, division, identifier);

    if (override) {
      const maxRosterSize = normalizeRosterSize(
        override.maxRosterSize ?? override.max_roster_size,
        `override for ${identifier}`
      );
      configs[identifier] = withOptionalRosterConstraints(override, {
        maxRosterSize,
        playableCount: override.playableCount ?? null,
        source: 'override',
      });
      continue;
    }

    if (division.maxRosterSize !== undefined) {
      const maxRosterSize = normalizeRosterSize(division.maxRosterSize, `division ${identifier}`);
      configs[identifier] = withOptionalRosterConstraints(division, {
        maxRosterSize,
        playableCount: division.playableCount ?? null,
        source: 'division-record',
      });
      continue;
    }

    const playableCount = resolvePlayableCount(division, identifier);
    const maxRosterSize = calculateMaxRosterSize(playableCount);
    configs[identifier] = withOptionalRosterConstraints(division, {
      maxRosterSize,
      playableCount,
      source: 'formula',
    });
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
 * @returns {Record<string, Object>}
 */
export function buildOverridesFromSupabaseRows(rows, { seasonId } = {}) {
  if (!Array.isArray(rows)) {
    throw new TypeError('rows must be an array');
  }

  const normalized = /** @type {Record<string, any>} */ ({});

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
      `Supabase row for division ${divisionId}`
    );
    const playableCount = row.playableCount ?? row.playable_count;
    const normalizedPlayableCount =
      playableCount === undefined || playableCount === null
        ? null
        : normalizePlayableCount(playableCount, divisionId);

    const candidate = {
      maxRosterSize,
      playableCount: normalizedPlayableCount,
      ...extractOptionalRosterConstraints(row, divisionId),
      seasonId: rowSeasonId,
    };

    const existing = normalized[divisionId];
    if (!existing || shouldPreferCandidate({ existing, candidate, seasonId })) {
      normalized[divisionId] = candidate;
    }
  });

  const result =
    /** @type {Record<string, { maxRosterSize: number, playableCount: number | null }>} */ ({});
  for (const divisionId in normalized) {
    const { seasonId: _seasonId, ...override } = normalized[divisionId];
    result[divisionId] = override;
  }

  return result;
}

function selectDivisionIdentifier(division) {
  const candidates = [division.id, division.code, division.slug, division.name].filter(
    (value) => typeof value === 'string' && value.trim().length > 0
  );

  if (candidates.length === 0) {
    throw new Error('division entry is missing an identifier');
  }

  return candidates[0];
}

function findOverride(overrides, division, identifier) {
  const keys = [identifier, division.id, division.code, division.slug, division.name].filter(
    (value) => typeof value === 'string' && value.trim().length > 0
  );

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

function withOptionalRosterConstraints(source, base) {
  const constraints = extractOptionalRosterConstraints(source, base.source || base.maxRosterSize);
  if (constraints.minRosterSize && constraints.minRosterSize > base.maxRosterSize) {
    throw new Error(`invalid minRosterSize for ${base.source}: cannot exceed maxRosterSize`);
  }
  if (constraints.minTeams && constraints.maxTeams && constraints.minTeams > constraints.maxTeams) {
    throw new Error(`invalid team bounds for ${base.source}: minTeams cannot exceed maxTeams`);
  }

  return {
    ...base,
    ...constraints,
  };
}

function extractOptionalRosterConstraints(source, context) {
  const result = {};
  const minRosterSize = normalizeOptionalPositiveInteger(
    source.minRosterSize ?? source.min_roster_size ?? source.minSize,
    `minRosterSize for ${context}`
  );
  const targetTeamSize = normalizeOptionalPositiveInteger(
    source.targetTeamSize ?? source.target_team_size ?? source.targetSize,
    `targetTeamSize for ${context}`
  );
  const teamCountOverride = normalizeOptionalPositiveInteger(
    source.teamCountOverride ?? source.team_count_override,
    `teamCountOverride for ${context}`
  );
  const minTeams = normalizeOptionalPositiveInteger(
    source.minTeams ?? source.min_teams,
    `minTeams for ${context}`
  );
  const maxTeams = normalizeOptionalPositiveInteger(
    source.maxTeams ?? source.max_teams,
    `maxTeams for ${context}`
  );

  if (minRosterSize !== null) result.minRosterSize = minRosterSize;
  if (targetTeamSize !== null) result.targetTeamSize = targetTeamSize;
  if (teamCountOverride !== null) result.teamCountOverride = teamCountOverride;
  if (minTeams !== null) result.minTeams = minTeams;
  if (maxTeams !== null) result.maxTeams = maxTeams;

  return result;
}

function normalizeOptionalPositiveInteger(value, context) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    throw new Error(`invalid ${context}`);
  }

  return Math.trunc(numberValue);
}

function shouldPreferCandidate({ existing, candidate, seasonId }) {
  if (!existing) {
    return true;
  }

  // When a seasonId is provided, prefer a season specific candidate over a generic existing one.
  if (seasonId) {
    const candidateMatchesSeason = candidate.seasonId === seasonId;
    const existingIsGeneric = existing.seasonId === null;
    return candidateMatchesSeason && existingIsGeneric;
  }

  // When no seasonId is provided, prefer a generic candidate over a season specific existing one.
  const candidateIsGeneric = candidate.seasonId === null;
  const existingIsSpecific = existing.seasonId !== null;
  return candidateIsGeneric && existingIsSpecific;
}

/**
 * Advise on a team count for a program before teams are generated: the range of team counts that
 * keeps every team between the roster limits, a recommended count, and the warnings for the count
 * the admin chose. Teams are assumed to be filled as evenly as possible, so with `n` players and
 * `t` teams the smallest has `floor(n / t)` and the largest `ceil(n / t)`.
 *
 * Advisory only: it does not change what `generateTeams` does, which also weighs coach count and
 * min/max team bounds.
 *
 * @param {{ playerCount: number, teamCount?: number|null, minRosterSize?: number|null,
 *   maxRosterSize?: number|null, targetTeamSize?: number|null }} params
 * @returns {{ fitRange: { min: number, max: number } | null, recommendedTeamCount: number | null,
 *   smallestTeam: number | null, largestTeam: number | null,
 *   warnings: Array<{ code: 'TOO_FEW_PLAYERS'|'TOO_FEW_PER_TEAM'|'TOO_MANY_PER_TEAM'|'NO_FIT',
 *     message: string }> }}
 */
export function assessTeamCount({
  playerCount,
  teamCount = null,
  minRosterSize = null,
  maxRosterSize = null,
  targetTeamSize = null,
}) {
  const n = Number.isInteger(playerCount) && playerCount > 0 ? playerCount : 0;
  const min = positiveOrNull(minRosterSize);
  const max = positiveOrNull(maxRosterSize);
  const target = positiveOrNull(targetTeamSize) ?? max ?? min;
  const warnings = [];

  if (n === 0) {
    return {
      fitRange: null,
      recommendedTeamCount: null,
      smallestTeam: null,
      largestTeam: null,
      warnings,
    };
  }

  if (min && n < min) {
    warnings.push({
      code: 'TOO_FEW_PLAYERS',
      message: `Only ${n} ${plural(n, 'player')} registered, fewer than the minimum roster of ${min}: even one team would be short.`,
    });
  }

  const lo = max ? Math.ceil(n / max) : 1;
  const hi = min ? Math.floor(n / min) : n;
  const fitRange = min && n < min ? null : lo <= hi ? { min: lo, max: hi } : null;

  if (!fitRange && !(min && n < min)) {
    warnings.push({
      code: 'NO_FIT',
      message: `No team count keeps every team between ${min} and ${max} players with ${n} players: ${lo} ${plural(lo, 'team')} would leave some under ${min}, ${lo - 1} would put some over ${max}.`,
    });
  }

  const ideal = target ? Math.max(1, Math.round(n / target)) : lo;
  const recommendedTeamCount = fitRange
    ? Math.min(Math.max(ideal, fitRange.min), fitRange.max)
    : Math.max(1, lo);

  const t = positiveOrNull(teamCount);
  let smallestTeam = null;
  let largestTeam = null;
  if (t) {
    smallestTeam = Math.floor(n / t);
    largestTeam = Math.ceil(n / t);
    if (max && largestTeam > max) {
      warnings.push({
        code: 'TOO_MANY_PER_TEAM',
        message: `With ${t} ${plural(t, 'team')}, ${someTeams(t)} would have ${largestTeam} players, over the maximum of ${max}. Use at least ${lo} teams.`,
      });
    }
    if (min && smallestTeam < min && !(n < min)) {
      warnings.push({
        code: 'TOO_FEW_PER_TEAM',
        message: `With ${t} ${plural(t, 'team')}, ${someTeams(t)} would have only ${smallestTeam} ${plural(smallestTeam, 'player')}, under the minimum of ${min}. Use at most ${hi} ${plural(hi, 'team')}.`,
      });
    }
  }

  return { fitRange, recommendedTeamCount, smallestTeam, largestTeam, warnings };
}

function positiveOrNull(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function someTeams(teamCount) {
  return teamCount === 1 ? 'the team' : 'some teams';
}

function plural(count, word) {
  return count === 1 ? word : `${word}s`;
}
