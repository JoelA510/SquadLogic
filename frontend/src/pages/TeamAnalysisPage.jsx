import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDashboardData } from '../hooks/useDashboardData.js';
import DataErrorBanner from '../components/ui/DataErrorBanner.jsx';
import { useTeamPersistence } from '../hooks/useTeamPersistence.js';
import { useAutoRunOnNavigate } from '../hooks/useAutoRunOnNavigate.js';
import { useImport } from '../contexts/ImportContext.jsx';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { useSeasonReadOnly } from '../hooks/useSeasonReadOnly.js';
import SeasonReadOnlyNote from '../components/chrome/SeasonReadOnlyNote.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import TeamOverviewPanel from '../components/TeamOverviewPanel.jsx';
import ProgramOverview from '../components/teaming/ProgramOverview.jsx';
import { NO_PROGRAM_KEY, groupByProgram, ownProgramIdOf } from '../utils/programGroups.js';
import { flagCountsOf } from '../utils/seatNotes.js';
import TeamingConfiguration from '../components/teaming/TeamingConfiguration.jsx';
import RosterManager from '../components/teaming/RosterManager.jsx';
import { useRosterDirectory } from '../hooks/useRosterDirectory.js';
import { applyRosterDirectory, countUnnamedPlayers } from '../utils/rosterPeople.js';
import TeamPersistencePanel from '../components/TeamPersistencePanel.jsx';
import DataValidationPanel from '../components/teaming/DataValidationPanel.jsx';
import BuddyRequestsList from '../components/teaming/BuddyRequestsList.jsx';
import PlacementReviewList from '../components/teaming/PlacementReviewList.jsx';
import PlayUpList from '../components/teaming/PlayUpList.jsx';
import TeamSizeOutcomeList from '../components/teaming/TeamSizeOutcomeList.jsx';
import Button from '../components/ui/Button.jsx';
import ProgressBar from '../components/ui/ProgressBar.jsx';
import { Edit2, Save, ArrowRight, Trash2, X } from 'lucide-react';
import { supabase } from '../lib/supabaseClient.js';
import { logger } from '../lib/logger.js';
import { edgeFunctionCache } from '../lib/cache.js';
import { IS_MOCK_MODE } from '../config.js';
import { generateTeams, resolveTeamCount } from '@squadlogic/core/teamGeneration.js';
import { TEAM_GENERATION } from '@squadlogic/core/constants.js';
import { DEFAULT_ROSTER_LIMITS, assessTeamCount } from '@squadlogic/core/rosterSizing.js';
import { prepareTeamingInput } from '@squadlogic/core/teamingPipeline.js';
import { applyPlayUpEligibility } from '@squadlogic/core/playUp.js';
import { seatsFromPlacedPlayers, summarizeSeats } from '@squadlogic/core/playUpSeats.js';
import { summarizeBuddyRequests } from '@squadlogic/core/buddyLinking.js';
import { isCoachingLeadAnswer } from '@squadlogic/core/coachingLeads.js';
import { mapSchedulerRunToSummary } from '@squadlogic/core/utils/teamSummaryMapper.js';
import { formatChangeNote } from '@squadlogic/core/teamDiagnostics.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { FEATURE_FLAGS } from '../constants/featureFlags.js';
import { useFeatures } from '../hooks/useFeatures.js';
import { canonicalImportKey } from '../utils/importAllowlist.js';
import {
  coachIdsNamedByReview,
  placementReviewAnnouncement,
  summarizePlacementReview,
} from '../utils/placementReview.js';
import {
  coachIdsNamedByPlayUp,
  playUpAnnouncement,
  summarizePlayUpReview,
  waitlistPlayersToActivate,
} from '../utils/playUpReview.js';
import { summarizeTeamSizeReview, teamSizeAnnouncement } from '../utils/teamSizeReview.js';
import { getPersistenceEndpoint, triggerTeamPersistence } from '../utils/teamPersistenceClient.js';
import {
  buildExistingSnapshotForRerun,
  buildManualRosterSnapshot,
  buildTeamReviewSnapshot,
  firstString,
  getPlayerExternalId,
  isUuid,
} from '../utils/teamReviewPersistence.js';

const {
  maxRosterSize: DEFAULT_MAX_ROSTER_SIZE,
  minRosterSize: DEFAULT_MIN_ROSTER_SIZE,
  targetTeamSize: DEFAULT_TARGET_TEAM_SIZE,
} = DEFAULT_ROSTER_LIMITS;

function getImportedRows(importedData) {
  if (!importedData) return [];
  if (Array.isArray(importedData)) return importedData;
  if (Array.isArray(importedData.data)) return importedData.data;
  if (Array.isArray(importedData.fullData)) return importedData.fullData;
  if (Array.isArray(importedData.rows)) return importedData.rows;
  return [];
}

function firstNonEmpty(row, keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return value;
    }
  }
  return null;
}

// GotSport exports the player's age in an "age group" column but no
// division/program column. Derive the playing division from it: a player of
// age N plays in U(N+1) (e.g. a 7-year-old → "U8"). Kept in sync with the
// import's division assignment and the divisions seeded for the season.
function ageGroupDivisionName(row) {
  const raw = firstNonEmpty(row, ['age group', 'age_group', 'ageGroup', 'Age Group', 'age']);
  if (raw == null) return null;
  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isInteger(n) || n <= 0 || n > 25) return null;
  return `U${n + 1}`;
}

function resolveDivisionName(row) {
  return (
    firstNonEmpty(row, [
      'division_name',
      'division',
      'divisionName',
      'Division',
      'Group',
      'Program',
      'program',
    ]) ||
    ageGroupDivisionName(row) ||
    'Unassigned'
  );
}

function resolveDivisionId(row) {
  const explicitId = firstNonEmpty(row, ['division_id', 'divisionId']);
  return String(explicitId || resolveDivisionName(row)).trim();
}

/**
 * A program's rules before anything is saved. The team count is Auto (no override): generation
 * builds the count `resolveTeamCount` gives. It used to be pre-filled with `ceil(players / 12)`,
 * which generation then saved, so every program soon carried an "override" nobody set (Phase B4).
 * A saved override is kept (`configFromDivisionRow`), with the recommendation beside it.
 */
function createDefaultConfig() {
  return {
    targetTeamSize: DEFAULT_TARGET_TEAM_SIZE,
    minRosterSize: DEFAULT_MIN_ROSTER_SIZE,
    maxRosterSize: DEFAULT_MAX_ROSTER_SIZE,
    minTeams: null,
    maxTeams: null,
    teamCountOverride: null,
    seed: '',
  };
}

/**
 * The divisions the file registers players in, by the division each row names, in order of first
 * appearance. This is where a player REGISTERED; where they PLAY is `placeImportRows`, and what the
 * advice counts is `derivePrograms`.
 */
function registeredDivisionsOf(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const id = resolveDivisionId(row);
    if (!grouped.has(id)) {
      grouped.set(id, { id, name: String(resolveDivisionName(row)).trim() || id });
    }
  }
  return Array.from(grouped.values());
}

/**
 * The programs of an import, with the players each holds, counted by the division each player PLAYS
 * in, as generation seats them (play-down plan, 2026-11-03, PR 1): a player moved to their own age
 * division is in the division they play in, not the one they registered in, so the advice and the
 * teams generation builds are counts of the same players. `byDivision` is `summarizeSeats`'s count
 * of every registrant, one seat each. The head coaches are not counted here: since the admin-only
 * change (owner decision 8a, 2026-10-27) only a `coach_team_requests` link anchors a team, and the
 * links are read at generation, not with the import's rows. So the overview's recommended team count
 * is the seatable players' (`coachCount` 0); generation itself makes a team for each coach whose child
 * is eligible for the division, and one whose child is not eligible, or is waitlisted, anchors no team
 * (Phase B2).
 *
 * `playerCount` is the players generation can seat, which the advice is for: a waitlisted player is
 * seated on no team (owner, 2026-10-27), and neither is one no division can hold
 * (`isEligibilityBlocked`, B2). They are counted apart, in `waitlistedCount` (by the division they
 * would play in) and `notEligibleCount` (by the division they registered in, since none holds them).
 * A row that is both is counted once, as not eligible, as the holds list and the review totals report
 * it (follow-ups F1, item 2; data follow-ups, item 2). `movedInCount` and `movedOutCount` are the
 * players who play somewhere other than where they registered, so the arithmetic from the file's count
 * to the advice is on screen.
 *
 * A row for each division the file registers players in, then, last, each division of the season the
 * file has no registrants in but whose rules take players from it (a U4 whose birth-date window holds
 * a U3 registrant; `incoming`): programs too, with the players that would play there, so they can be
 * seen and generated, and so a player who moved is shown somewhere even when they are waitlisted
 * (that row reads "All on the waitlist"). Their id is the division's own, which is the id the age
 * placement gives them.
 *
 * `totalPlayers` is every registrant the row accounts for: the players who play here, seated or on
 * the waitlist, and the ones registered here whom no division holds. A player who moved out is in the
 * row they moved to, not this one. Nothing reads it (it was "everyone registered" before the advice
 * counted by the division played).
 *
 * @param {Object} params
 * @param {Array<{ id: string, name: string }>} params.registeredDivisions - `registeredDivisionsOf`
 * @param {Map<string, import('@squadlogic/core/playUpSeats.js').SeatCounts>} params.byDivision
 * @param {Array<Object>} [params.incomingDescriptors] - the season's divisions no program of the
 *   file is (`buildDivisionDescriptors`' `otherDescriptors`); none until the divisions are read
 * @param {boolean} [params.checked] - the seats were compared with the divisions' age bands, which
 *   needs the season's divisions to have been read; until then the flag counts say they are not known
 */
function derivePrograms({ registeredDivisions, byDivision, incomingDescriptors = [], checked }) {
  const toProgram = (id, name, extra = {}) => {
    const counts = /** @type {import('@squadlogic/core/playUpSeats.js').SeatCounts} */ (
      byDivision.get(id)
    );
    return {
      id,
      name,
      playerCount: counts.seated,
      waitlistedCount: counts.waitlisted,
      notEligibleCount: counts.notEligible,
      movedInCount: counts.movedIn,
      movedOutCount: counts.movedOut,
      // Who plays up or down in this division, counted by the same seats (play-down plan, PR 2).
      flags: flagCountsOf(counts, checked === true),
      coachCount: 0,
      totalPlayers: counts.seated + counts.waitlisted + counts.notEligible,
      ...extra,
    };
  };
  return [
    ...registeredDivisions.map(({ id, name }) => toProgram(id, name)),
    ...incomingDescriptors
      .filter((descriptor) => {
        const counts = byDivision.get(descriptor.id);
        return counts !== undefined && counts.seated + counts.waitlisted > 0;
      })
      .map((descriptor) => toProgram(descriptor.id, String(descriptor.name), { incoming: true })),
  ];
}

/**
 * The divisions a player's age is counted against (E3b): one for each program of the file, with the
 * rules saved for it (the selected program's from `savedDivision`, the others' from their division
 * rows), then every other division of the season, however few registrants the file has in it (none,
 * for a U4 that only takes older 2-year-olds): a window is the season's rule, and a player whose birth
 * date is in one belongs there, as the import counted their age. A division row is a program's when
 * the program is its id or name, so the same division is never described twice.
 *
 * @returns {{ divisionDescriptors: Array<Object>, otherDescriptors: Array<Object> }}
 */
function buildDivisionDescriptors({ programs, divisionRows, selectedProgramKey, savedDivision }) {
  const programRowIds = new Set();
  const programDescriptors = programs.map((program) => {
    const programKey = String(program.id);
    const row =
      selectedProgramKey !== null && programKey === selectedProgramKey
        ? savedDivision
        : findDivisionRowForProgram(program, divisionRows ?? []);
    if (row?.id) programRowIds.add(String(row.id));
    return {
      id: programKey,
      name: program.name,
      min_age: row?.min_age ?? null,
      max_age: row?.max_age ?? null,
      gender_policy: row?.gender_policy ?? null,
      // A birth date in a division's window counts as that division's age (E3b).
      birthdate_start: row?.birthdate_start ?? null,
      birthdate_end: row?.birthdate_end ?? null,
    };
  });
  const otherDescriptors = (divisionRows ?? [])
    .filter((row) => row?.id && !programRowIds.has(String(row.id)))
    .map((row) => ({
      id: String(row.id),
      name: row.name,
      min_age: row.min_age ?? null,
      max_age: row.max_age ?? null,
      gender_policy: row.gender_policy ?? null,
      birthdate_start: row.birthdate_start ?? null,
      birthdate_end: row.birthdate_end ?? null,
    }));
  return { divisionDescriptors: [...programDescriptors, ...otherDescriptors], otherDescriptors };
}

