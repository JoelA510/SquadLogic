import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Clock,
  ShieldCheck,
  Trash2,
  UserMinus,
  UserRoundCheck,
  Users,
} from 'lucide-react';
import Page from '../components/chrome/Page.jsx';
import PageHeader from '../components/chrome/PageHeader.jsx';
import DataGrid from '../components/grid/DataGrid.jsx';
import Button from '../components/ui/Button.jsx';
import Badge from '../components/ui/Badge.jsx';
import Modal from '../components/ui/Modal.jsx';
import ConsequencePreview from '../components/scheduling/ConsequencePreview.jsx';
import { useToast } from '../components/ui/ToastHost.jsx';
import LoadingScreen from '../components/LoadingScreen.jsx';
import { supabase } from '../lib/supabaseClient.js';
import { mapInChunks } from '../utils/asyncChunks.js';
import { fetchAllPages } from '../lib/pagedFetch.js';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { usePermission } from '../hooks/usePermission.js';
import { useFeatures } from '../hooks/useFeatures.js';
import { divisionDisplayName } from '../utils/divisions.js';
import { logger } from '../lib/logger.js';
import { useDemo } from '../hooks/useDemo.js';
import { coachChangeConsequence } from '@squadlogic/core/people/assignmentHistory.js';
import { repairNotComputed } from '@squadlogic/core/fieldAdmin/index.js';

const STATUS_FILTERS = [
  { id: 'all', label: 'All statuses' },
  { id: 'registered', label: 'Registered' },
  { id: 'interested', label: 'Interested' },
  { id: 'inactive', label: 'Inactive' },
];

const STATUS_LABELS = {
  active: 'Registered',
  'pending-confirmation': 'Pending',
  interested: 'Interested',
  inactive: 'Inactive',
};

const STATUS_OPTIONS = [
  { value: 'active', label: 'Registered' },
  { value: 'pending-confirmation', label: 'Pending' },
  { value: 'interested', label: 'Interested' },
  { value: 'inactive', label: 'Inactive' },
];

const STATUS_TONE = {
  active: 'success',
  'pending-confirmation': 'warning',
  interested: 'info',
  inactive: 'neutral',
};

