import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDashboardData } from '../hooks/useDashboardData.js';
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
import Button from '../components/ui/Button.jsx';
import ProgressBar from '../components/ui/ProgressBar.jsx';
import { Edit2, Save, ArrowRight, Trash2, X } from 'lucide-react';
import { supabase } from '../lib/supabaseClient.js';
import { IS_MOCK_MODE } from '../config.js';
import { generateTeams } from '@squadlogic/core/teamGeneration.js';
import { prepareTeamingInput } from '@squadlogic/core/teamingPipeline.js';
import { mapSchedulerRunToSummary } from '@squadlogic/core/utils/teamSummaryMapper.js';
import { formatChangeNote } from '@squadlogic/core/teamDiagnostics.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { getPersistenceEndpoint, triggerTeamPersistence } from '../utils/teamPersistenceClient.js';
import {
  buildExistingSnapshotForRerun,
  buildManualRosterSnapshot,
  buildTeamReviewSnapshot,
  firstString,
  getPlayerExternalId,
  isUuid,
} from '../utils/teamReviewPersistence.js';

const DEFAULT_MAX_ROSTER_SIZE = 14;
const DEFAULT_MIN_ROSTER_SIZE = 10;
const DEFAULT_TARGET_TEAM_SIZE = 12;

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

function createDefaultConfig(program) {
  const estimatedTeams = Math.max(
    1,
    Math.ceil((program?.playerCount || 0) / DEFAULT_TARGET_TEAM_SIZE)
  );
  return {
    targetTeamSize: DEFAULT_TARGET_TEAM_SIZE,
    minRosterSize: DEFAULT_MIN_ROSTER_SIZE,
    maxRosterSize: DEFAULT_MAX_ROSTER_SIZE,
    minTeams: null,
    maxTeams: null,
    teamCountOverride: estimatedTeams,
    seed: '',
  };
}

function derivePrograms(rows) {
  const grouped = new Map();

  rows.forEach((row) => {
    const id = resolveDivisionId(row);
    const name = String(resolveDivisionName(row)).trim() || id;
    const current = grouped.get(id) || { id, name, playerCount: 0 };
    current.playerCount += 1;
    grouped.set(id, current);
  });

  return Array.from(grouped.values()).map((program) => ({
    ...program,
    totalPlayers: program.playerCount,
  }));
}