function positiveIntegerOrFallback(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function deriveProgramStats(program, config = {}) {
  const maxRosterSize = positiveIntegerOrFallback(config.maxRosterSize, DEFAULT_MAX_ROSTER_SIZE);
  // The count generation will build from the registered players and the head coaches the import
  // names, by the generator's own rule, so the overview and the settings panel agree with it.
  // Empty limits mean what they mean to the generator: no minimum, a target equal to the maximum
  // (an empty maximum is refused; the overview shows no estimate then).
  // A program whose registrants are all waitlisted has nobody to seat: generation builds no team.
  const estimatedTeams =
    program.playerCount === 0
      ? 0
      : resolveTeamCount({
          playerCount: program.playerCount,
          coachCount: program.coachCount ?? 0,
          maxRosterSize,
          targetTeamSize: positiveIntegerOrFallback(config.targetTeamSize, null),
          teamCountOverride: positiveIntegerOrFallback(config.teamCountOverride, null),
          minTeams: positiveIntegerOrFallback(config.minTeams, null),
          maxTeams: positiveIntegerOrFallback(config.maxTeams, null),
          minRosterSize: positiveIntegerOrFallback(config.minRosterSize, null),
        });
  // The settings panel's advice, for the overview's recommended count and status: the same
  // call the panel makes, with the config as the admin left it (an empty maximum is "blocked").
  const assessment = assessTeamCount({
    playerCount: program.playerCount,
    coachCount: program.coachCount ?? 0,
    teamCountOverride: config.teamCountOverride,
    minRosterSize: config.minRosterSize,
    maxRosterSize: config.maxRosterSize,
    targetTeamSize: config.targetTeamSize,
    minTeams: config.minTeams,
    maxTeams: config.maxTeams,
  });

  return {
    ...program,
    estimatedTeams,
    assessment,
    avgRosterSize:
      estimatedTeams > 0 ? Number((program.playerCount / estimatedTeams).toFixed(1)) : 0,
    capacity: estimatedTeams * maxRosterSize,
  };
}

function findDivisionRowForProgram(program, divisionRows) {
  if (!program) return null;
  const rows = divisionRows || [];
  const programId = String(program.id || '')
    .trim()
    .toLowerCase();
  const programName = String(program.name || '')
    .trim()
    .toLowerCase();

  return (
    rows.find(
      (row) =>
        String(row.id || '')
          .trim()
          .toLowerCase() === programId
    ) ||
    rows.find(
      (row) =>
        String(row.name || '')
          .trim()
          .toLowerCase() === programName
    ) ||
    rows.find(
      (row) =>
        String(row.name || '')
          .trim()
          .toLowerCase() === programId
    ) ||
    null
  );
}

/** The division columns the teaming rules read (`plays_games` is added when it exists, D2;
 *  `program_id` when it exists, E2). The age band and gender are what a player's own age division
 *  is found by (play-up by request), and the birth-date window takes every player born in it as
 *  the division's age (E3b), so a division with a window counts as the import counted it. */
const DIVISION_SETTING_COLUMNS =
  'id, organization_id, season_settings_id, name, max_roster_size, min_roster_size, ' +
  'target_team_size, team_count_override, min_teams, max_teams, min_age, max_age, gender_policy, ' +
  'birthdate_start, birthdate_end';

function configFromDivisionRow(divisionRow) {
  const defaults = createDefaultConfig();
  if (!divisionRow) return defaults;

  return {
    ...defaults,
    // D2: only a stored division carries its games setting, and only once
    // the column exists; without it the settings offer no games toggle.
    ...(typeof divisionRow.plays_games === 'boolean'
      ? { playsGames: divisionRow.plays_games }
      : {}),
    // Phase D PR B: likewise the practice settings, once their columns exist. A length of
    // `null` is "any slot length".
    ...(typeof divisionRow.practices_per_week === 'number'
      ? {
          practicesPerWeek: divisionRow.practices_per_week,
          practiceMinutes: divisionRow.practice_minutes ?? null,
        }
      : {}),
    targetTeamSize: divisionRow.target_team_size ?? defaults.targetTeamSize,
    minRosterSize: divisionRow.min_roster_size ?? defaults.minRosterSize,
    maxRosterSize: divisionRow.max_roster_size ?? defaults.maxRosterSize,
    minTeams: divisionRow.min_teams ?? defaults.minTeams,
    maxTeams: divisionRow.max_teams ?? defaults.maxTeams,
    teamCountOverride: divisionRow.team_count_override ?? defaults.teamCountOverride,
  };
}

function toDivisionConfigPayload({ program, config, organizationId, seasonSettingsId }) {
  return {
    organization_id: organizationId,
    season_settings_id: seasonSettingsId,
    name: program.name || String(program.id),
    max_roster_size: config.maxRosterSize ?? null,
    min_roster_size: config.minRosterSize ?? null,
    target_team_size: config.targetTeamSize ?? null,
    team_count_override: config.teamCountOverride ?? null,
    min_teams: config.minTeams ?? null,
    max_teams: config.maxTeams ?? null,
    // D2: sent only when the division's setting was read (a boolean), so a
    // save before the migration calls the ten-argument writer it has.
    ...(typeof config.playsGames === 'boolean' ? { plays_games: config.playsGames } : {}),
    // Phase D PR B: sent only when the settings were read (a number), for the same reason. The
    // writer keeps a stored length on NULL and clears it on 0, so "any slot length" is sent as 0.
    ...(typeof config.practicesPerWeek === 'number'
      ? {
          practices_per_week: config.practicesPerWeek,
          practice_minutes: config.practiceMinutes ?? 0,
        }
      : {}),
  };
}

function parseBooleanLike(value) {
  return ['true', 'yes', 'y', '1'].includes(
    String(value || '')
      .trim()
      .toLowerCase()
  );
}

// The import columns a play-up request is read from: the stored flag first (an admin may have
// set or cleared it on the record), then the file's column as `canonicalImportKey` stages it.
// Yes, true, 1 and x are a request (`finalize_import_job` reads the same spellings).
const PLAY_UP_KEYS = [
  'play_up_requested',
  'play_up',
  'Play Up',
  'play up',
  'are you coaching so this player can play up a division?',
];

function parsePlayUpRequest(row) {
  const value = firstNonEmpty(row, PLAY_UP_KEYS);
  return ['true', 'yes', 'y', '1', 'x'].includes(
    String(value ?? '')
      .trim()
      .toLowerCase()
  );
}

function normalizeSkillRating(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;

  const text = String(value).trim().toLowerCase();
  if (text === 'advanced') return 5;
  if (text === 'developing') return 3;
  if (text === 'novice') return 1;
  return undefined;
}

// The keys `materialize_import_buddy_pairs` reads (migration 20260503080000), in its order. A
// row's header counts when the import would stage it under one of them (`canonicalImportKey`,
// the alias map the import maps headers with), so "Buddy Request" and "Friend" are read too.
const BUDDY_REQUEST_KEYS = [
  'buddy_request',
  'buddy_id',
  'buddy_external_registration_id',
  'buddy_registration_id',
  'friend_request',
];
const BUDDY_CODE_KEYS = ['mutual_buddy_code', 'buddy_code', 'friend_code'];

function readImportField(row, canonicalKeys) {
  const nonBlank = (value) => value !== undefined && value !== null && String(value).trim() !== '';
  for (const key of canonicalKeys) {
    if (nonBlank(row?.[key])) return String(row[key]).trim();
  }
  for (const [header, value] of Object.entries(row || {})) {
    if (canonicalKeys.includes(canonicalImportKey(header)) && nonBlank(value)) {
      return String(value).trim();
    }
  }
  return null;
}

/** The buddy fields a generator player carries (Phase B1); none when buddy requests are off. */
function buddyFieldsOf(row) {
  const buddyRequest = readImportField(row, BUDDY_REQUEST_KEYS);
  const mutualBuddyCode = readImportField(row, BUDDY_CODE_KEYS);
  const externalId = getPlayerExternalCandidate(row);
  return {
    ...(buddyRequest ? { buddy_request: buddyRequest } : {}),
    ...(mutualBuddyCode ? { mutual_buddy_code: mutualBuddyCode } : {}),
    ...(externalId ? { external_registration_id: String(externalId) } : {}),
  };
}

// What a durable player row holds of a person's identity, buddy request and natural age. The
// Player Record page edits names and the request on `players`, so these win over the import
// rows, which keep what the file said. The stored natural age (admin-focus plan R5) is what
// eligibility reads when a row carries no birth date: no birth date is stored.
const DURABLE_PLAYER_FIELDS =
  'id, external_registration_id, division_id, first_name, last_name, preferred_name, buddy_request, mutual_buddy_code, natural_age, willing_to_coach, years_played, skill_tier, rating, status, play_up_requested';
const IDENTITY_KEYS = ['first_name', 'last_name', 'preferred_name', 'nickname'];
// The headers a coaching answer and years played are read from (`toGeneratorPlayer`), as
// `canonicalImportKey` stages them and as older mock rows spell them.
const COACHING_ANSWER_KEYS = ['willing_to_coach', 'coach_volunteer', 'Willing to Coach'];
const YEARS_PLAYED_KEYS = ['years_played', 'Years Played', 'yearsPlayed'];
// The headers a skill rating is read from (`toGeneratorPlayer`): a number a row already carries,
// which is read whatever the organization's options, and the skill tier as the import stages it
// ('skill_tier') and as older mock rows spell it, which is read only with the Skill Tier option
// on (`toGeneratorPlayer`, `withDurableIdentity`).
const SKILL_NUMBER_KEYS = ['skillRating', 'skill_rating', 'Skill Rating'];
const SKILL_TIER_KEYS = ['skill_tier', 'Skill Tier'];
const SKILL_KEYS_ALL = [...SKILL_NUMBER_KEYS, ...SKILL_TIER_KEYS];
// The import columns a waitlisted registrant is marked by (`finalize_import_job` reads both).
const WAITLIST_KEYS = ['waitlist', 'waitlisted'];
const IDENTITY_CAMEL_KEYS = ['firstName', 'lastName', 'preferredName'];
const LOOKUP_CHUNK = 200;
/** The coach statuses `admin_assign_team_coach` accepts, and so the ones whose child links anchor a team. */
const ANCHORING_COACH_STATUSES = ['active', 'pending-confirmation'];
const LOOKUP_CONCURRENCY = 8;

/**
 * The import row with the durable player's identity and buddy request over it. Every header
 * the import reads as a name or a request is replaced, so a request the admin cleared on the
 * record is cleared here too. The code stays the import's unless the player row holds one.
 * The teaming signals the record holds win too (Phase B6): `willing_to_coach` (what makes a
 * coaching lead, as the import stored it), `years_played`, `skill_tier` (the registration
 * file's, or the evaluations import's, which writes only the record) and the admin's `rating`;
 * and the waitlist: the record's `status` (an admin may have moved the player on or off the waitlist
 * since the file was read) replaces the file's waitlist column. So does the record's
 * `play_up_requested` for the file's play-up column: the admin may have set or cleared it.
 * With `skillTier` (the Skill Tier option) the record's `skill_tier` wins over the file's the
 * same way, whatever column the file's skill came in (the evaluations import writes the record
 * and not the file); a null or blank leaves the file's. Without it the record's tier is not
 * handed on, and `toGeneratorPlayer` does not read the file's.
 */
function withDurableIdentity(row, durable, { skillTier = false } = {}) {
  if (!durable) return row;
  const storedWaitlist = typeof durable.status === 'string';
  const storedLead = typeof durable.willing_to_coach === 'boolean';
  const storedPlayUp = typeof durable.play_up_requested === 'boolean';
  const storedYears = Number.isInteger(durable.years_played);
  // A tier counts as stored when the generator could read one from it: 'advanced', 'developing',
  // 'novice' or a number. A blank, or a word it cannot read, leaves the file's tier in place.
  const storedTier = skillTier && normalizeSkillRating(durable.skill_tier) !== undefined;
  const next = {};
  for (const [header, value] of Object.entries(row || {})) {
    const key = canonicalImportKey(header);
    if (BUDDY_REQUEST_KEYS.includes(key) || IDENTITY_KEYS.includes(key)) continue;
    if (IDENTITY_CAMEL_KEYS.includes(header)) continue;
    if (storedWaitlist && WAITLIST_KEYS.includes(key)) continue;
    if (storedLead && (COACHING_ANSWER_KEYS.includes(key) || COACHING_ANSWER_KEYS.includes(header)))
      continue;
    if (storedPlayUp && (PLAY_UP_KEYS.includes(key) || PLAY_UP_KEYS.includes(header))) continue;
    if (storedYears && (YEARS_PLAYED_KEYS.includes(key) || YEARS_PLAYED_KEYS.includes(header)))
      continue;
    if (storedTier && [key, header].some((name) => SKILL_KEYS_ALL.includes(name))) continue;
    next[header] = value;
  }
  if (storedWaitlist) next.waitlist = durable.status === 'waitlist';
  if (storedLead) next.willing_to_coach = durable.willing_to_coach;
  if (storedPlayUp) next.play_up_requested = durable.play_up_requested ? 'yes' : 'no';
  if (storedYears) next.years_played = durable.years_played;
  if (storedTier) next.skill_tier = durable.skill_tier;
  if (Number.isFinite(durable.rating)) next.rating = durable.rating;
  // A name the player row lacks (a mock row, a partial select) keeps the import's.
  next.first_name =
    durable.first_name ?? firstNonEmpty(row, ['first_name', 'First Name', 'firstName']) ?? '';
  next.last_name =
    durable.last_name ?? firstNonEmpty(row, ['last_name', 'Last Name', 'lastName']) ?? '';
  if (durable.preferred_name) next.preferred_name = durable.preferred_name;
  if (durable.buddy_request) next.buddy_request = durable.buddy_request;
  if (durable.mutual_buddy_code) next.mutual_buddy_code = durable.mutual_buddy_code;
  if (Number.isFinite(durable.natural_age)) next.natural_age = durable.natural_age;
  return next;
}

/** Stored players by id and by external registration id, for `matchDurablePlayer`. */
function indexDurablePlayers(durablePlayers) {
  return {
    byId: new Map(durablePlayers.map((player) => [String(player.id), player])),
    byExternalId: new Map(
      durablePlayers
        .filter((player) => player.external_registration_id)
        .map((player) => [String(player.external_registration_id), player])
    ),
  };
}

/** The stored player an import row is: by its id when that is a UUID, else by registration id. */
function matchDurablePlayer(row, byId, byExternalId) {
  const idCandidate = getPlayerIdCandidate(row);
  const externalCandidate = getPlayerExternalCandidate(row);
  return (
    (isUuid(idCandidate) && byId.get(idCandidate)) ||
    (externalCandidate && byExternalId.get(externalCandidate)) ||
    null
  );
}

/**
 * Does the row mark a registrant as waitlisted? The one place the page decides it: what generation
 * seats and what the advice counts (both through `toGeneratorPlayer`, by way of `placeImportRows`)
 * ask here, so the two cannot disagree. The row is the file's, or the file's with the stored status
 * over it (`withDurableIdentity`).
 */
function isWaitlistedRow(row) {
  return WAITLIST_KEYS.some((key) => parseBooleanLike(row?.[key]));
}

/** No stored players are known: the read has not arrived, or it was refused. */
const NO_DURABLE_PLAYERS = /** @type {any[]} */ ([]);

/**
 * Where each row of the file plays: THE one place the page asks core's placement
 * (`applyPlayUpEligibility`), so the advice, the divisions that gain players and the players
 * generation takes in from other divisions cannot drift apart (a census test fails a second call in
 * `frontend/src`; play-down plan, 2026-11-03, PR 1).
 *
 * Each row becomes the generator player generation builds (`toGeneratorPlayer`, with the stored
 * player's natural age, play-up request and waitlist status over the file's, `withDurableIdentity`,
 * where a stored player matches), and is placed against the season's divisions: in their own age
 * division unless they asked to play up, and in no division when none holds their age
 * (`isEligibilityBlocked`). A player with no age is placed in the division registered (B2). Row ids
 * are made unique (`row-<position>`), because the placement keys its players by id and two rows can
 * share one.
 *
 * With `divisionDescriptors` null (the season's divisions have not been read, so nothing can be
 * judged: a band guessed from a division's name must not decide who is left out) nobody is placed:
 * each player is where they registered.
 *
 * @param {Object} params
 * @param {Array<{ row: any, sourceIndex: number }>} params.entries - the rows, with their positions
 *   in the import
 * @param {any[]} [params.durablePlayers] - the stored players `fetchDurablePlayers` returned
 * @param {boolean} [params.waitlist] - the Waitlist option: a waitlisted row carries
 *   `status: 'waitlist'`, which generation seats nowhere
 * @param {Array<Object>|null} params.divisionDescriptors - `buildDivisionDescriptors`, every
 *   division, or null before they are read
 * @param {any} params.seasonYear - the season's rule, as the page reads it
 * @param {any} params.cutoffMode
 * @param {any} params.cutoffMonth
 * @param {any} params.cutoffDay
 * @returns {Array<Object>} the players, in the order of `entries`
 */
function placeImportRows({
  entries,
  durablePlayers = NO_DURABLE_PLAYERS,
  waitlist = false,
  divisionDescriptors,
  seasonYear,
  cutoffMode,
  cutoffMonth,
  cutoffDay,
}) {
  const { byId, byExternalId } = indexDurablePlayers(durablePlayers);
  const players = entries.map(({ row, sourceIndex }) => {
    const durable = matchDurablePlayer(row, byId, byExternalId);
    const generationRow = durable ? withDurableIdentity(row, durable) : row;
    return {
      ...toGeneratorPlayer(generationRow, sourceIndex, resolveDivisionId(row), { waitlist }),
      id: `row-${sourceIndex}`,
    };
  });
  if (divisionDescriptors === null) return players;
  return applyPlayUpEligibility({
    players,
    divisions: divisionDescriptors,
    seasonYear,
    cutoffMode,
    cutoffMonth,
    cutoffDay,
  }).players;
}

/**
 * Durable players by id and by external registration id, in chunks (a long `in` list is a
 * long URL), at most eight requests at a time. A refused read throws.
 * Players belong to one season (20261108010000), and a registration id is unique within a
 * season only, so both lookups are of the season the run is for.
 * @param {string} organizationId
 * @param {string} seasonId
 * @param {{ ids?: string[], externalIds?: string[], divisionId?: string | null }} keys
 *   `divisionId` narrows the external-id lookup to one division.
 */
async function fetchDurablePlayers(
  organizationId,
  seasonId,
  { ids = [], externalIds = [], divisionId = null }
) {
  if (!seasonId) throw new Error('Select a season before looking up its players.');
  const queries = [];
  for (let start = 0; start < ids.length; start += LOOKUP_CHUNK) {
    const chunk = ids.slice(start, start + LOOKUP_CHUNK);
    queries.push(() =>
      supabase
        .from('players')
        .select(DURABLE_PLAYER_FIELDS)
        .eq('organization_id', organizationId)
        .eq('season_settings_id', seasonId)
        .in('id', chunk)
    );
  }
  for (let start = 0; start < externalIds.length; start += LOOKUP_CHUNK) {
    const chunk = externalIds.slice(start, start + LOOKUP_CHUNK);
    queries.push(() => {
      const query = supabase
        .from('players')
        .select(DURABLE_PLAYER_FIELDS)
        .eq('organization_id', organizationId)
        .eq('season_settings_id', seasonId);
      return (divisionId ? query.eq('division_id', divisionId) : query).in(
        'external_registration_id',
        chunk
      );
    });
  }
  const players = [];
  for (let start = 0; start < queries.length; start += LOOKUP_CONCURRENCY) {
    const results = await Promise.all(
      queries.slice(start, start + LOOKUP_CONCURRENCY).map((run) => run())
    );
    for (const { data, error } of results) {
      if (error) throw error;
      players.push(...(data || []));
    }
  }
  return players;
}

/**
 * The names of the coaches a review flags, by id. A read that fails is logged and the review
 * says "name not loaded": the flag stands without the name, and a name is not worth stopping
 * a run for.
 * @param {string} organizationId
 * @param {string} seasonId coaches belong to one season (20261108010000): the run's
 * @param {string[]} coachIds
 * @returns {Promise<Record<string, string>>}
 */
async function readCoachNames(organizationId, seasonId, coachIds) {
  /** @type {Record<string, string>} */
  const names = {};
  for (let start = 0; start < coachIds.length; start += LOOKUP_CHUNK) {
    const { data, error } = await supabase
      .from('coaches')
      .select('id, full_name')
      .eq('organization_id', organizationId)
      .eq('season_settings_id', seasonId)
      .in('id', coachIds.slice(start, start + LOOKUP_CHUNK));
    if (error) {
      logger.error('[TeamAnalysis] coach names could not be read:', error);
      return names;
    }
    for (const row of data || []) {
      const name = String(row.full_name ?? '').trim();
      if (name) names[String(row.id)] = name;
    }
  }
  return names;
}

/**
 * The ids, of the coaches given, that may anchor a team: those `admin_assign_team_coach` would
 * assign a team to, status `active` or `pending-confirmation` (20260503050000). A link of a coach
 * who is `inactive` or `interested` stays on file -- the coach import writes it whatever the
 * status, so re-activating the coach restores the anchor -- but teaming does not read it. Not
 * guarded, as the link read above it is not (Phase B3): a refused read stops the run.
 * A coach of another season anchors nothing here: coaches belong to one season (20261108010000).
 * @param {string} organizationId
 * @param {string} seasonId
 * @param {string[]} coachIds
 * @returns {Promise<Set<string>>}
 */
async function readAnchoringCoachIds(organizationId, seasonId, coachIds) {
  const anchoring = new Set();
  for (let start = 0; start < coachIds.length; start += LOOKUP_CHUNK) {
    const { data, error } = await supabase
      .from('coaches')
      .select('id, status')
      .eq('organization_id', organizationId)
      .eq('season_settings_id', seasonId)
      .in('id', coachIds.slice(start, start + LOOKUP_CHUNK));
    if (error) {
      throw new Error(
        `Could not read the coaches' status, so teams were not generated: ${
          error.message || 'the read was refused'
        }.`
      );
    }
    for (const row of data || []) {
      if (ANCHORING_COACH_STATUSES.includes(row.status)) anchoring.add(String(row.id));
    }
  }
  return anchoring;
}

/** A roster entry buddy requests are matched against: identity only. */
function toBuddyRosterEntry(row, id, division) {
  return {
    id: String(id),
    division: String(division),
    firstName: firstNonEmpty(row, ['first_name', 'First Name', 'firstName']) || '',
    lastName: firstNonEmpty(row, ['last_name', 'Last Name', 'lastName']) || '',
    preferredName:
      firstNonEmpty(row, ['preferred_name', 'Preferred Name', 'preferredName', 'nickname']) || '',
    ...buddyFieldsOf(row),
  };
}

/** Years played as the import stores it: a whole number from 0 to 30, else none. */
function parseYearsPlayed(value) {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  if (!/^[0-9]{1,2}$/.test(text)) return undefined;
  const years = Number(text);
  return years <= 30 ? years : undefined;
}

/**
 * A generator player from an import row (the durable player's fields over it). With
 * `coachingLeads` (the Coaching Interest flag) a player whose parent volunteers to coach is a
 * coaching lead, `isCoachingLead` (Phase B6). A lead is not a coach: only a coach linked to a
 * child through `coach_team_requests` anchors a team (`prepareTeamingInput`); a coach the row
 * names (`coach_id`, `coach_email`) does not (owner decision 8a, 2026-10-27: the coach import
 * writes the links, from the children it names). With `waitlist` (the
 * Waitlist flag) a player the row marks as waitlisted carries `status: 'waitlist'`, which the
 * generator seats nowhere and leaves out of the league-wide averages. With `skillTier` (the
 * Skill Tier flag) the row's skill tier counts as a skill rating (novice 1, developing 3,
 * advanced 5); without it only a number the row already carries as one does, so a tier the file
 * holds does not steer the teams of an organization that has not asked for it.
 */
function toGeneratorPlayer(
  row,
  sourceIndex,
  division,
  { buddyRequests = false, coachingLeads = false, waitlist = false, skillTier = false } = {}
) {
  const id = String(
    firstNonEmpty(row, [
      'id',
      'player_id',
      'playerId',
      'external_registration_id',
      'gotsport_id',
      'registration_id',
    ]) || sourceIndex
  );
  const firstName = firstNonEmpty(row, ['first_name', 'First Name', 'firstName']) || '';
  const lastName = firstNonEmpty(row, ['last_name', 'Last Name', 'lastName']) || '';
  const skillRating = normalizeSkillRating(
    firstNonEmpty(row, skillTier ? SKILL_KEYS_ALL : SKILL_NUMBER_KEYS)
  );
  const isWaitlisted = waitlist && isWaitlistedRow(row);
  const isCoachingLead =
    coachingLeads && COACHING_ANSWER_KEYS.some((key) => isCoachingLeadAnswer(row?.[key]));
  const yearsPlayed = parseYearsPlayed(firstNonEmpty(row, YEARS_PLAYED_KEYS));
  // The admin's 1-5 rating, from the player record (`withDurableIdentity`; `rating` is not on
  // the import allowlist, so an import row carries none); a blank is none.
  const ratingValue = firstNonEmpty(row, ['rating']);
  const rating = ratingValue === null ? NaN : Number(ratingValue);
  // Carry the DOB, else the natural age, and play-up signals so the play-up/play-down classifier
  // has an age to work with (without these every player resolves to "unknown"). The DOB is the
  // file's, which only the import session's rows carry: it is counted in the page's season, as
  // before R5. A row without one carries the stored player's natural age (or the one
  // import-validation returned), counted in the season of its import; no birth date is stored.
  const naturalAge = Number(firstNonEmpty(row, ['natural_age', 'naturalAge']));
  const dateOfBirth = firstNonEmpty(row, ['date_of_birth', 'DOB', 'Birthdate', 'dob', 'birthdate']);
  const playUpRequested = parsePlayUpRequest(row);

  return {
    id,
    division,
    firstName,
    lastName,
    name: `${firstName} ${lastName}`.trim() || 'Unnamed Player',
    ...(dateOfBirth
      ? { date_of_birth: dateOfBirth }
      : Number.isInteger(naturalAge) && naturalAge > 0
        ? { naturalAge }
        : {}),
    ...(playUpRequested ? { play_up_requested: true } : {}),
    ...(skillRating !== undefined ? { skillRating } : {}),
    ...(Number.isFinite(rating) ? { rating } : {}),
    ...(yearsPlayed !== undefined ? { years_played: yearsPlayed } : {}),
    ...(isWaitlisted ? { status: 'waitlist' } : {}),
    ...(isCoachingLead ? { isCoachingLead: true } : {}),
    ...(buddyRequests ? buddyFieldsOf(row) : {}),
  };
}

function getTeamReviewStorageKey(organizationId, seasonSettingsId) {
  if (!organizationId || !seasonSettingsId) return null;
  return `squadlogic:team-review:${organizationId}:${seasonSettingsId}`;
}

function resolveImportedPlayerName(row) {
  const firstName = firstNonEmpty(row, ['first_name', 'First Name', 'firstName']) || '';
  const lastName = firstNonEmpty(row, ['last_name', 'Last Name', 'lastName']) || '';
  return `${firstName} ${lastName}`.trim() || 'Unnamed Player';
}

function getPlayerIdCandidate(row) {
  return firstString(row, ['id', 'player_id', 'playerId']);
}

function getPlayerExternalCandidate(row) {
  return (
    getPlayerExternalId(row) ||
    (isUuid(getPlayerIdCandidate(row)) ? null : getPlayerIdCandidate(row))
  );
}

function collectPlayerLookupKeys(rowsForProgram) {
  const ids = new Set();
  const externalIds = new Set();

  rowsForProgram.forEach(({ row }) => {
    const idCandidate = getPlayerIdCandidate(row);
    const externalCandidate = getPlayerExternalCandidate(row);
    if (isUuid(idCandidate)) ids.add(idCandidate);
    if (externalCandidate) externalIds.add(externalCandidate);
  });

  return {
    ids: [...ids],
    externalIds: [...externalIds],
  };
}

/**
 * Why a run built no teams. A division whose every player is blocked builds none (Phase B2), and
 * the players are imported: say they are not eligible, and name some. Otherwise the generic
 * reason, with how many of the players were not eligible when some were.
 */
function noTeamsMessage(programName, preparedPlayers, result) {
  const blocked = Object.values(result.overflowByDivision || {})
    .flat()
    .filter((entry) => entry?.reason === TEAM_GENERATION.REASON_EligibilityBlocked)
    .flatMap((entry) => entry.players || []);
  const names = (players) => {
    const shown = players.slice(0, 3).map((player) => player.name || String(player.id));
    const more = players.length - shown.length;
    return `${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
  };
  if (blocked.length > 0 && blocked.length >= preparedPlayers.length) {
    return `No teams could be generated for ${programName}: none of its players is eligible for the division (each plays down, or plays up without a coaching parent or a coach's child as a buddy). Not eligible (${blocked.length}): ${names(blocked)}. Check their age groups and the division's age band.`;
  }
  const notEligible =
    blocked.length > 0
      ? ` ${blocked.length} of its ${preparedPlayers.length} players are not eligible for the division: ${names(blocked)}.`
      : '';
  const waitlisted = Object.values(result.overflowByDivision || {})
    .flat()
    .filter((entry) => entry?.reason === TEAM_GENERATION.REASON_Waitlisted)
    .flatMap((entry) => entry.players || []);
  const onWaitlist =
    waitlisted.length > 0
      ? ` ${waitlisted.length} of its ${preparedPlayers.length} players are on the waitlist, which no team seats: ${names(waitlisted)}.`
      : '';
  return `No teams could be generated for ${programName}. Check that players are imported for this division and that the roster settings allow at least one team.${notEligible}${onWaitlist}`;
}

export default function TeamAnalysisPage() {
  // No `timezone` here: the one consumer was `TeamOverviewPanel`, which
  // deliberately renders its `generatedAt` on the viewer's clock and no longer
  // declares the prop. `useDashboardData` does not return a `timezone` either,
  // so the binding was `undefined` in every render this page has ever had.
  // `useDashboardData` also returns an `error` (it used to swallow all three
  // fetch failures). The comment that used to sit here deferred reading it —
  // "this page has no data-error surface to put it on ... is its own unit" —
  // and this is that unit. The surface is `DataErrorBanner`, the one
  // `WorkflowPage` already had, now shared.
  //
  // The deferred note was right about where it does NOT belong, and that part
  // still holds: `validationErrors` below is a pre-generation gate ("select a
  // program", "missing roster"), and a transient RLS refusal on the *last team
  // run* is not a reason to block generating new teams. So the banner is its
  // own element above the header and `validationErrors` is left alone.
  //
  // This page reads `team` only, but `error` is the hook's aggregate over all
  // three reads, so a refused `practice` or `game` read opens the banner over
  // a teaming analysis that loaded correctly. Over-reporting rather than the
  // silence this PR removes; the fix is per-source errors on the hook, which
  // this change was scoped not to touch. Named in the PR.
  const { team, loading, errors } = useDashboardData();
  // The one source this page renders. The hook's aggregate `error` would
  // raise an assertive alert here for a refused practice or game read, about
  // rows this page does not show.
  const dataError = errors.team;
  const {
    persistenceSnapshot,
    loading: persistenceLoading,
    refresh: refreshPersistence,
  } = useTeamPersistence();
  const { importedData } = useImport();
  const { currentOrganization, currentSeasonSetting, permissions = [] } = useOrganization();
  const { session, user: authUser } = useAuth();
  const { features, isEnabled, buddyRule } = useFeatures();
  const buddyRequestsEnabled = isEnabled(FEATURE_FLAGS.BUDDY_REQUESTS);
  const coachingInterestEnabled = isEnabled(FEATURE_FLAGS.COACHING_INTEREST);
  const waitlistEnabled = isEnabled(FEATURE_FLAGS.WAITLIST);
  const skillTierEnabled = isEnabled(FEATURE_FLAGS.SKILL_TIER);
  const [isEditMode, setIsEditMode] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [manualTeams, setManualTeams] = useState(null);
  const [manualSaveState, setManualSaveState] = useState('idle');
  const [manualSaveMessage, setManualSaveMessage] = useState('');
  const [selectedProgramId, setSelectedProgramId] = useState(null);
  const [configs, setConfigs] = useState({});
  const [generationError, setGenerationError] = useState(null);
  const [reviewMessage, setReviewMessage] = useState('');
  // The polite live region's text: set once per generation, when a review is staged, so the
  // lists are announced once rather than on every remount of the view that shows them.
  const [placementAnnouncement, setPlacementAnnouncement] = useState('');
  const [stagedReview, setStagedReview] = useState(null);
  const [divisionRows, setDivisionRows] = useState(null);
  // Whether `divisionRows` is what the season's divisions read returned. It is `[]` while nothing was
  // read as well (no season yet, or the read failed: `divisionSettingsError` says so), so `[]` alone
  // cannot tell a season with no divisions from a read that gave none. Only a read that worked sets this.
  const [divisionsRead, setDivisionsRead] = useState(false);
  // The season's programs (E2), read to group the overview. Empty before the migration, when the
  // read fails, or for a league that never made one: the overview is then a flat list.
  const [seasonPrograms, setSeasonPrograms] = useState([]);
  const [divisionSettingsError, setDivisionSettingsError] = useState(null);
  const [savingConfigId, setSavingConfigId] = useState(null);
  const [configSaveMessage, setConfigSaveMessage] = useState('');
  const [deletedTeamIds, setDeletedTeamIds] = useState(new Set());
  const [renamingTeamId, setRenamingTeamId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [renamedTeams, setRenamedTeams] = useState({});
  const loadedReviewKeyRef = useRef(null);
  const navigate = useNavigate();
  // A completed season is history: no teams are generated, edited or saved in it (the database
  // refuses the write too, `season_completed`).
  const seasonReadOnly = useSeasonReadOnly();
  const canManageTeams =
    !seasonReadOnly &&
    (permissions.includes(PERMISSIONS.MANAGE_ALL_TEAMS) ||
      permissions.includes(PERMISSIONS.MANAGE_ORGANIZATION));
  const canEditTeams = canManageTeams && isEditMode;

  const importedPlayerRows = useMemo(() => getImportedRows(importedData), [importedData]);
  // The stored players of the file, for the advice (follow-ups F1, item 3; data follow-ups, item 2).
  // The record wins over the file where generation lets it: the status (a buddy taken off the
  // waitlist is active in the record while the file still marks them), and the natural age and the
  // play-up request that decide whether a division can hold the player. So the stored players of the
  // file are read once per import, whatever the league's options, as generation reads them. Until
  // they arrive, and if they cannot be read (logged; generation re-reads and stops on a refused
  // read), the file's own columns are used.
  const [storedPlayers, setStoredPlayers] = useState(
    /** @type {null | { rows: any[], durable: any[] }} */ (null)
  );
  // Bumped when this page changes stored statuses itself (players taken off the waitlist are made
  // active on save), so the advice reads the record again rather than the one it read on load.
  const [waitlistReadKey, setWaitlistReadKey] = useState(0);
  useEffect(() => {
    if (importedPlayerRows.length === 0 || !currentOrganization?.id || !currentSeasonSetting?.id) {
      setStoredPlayers(null);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const durable = await fetchDurablePlayers(
          currentOrganization.id,
          currentSeasonSetting.id,
          collectPlayerLookupKeys(
            importedPlayerRows.map((row, sourceIndex) => ({ row, sourceIndex }))
          )
        );
        if (!cancelled) setStoredPlayers({ rows: importedPlayerRows, durable });
      } catch (error) {
        logger.error(
          `[TeamAnalysis] the stored players could not be read (${error?.message ?? 'the read was refused'}); the overview counts the file's waitlist column and ages instead:`,
          error
        );
        if (!cancelled) setStoredPlayers(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [importedPlayerRows, currentOrganization?.id, currentSeasonSetting?.id, waitlistReadKey]);
  const durablePlayers =
    storedPlayers?.rows === importedPlayerRows ? storedPlayers.durable : NO_DURABLE_PLAYERS;
  // The season's rule for a player's age, as generation reads it, and the divisions the age is
  // placed against (E3b).
  const seasonYearSetting = currentSeasonSetting?.season_year;
  const cutoffModeSetting = currentSeasonSetting?.age_cutoff_mode;
  const cutoffMonthSetting = currentSeasonSetting?.age_cutoff_month;
  const cutoffDaySetting = currentSeasonSetting?.age_cutoff_day;
  const registeredDivisions = useMemo(
    () => registeredDivisionsOf(importedPlayerRows),
    [importedPlayerRows]
  );
  // The advice is for the players generation seats, so it counts every registrant in the division
  // they PLAY in (play-down plan, PR 1): the waitlisted and the registrants no division can hold are
  // seated on no team, so the advice leaves them out, and a player moved to their own age division
  // counts where they play, not where they registered. One placement of every row, by generation's
  // own function (`placeImportRows`), then one count of the seats (`summarizeSeats`). Nobody is placed
  // until the season's divisions have been read (`divisionsRead`: not while they load, not when the
  // read failed, not with no season): without their saved age bands a band is guessed from each
  // division's name, and a guess must not decide who is left out or moved. A read that worked and
  // returned no divisions is still judged by the names, as generation judges it. The advice is what it
  // was until then: everyone where they registered, less the waitlisted.
  // Every division a player's age is counted against, once the season's divisions have been read; the
  // same set the Play-up section judges a run's listing by, so the two cannot be given different bands.
  const descriptorSet = useMemo(
    () =>
      divisionsRead
        ? buildDivisionDescriptors({
            programs: registeredDivisions,
            divisionRows,
            selectedProgramKey: null,
            savedDivision: null,
          })
        : { divisionDescriptors: null, otherDescriptors: [] },
    [divisionsRead, registeredDivisions, divisionRows]
  );
  const placement = useMemo(() => {
    const entries = importedPlayerRows.map((row, sourceIndex) => ({ row, sourceIndex }));
    const { divisionDescriptors, otherDescriptors } =
      importedPlayerRows.length > 0
        ? descriptorSet
        : { divisionDescriptors: null, otherDescriptors: [] };
    const placed = placeImportRows({
      entries,
      durablePlayers,
      waitlist: waitlistEnabled,
      divisionDescriptors,
      seasonYear: seasonYearSetting,
      cutoffMode: cutoffModeSetting,
      cutoffMonth: cutoffMonthSetting,
      cutoffDay: cutoffDaySetting,
    });
    return { placed, divisionDescriptors, otherDescriptors };
  }, [
    descriptorSet,
    importedPlayerRows,
    durablePlayers,
    waitlistEnabled,
    seasonYearSetting,
    cutoffModeSetting,
    cutoffMonthSetting,
    cutoffDaySetting,
  ]);
  // The count of those seats, by division, by program and for the league. A division is in a program
  // of the league's own, or in none (the same rule as the overview's headings, `ownProgramIdOf`), so a
  // program's counts are the sum of the divisions under its heading. `checked` is false until the
  // divisions have been read: no age band is known then, and the flags say so rather than "None".
  const seatCount = useMemo(() => {
    const { placed, divisionDescriptors, otherDescriptors } = placement;
    const divisions = (divisionDescriptors ?? []).map((descriptor) => ({
      ...descriptor,
      program_id: ownProgramIdOf(
        findDivisionRowForProgram(descriptor, divisionRows ?? [])?.program_id,
        seasonPrograms
      ),
    }));
    const { byDivision, byProgram, league } = summarizeSeats({
      seats: seatsFromPlacedPlayers(placed),
      divisions,
    });
    return {
      byDivision,
      byProgram,
      league,
      otherDescriptors,
      checked: divisionDescriptors !== null,
    };
  }, [placement, divisionRows, seasonPrograms]);
  const basePrograms = useMemo(
    () =>
      derivePrograms({
        registeredDivisions,
        byDivision: seatCount.byDivision,
        incomingDescriptors: seatCount.otherDescriptors,
        checked: seatCount.checked,
      }),
    [registeredDivisions, seatCount]
  );

  const reviewStorageKey = useMemo(
    () => getTeamReviewStorageKey(currentOrganization?.id, currentSeasonSetting?.id),
    [currentOrganization?.id, currentSeasonSetting?.id]
  );
  const programs = useMemo(
    () =>
      basePrograms.map((program) =>
        deriveProgramStats(program, configs[program.id] || createDefaultConfig())
      ),
    [basePrograms, configs]
  );

  useEffect(() => {
    setConfigs({});
    setConfigSaveMessage('');
    setManualTeams(null);
    setManualSaveMessage('');
    setIsEditMode(false);
  }, [currentOrganization?.id, currentSeasonSetting?.id]);

  useEffect(() => {
    loadedReviewKeyRef.current = reviewStorageKey;
    // Another organization's or season's review: what was announced was about the last one.
    setPlacementAnnouncement('');
    if (!reviewStorageKey || typeof sessionStorage === 'undefined') {
      setStagedReview(null);
      return;
    }

    try {
      const storedReview = sessionStorage.getItem(reviewStorageKey);
      setStagedReview(storedReview ? JSON.parse(storedReview) : null);
    } catch {
      setStagedReview(null);
    }
  }, [reviewStorageKey]);

  useEffect(() => {
    if (
      !reviewStorageKey ||
      loadedReviewKeyRef.current !== reviewStorageKey ||
      typeof sessionStorage === 'undefined'
    ) {
      return;
    }

    if (stagedReview) {
      sessionStorage.setItem(reviewStorageKey, JSON.stringify(stagedReview));
    } else {
      sessionStorage.removeItem(reviewStorageKey);
    }
  }, [reviewStorageKey, stagedReview]);

  // E2: the divisions under the program each is in, only when the league has a program of its
  // own with one of them in it; otherwise null and the overview is a flat list, no heading.
  const overviewGroups = useMemo(() => {
    const groups = groupByProgram({
      items: programs,
      programIdOf: (program) => findDivisionRowForProgram(program, divisionRows ?? [])?.program_id,
      programs: seasonPrograms,
    });
    // Each heading carries its program's play-up and play-down counts (a program with no count is not
    // shown as zero: the heading says it is not checked).
    return (
      groups?.map((group) => {
        const counts = seatCount.byProgram.get(group.key === NO_PROGRAM_KEY ? null : group.key);
        return {
          ...group,
          flags: counts ? flagCountsOf(counts, seatCount.checked) : { checked: false },
        };
      }) ?? null
    );
  }, [programs, divisionRows, seasonPrograms, seatCount]);
  const leagueFlags = useMemo(
    () => (programs.length > 0 ? flagCountsOf(seatCount.league, seatCount.checked) : null),
    [programs.length, seatCount]
  );

  const selectedProgram = useMemo(
    () => programs.find((p) => p.id === selectedProgramId) || programs[0],
    [selectedProgramId, programs]
  );

  useEffect(() => {
    if (basePrograms.length === 0 || divisionRows === null) return;

    setConfigs((prev) => {
      let changed = false;
      const next = { ...prev };

      basePrograms.forEach((program) => {
        if (next[program.id]) return;
        const divisionRow = findDivisionRowForProgram(program, divisionRows);
        next[program.id] = configFromDivisionRow(divisionRow);
        changed = true;
      });

      return changed ? next : prev;
    });
  }, [basePrograms, divisionRows]);

  useEffect(() => {
    const selectedExists = programs.some((program) => program.id === selectedProgramId);
    if (programs.length > 0 && (!selectedProgramId || !selectedExists)) {
      setSelectedProgramId(programs[0].id);
    }
  }, [programs, selectedProgramId]);

  useEffect(() => {
    let cancelled = false;

    const fetchDivisionRows = async () => {
      if (!currentOrganization?.id || !currentSeasonSetting?.id) {
        setDivisionRows([]);
        setDivisionsRead(false);
        setDivisionSettingsError(null);
        return;
      }

      setDivisionRows(null);
      setDivisionsRead(false);
      setDivisionSettingsError(null);
      const readDivisions = (columns) =>
        supabase
          .from('divisions')
          .select(columns)
          .eq('organization_id', currentOrganization.id)
          .eq('season_settings_id', currentSeasonSetting.id)
          .order('name', { ascending: true });
      let { data, error } = await readDivisions(
        `${DIVISION_SETTING_COLUMNS}, plays_games, program_id, practices_per_week, practice_minutes`
      );
      // Phase D PR B: before migration 20261105010000 the practice settings do not exist (42703).
      // They are read without them: the settings offer no practice fields.
      if (!cancelled && error?.code === '42703') {
        ({ data, error } = await readDivisions(
          `${DIVISION_SETTING_COLUMNS}, plays_games, program_id`
        ));
      }
      // D2 and E2: before migration 20261029010000 `plays_games` does not exist, and before
      // 20261101020000 `program_id` does not (42703). The rules are read without them: no
      // division offers the games setting, and none is grouped under a program. Every other
      // error stays an error.
      if (!cancelled && error?.code === '42703') {
        ({ data, error } = await readDivisions(`${DIVISION_SETTING_COLUMNS}, plays_games`));
      }
      if (!cancelled && error?.code === '42703') {
        ({ data, error } = await readDivisions(DIVISION_SETTING_COLUMNS));
      }

      if (cancelled) return;
      if (error) {
        setDivisionRows([]);
        setDivisionsRead(false);
        setDivisionSettingsError(error.message || 'Could not load division settings.');
        return;
      }

      setDivisionRows(data || []);
      setDivisionsRead(true);
      setDivisionSettingsError(null);
    };

    fetchDivisionRows();

    return () => {
      cancelled = true;
    };
  }, [currentOrganization?.id, currentSeasonSetting?.id]);

  useEffect(() => {
    let cancelled = false;
    if (!currentSeasonSetting?.id) {
      setSeasonPrograms([]);
      return undefined;
    }
    (async () => {
      const { data, error } = await supabase
        .from('programs')
        .select('id, name, is_default')
        .eq('season_settings_id', currentSeasonSetting.id);
      if (cancelled) return;
      if (error) {
        // Not shown: grouping is a convenience, and before the migration there is no table.
        logger.warn('[TeamAnalysis] programs not read; the overview is not grouped', {
          code: error.code,
          message: error.message,
        });
        setSeasonPrograms([]);
        return;
      }
      setSeasonPrograms(data || []);
    })();
    return () => {
      cancelled = true;
    };
  }, [currentSeasonSetting?.id]);

  const updateConfig = (programId, patch) => {
    setConfigSaveMessage('');
    setConfigs((prev) => ({
      ...prev,
      [programId]: {
        ...(prev[programId] || {}),
        ...patch,
      },
    }));
  };

  const saveDivisionConfig = useCallback(
    async (program, config, { silent = false } = {}) => {
      if (!program) throw new Error('Select a division before saving rules.');
      if (!currentOrganization?.id) throw new Error('Select an active organization.');
      if (!currentSeasonSetting?.id) throw new Error('Select an active season.');
      if (!canManageTeams) throw new Error('Admin team-management permission is required.');
      if (divisionRows === null) throw new Error('Division settings are still loading.');

      const payload = toDivisionConfigPayload({
        program,
        config,
        organizationId: currentOrganization.id,
        seasonSettingsId: currentSeasonSetting.id,
      });
      const existingRow = findDivisionRowForProgram(program, divisionRows);
      if (existingRow?.id && existingRow.name) {
        payload.name = existingRow.name;
      }

      if (!silent) {
        setSavingConfigId(program.id);
        setConfigSaveMessage('');
      }

      try {
        const { data, error } = await supabase.rpc('admin_upsert_division_settings', {
          p_organization_id: payload.organization_id,
          p_season_settings_id: payload.season_settings_id,
          p_division_id: existingRow?.id || null,
          p_name: payload.name,
          p_max_roster_size: payload.max_roster_size,
          p_min_roster_size: payload.min_roster_size,
          p_target_team_size: payload.target_team_size,
          p_team_count_override: payload.team_count_override,
          p_min_teams: payload.min_teams,
          p_max_teams: payload.max_teams,
          ...(typeof payload.plays_games === 'boolean'
            ? { p_plays_games: payload.plays_games }
            : {}),
          ...(typeof payload.practices_per_week === 'number'
            ? {
                p_practices_per_week: payload.practices_per_week,
                p_practice_minutes: payload.practice_minutes,
              }
            : {}),
        });

        if (error) {
          if (!silent) setConfigSaveMessage(`Save failed: ${error.message}`);
          throw error;
        }

        const savedDivision =
          data ||
          (IS_MOCK_MODE
            ? {
                id: existingRow?.id || `${payload.season_settings_id}:${payload.name}`,
                ...payload,
              }
            : null);

        if (!savedDivision?.id) {
          throw new Error('Division settings save did not return a division row.');
        }

        setDivisionRows((prev) => {
          const withoutCurrent = (prev || []).filter(
            (row) =>
              String(row.id) !== String(savedDivision.id) &&
              !(
                String(row.season_settings_id) === String(savedDivision.season_settings_id) &&
                String(row.name).trim().toLowerCase() ===
                  String(savedDivision.name).trim().toLowerCase()
              )
          );
          return [...withoutCurrent, savedDivision].sort((a, b) =>
            String(a.name).localeCompare(String(b.name))
          );
        });
        setConfigs((prev) => ({
          ...prev,
          [program.id]: configFromDivisionRow(savedDivision),
        }));
        // The auto-scheduler's cached runs were made with the settings as they were: a run for
        // identical teams and slots must not answer for a division whose count just changed.
        edgeFunctionCache.invalidateByPrefix(`auto-scheduler:${currentOrganization.id}:`);
        if (!silent) setConfigSaveMessage('Rules saved.');
        return savedDivision;
      } finally {
        if (!silent) setSavingConfigId(null);
      }
    },
    [canManageTeams, currentOrganization?.id, currentSeasonSetting?.id, divisionRows]
  );

  const validationErrors = useMemo(() => {
    const errors = [];
    const selectedConfig = selectedProgram ? configs[selectedProgram.id] : null;

    if (importedPlayerRows.length === 0) {
      errors.push({ type: 'data', message: 'Missing imported player roster.' });
    }
    if (!currentOrganization?.id) {
      errors.push({ type: 'organization', message: 'Select an active organization.' });
    }
    if (!canManageTeams) {
      errors.push({ type: 'permission', message: 'Admin team-management permission is required.' });
    }
    if (divisionSettingsError) {
      errors.push({ type: 'division-settings', message: divisionSettingsError });
    }
    if (!selectedProgram) {
      errors.push({ type: 'division', message: 'Select a division before generating teams.' });
    }
    if (
      selectedConfig?.minRosterSize &&
      selectedConfig?.maxRosterSize &&
      selectedConfig.minRosterSize > selectedConfig.maxRosterSize
    ) {
      errors.push({
        type: 'roster',
        message: 'Minimum roster size cannot exceed max roster size.',
      });
    }
    if (
      selectedConfig?.minTeams &&
      selectedConfig?.maxTeams &&
      selectedConfig.minTeams > selectedConfig.maxTeams
    ) {
      errors.push({ type: 'teams', message: 'Minimum team count cannot exceed max team count.' });
    }
    if (
      selectedConfig?.teamCountOverride &&
      selectedConfig?.minTeams &&
      selectedConfig.teamCountOverride < selectedConfig.minTeams
    ) {
      errors.push({ type: 'teams', message: 'Override team count cannot be below min teams.' });
    }
    if (
      selectedConfig?.teamCountOverride &&
      selectedConfig?.maxTeams &&
      selectedConfig.teamCountOverride > selectedConfig.maxTeams
    ) {
      errors.push({ type: 'teams', message: 'Override team count cannot exceed max teams.' });
    }
    const hasPracticeSettings = Boolean(selectedConfig) && 'practicesPerWeek' in selectedConfig;
    if (
      hasPracticeSettings &&
      !(
        Number.isInteger(selectedConfig.practicesPerWeek) &&
        selectedConfig.practicesPerWeek >= 0 &&
        selectedConfig.practicesPerWeek <= 7
      )
    ) {
      errors.push({
        type: 'practice-settings',
        message: 'Practices per week must be a whole number from 0 to 7.',
      });
    }
    if (
      hasPracticeSettings &&
      selectedConfig.practiceMinutes != null &&
      !(
        Number.isInteger(selectedConfig.practiceMinutes) &&
        selectedConfig.practiceMinutes >= 15 &&
        selectedConfig.practiceMinutes <= 240
      )
    ) {
      errors.push({
        type: 'practice-settings',
        message:
          'A practice is from 15 to 240 minutes long (or leave it empty for any slot length).',
      });
    }
    if (generationError) {
      errors.push({ type: 'generation', message: generationError });
    }

    return errors;
  }, [
    configs,
    canManageTeams,
    currentOrganization?.id,
    divisionSettingsError,
    generationError,
    importedPlayerRows.length,
    selectedProgram,
  ]);

  const resolveGeneratorPlayers = useCallback(
    async (rowsForProgram, selectedProgramKey, selectedDivisionId) => {
      const { ids, externalIds } = collectPlayerLookupKeys(rowsForProgram);
      const selectedDivisionKey = String(selectedDivisionId || '');
      const [byIdRows, byExternalRows] = await Promise.all([
        fetchDurablePlayers(currentOrganization.id, currentSeasonSetting?.id, { ids }),
        fetchDurablePlayers(currentOrganization.id, currentSeasonSetting?.id, {
          externalIds,
          divisionId: selectedDivisionId,
        }),
      ]);
      const durablePlayers = [...byIdRows, ...byExternalRows];

      const { byId, byExternalId } = indexDurablePlayers(durablePlayers);
      const missingRows = [];
      const generationRows = [];

      const generatorPlayers = rowsForProgram.map(({ row, sourceIndex }) => {
        const matchedPlayer = matchDurablePlayer(row, byId, byExternalId);
        const durablePlayer =
          matchedPlayer &&
          (!selectedDivisionKey || String(matchedPlayer.division_id || '') === selectedDivisionKey)
            ? matchedPlayer
            : null;

        if (!durablePlayer && !IS_MOCK_MODE) {
          missingRows.push(resolveImportedPlayerName(row));
        }

        const rowForGeneration = durablePlayer
          ? {
              ...withDurableIdentity(row, durablePlayer, { skillTier: skillTierEnabled }),
              id: durablePlayer.id,
              player_id: durablePlayer.id,
              division_id: durablePlayer.division_id || row.division_id,
            }
          : row;
        generationRows.push(rowForGeneration);

        return toGeneratorPlayer(rowForGeneration, sourceIndex, selectedProgramKey, {
          buddyRequests: buddyRequestsEnabled,
          coachingLeads: coachingInterestEnabled,
          waitlist: waitlistEnabled,
          skillTier: skillTierEnabled,
        });
      });

      if (missingRows.length > 0) {
        const preview = missingRows.slice(0, 3).join(', ');
        throw new Error(
          `Apply-ready team generation requires durable roster players. Could not match ${missingRows.length} imported row${missingRows.length === 1 ? '' : 's'} to players: ${preview}.`
        );
      }

      return { generatorPlayers, generationRows };
    },
    [
      buddyRequestsEnabled,
      coachingInterestEnabled,
      waitlistEnabled,
      skillTierEnabled,
      currentOrganization?.id,
      currentSeasonSetting?.id,
    ]
  );

  const handleGenerateTeams = useCallback(async () => {
    setIsGenerating(true);
    setGenerationError(null);
    setPlacementAnnouncement('');
    try {
      const user = authUser || session?.user;
      if (!user?.id) throw new Error('Sign in before generating teams.');
      if (!currentOrganization?.id) throw new Error('Select an active organization.');
      if (!canManageTeams) throw new Error('Admin team-management permission is required.');
      if (!selectedProgram) throw new Error('Select a division before generating teams.');
      // Guard the initial-load race: until the persisted history has loaded, persistenceSnapshot is
      // empty and a re-run would look like a first run (draft) and silently regenerate fresh —
      // discarding the saved team UUIDs and manual moves. Make the admin wait the brief load window.
      if (persistenceLoading) {
        throw new Error('Still loading previously saved teams — please try again in a moment.');
      }

      const selectedProgramKey = String(selectedProgram.id);
      const config = configs[selectedProgramKey] || createDefaultConfig();
      const savedDivision = await saveDivisionConfig(selectedProgram, config, { silent: true });
      const rowsForProgram = importedPlayerRows
        .map((row, sourceIndex) => ({ row, sourceIndex }))
        .filter(({ row }) => resolveDivisionId(row) === selectedProgramKey);
      // A division the file has no registrants in has none of its own: its players are the ones its
      // rules take from the other programs, placed below.
      if (rowsForProgram.length === 0 && !selectedProgram.incoming) {
        throw new Error(`No imported players found for ${selectedProgram.name}.`);
      }

      const { generatorPlayers, generationRows } = await resolveGeneratorPlayers(
        rowsForProgram,
        selectedProgramKey,
        savedDivision.id
      );

      // Every imported player outside this program, with the durable player each is (the record's
      // edits over the file's row, where found). They feed the buddy roster, so a request naming
      // someone outside this program is told apart from one naming nobody, and they are who may
      // play in this program's division instead of the one they registered for (a player plays
      // in their own age division unless a play-up was requested).
      const programIndexBySource = new Map(
        rowsForProgram.map((entry, programIndex) => [entry.sourceIndex, programIndex])
      );
      const otherEntries = importedPlayerRows
        .map((row, sourceIndex) => ({ row, sourceIndex }))
        .filter(({ sourceIndex }) => !programIndexBySource.has(sourceIndex));
      const otherDurable =
        otherEntries.length > 0
          ? await fetchDurablePlayers(
              currentOrganization.id,
              currentSeasonSetting?.id,
              collectPlayerLookupKeys(otherEntries)
            )
          : [];
      const { byId: otherById, byExternalId: otherByExternalId } =
        indexDurablePlayers(otherDurable);
      const others = otherEntries.map(({ row, sourceIndex }) => {
        const division = resolveDivisionId(row);
        const durable = matchDurablePlayer(row, otherById, otherByExternalId);
        const identified = withDurableIdentity(row, durable, { skillTier: skillTierEnabled });
        const generationRow = durable
          ? {
              ...identified,
              id: durable.id,
              player_id: durable.id,
              division_id: durable.division_id || row.division_id,
            }
          : row;
        return {
          row,
          sourceIndex,
          division,
          durable,
          identified,
          player: toGeneratorPlayer(generationRow, sourceIndex, division, {
            buddyRequests: buddyRequestsEnabled,
            coachingLeads: coachingInterestEnabled,
            waitlist: waitlistEnabled,
            skillTier: skillTierEnabled,
          }),
        };
      });
      const otherBySource = new Map(others.map((entry) => [entry.sourceIndex, entry]));
      let buddyRoster;
      if (buddyRequestsEnabled) {
        buddyRoster = importedPlayerRows.map((row, sourceIndex) => {
          const programIndex = programIndexBySource.get(sourceIndex);
          if (programIndex !== undefined) {
            return toBuddyRosterEntry(
              generationRows[programIndex],
              generatorPlayers[programIndex].id,
              selectedProgramKey
            );
          }
          const other = otherBySource.get(sourceIndex);
          return toBuddyRosterEntry(
            other.identified,
            other.durable?.id ?? toGeneratorPlayer(other.row, sourceIndex, other.division).id,
            other.division
          );
        });
      }

      // Coach-anchored teaming + play-up/play-down eligibility. Imported coaches
      // (via coach_team_requests) drive which players anchor a coach's team, and
      // a coach-child or qualifying buddy sanctions a play-up. Not guarded (Phase B3): a
      // refused read or a pipeline that throws stops the run here, through the catch below,
      // instead of generating the raw roster with no coach anchors and no eligibility check.
      const { data: coachLinks, error: coachLinksError } = await supabase
        .from('coach_team_requests')
        .select('coach_id, player_id, preferred_co_coach_id')
        .eq('organization_id', currentOrganization.id);
      if (coachLinksError) {
        throw new Error(
          `Could not read the coaches' team links, so teams were not generated: ${
            coachLinksError.message || 'the read was refused'
          }.`
        );
      }
      // Only a coach who is active or pending confirmation anchors a team; an inactive coach's
      // child is placed like any other player and the team is left needing a coach.
      const anchoringCoachIds = await readAnchoringCoachIds(
        currentOrganization.id,
        currentSeasonSetting?.id,
        [...new Set((coachLinks || []).map((link) => String(link.coach_id)))]
      );
      const coachesById = new Map();
      for (const link of coachLinks || []) {
        if (!link.player_id) continue;
        if (!anchoringCoachIds.has(String(link.coach_id))) continue;
        const entry = coachesById.get(link.coach_id) || {
          id: link.coach_id,
          children: [],
          preferred_co_coach_id: link.preferred_co_coach_id || null,
        };
        entry.children.push({ player_id: link.player_id });
        coachesById.set(link.coach_id, entry);
      }
      // Every program of the import is a division a player may play in: the selected program
      // takes its band from the saved row, the others from their division rows (the age band
      // and gender), else from the program's name.
      const { divisionDescriptors } = buildDivisionDescriptors({
        programs,
        divisionRows,
        selectedProgramKey,
        savedDivision,
      });
      // Who plays in this program: everyone who registered in it except a player who plays in
      // their own age division (a play-up nobody requested, a play-down), plus those who
      // registered elsewhere and play here. Placed first, on the file and the records alone, by the
      // page's one placement (`placeImportRows`, the same call the advice makes), so the players of
      // other programs are only read in when they land here.
      const seasonYear = currentSeasonSetting?.season_year;
      const cutoffMode = currentSeasonSetting?.age_cutoff_mode;
      const cutoffMonth = currentSeasonSetting?.age_cutoff_month;
      const cutoffDay = currentSeasonSetting?.age_cutoff_day;
      const placedOthers = placeImportRows({
        entries: others,
        durablePlayers: otherDurable,
        divisionDescriptors,
        seasonYear,
        cutoffMode,
        cutoffMonth,
        cutoffDay,
      });
      const movedIn = others.filter(
        (_entry, index) => String(placedOthers[index].division) === selectedProgramKey
      );
      const unmatchedMovedIn = IS_MOCK_MODE
        ? []
        : movedIn
            .filter((entry) => !entry.durable)
            .map((entry) => resolveImportedPlayerName(entry.row));
      if (unmatchedMovedIn.length > 0) {
        throw new Error(
          `Apply-ready team generation requires durable roster players. Could not match ${unmatchedMovedIn.length} imported row${unmatchedMovedIn.length === 1 ? '' : 's'} playing in this division to players: ${unmatchedMovedIn.slice(0, 3).join(', ')}.`
        );
      }
      const prepared = prepareTeamingInput({
        players: [...generatorPlayers, ...movedIn.map((entry) => entry.player)],
        roster: buddyRoster,
        buddyRule,
        coaches: [...coachesById.values()],
        divisions: divisionDescriptors,
        seasonYear,
        cutoffMode,
        cutoffMonth,
        cutoffDay,
      });
      // The pipeline places each player in the division they play in; this run seats the ones
      // who play in this program. The rest of the registrants are in the listing only.
      const preparedPlayers = prepared.players.filter(
        (player) => String(player.division) === selectedProgramKey
      );
      const preparedDiagnostics = prepared.diagnostics;
      const inThisProgram = (entry) =>
        [entry.registeredDivision, entry.playedDivision].includes(selectedProgramKey);
      const playUpListing = preparedDiagnostics.playUp.listing.filter(inThisProgram);
      const waitlistExceptions = preparedDiagnostics.waitlistExceptions.filter(
        (entry) => entry.division === selectedProgramKey
      );

      const divisionConfig = {
        id: selectedProgramKey,
        name: selectedProgram.name,
        teamsCount: config.teamCountOverride || selectedProgram.estimatedTeams,
        slotsPerWeek: 0,
        maxRosterSize: config.maxRosterSize,
        minRosterSize: config.minRosterSize,
        targetTeamSize: config.targetTeamSize,
        teamCountOverride: config.teamCountOverride,
        minTeams: config.minTeams,
        maxTeams: config.maxTeams,
      };
      // Snapshot-aware re-run: when a prior persisted snapshot exists for this division, preserve
      // its team IDs, coach assignments, and manual roster moves rather than regenerating fresh.
      // First runs (no prior snapshot) get a null snapshot → identical fresh behavior as before.
      const existingSnapshot = buildExistingSnapshotForRerun(persistenceSnapshot, {
        divisionKey: selectedProgramKey,
      });
      const generationMode = existingSnapshot ? 'review' : 'draft';
      const generated = generateTeams({
        players: preparedPlayers,
        divisionConfigs: { [selectedProgramKey]: divisionConfig },
        seed: config.seed,
        existingSnapshot,
        generationMode,
        // The league's effective settings (defaults applied): the balance signal and whether
        // coaching leads are spread (Phase B6).
        featureFlags: features,
      });
      // The "Buddy requests" list, kept in the run's results so it survives a reload.
      const withBuddyList =
        buddyRequestsEnabled && preparedDiagnostics
          ? {
              ...generated,
              buddyRequestsByDivision: {
                [selectedProgramKey]: summarizeBuddyRequests({
                  players: preparedPlayers,
                  requests: preparedDiagnostics.buddyRequests.filter((request) =>
                    preparedPlayers.some((player) => String(player.id) === request.playerId)
                  ),
                  linkDiagnostics: preparedDiagnostics.buddyLinking,
                  buddyDiagnostics: generated.buddyDiagnosticsByDivision?.[selectedProgramKey],
                  teams: generated.teamsByDivision?.[selectedProgramKey],
                  overflow: generated.overflowByDivision?.[selectedProgramKey],
                  roster: buddyRoster,
                  buddyRule,
                }),
              },
            }
          : generated;
      // The Play-up section's rows and the players taken off the waitlist, kept in the run's
      // results so they survive a reload and the save can make those players active.
      const result = {
        ...withBuddyList,
        playUpByDivision: { [selectedProgramKey]: playUpListing },
        waitlistExceptionsByDivision: { [selectedProgramKey]: waitlistExceptions },
      };
      const generatedTeams = result.teamsByDivision?.[selectedProgramKey] ?? [];
      if (generatedTeams.length === 0) {
        throw new Error(noTeamsMessage(selectedProgram.name, preparedPlayers, result));
      }
      const coverage = result.coachCoverageByDivision?.[selectedProgramKey] ?? null;
      // The review names the coaches it flags (no team to anchor, more than one child); the run
      // holds ids only, so their names are kept with it.
      const coachNamesById = await readCoachNames(
        currentOrganization.id,
        currentSeasonSetting?.id,
        [
          ...new Set([
            ...coachIdsNamedByReview(summarizePlacementReview(result)),
            ...coachIdsNamedByPlayUp(summarizePlayUpReview(result)),
          ]),
        ]
      );
      const now = new Date().toISOString();
      const snapshot = buildTeamReviewSnapshot({
        generatedResult:
          Object.keys(coachNamesById).length > 0 ? { ...result, coachNamesById } : result,
        divisionKey: selectedProgramKey,
        divisionId: savedDivision.id,
        organizationId: currentOrganization.id,
        seasonSettingsId: currentSeasonSetting?.id,
        userId: user.id,
        selectedProgramId: selectedProgramKey,
        divisionConfig,
        nowIso: now,
      });
      const summary = mapSchedulerRunToSummary({
        id: snapshot.lastRunId,
        organization_id: currentOrganization.id,
        season_id: currentSeasonSetting?.id ?? null,
        season_settings_id: currentSeasonSetting?.id ?? null,
        run_type: 'team',
        status: 'needs_manual_review',
        results: snapshot.runMetadata.results,
        created_at: now,
        completed_at: now,
      });

      setStagedReview({
        snapshot,
        summary,
        createdAt: now,
        programName: selectedProgram.name,
      });
      setPlacementAnnouncement(
        [
          teamSizeAnnouncement(summarizeTeamSizeReview(snapshot.runMetadata.results)),
          placementReviewAnnouncement(summarizePlacementReview(snapshot.runMetadata.results)),
          playUpAnnouncement(
            summarizePlayUpReview(snapshot.runMetadata.results, divisionDescriptors)
          ),
        ]
          .filter(Boolean)
          .join(' ')
      );
      setManualTeams(null);
      const coachNote = coverage
        ? coverage.teamsWithoutCoach > 0
          ? ` ${coverage.teamsWithCoach}/${coverage.totalTeams} teams have a coach — ${coverage.additionalCoachesNeeded} more coach${
              coverage.additionalCoachesNeeded === 1 ? '' : 'es'
            } needed (uncovered teams are flagged "Coach needed").`
          : ` All ${coverage.totalTeams} teams have a coach.`
        : '';
      const changes = result.changeDiagnosticsByDivision?.[selectedProgramKey] ?? null;
      const formattedChangeNote = formatChangeNote(changes);
      const changeNote = formattedChangeNote ? ` ${formattedChangeNote}` : '';
      setReviewMessage(
        `Team review staged: ${generatedTeams.length} team${
          generatedTeams.length === 1 ? '' : 's'
        }.${coachNote}${changeNote} Sync to Supabase to apply it.`
      );
    } catch (err) {
      console.error('Generation failed:', err);
      setGenerationError(err?.message || 'Team generation failed.');
    } finally {
      setIsGenerating(false);
    }
  }, [
    buddyRequestsEnabled,
    buddyRule,
    coachingInterestEnabled,
    waitlistEnabled,
    skillTierEnabled,
    configs,
    canManageTeams,
    features,
    currentOrganization?.id,
    currentSeasonSetting?.id,
    currentSeasonSetting?.season_year,
    currentSeasonSetting?.age_cutoff_mode,
    currentSeasonSetting?.age_cutoff_month,
    currentSeasonSetting?.age_cutoff_day,
    authUser,
    importedPlayerRows,
    persistenceSnapshot,
    persistenceLoading,
    programs,
    divisionRows,
    resolveGeneratorPlayers,
    saveDivisionConfig,
    session?.user,
    selectedProgram,
  ]);

  // Auto-run teaming when arriving from the dashboard "Start Teaming" button.
  // Fires once a program is selected and players are loaded; if no program can
  // be resolved the user simply lands on the page with the normal control.
  const teamingAutoRunReady =
    Boolean(selectedProgram) &&
    importedPlayerRows.length > 0 &&
    canManageTeams &&
    Boolean(currentOrganization?.id) &&
    // Division settings must be loaded — handleGenerateTeams -> saveDivisionConfig
    // throws while divisionRows === null, and the one-shot intent would be
    // consumed without retrying once settings arrive.
    divisionRows !== null &&
    !isGenerating;
  useAutoRunOnNavigate({
    intentKey: 'autoRunTeaming',
    ready: teamingAutoRunReady,
    onRun: handleGenerateTeams,
  });

  // Combined loading state for better UX
  const isActuallyGenerating = useMemo(() => {
    if (team?.status === 'running') return true;
    return isGenerating;
  }, [team?.status, isGenerating]);

  // Reset local trigger state when polling confirms processing started or failed
  useEffect(() => {
    if (isGenerating && (team?.status === 'running' || team?.status === 'error')) {
      // This is still a set state in effect, but it's gated and handles the transition
      // To fully remove it, we'd need to manage the transition state in the hook itself.
      // However, making it asynchronous or using a ref for the transition is cleaner.
      const timer = setTimeout(() => setIsGenerating(false), 0);
      return () => clearTimeout(timer);
    }
  }, [team?.status, isGenerating]);

  const activeTeamData = useMemo(() => {
    if (!stagedReview?.summary) return team;
    return {
      ...team,
      summary: stagedReview.summary,
      generatedAt: stagedReview.summary.generatedAt,
      totals: stagedReview.summary.totals,
      divisions: stagedReview.summary.divisions,
      teams: stagedReview.summary.teams,
      team_players: stagedReview.summary.team_players,
      status: 'needs_manual_review',
      progress: 100,
    };
  }, [stagedReview?.summary, team]);

  const displayPersistenceSnapshot = stagedReview?.snapshot || persistenceSnapshot;

  const refetchTeam = team?.refetch;
  // The players this run took off the waitlist (a coach's child's buddy) become active when the
  // teams are saved, through the same audited bulk status write the Players page uses. A failed
  // write is said, never swallowed: they are on a team and still marked waitlisted until it is.
  const activateWaitlistedPlayers = useCallback(async (playerIds, appliedMessage) => {
    const plural = playerIds.length === 1 ? 'player' : 'players';
    const { error } = await supabase.rpc('admin_bulk_update_players', {
      p_player_ids: playerIds,
      p_patch: { status: 'active' },
    });
    if (error) {
      logger.error('[TeamAnalysis] waitlisted players could not be made active:', error);
      setReviewMessage(
        `${appliedMessage} ${playerIds.length} ${plural} taken off the waitlist could not be made active (${
          error.message || 'the write was refused'
        }): set their status on the Players page.`
      );
      return;
    }
    setWaitlistReadKey((key) => key + 1);
    setReviewMessage(
      `${appliedMessage} ${playerIds.length} ${plural} taken off the waitlist ${playerIds.length === 1 ? 'is' : 'are'} now active.`
    );
  }, []);
  const handlePersistSuccess = useCallback(
    (result) => {
      if (stagedReview) {
        const savedSnapshot = stagedReview.snapshot;
        setStagedReview(null);
        setPlacementAnnouncement('');
        // The page's own line, so it survives the panel: the sync's counts are kept here
        // because the panel below is remounted while the synced run is read back.
        const counts =
          Number.isFinite(result?.updatedTeams) && Number.isFinite(result?.updatedPlayers)
            ? ` ${result.updatedTeams} teams and ${result.updatedPlayers} players synced to Supabase.`
            : '';
        const applied = `Team review applied.${counts}`;
        setReviewMessage(applied);
        const taken = waitlistPlayersToActivate(
          savedSnapshot?.runMetadata?.results,
          savedSnapshot?.payload?.teamPlayerRows
        );
        if (taken.length > 0) activateWaitlistedPlayers(taken, applied);
      }
      // Pull the just-persisted run back into the hook so a same-session re-run preserves it
      // instead of falling back to the stale pre-sync snapshot.
      refreshPersistence();
      // And the team summary, which the cleared review stood in for: without it the page fell
      // back to the summary read before the sync (none, on a first run) and showed its
      // generate view until a reload.
      refetchTeam?.();
    },
    [stagedReview, refreshPersistence, refetchTeam, activateWaitlistedPlayers]
  );

  const handleDiscardReview = useCallback(() => {
    setStagedReview(null);
    setPlacementAnnouncement('');
    setManualTeams(null);
    setIsEditMode(false);
    setReviewMessage('Team review discarded.');
  }, []);

  const handleRosterTeamsChange = useCallback((nextTeams) => {
    setManualTeams(nextTeams);
    setManualSaveMessage('Roster changes staged.');
  }, []);

  const handleSaveRosterChanges = useCallback(async () => {
    if (!manualTeams || manualTeams.length === 0) {
      setIsEditMode(false);
      return;
    }

    setManualSaveState('saving');
    setManualSaveMessage('');

    try {
      const user = authUser || session?.user;
      if (!user?.id) throw new Error('Sign in before saving roster changes.');
      if (!currentOrganization?.id) throw new Error('Select an active organization.');
      if (!currentSeasonSetting?.id) throw new Error('Select an active season.');
      if (!canManageTeams) throw new Error('Admin team-management permission is required.');

      const snapshot = buildManualRosterSnapshot({
        baseSnapshot: displayPersistenceSnapshot,
        teams: manualTeams,
        organizationId: currentOrganization.id,
        seasonSettingsId: currentSeasonSetting.id,
        userId: user.id,
        divisionRows: divisionRows || [],
      });

      if (stagedReview) {
        const summary = mapSchedulerRunToSummary({
          id: snapshot.lastRunId,
          organization_id: currentOrganization.id,
          season_id: currentSeasonSetting.id,
          season_settings_id: currentSeasonSetting.id,
          run_type: 'team',
          status: 'needs_manual_review',
          results: snapshot.runMetadata.results,
          created_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
        });
        setStagedReview((current) => ({
          ...(current || {}),
          snapshot,
          summary,
        }));
        setManualSaveMessage('Roster changes staged for review.');
      } else {
        const result = await triggerTeamPersistence({
          snapshot,
          overrides: [],
          endpoint: getPersistenceEndpoint(),
          accessToken: session?.access_token,
        });

        if (result.status !== 'success') {
          throw new Error(result.message || 'Roster persistence failed.');
        }

        setManualSaveMessage('Roster changes synced to Supabase.');
      }

      setIsEditMode(false);
    } catch (err) {
      setManualSaveMessage(err?.message || 'Roster changes could not be saved.');
    } finally {
      setManualSaveState('idle');
    }
  }, [
    canManageTeams,
    currentOrganization?.id,
    currentSeasonSetting?.id,
    displayPersistenceSnapshot,
    authUser,
    divisionRows,
    manualTeams,
    session?.access_token,
    session?.user,
    stagedReview,
  ]);

  // Placed players with no eligibility check, flagged beside their name in the roster editor too.
  const uncheckedPlayerIds = useMemo(() => {
    const review = summarizePlacementReview(displayPersistenceSnapshot?.runMetadata?.results);
    return new Set(
      (review?.divisions ?? []).flatMap((division) =>
        division.unchecked.map((entry) => entry.playerId)
      )
    );
  }, [displayPersistenceSnapshot?.runMetadata?.results]);

  // Coaching leads (Phase B6), marked beside their name in the roster editor: read from the
  // run's rosters, which carry each player's `isCoachingLead`.
  const leadPlayerIds = useMemo(() => {
    const teamsByDivision = displayPersistenceSnapshot?.runMetadata?.results?.teamsByDivision ?? {};
    return new Set(
      Object.values(teamsByDivision)
        .flat()
        .flatMap((team) => team?.players ?? [])
        .filter((player) => player?.isCoachingLead === true)
        .map((player) => String(player.id))
    );
  }, [displayPersistenceSnapshot?.runMetadata?.results]);

  // Map persistence snapshot to nested structure for RosterManager
  const mappedTeams = useMemo(() => {
    const { teamRows = [], teamPlayerRows = [] } = displayPersistenceSnapshot?.payload || {};
    const rawPlayers = importedPlayerRows;

    return teamRows.map((teamRow) => {
      const players = teamPlayerRows
        .filter((tp) => tp.team_id === teamRow.id)
        .map((tp) => {
          // Join with imported data to get name and skill
          const playerDetails = rawPlayers.find(
            (rp, idx) => rp.id === tp.player_id || String(idx) === String(tp.player_id)
          );

          return {
            id: tp.player_id,
            name: playerDetails
              ? `${playerDetails['First Name'] || playerDetails['first_name'] || ''} ${playerDetails['Last Name'] || playerDetails['last_name'] || ''}`.trim() ||
                'Unnamed Player'
              : tp.player_name || 'Unknown Player',
            // No default: a player with no skill on file reads "Unrated" in the editor, not an
            // invented tier (the durable rating fills it in, `applyRosterDirectory`).
            skill: playerDetails?.['Skill Level'] || playerDetails?.['skill_tier'] || tp.skill,
            buddyId: playerDetails?.buddyId || playerDetails?.buddy_id,
            gender: playerDetails?.gender || playerDetails?.Gender,
            age: playerDetails?.age || playerDetails?.Age || 10,
            assignment_source: tp.source,
            eligibilityNotChecked: uncheckedPlayerIds.has(String(tp.player_id)),
            isCoachingLead: leadPlayerIds.has(String(tp.player_id)),
          };
        });

      return {
        id: teamRow.id,
        name: teamRow.name,
        division: teamRow.division || teamRow.division_id,
        // The division row the team is in: what the roster list judges its players' ages by.
        divisionId: teamRow.division_id,
        minAge: teamRow.min_age,
        maxAge: teamRow.max_age,
        gender: teamRow.gender,
        players,
      };
    });
  }, [displayPersistenceSnapshot?.payload, importedPlayerRows, uncheckedPlayerIds, leadPlayerIds]);

  // Use real data from the dashboard hook if available, otherwise empty array
  // Map automated results if persistence is empty
  const activeTeams = useMemo(() => {
    if (mappedTeams.length > 0) return mappedTeams;
    if (!activeTeamData?.teams) return [];

    const rawPlayers = importedPlayerRows;
    const teamPlayers = activeTeamData?.team_players || [];

    return activeTeamData.teams.map((t) => ({
      ...t,
      divisionId: t.division_id,
      players: teamPlayers
        .filter((tp) => tp.team_id === t.id)
        .map((tp) => {
          const playerDetails = rawPlayers.find(
            (rp, idx) => rp.id === tp.player_id || String(idx) === String(tp.player_id)
          );
          return {
            id: tp.player_id,
            name: playerDetails
              ? `${playerDetails['First Name'] || playerDetails['first_name'] || ''} ${playerDetails['Last Name'] || playerDetails['last_name'] || ''}`.trim() ||
                'Unnamed Player'
              : tp.player_name || 'Unknown Player',
            // No default: a player with no skill on file reads "Unrated" in the editor, not an
            // invented tier (the durable rating fills it in, `applyRosterDirectory`).
            skill: playerDetails?.['Skill Level'] || playerDetails?.['skill_tier'] || tp.skill,
            buddyId: playerDetails?.buddyId || playerDetails?.buddy_id,
            gender: playerDetails?.gender || playerDetails?.Gender,
            age: playerDetails?.age || playerDetails?.Age || 10,
            assignment_source: tp.source,
            eligibilityNotChecked: uncheckedPlayerIds.has(String(tp.player_id)),
            isCoachingLead: leadPlayerIds.has(String(tp.player_id)),
          };
        }),
    }));
  }, [mappedTeams, activeTeamData, importedPlayerRows, uncheckedPlayerIds, leadPlayerIds]);

  const handleEditButtonClick = useCallback(() => {
    if (isEditMode) {
      handleSaveRosterChanges();
      return;
    }

    setManualTeams(activeTeams);
    setManualSaveMessage('');
    setIsEditMode(true);
  }, [activeTeams, handleSaveRosterChanges, isEditMode]);

  // The editor's names come from the durable `players` and `coaches` tables, read in full while
  // the editor is open. The team run holds ids only; the import is one user's staging copy.
  const rosterDirectory = useRosterDirectory({ enabled: canEditTeams });
  const rosterTeams = useMemo(
    () =>
      applyRosterDirectory(manualTeams || activeTeams, rosterDirectory, {
        skillTier: skillTierEnabled,
      }),
    [manualTeams, activeTeams, rosterDirectory, skillTierEnabled]
  );
  const unnamedRosterPlayers = useMemo(
    () => (rosterDirectory.status === 'ready' ? countUnnamedPlayers(rosterTeams) : 0),
    [rosterDirectory.status, rosterTeams]
  );

  const visibleTeams = useMemo(
    () => activeTeams.filter((t) => !deletedTeamIds.has(t.id)),
    [activeTeams, deletedTeamIds]
  );

  const handleDeleteTeam = useCallback(async (team) => {
    if (
      !window.confirm(
        `Delete team "${team.name}"? This will remove all associated schedules and player assignments.`
      )
    )
      return;
    try {
      const { error } = await supabase.rpc('admin_delete_team', { p_team_id: team.id });
      if (error) throw error;
      setDeletedTeamIds((prev) => new Set([...prev, team.id]));
    } catch (err) {
      window.alert(`Failed to delete team: ${err?.message || 'Unknown error'}`);
    }
  }, []);

  const startRenameTeam = useCallback((team, currentName) => {
    setRenamingTeamId(team.id);
    setRenameValue(currentName);
  }, []);

  const handleRenameTeam = useCallback(
    async (team) => {
      const nextName = renameValue.trim();
      if (!nextName || nextName === team.name) {
        setRenamingTeamId(null);
        return;
      }
      try {
        const { error } = await supabase.rpc('admin_update_team', {
          p_team_id: team.id,
          p_patch: { name: nextName },
        });
        if (error) throw error;
        setRenamedTeams((prev) => ({ ...prev, [team.id]: nextName }));
        setRenamingTeamId(null);
      } catch (err) {
        window.alert(`Failed to rename team: ${err?.message || 'Unknown error'}`);
      }
    },
    [renameValue]
  );

  return (
    <div
      className={`animate-fadeIn space-y-8 w-full ${canEditTeams ? '' : 'max-w-[65ch] mx-auto'}`}
    >
      <DataErrorBanner message={dataError} />
      <SeasonReadOnlyNote />
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {stagedReview ? placementAnnouncement : ''}
      </p>

      <div className="flex justify-between items-start mb-8">
        <div>
          <h1 className="text-3xl font-display font-bold text-text-primary mb-2">
            Teaming & Analysis
          </h1>
          <p className="text-text-secondary">
            Review team generation, division capacity, and roster assignments.
          </p>
        </div>
        {activeTeamData?.generatedAt && canManageTeams && (
          <Button
            variant={isEditMode ? 'primary' : 'secondary'}
            onClick={handleEditButtonClick}
            disabled={manualSaveState === 'saving'}
            className="flex items-center gap-2"
          >
            {isEditMode ? <Save size={18} /> : <Edit2 size={18} />}
            {isEditMode
              ? manualSaveState === 'saving'
                ? 'Saving...'
                : 'Save Changes'
              : 'Edit Mode'}
          </Button>
        )}
      </div>

      {/* Above the views, not inside the generated-teams one: a review's status outlives the
          view it was staged in. After a sync the page reads the synced run back and shows its
          loading view meanwhile, so a line kept inside the one view was lost. */}
      {(stagedReview || reviewMessage) && (
        <section className="bg-bg-surface border border-border-subtle rounded-xl p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-lg font-bold text-text-primary">
                {stagedReview ? 'Team Review Pending' : 'Team Review Status'}
              </h3>
              <p className="text-sm text-text-secondary">
                {reviewMessage ||
                  `${stagedReview.programName || 'Selected division'} is ready for Supabase sync.`}
              </p>
            </div>
            {stagedReview && (
              <Button variant="secondary" onClick={handleDiscardReview}>
                Discard Review
              </Button>
            )}
          </div>
        </section>
      )}
      {(loading?.team && !stagedReview) || isActuallyGenerating ? (
        <div className="p-12 text-center animate-fadeIn">
          <div className="max-w-md mx-auto">
            <h3 className="text-xl font-bold text-text-primary mb-4">
              {team?.status === 'running' || isActuallyGenerating
                ? 'Generating Teams...'
                : 'Loading Team Data...'}
            </h3>
            <ProgressBar
              progress={team?.progress || 0}
              label={
                team?.status === 'running' || isActuallyGenerating
                  ? 'Processing roster rules and division caps...'
                  : 'Fetching data...'
              }
            />
          </div>
        </div>
      ) : !activeTeamData?.generatedAt && importedData ? (
        // NEW DASHBOARD VIEW
        <div className="space-y-6">
          {/* 1. Validation Panel */}
          <DataValidationPanel errors={validationErrors} />

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* 2. Program Overview (Left 2/3) */}
            <div className="lg:col-span-2">
              <ProgramOverview
                programs={programs}
                groups={overviewGroups}
                league={leagueFlags}
                onSelectProgram={setSelectedProgramId}
                selectedProgramId={selectedProgramId}
              />
            </div>

            {/* 3. Configuration (Right 1/3) */}
            <div className="lg:col-span-1">
              <TeamingConfiguration
                program={selectedProgram}
                config={selectedProgram ? configs[selectedProgram.id] : null}
                onUpdate={updateConfig}
                onSave={() =>
                  selectedProgram &&
                  saveDivisionConfig(
                    selectedProgram,
                    configs[selectedProgram.id] || createDefaultConfig()
                  ).catch((err) => {
                    console.error('Division rule save failed:', err);
                  })
                }
                saving={selectedProgram ? savingConfigId === selectedProgram.id : false}
                saveDisabled={
                  !canManageTeams ||
                  !selectedProgram ||
                  divisionRows === null ||
                  validationErrors.some((error) => error.type !== 'generation')
                }
                saveMessage={configSaveMessage}
              />
            </div>
          </div>

          {/* 4. Action Bar */}
          <div className="flex justify-end pt-6 border-t border-border-subtle">
            <Button
              variant="primary"
              size="lg"
              onClick={handleGenerateTeams}
              disabled={
                seasonReadOnly ||
                isActuallyGenerating ||
                divisionRows === null ||
                validationErrors.some((error) => error.type !== 'generation')
              }
              className="flex items-center gap-2"
            >
              Generate Teams <ArrowRight size={18} />
            </Button>
          </div>
        </div>
      ) : canEditTeams ? (
        <section className="card" aria-labelledby="manual-roster-heading">
          <div className="card-head" style={{ flexWrap: 'wrap' }}>
            <h2 id="manual-roster-heading" style={{ fontSize: 16 }}>
              Manual Roster Management
            </h2>
            <p className="secondary" style={{ margin: 0, fontSize: 13 }}>
              Drag a player by the handle, or use that player&apos;s Move button, to override
              automated assignments.
            </p>
          </div>
          <div className="card-body">
            {manualSaveMessage && (
              <p role="status" className="secondary" style={{ margin: '0 0 12px' }}>
                {manualSaveMessage}
              </p>
            )}
            {rosterDirectory.status === 'error' ? (
              <div className="space-y-4">
                <DataErrorBanner
                  message={`Player and coach names could not be loaded, so the roster editor is not shown (it would name only some of the people): ${rosterDirectory.error}`}
                />
                <Button variant="secondary" size="sm" onClick={rosterDirectory.retry}>
                  Try again
                </Button>
              </div>
            ) : rosterDirectory.status !== 'ready' ? (
              <div role="status" className="secondary">
                Loading player and coach names...
              </div>
            ) : (
              <>
                {unnamedRosterPlayers > 0 && (
                  <p role="status" className="secondary" style={{ margin: '0 0 12px' }}>
                    {`${unnamedRosterPlayers} roster ${unnamedRosterPlayers === 1 ? 'entry has' : 'entries have'} no matching player record, so ${unnamedRosterPlayers === 1 ? 'it is' : 'they are'} shown as Unknown Player.`}
                  </p>
                )}
                <RosterManager
                  initialTeams={rosterTeams}
                  onTeamsChange={handleRosterTeamsChange}
                  seasonDivisions={divisionsRead ? divisionRows : null}
                />
              </>
            )}
          </div>
        </section>
      ) : (
        <>
          <TeamOverviewPanel
            totals={activeTeamData.totals}
            divisions={activeTeamData.divisions}
            generatedAt={activeTeamData.generatedAt}
          />
          <TeamSizeOutcomeList results={displayPersistenceSnapshot?.runMetadata?.results} />
          <TeamPersistencePanel
            teamPersistenceSnapshot={displayPersistenceSnapshot}
            onPersistSuccess={stagedReview ? handlePersistSuccess : undefined}
          />
          <PlayUpList
            results={displayPersistenceSnapshot?.runMetadata?.results}
            divisions={descriptorSet.divisionDescriptors}
          />
          <PlacementReviewList results={displayPersistenceSnapshot?.runMetadata?.results} />
          <BuddyRequestsList results={displayPersistenceSnapshot?.runMetadata?.results} />
          {visibleTeams.length > 0 && (
            <section
              className="bg-bg-surface border border-border-subtle rounded-xl p-6"
              aria-label="Generated Teams"
            >
              <h3 className="text-xl font-bold text-text-primary mb-4">Generated Teams</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                {visibleTeams.map((generatedTeam) => {
                  const displayName = renamedTeams[generatedTeam.id] || generatedTeam.name;
                  const isPersisted = generatedTeam.id && isUuid(generatedTeam.id);
                  const isRenaming = renamingTeamId === generatedTeam.id;
                  return (
                    <div
                      key={generatedTeam.id}
                      className="rounded-lg border border-border-subtle bg-bg-surface px-4 py-3 flex items-center justify-between gap-2"
                    >
                      <div className="min-w-0 flex-1">
                        {isRenaming ? (
                          <input
                            type="text"
                            className="w-full bg-bg-app border border-border-highlight rounded-lg px-2 py-1 text-sm font-semibold text-text-primary outline-none"
                            value={renameValue}
                            // eslint-disable-next-line jsx-a11y/no-autofocus -- the rename field appears because the user just pressed Rename; focus moves to it
                            autoFocus
                            aria-label={`New name for team ${displayName}`}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleRenameTeam(generatedTeam);
                              if (e.key === 'Escape') setRenamingTeamId(null);
                            }}
                          />
                        ) : (
                          <div className="font-semibold text-text-primary truncate">
                            {displayName}
                          </div>
                        )}
                        <div className="text-sm text-text-secondary truncate">
                          {generatedTeam.divisionName ||
                            generatedTeam.division ||
                            generatedTeam.division_id ||
                            'Unassigned'}
                        </div>
                      </div>
                      {canManageTeams && isPersisted && (
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          {isRenaming ? (
                            <>
                              <button
                                type="button"
                                className="p-1.5 rounded-lg border border-border-subtle bg-bg-app text-text-muted hover:text-text-accent hover:border-brand-400/50 transition-all"
                                aria-label={`Save name for team ${displayName}`}
                                onClick={() => handleRenameTeam(generatedTeam)}
                              >
                                <Save size={14} aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                className="p-1.5 rounded-lg border border-border-subtle bg-bg-app text-text-muted hover:text-text-primary transition-all"
                                aria-label={`Cancel renaming team ${displayName}`}
                                onClick={() => setRenamingTeamId(null)}
                              >
                                <X size={14} aria-hidden="true" />
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                className="p-1.5 rounded-lg border border-border-subtle bg-bg-app text-text-muted hover:text-text-accent hover:border-brand-400/50 transition-all"
                                aria-label={`Rename team ${displayName}`}
                                onClick={() => startRenameTeam(generatedTeam, displayName)}
                              >
                                <Edit2 size={14} aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                className="p-1.5 rounded-lg border border-border-subtle bg-bg-app text-text-muted hover:text-status-error-text hover:border-red-400/50 hover:bg-red-500/10 transition-all"
                                aria-label={`Delete team ${displayName}`}
                                onClick={() => handleDeleteTeam(generatedTeam)}
                              >
                                <Trash2 size={14} aria-hidden="true" />
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}
          <div className="flex justify-end pt-4 border-t border-border-subtle">
            {canManageTeams && (
              <Button variant="primary" size="lg" onClick={() => navigate('/fields')}>
                Confirm Teams & Proceed
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
