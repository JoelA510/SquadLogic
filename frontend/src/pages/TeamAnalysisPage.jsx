import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDashboardData } from '../hooks/useDashboardData.js';
import DataErrorBanner from '../components/ui/DataErrorBanner.jsx';
import { useTeamPersistence } from '../hooks/useTeamPersistence.js';
import { useAutoRunOnNavigate } from '../hooks/useAutoRunOnNavigate.js';
import { useImport } from '../contexts/ImportContext.jsx';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import TeamOverviewPanel from '../components/TeamOverviewPanel.jsx';
import ProgramOverview from '../components/teaming/ProgramOverview.jsx';
import TeamingConfiguration from '../components/teaming/TeamingConfiguration.jsx';
import RosterManager from '../components/teaming/RosterManager.jsx';
import TeamPersistencePanel from '../components/TeamPersistencePanel.jsx';
import DataValidationPanel from '../components/teaming/DataValidationPanel.jsx';
import BuddyRequestsList from '../components/teaming/BuddyRequestsList.jsx';
import PlacementReviewList from '../components/teaming/PlacementReviewList.jsx';
import TeamSizeOutcomeList from '../components/teaming/TeamSizeOutcomeList.jsx';
import Button from '../components/ui/Button.jsx';
import ProgressBar from '../components/ui/ProgressBar.jsx';
import { Edit2, Save, ArrowRight, Trash2, X } from 'lucide-react';
import { supabase } from '../lib/supabaseClient.js';
import { IS_MOCK_MODE } from '../config.js';
import { generateTeams, resolveTeamCount } from '@squadlogic/core/teamGeneration.js';
import { TEAM_GENERATION } from '@squadlogic/core/constants.js';
import { DEFAULT_ROSTER_LIMITS, assessTeamCount } from '@squadlogic/core/rosterSizing.js';
import { prepareTeamingInput } from '@squadlogic/core/teamingPipeline.js';
import { summarizeBuddyRequests } from '@squadlogic/core/buddyLinking.js';
import { mapSchedulerRunToSummary } from '@squadlogic/core/utils/teamSummaryMapper.js';
import { formatChangeNote } from '@squadlogic/core/teamDiagnostics.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { FEATURE_FLAGS } from '../constants/featureFlags.js';
import { useFeatures } from '../hooks/useFeatures.js';
import { canonicalImportKey } from '../utils/importAllowlist.js';
import { placementReviewAnnouncement, summarizePlacementReview } from '../utils/placementReview.js';
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
 * The programs of an import, with the players and the head coaches each holds. A coach is
 * counted by the rule generation uses (`toGeneratorPlayer`'s `coachId`), once per distinct
 * coach, as the generator counts them. It is the import's count, not the run's: coaches the
 * `coach_team_requests` links add at generation are not known here, and a coach whose child is
 * not eligible for the division anchors no team (Phase B2), as the registered players are
 * counted here and the eligible ones by the generator.
 */
function derivePrograms(rows) {
  const grouped = new Map();

  rows.forEach((row, sourceIndex) => {
    const id = resolveDivisionId(row);
    const name = String(resolveDivisionName(row)).trim() || id;
    const current = grouped.get(id) || { id, name, playerCount: 0, coachIds: new Set() };
    current.playerCount += 1;
    const { coachId } = toGeneratorPlayer(row, sourceIndex, id);
    if (coachId) current.coachIds.add(coachId);
    grouped.set(id, current);
  });

  return Array.from(grouped.values()).map(({ coachIds, ...program }) => ({
    ...program,
    coachCount: coachIds.size,
    totalPlayers: program.playerCount,
  }));
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
  const estimatedTeams = resolveTeamCount({
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
    avgRosterSize: Number((program.playerCount / estimatedTeams).toFixed(1)),
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

function configFromDivisionRow(divisionRow) {
  const defaults = createDefaultConfig();
  if (!divisionRow) return defaults;

  return {
    ...defaults,
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
  };
}

function parseBooleanLike(value) {
  return ['true', 'yes', 'y', '1'].includes(
    String(value || '')
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
  'id, external_registration_id, division_id, first_name, last_name, preferred_name, buddy_request, mutual_buddy_code, natural_age';
const IDENTITY_KEYS = ['first_name', 'last_name', 'preferred_name', 'nickname'];
const IDENTITY_CAMEL_KEYS = ['firstName', 'lastName', 'preferredName'];
const LOOKUP_CHUNK = 200;
const LOOKUP_CONCURRENCY = 8;

/**
 * The import row with the durable player's identity and buddy request over it. Every header
 * the import reads as a name or a request is replaced, so a request the admin cleared on the
 * record is cleared here too. The code stays the import's unless the player row holds one.
 */
function withDurableIdentity(row, durable) {
  if (!durable) return row;
  const next = {};
  for (const [header, value] of Object.entries(row || {})) {
    const key = canonicalImportKey(header);
    if (BUDDY_REQUEST_KEYS.includes(key) || IDENTITY_KEYS.includes(key)) continue;
    if (IDENTITY_CAMEL_KEYS.includes(header)) continue;
    next[header] = value;
  }
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

/**
 * Durable players by id and by external registration id, in chunks (a long `in` list is a
 * long URL), at most eight requests at a time. A refused read throws.
 * @param {string} organizationId
 * @param {{ ids?: string[], externalIds?: string[], divisionId?: string | null }} keys
 *   `divisionId` narrows the external-id lookup to one division.
 */
async function fetchDurablePlayers(
  organizationId,
  { ids = [], externalIds = [], divisionId = null }
) {
  const queries = [];
  for (let start = 0; start < ids.length; start += LOOKUP_CHUNK) {
    const chunk = ids.slice(start, start + LOOKUP_CHUNK);
    queries.push(() =>
      supabase
        .from('players')
        .select(DURABLE_PLAYER_FIELDS)
        .eq('organization_id', organizationId)
        .in('id', chunk)
    );
  }
  for (let start = 0; start < externalIds.length; start += LOOKUP_CHUNK) {
    const chunk = externalIds.slice(start, start + LOOKUP_CHUNK);
    queries.push(() => {
      const query = supabase
        .from('players')
        .select(DURABLE_PLAYER_FIELDS)
        .eq('organization_id', organizationId);
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

function toGeneratorPlayer(row, sourceIndex, division, { buddyRequests = false } = {}) {
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
    firstNonEmpty(row, ['skillRating', 'skill_rating', 'Skill Rating', 'skill_tier', 'Skill Tier'])
  );
  const coachId = firstNonEmpty(row, ['coach_id', 'coachId', 'coach_email', 'Coach Email']);
  const willingToCoach =
    parseBooleanLike(row.willing_to_coach) ||
    parseBooleanLike(row.coach_volunteer) ||
    parseBooleanLike(row['Willing to Coach']);
  // Carry the DOB, else the natural age, and play-up signals so the play-up/play-down classifier
  // has an age to work with (without these every player resolves to "unknown"). The DOB is the
  // file's, which only the import session's rows carry: it is counted in the page's season, as
  // before R5. A row without one carries the stored player's natural age (or the one
  // import-validation returned), counted in the season of its import; no birth date is stored.
  const naturalAge = Number(firstNonEmpty(row, ['natural_age', 'naturalAge']));
  const dateOfBirth = firstNonEmpty(row, ['date_of_birth', 'DOB', 'Birthdate', 'dob', 'birthdate']);
  const playUpRequested = parseBooleanLike(row.play_up_requested);

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
    ...(coachId || willingToCoach ? { coachId: String(coachId || `coach-${id}`) } : {}),
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
  return `No teams could be generated for ${programName}. Check that players are imported for this program and that the roster settings allow at least one team.${notEligible}`;
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
  const { isEnabled, buddyRule } = useFeatures();
  const buddyRequestsEnabled = isEnabled(FEATURE_FLAGS.BUDDY_REQUESTS);
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
  const [divisionSettingsError, setDivisionSettingsError] = useState(null);
  const [savingConfigId, setSavingConfigId] = useState(null);
  const [configSaveMessage, setConfigSaveMessage] = useState('');
  const [deletedTeamIds, setDeletedTeamIds] = useState(new Set());
  const [renamingTeamId, setRenamingTeamId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [renamedTeams, setRenamedTeams] = useState({});
  const loadedReviewKeyRef = useRef(null);
  const navigate = useNavigate();
  const canManageTeams =
    permissions.includes(PERMISSIONS.MANAGE_ALL_TEAMS) ||
    permissions.includes(PERMISSIONS.MANAGE_ORGANIZATION);
  const canEditTeams = canManageTeams && isEditMode;

  const importedPlayerRows = useMemo(() => getImportedRows(importedData), [importedData]);
  const basePrograms = useMemo(() => derivePrograms(importedPlayerRows), [importedPlayerRows]);
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
        setDivisionSettingsError(null);
        return;
      }

      setDivisionRows(null);
      setDivisionSettingsError(null);
      const { data, error } = await supabase
        .from('divisions')
        .select(
          `
          id,
          organization_id,
          season_settings_id,
          name,
          max_roster_size,
          min_roster_size,
          target_team_size,
          team_count_override,
          min_teams,
          max_teams
        `
        )
        .eq('organization_id', currentOrganization.id)
        .eq('season_settings_id', currentSeasonSetting.id)
        .order('name', { ascending: true });

      if (cancelled) return;
      if (error) {
        setDivisionRows([]);
        setDivisionSettingsError(error.message || 'Could not load division settings.');
        return;
      }

      setDivisionRows(data || []);
      setDivisionSettingsError(null);
    };

    fetchDivisionRows();

    return () => {
      cancelled = true;
    };
  }, [currentOrganization?.id, currentSeasonSetting?.id]);

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
      if (!program) throw new Error('Select a program before saving rules.');
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
      errors.push({ type: 'division', message: 'Select a program before generating teams.' });
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
        fetchDurablePlayers(currentOrganization.id, { ids }),
        fetchDurablePlayers(currentOrganization.id, {
          externalIds,
          divisionId: selectedDivisionId,
        }),
      ]);
      const durablePlayers = [...byIdRows, ...byExternalRows];

      const byId = new Map(durablePlayers.map((player) => [String(player.id), player]));
      const byExternalId = new Map(
        durablePlayers
          .filter((player) => player.external_registration_id)
          .map((player) => [String(player.external_registration_id), player])
      );
      const missingRows = [];
      const generationRows = [];

      const generatorPlayers = rowsForProgram.map(({ row, sourceIndex }) => {
        const idCandidate = getPlayerIdCandidate(row);
        const externalCandidate = getPlayerExternalCandidate(row);
        const matchedPlayer =
          (isUuid(idCandidate) && byId.get(idCandidate)) ||
          (externalCandidate && byExternalId.get(externalCandidate)) ||
          null;
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
              ...withDurableIdentity(row, durablePlayer),
              id: durablePlayer.id,
              player_id: durablePlayer.id,
              division_id: durablePlayer.division_id || row.division_id,
            }
          : row;
        generationRows.push(rowForGeneration);

        return toGeneratorPlayer(rowForGeneration, sourceIndex, selectedProgramKey, {
          buddyRequests: buddyRequestsEnabled,
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
    [buddyRequestsEnabled, currentOrganization?.id]
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
      if (!selectedProgram) throw new Error('Select a program before generating teams.');
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
      if (rowsForProgram.length === 0) {
        throw new Error(`No imported players found for ${selectedProgram.name}.`);
      }

      const { generatorPlayers, generationRows } = await resolveGeneratorPlayers(
        rowsForProgram,
        selectedProgramKey,
        savedDivision.id
      );

      // Every imported player, so a buddy request naming someone outside this program is told
      // apart from one naming nobody. The program's own rows carry their generator ids; every
      // row carries its durable player's names and request (the record's edits), where found.
      const programIndexBySource = new Map(
        rowsForProgram.map((entry, programIndex) => [entry.sourceIndex, programIndex])
      );
      let buddyRoster;
      if (buddyRequestsEnabled) {
        const otherRows = importedPlayerRows.filter(
          (_, sourceIndex) => !programIndexBySource.has(sourceIndex)
        );
        const otherKeys = collectPlayerLookupKeys(otherRows.map((row) => ({ row })));
        const otherDurable = await fetchDurablePlayers(currentOrganization.id, otherKeys);
        const otherById = new Map(otherDurable.map((player) => [String(player.id), player]));
        const otherByExternalId = new Map(
          otherDurable
            .filter((player) => player.external_registration_id)
            .map((player) => [String(player.external_registration_id), player])
        );
        buddyRoster = importedPlayerRows.map((row, sourceIndex) => {
          const programIndex = programIndexBySource.get(sourceIndex);
          if (programIndex !== undefined) {
            return toBuddyRosterEntry(
              generationRows[programIndex],
              generatorPlayers[programIndex].id,
              selectedProgramKey
            );
          }
          const division = resolveDivisionId(row);
          const idCandidate = getPlayerIdCandidate(row);
          const externalCandidate = getPlayerExternalCandidate(row);
          const durable =
            (isUuid(idCandidate) && otherById.get(idCandidate)) ||
            (externalCandidate && otherByExternalId.get(externalCandidate)) ||
            null;
          return toBuddyRosterEntry(
            withDurableIdentity(row, durable),
            durable?.id ?? toGeneratorPlayer(row, sourceIndex, division).id,
            division
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
      const coachesById = new Map();
      for (const link of coachLinks || []) {
        if (!link.player_id) continue;
        const entry = coachesById.get(link.coach_id) || {
          id: link.coach_id,
          children: [],
          preferred_co_coach_id: link.preferred_co_coach_id || null,
        };
        entry.children.push({ player_id: link.player_id });
        coachesById.set(link.coach_id, entry);
      }
      const prepared = prepareTeamingInput({
        players: generatorPlayers,
        roster: buddyRoster,
        buddyRule,
        coaches: [...coachesById.values()],
        divisions: [
          {
            id: selectedProgramKey,
            name: selectedProgram.name,
            min_age: savedDivision.min_age,
            max_age: savedDivision.max_age,
            birthdate_start: savedDivision.birthdate_start,
            birthdate_end: savedDivision.birthdate_end,
            gender_policy: savedDivision.gender_policy,
          },
        ],
        seasonYear: currentSeasonSetting?.season_year,
        cutoffMode: currentSeasonSetting?.age_cutoff_mode,
        // Single-division flow: annotate eligibility, do not remap across divisions.
        remapBlocked: false,
      });
      const preparedPlayers = prepared.players;
      const preparedDiagnostics = prepared.diagnostics;

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
      });
      // The "Buddy requests" list, kept in the run's results so it survives a reload.
      const result =
        buddyRequestsEnabled && preparedDiagnostics
          ? {
              ...generated,
              buddyRequestsByDivision: {
                [selectedProgramKey]: summarizeBuddyRequests({
                  players: preparedPlayers,
                  requests: preparedDiagnostics.buddyRequests,
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
      const generatedTeams = result.teamsByDivision?.[selectedProgramKey] ?? [];
      if (generatedTeams.length === 0) {
        throw new Error(noTeamsMessage(selectedProgram.name, preparedPlayers, result));
      }
      const coverage = result.coachCoverageByDivision?.[selectedProgramKey] ?? null;
      const now = new Date().toISOString();
      const snapshot = buildTeamReviewSnapshot({
        generatedResult: result,
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
    configs,
    canManageTeams,
    currentOrganization?.id,
    currentSeasonSetting?.id,
    currentSeasonSetting?.season_year,
    currentSeasonSetting?.age_cutoff_mode,
    authUser,
    importedPlayerRows,
    persistenceSnapshot,
    persistenceLoading,
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
  const handlePersistSuccess = useCallback(
    (result) => {
      if (stagedReview) {
        setStagedReview(null);
        setPlacementAnnouncement('');
        // The page's own line, so it survives the panel: the sync's counts are kept here
        // because the panel below is remounted while the synced run is read back.
        const counts =
          Number.isFinite(result?.updatedTeams) && Number.isFinite(result?.updatedPlayers)
            ? ` ${result.updatedTeams} teams and ${result.updatedPlayers} players synced to Supabase.`
            : '';
        setReviewMessage(`Team review applied.${counts}`);
      }
      // Pull the just-persisted run back into the hook so a same-session re-run preserves it
      // instead of falling back to the stale pre-sync snapshot.
      refreshPersistence();
      // And the team summary, which the cleared review stood in for: without it the page fell
      // back to the summary read before the sync (none, on a first run) and showed its
      // generate view until a reload.
      refetchTeam?.();
    },
    [stagedReview, refreshPersistence, refetchTeam]
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
            skill:
              playerDetails?.['Skill Level'] ||
              playerDetails?.['skill_tier'] ||
              tp.skill ||
              'developing',
            buddyId: playerDetails?.buddyId || playerDetails?.buddy_id,
            gender: playerDetails?.gender || playerDetails?.Gender,
            age: playerDetails?.age || playerDetails?.Age || 10,
            assignment_source: tp.source,
            eligibilityNotChecked: uncheckedPlayerIds.has(String(tp.player_id)),
          };
        });

      return {
        id: teamRow.id,
        name: teamRow.name,
        division: teamRow.division || teamRow.division_id,
        minAge: teamRow.min_age,
        maxAge: teamRow.max_age,
        gender: teamRow.gender,
        players,
      };
    });
  }, [displayPersistenceSnapshot?.payload, importedPlayerRows, uncheckedPlayerIds]);

  // Use real data from the dashboard hook if available, otherwise empty array
  // Map automated results if persistence is empty
  const activeTeams = useMemo(() => {
    if (mappedTeams.length > 0) return mappedTeams;
    if (!activeTeamData?.teams) return [];

    const rawPlayers = importedPlayerRows;
    const teamPlayers = activeTeamData?.team_players || [];

    return activeTeamData.teams.map((t) => ({
      ...t,
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
            skill:
              playerDetails?.['Skill Level'] ||
              playerDetails?.['skill_tier'] ||
              tp.skill ||
              'developing',
            buddyId: playerDetails?.buddyId || playerDetails?.buddy_id,
            gender: playerDetails?.gender || playerDetails?.Gender,
            age: playerDetails?.age || playerDetails?.Age || 10,
            assignment_source: tp.source,
            eligibilityNotChecked: uncheckedPlayerIds.has(String(tp.player_id)),
          };
        }),
    }));
  }, [mappedTeams, activeTeamData, importedPlayerRows, uncheckedPlayerIds]);

  const handleEditButtonClick = useCallback(() => {
    if (isEditMode) {
      handleSaveRosterChanges();
      return;
    }

    setManualTeams(activeTeams);
    setManualSaveMessage('');
    setIsEditMode(true);
  }, [activeTeams, handleSaveRosterChanges, isEditMode]);

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
    <div className="animate-fadeIn space-y-8 max-w-[65ch] mx-auto w-full">
      <DataErrorBanner message={dataError} />
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
                  `${stagedReview.programName || 'Selected program'} is ready for Supabase sync.`}
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
        <div className="space-y-6">
          <div className="bg-bg-surface border border-border-subtle rounded-xl p-6">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-xl font-bold text-text-primary">Manual Roster Management</h3>
              <p className="text-sm text-text-secondary">
                Drag and drop players between teams to manually override automated assignments.
              </p>
            </div>
            {manualSaveMessage && (
              <div className="mb-4 rounded-lg border border-border-subtle bg-bg-surface px-4 py-3 text-sm text-text-secondary">
                {manualSaveMessage}
              </div>
            )}
            <RosterManager
              initialTeams={manualTeams || activeTeams}
              onTeamsChange={handleRosterTeamsChange}
            />
          </div>
        </div>
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