function normalizeSearch(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function uniqueValues(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function formatTeamAssignmentLabel({ team, divisionsById }) {
  const divisionName = divisionsById.get(String(team.division_id || ''))?.name;
  return [team.name || team.id, divisionName, team.coach_id ? 'Assigned' : 'Unassigned']
    .filter(Boolean)
    .join(' - ');
}

function getCoachStatusGroup(status) {
  if (status === 'active' || status === 'pending-confirmation') return 'registered';
  if (status === 'inactive') return 'inactive';
  return 'interested';
}

function formatDate(value) {
  if (!value) return 'Not imported';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not imported';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

// A coach's programs are the divisions of the teams they coach. The divisions
// a player import once recorded a coaching lead in (`coach_interested_programs`)
// are gone with the leads (20261025010000).
export function buildCoachReviewRows({ coaches = [], divisions = [], teams = [] } = {}) {
  const divisionsById = new Map(divisions.map((division) => [String(division.id), division]));
  const teamsByCoach = new Map();

  for (const team of teams) {
    const coachId = String(team.coach_id || '');
    if (!coachId) continue;
    const entries = teamsByCoach.get(coachId) || [];
    entries.push(team);
    teamsByCoach.set(coachId, entries);
  }

  return coaches.map((coach) => {
    const coachId = String(coach.id);
    const assignedTeams = teamsByCoach.get(coachId) || [];
    const status = coach.status || 'active';
    const divisionIds = uniqueValues(
      assignedTeams.map((team) => (team.division_id ? String(team.division_id) : null))
    );
    const programNames = uniqueValues(
      divisionIds.map((divisionId) => divisionsById.get(divisionId)?.name || divisionId)
    );

    return {
      id: coach.id,
      fullName: coach.full_name || 'Unnamed coach',
      email: coach.email || '',
      phone: coach.phone || '',
      status,
      statusLabel: STATUS_LABELS[status] || status,
      statusGroup: getCoachStatusGroup(status),
      importSource: coach.import_source || '',
      lastImportedAt: coach.last_imported_at || null,
      lastImportedLabel: formatDate(coach.last_imported_at),
      canCoachMultipleTeams: Boolean(coach.can_coach_multiple_teams),
      divisionIds,
      programNames,
      teams: assignedTeams.map((team) => ({
        id: team.id,
        name: team.name || team.id,
        divisionId: team.division_id || null,
      })),
    };
  });
}

export function summarizeCoachRows(rows = []) {
  return rows.reduce(
    (summary, row) => {
      summary.total += 1;
      if (row.statusGroup === 'registered') summary.registered += 1;
      if (row.statusGroup === 'interested') summary.interested += 1;
      if (row.statusGroup === 'inactive') summary.inactive += 1;
      if (row.statusGroup === 'registered' && row.teams.length === 0) summary.unassigned += 1;
      return summary;
    },
    { total: 0, registered: 0, interested: 0, inactive: 0, unassigned: 0 }
  );
}

export function filterCoachReviewRows(
  rows = [],
  { status = 'all', divisionId = 'all', search = '' } = {}
) {
  const query = normalizeSearch(search);

  return rows.filter((row) => {
    const matchesStatus = status === 'all' || row.statusGroup === status;
    const matchesDivision = divisionId === 'all' || row.divisionIds.includes(String(divisionId));
    const searchable = [
      row.fullName,
      row.email,
      row.phone,
      row.statusLabel,
      ...row.programNames,
      ...row.teams.map((team) => team.name),
    ]
      .join(' ')
      .toLowerCase();
    const matchesSearch = !query || searchable.includes(query);

    return matchesStatus && matchesDivision && matchesSearch;
  });
}

export function buildTeamAssignmentOptions({ teams = [], divisions = [] } = {}) {
  const divisionsById = new Map(divisions.map((division) => [String(division.id), division]));

  return teams.map((team) => ({
    value: team.id,
    label: formatTeamAssignmentLabel({ team, divisionsById }),
    coachId: team.coach_id || null,
    divisionId: team.division_id || null,
  }));
}

export function canAssignCoachToTeam(coach) {
  return coach?.status === 'active' || coach?.status === 'pending-confirmation';
}

export function canSetCoachStatus(coach, status) {
  return !(['inactive', 'interested'].includes(status) && (coach?.teams || []).length > 0);
}

/**
 * Plans a bulk status change over the selected coach rows: rows already in
 * the target status are no-ops, and rows the status rules forbid (e.g.
 * benching a coach who still has teams) are skipped rather than failed.
 */
export function planBulkCoachStatus(rows = [], selectedIds = new Set(), nextStatus) {
  const selected = rows.filter((row) => selectedIds.has(row.id));
  const eligible = selected.filter(
    (row) => row.status !== nextStatus && canSetCoachStatus(row, nextStatus)
  );
  return { eligible, skipped: selected.length - eligible.length };
}

/**
 * Coaches roster — same Lightning-class grid UI as the Players view, with
 * coach-specific metrics in the header (registered / interested /
 * unassigned). Status edits and team assignments flow through the audited
 * admin RPCs; selection enables bulk status changes.
 */
export default function CoachesPage() {
  const { currentOrganization, currentSeasonSetting, seasonSettingsLoading } = useOrganization();
  const seasonId = currentSeasonSetting?.id ?? null;
  const { can, PERMISSIONS } = usePermission();
  const { genderModel } = useFeatures();
  const toast = useToast();
  const latestRequestRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [coaches, setCoaches] = useState([]);
  const [divisions, setDivisions] = useState([]);
  const [teams, setTeams] = useState([]);
  const [statusFilter, setStatusFilter] = useState('all');
  const [divisionFilter, setDivisionFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [manageCoachId, setManageCoachId] = useState(null);
  const [assignTeamId, setAssignTeamId] = useState('');
  // 8.8: the effective-dated coaching record, and the change awaiting
  // confirmation. A change is previewed (sole-coach register before and after)
  // and only then committed.
  const [assignmentRows, setAssignmentRows] = useState(null);
  const [pendingChange, setPendingChange] = useState(null);
  const canManageCoaches = can(PERMISSIONS.MANAGE_ORGANIZATION);
  // A demo's coach records are read-only (the server refuses every write, D3): no status edits and
  // no deletes. Assigning a coach to a team is a team write, and stays.
  const { isDemo } = useDemo();
  const canEditCoachRecords = canManageCoaches && !isDemo;

  const loadCoaches = useCallback(async () => {
    const requestId = latestRequestRef.current + 1;
    latestRequestRef.current = requestId;

    // A coach row belongs to one season (20261108010000): the page lists the season the header
    // shows. With none (an organization with no season yet), there is nothing to list; while it
    // loads, the page keeps what it has.
    if (seasonSettingsLoading) return;
    if (!currentOrganization?.id || !seasonId) {
      setCoaches([]);
      setDivisions([]);
      setTeams([]);
      setAssignmentRows(null);
      setLoading(false);
      return;
    }

    setError(null);

    try {
      const [coachResult, divisionResult, teamResult, assignmentResult] = await Promise.all([
        supabase
          .from('coaches')
          .select(
            'id, organization_id, full_name, email, phone, status, import_source, last_imported_at, can_coach_multiple_teams, created_at'
          )
          .eq('organization_id', currentOrganization.id)
          .eq('season_settings_id', seasonId)
          .order('full_name', { ascending: true }),
        supabase
          .from('divisions')
          .select('id, name, organization_id')
          .eq('organization_id', currentOrganization.id)
          .eq('season_settings_id', seasonId)
          .order('name', { ascending: true }),
        supabase
          .from('teams')
          .select('id, name, division_id, coach_id, organization_id')
          .eq('organization_id', currentOrganization.id)
          .order('name', { ascending: true }),
        // Paged: the history only grows (nothing is deleted), and an unranged
        // select is cut at the server's row cap -- a partial history would
        // make covered teams read as uncoached in the preview.
        fetchAllPages(() =>
          supabase
            .from('team_coach_assignments')
            .select('id, team_id, coach_id, role, effective_from, effective_to')
            .eq('organization_id', currentOrganization.id)
        ).then(
          (data) => ({ data, error: null }),
          (error) => ({ data: null, error })
        ),
      ]);

      const resultError = coachResult.error || divisionResult.error || teamResult.error;
      if (resultError) throw resultError;
      if (latestRequestRef.current !== requestId) return;

      setCoaches(coachResult.data || []);
      setDivisions(divisionResult.data || []);
      // Teams carry no season of their own: they are the season's through their division.
      const seasonDivisionIds = new Set((divisionResult.data || []).map((d) => String(d.id)));
      setTeams((teamResult.data || []).filter((t) => seasonDivisionIds.has(String(t.division_id))));
      // An unreadable coaching record is NOT an empty one: null makes the
      // preview say "could not be computed" instead of "no effect".
      setAssignmentRows(assignmentResult.error ? null : assignmentResult.data || []);
      if (assignmentResult.error) {
        logger.error('Failed to load coach assignment history:', assignmentResult.error);
      }
      setSelected((previous) => {
        const validIds = new Set((coachResult.data || []).map((coach) => String(coach.id)));
        return new Set([...previous].filter((id) => validIds.has(String(id))));
      });
    } catch (err) {
      if (latestRequestRef.current !== requestId) return;
      logger.error('Failed to load coaches:', err);
      setError('Failed to load coach records.');
    } finally {
      if (latestRequestRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [currentOrganization?.id, seasonId, seasonSettingsLoading]);

  useEffect(() => {
    setLoading(true);
    loadCoaches();
  }, [loadCoaches]);

  useEffect(() => {
    setSelected(new Set());
    setManageCoachId(null);
  }, [currentOrganization?.id, seasonId]);

  const allRows = useMemo(
    () => buildCoachReviewRows({ coaches, divisions, teams }),
    [coaches, divisions, teams]
  );
  const summary = useMemo(() => summarizeCoachRows(allRows), [allRows]);
  const teamAssignmentOptions = useMemo(
    () => buildTeamAssignmentOptions({ teams, divisions }),
    [teams, divisions]
  );

  // Toolbar filters narrow the grid rows; text search is the grid's own.
  const rows = useMemo(
    () =>
      filterCoachReviewRows(allRows, { status: statusFilter, divisionId: divisionFilter }).map(
        (row) => ({
          ...row,
          _programs: row.programNames
            .map((name) => divisionDisplayName(name, genderModel))
            .join(', '),
          _teams: row.teams.map((team) => team.name).join(', '),
        })
      ),
    [allRows, statusFilter, divisionFilter, genderModel]
  );

  const manageCoach = useMemo(
    () => allRows.find((row) => row.id === manageCoachId) || null,
    [allRows, manageCoachId]
  );

  const runMutation = useCallback(
    async (mutation, successMessage) => {
      if (!currentOrganization?.id || !canManageCoaches) return false;
      setBusy(true);
      try {
        const { error: mutationError } = await mutation();
        if (mutationError) throw mutationError;
        if (successMessage) toast(successMessage, 'success');
        await loadCoaches();
        return true;
      } catch (err) {
        logger.error('Coach admin mutation failed:', err);
        toast(err?.message || 'Coach action failed. Please try again.', 'warning');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [canManageCoaches, currentOrganization?.id, loadCoaches, toast]
  );

  const handleCellChange = useCallback(
    (coachId, key, value) => {
      if (key !== 'status') return;
      const coach = allRows.find((row) => row.id === coachId);
      if (!coach || !value || value === coach.status) return;
      if (!canSetCoachStatus(coach, value)) {
        toast('Unassign this coach from their teams before benching them', 'warning');
        return;
      }
      runMutation(
        () =>
          supabase.rpc('admin_update_coach_status', {
            p_organization_id: currentOrganization.id,
            p_coach_id: coachId,
            p_status: value,
          }),
        `${coach.fullName} set to ${STATUS_LABELS[value] || value}`
      );
    },
    [allRows, currentOrganization?.id, runMutation, toast]
  );

  const handleBulkStatusChange = useCallback(
    async (nextStatus) => {
      if (!currentOrganization?.id || !canManageCoaches) return;
      // Plan over ALL rows: the selection bar counts every selected coach,
      // including ones a toolbar filter currently hides (Players-grid
      // semantics), so the bulk action must cover them too.
      const { eligible, skipped } = planBulkCoachStatus(allRows, selected, nextStatus);
      const statusLabel = STATUS_LABELS[nextStatus] || nextStatus;
      if (eligible.length === 0) {
        toast(
          `None of the selected coaches can be set to ${statusLabel} (coaches with assigned teams must be unassigned first)`,
          'warning'
        );
        return;
      }

      setBusy(true);
      // Bound RPC concurrency (free-tier pooled connections are scarce).
      const results = await mapInChunks(eligible, async (coach) => {
        try {
          const { error: mutationError } = await supabase.rpc('admin_update_coach_status', {
            p_organization_id: currentOrganization.id,
            p_coach_id: coach.id,
            p_status: nextStatus,
          });
          if (mutationError) throw mutationError;
          return true;
        } catch (err) {
          logger.error('Bulk coach status update failed:', err);
          return false;
        }
      });

      const failures = results.filter((ok) => !ok).length;
      const updated = eligible.length - failures;
      const notes = [];
      if (skipped > 0) notes.push(`${skipped} skipped`);
      if (failures > 0) notes.push(`${failures} failed`);
      toast(
        `${updated} coach${updated === 1 ? '' : 'es'} set to ${statusLabel}${
          notes.length > 0 ? ` (${notes.join(', ')})` : ''
        }`,
        failures > 0 ? 'warning' : 'success'
      );
      setSelected(new Set());
      setBusy(false);
      await loadCoaches();
    },
    [allRows, canManageCoaches, currentOrganization?.id, loadCoaches, selected, toast]
  );

  const handleDeleteCoaches = useCallback(
    async (coachIds) => {
      if (coachIds.length === 0) return;
      const ok = await runMutation(
        () => supabase.rpc('admin_delete_coaches', { p_coach_ids: coachIds }),
        `${coachIds.length} coach${coachIds.length === 1 ? '' : 'es'} deleted`
      );
      if (ok) {
        setSelected((previous) => {
          const next = new Set(previous);
          for (const id of coachIds) next.delete(id);
          return next;
        });
      }
    },
    [runMutation]
  );

  // Staging, not committing: Assign and Unassign each stage the head-coach
  // change so its consequence is shown BEFORE it is written (8.8).
  const handleAssignTeam = useCallback(() => {
    if (!manageCoach || !assignTeamId) return;
    const team = teams.find((entry) => String(entry.id) === String(assignTeamId));
    setPendingChange({
      teamId: assignTeamId,
      teamName: team?.name || 'the selected team',
      leadCoachId: manageCoach.id,
      successMessage: `${manageCoach.fullName} assigned to the selected team`,
    });
  }, [assignTeamId, manageCoach, teams]);

  const handleUnassignTeam = useCallback((team) => {
    setPendingChange({
      teamId: team.id,
      teamName: team.name,
      leadCoachId: null,
      successMessage: `${team.name} no longer has an assigned coach`,
    });
  }, []);

  const handleConfirmChange = useCallback(async () => {
    if (!pendingChange) return;
    const change = pendingChange;
    const ok = await runMutation(
      () =>
        supabase.rpc('admin_assign_team_coach', {
          p_organization_id: currentOrganization.id,
          p_team_id: change.teamId,
          p_coach_id: change.leadCoachId,
        }),
      change.successMessage
    );
    setPendingChange(null);
    if (ok && change.leadCoachId) setAssignTeamId('');
  }, [currentOrganization?.id, pendingChange, runMutation]);

  const pendingCoverage = useMemo(() => {
    if (!pendingChange || assignmentRows === null) return undefined;
    const today = new Date().toISOString().slice(0, 10);
    try {
      const report = coachChangeConsequence({
        rows: assignmentRows,
        teamIds: teams.map((team) => String(team.id)),
        change: {
          teamId: String(pendingChange.teamId),
          leadCoachId: pendingChange.leadCoachId ? String(pendingChange.leadCoachId) : null,
          assistantCoachIds: null,
        },
        effectiveOn: today,
      });
      const teamName = new Map(teams.map((team) => [String(team.id), team.name]));
      const coachName = new Map(coaches.map((coach) => [String(coach.id), coach.full_name]));
      return {
        effectiveOn: report.effectiveOn,
        teamsExamined: report.teamsExamined,
        changes: report.changes.map((row) => ({
          ...row,
          teamName: teamName.get(row.teamId) || row.teamId,
          soleCoachName: row.soleCoachId
            ? coachName.get(row.soleCoachId) || 'a coach no longer on file'
            : null,
        })),
      };
    } catch (err) {
      logger.error('Coach change consequence failed:', err);
      return undefined;
    }
  }, [assignmentRows, coaches, pendingChange, teams]);

  const columns = useMemo(() => {
    /** @type {any[]} */
    const cols = [
      {
        key: 'fullName',
        label: 'Coach',
        width: 190,
        sticky: true,
        render: (row) => (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {row.fullName}
            </span>
            {row.canCoachMultipleTeams && (
              <Badge tone="info" square>
                multi
              </Badge>
            )}
          </span>
        ),
      },
      {
        key: 'email',
        label: 'Email',
        width: 210,
        render: (row) =>
          row.email ? (
            <a className="linklike" href={`mailto:${row.email}`}>
              {row.email}
            </a>
          ) : (
            <span className="muted">—</span>
          ),
      },
      { key: 'phone', label: 'Phone', width: 120 },
      {
        key: 'status',
        label: 'Status',
        width: 120,
        editable: canEditCoachRecords,
        type: 'select',
        options: STATUS_OPTIONS,
        render: (row) => (
          <Badge tone={STATUS_TONE[row.status] || 'neutral'}>{row.statusLabel}</Badge>
        ),
        sortVal: (row) => row.statusLabel,
      },
      {
        key: '_programs',
        label: 'Divisions',
        width: 200,
        render: (row) =>
          row._programs ? (
            <span>{row._programs}</span>
          ) : (
            <span className="muted">No divisions</span>
          ),
      },
      {
        key: '_teams',
        label: 'Teams',
        width: 170,
        render: (row) => row._teams || <span className="muted">Unassigned</span>,
      },
      {
        key: 'lastImportedLabel',
        label: 'Last import',
        width: 130,
        sortVal: (row) => row.lastImportedAt || '',
      },
    ];
    return cols;
  }, [canEditCoachRecords]);

  if (loading) return <LoadingScreen />;

  return (
    <Page
      flush
      header={
        <PageHeader
          title="Coaches"
          subtitle={`${summary.total} coaches · ${summary.registered} registered · ${summary.interested} interested · ${summary.unassigned} unassigned`}
          icon={
            <span className="page-obj-icon" style={{ background: 'var(--accent-teal)' }}>
              <Users size={20} aria-hidden="true" />
            </span>
          }
        />
      }
    >
      {error && (
        <div className="badge danger" role="alert" style={{ margin: 12 }}>
          {error}
        </div>
      )}
      <DataGrid
        label="Coaches grid"
        columns={columns}
        rows={rows}
        selectable={canEditCoachRecords}
        selected={selected}
        setSelected={setSelected}
        search={search}
        setSearch={setSearch}
        searchKeys={['fullName', 'email', 'phone', 'statusLabel', '_programs', '_teams']}
        onCellChange={canEditCoachRecords ? handleCellChange : undefined}
        rowActions={
          canManageCoaches
            ? [
                { id: 'teams', label: 'Manage teams', icon: Users },
                ...(isDemo
                  ? []
                  : [{ id: 'delete', label: 'Delete coach', icon: Trash2, danger: true }]),
              ]
            : []
        }
        onRowAction={(action, row) => {
          if (action === 'teams') {
            setAssignTeamId('');
            setManageCoachId(row.id);
          } else if (action === 'delete') {
            if (
              window.confirm(
                `Delete ${row.fullName}? Their teams will be left without a coach. This cannot be undone.`
              )
            ) {
              handleDeleteCoaches([row.id]);
            }
          }
        }}
        toolbar={
          <>
            <select
              className="select"
              style={{ width: 150, height: 32 }}
              aria-label="Filter by status"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              {STATUS_FILTERS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <select
              className="select"
              style={{ width: 160, height: 32 }}
              aria-label="Filter by division"
              value={divisionFilter}
              onChange={(event) => setDivisionFilter(event.target.value)}
            >
              <option value="all">All divisions</option>
              {divisions.map((division) => (
                <option key={division.id} value={division.id}>
                  {divisionDisplayName(division.name, genderModel)}
                </option>
              ))}
            </select>
          </>
        }
        bulkActions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={ShieldCheck}
              disabled={busy}
              onClick={() => handleBulkStatusChange('active')}
            >
              Set Registered
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={UserRoundCheck}
              disabled={busy}
              onClick={() => handleBulkStatusChange('interested')}
            >
              Set Interested
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={Clock}
              disabled={busy}
              onClick={() => handleBulkStatusChange('inactive')}
            >
              Set Inactive
            </Button>
            <Button
              variant="ghost-danger"
              size="sm"
              icon={Trash2}
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    `Delete ${selected.size} coach${selected.size === 1 ? '' : 'es'}? Their teams will be left without a coach. This cannot be undone.`
                  )
                ) {
                  handleDeleteCoaches([...selected]);
                }
              }}
            >
              Delete
            </Button>
          </>
        }
        emptyText="No coaches match the current filters"
      />

      <Modal
        open={Boolean(manageCoach)}
        onClose={() => {
          setPendingChange(null);
          setManageCoachId(null);
        }}
        title={manageCoach ? `Teams — ${manageCoach.fullName}` : 'Teams'}
        footer={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setPendingChange(null);
              setManageCoachId(null);
            }}
          >
            Done
          </Button>
        }
      >
        {manageCoach && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <div className="muted" style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                Assigned teams
              </div>
              {manageCoach.teams.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {manageCoach.teams.map((team) => (
                    <div key={team.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ flex: 1 }}>{team.name}</span>
                      <Button
                        variant="ghost-danger"
                        size="sm"
                        icon={UserMinus}
                        disabled={busy}
                        onClick={() => handleUnassignTeam(team)}
                        aria-label={`Unassign ${manageCoach.fullName} from ${team.name}`}
                      >
                        Unassign
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <span className="muted">Unassigned</span>
              )}
            </div>

            <div>
              <div className="muted" style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                Assign to team
              </div>
              {canAssignCoachToTeam(manageCoach) ? (
                <div style={{ display: 'flex', gap: 8 }}>
                  <select
                    className="select"
                    style={{ flex: 1 }}
                    aria-label={`Assign team to ${manageCoach.fullName}`}
                    value={assignTeamId}
                    onChange={(event) => setAssignTeamId(event.target.value)}
                  >
                    <option value="">Select team</option>
                    {teamAssignmentOptions.map((team) => (
                      <option key={team.value} value={team.value}>
                        {team.label}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="primary"
                    size="sm"
                    icon={CheckCircle2}
                    disabled={!assignTeamId || busy}
                    onClick={handleAssignTeam}
                  >
                    Assign
                  </Button>
                </div>
              ) : (
                <span className="muted">
                  Only Registered or Pending coaches can be assigned to a team.
                </span>
              )}
            </div>

            {pendingChange && (
              <div data-testid="coach-change-preview">
                <ConsequencePreview
                  subject={pendingChange.teamName}
                  operation="reassign"
                  titleId="coach-change-preview-title"
                  coverage={pendingCoverage}
                  repair={repairNotComputed('reassign')}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <Button variant="primary" size="sm" disabled={busy} onClick={handleConfirmChange}>
                    Confirm change
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => setPendingChange(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>
    </Page>
  );
}