function positiveIntegerOrFallback(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function deriveProgramStats(program, config = {}) {
  const targetTeamSize = positiveIntegerOrFallback(config.targetTeamSize, DEFAULT_TARGET_TEAM_SIZE);
  const maxRosterSize = positiveIntegerOrFallback(config.maxRosterSize, DEFAULT_MAX_ROSTER_SIZE);
  const minTeams = positiveIntegerOrFallback(config.minTeams, null);
  const maxTeams = positiveIntegerOrFallback(config.maxTeams, null);
  const overrideTeams = positiveIntegerOrFallback(config.teamCountOverride, null);
  const baseEstimate =
    overrideTeams || Math.max(1, Math.ceil(program.playerCount / targetTeamSize));
  const minBoundedEstimate = minTeams ? Math.max(baseEstimate, minTeams) : baseEstimate;
  const estimatedTeams = maxTeams ? Math.min(minBoundedEstimate, maxTeams) : minBoundedEstimate;

  return {
    ...program,
    estimatedTeams,
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

function configFromDivisionRow(program, divisionRow) {
  const defaults = createDefaultConfig(program);
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

function toGeneratorPlayer(row, sourceIndex, division) {
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
  // Carry DOB + play-up signals so the play-up/play-down classifier has an age
  // to work with (without these every player resolves to "unknown").
  const dateOfBirth = firstNonEmpty(row, ['date_of_birth', 'DOB', 'Birthdate', 'dob', 'birthdate']);
  const playUpRequested = parseBooleanLike(row.play_up_requested);

  return {
    id,
    division,
    firstName,
    lastName,
    name: `${firstName} ${lastName}`.trim() || 'Unnamed Player',
    ...(dateOfBirth ? { date_of_birth: dateOfBirth } : {}),
    ...(playUpRequested ? { play_up_requested: true } : {}),
    ...(skillRating !== undefined ? { skillRating } : {}),
    ...(coachId || willingToCoach ? { coachId: String(coachId || `coach-${id}`) } : {}),
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

export default function TeamAnalysisPage() {
  // No `timezone` here: the one consumer was `TeamOverviewPanel`, which
  // deliberately renders its `generatedAt` on the viewer's clock and no longer
  // declares the prop. `useDashboardData` does not return a `timezone` either,
  // so the binding was `undefined` in every render this page has ever had.
  const { team, loading, error: _error } = useDashboardData();
  const {
    persistenceSnapshot,
    loading: persistenceLoading,
    refresh: refreshPersistence,
  } = useTeamPersistence();
  const { importedData } = useImport();
  const { currentOrganization, currentSeasonSetting, permissions = [] } = useOrganization();
  const { session, user: authUser } = useAuth();
  const [isEditMode, setIsEditMode] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [manualTeams, setManualTeams] = useState(null);
  const [manualSaveState, setManualSaveState] = useState('idle');
  const [manualSaveMessage, setManualSaveMessage] = useState('');
  const [selectedProgramId, setSelectedProgramId] = useState(null);
  const [configs, setConfigs] = useState({});
  const [generationError, setGenerationError] = useState(null);
  const [reviewMessage, setReviewMessage] = useState('');
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
        deriveProgramStats(program, configs[program.id] || createDefaultConfig(program))
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
        next[program.id] = configFromDivisionRow(program, divisionRow);
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
          [program.id]: configFromDivisionRow(program, savedDivision),
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
      const durablePlayers = [];
      const selectedDivisionKey = String(selectedDivisionId || '');
      const lookupResults = await Promise.all([
        ids.length > 0
          ? supabase
              .from('players')
              .select('id, external_registration_id, division_id')
              .eq('organization_id', currentOrganization.id)
              .in('id', ids)
          : Promise.resolve({ data: [], error: null }),
        externalIds.length > 0
          ? supabase
              .from('players')
              .select('id, external_registration_id, division_id')
              .eq('organization_id', currentOrganization.id)
              .eq('division_id', selectedDivisionId)
              .in('external_registration_id', externalIds)
          : Promise.resolve({ data: [], error: null }),
      ]);

      lookupResults.forEach(({ data, error }) => {
        if (error) throw error;
        durablePlayers.push(...(data || []));
      });

      const byId = new Map(durablePlayers.map((player) => [String(player.id), player]));
      const byExternalId = new Map(
        durablePlayers
          .filter((player) => player.external_registration_id)
          .map((player) => [String(player.external_registration_id), player])
      );
      const missingRows = [];

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
              ...row,
              id: durablePlayer.id,
              player_id: durablePlayer.id,
              division_id: durablePlayer.division_id || row.division_id,
            }
          : row;

        return toGeneratorPlayer(rowForGeneration, sourceIndex, selectedProgramKey);
      });

      if (missingRows.length > 0) {
        const preview = missingRows.slice(0, 3).join(', ');
        throw new Error(
          `Apply-ready team generation requires durable roster players. Could not match ${missingRows.length} imported row${missingRows.length === 1 ? '' : 's'} to players: ${preview}.`
        );
      }

      return generatorPlayers;
    },
    [currentOrganization?.id]
  );

  const handleGenerateTeams = useCallback(async () => {
    setIsGenerating(true);
    setGenerationError(null);
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
      const config = configs[selectedProgramKey] || createDefaultConfig(selectedProgram);
      const savedDivision = await saveDivisionConfig(selectedProgram, config, { silent: true });
      const rowsForProgram = importedPlayerRows
        .map((row, sourceIndex) => ({ row, sourceIndex }))
        .filter(({ row }) => resolveDivisionId(row) === selectedProgramKey);
      if (rowsForProgram.length === 0) {
        throw new Error(`No imported players found for ${selectedProgram.name}.`);
      }

      const generatorPlayers = await resolveGeneratorPlayers(
        rowsForProgram,
        selectedProgramKey,
        savedDivision.id
      );

      // Coach-anchored teaming + play-up/play-down eligibility. Imported coaches
      // (via coach_team_requests) drive which players anchor a coach's team, and
      // a coach-child or qualifying buddy sanctions a play-up. Guarded so the
      // page falls back to the raw roster if coach links are unavailable.
      let preparedPlayers = generatorPlayers;
      try {
        const { data: coachLinks } = await supabase
          .from('coach_team_requests')
          .select('coach_id, player_id, preferred_co_coach_id')
          .eq('organization_id', currentOrganization.id);
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
        preparedPlayers = prepared.players;
      } catch (pipelineErr) {
        console.warn('Teaming pipeline (coach links / play-up) skipped:', pipelineErr?.message);
      }

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
      const result = generateTeams({
        players: preparedPlayers,
        divisionConfigs: { [selectedProgramKey]: divisionConfig },
        seed: config.seed,
        existingSnapshot,
        generationMode,
      });
      const generatedTeams = result.teamsByDivision?.[selectedProgramKey] ?? [];
      if (generatedTeams.length === 0) {
        throw new Error(
          `No teams could be generated for ${selectedProgram.name}. Check that players are imported for this program and that the roster settings allow at least one team.`
        );
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

  const handlePersistSuccess = useCallback(() => {
    if (stagedReview) {
      setStagedReview(null);
      setReviewMessage('Team review applied. Latest persisted teams will load from Supabase.');
    }
    // Pull the just-persisted run back into the hook so a same-session re-run preserves it
    // instead of falling back to the stale pre-sync snapshot.
    refreshPersistence();
  }, [stagedReview, refreshPersistence]);

  const handleDiscardReview = useCallback(() => {
    setStagedReview(null);
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
  }, [displayPersistenceSnapshot?.payload, importedPlayerRows]);

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
          };
        }),
    }));
  }, [mappedTeams, activeTeamData, importedPlayerRows]);

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
                    configs[selectedProgram.id] || createDefaultConfig(selectedProgram)
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
          <TeamPersistencePanel
            teamPersistenceSnapshot={displayPersistenceSnapshot}
            onPersistSuccess={stagedReview ? handlePersistSuccess : undefined}
          />
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
                                className="p-1.5 rounded-lg border border-border-subtle bg-bg-app text-text-muted hover:text-brand-400 hover:border-brand-400/50 transition-all"
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
                                className="p-1.5 rounded-lg border border-border-subtle bg-bg-app text-text-muted hover:text-brand-400 hover:border-brand-400/50 transition-all"
                                aria-label={`Rename team ${displayName}`}
                                onClick={() => startRenameTeam(generatedTeam, displayName)}
                              >
                                <Edit2 size={14} aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                className="p-1.5 rounded-lg border border-border-subtle bg-bg-app text-text-muted hover:text-red-400 hover:border-red-400/50 hover:bg-red-500/10 transition-all"
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
