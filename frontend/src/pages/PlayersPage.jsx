import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Clock, ExternalLink, Trash2, User, UserPlus } from 'lucide-react';
import Page from '../components/chrome/Page.jsx';
import PageHeader from '../components/chrome/PageHeader.jsx';
import DataGrid from '../components/grid/DataGrid.jsx';
import Button from '../components/ui/Button.jsx';
import Badge from '../components/ui/Badge.jsx';
import { useToast } from '../components/ui/ToastHost.jsx';
import { usePlayersData } from '../hooks/usePlayersData.js';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { useFeatures } from '../hooks/useFeatures.js';
import { FEATURE_FLAGS } from '../constants/featureFlags.js';
import { divisionDisplayName, divisionFilters } from '../utils/divisions.js';
import { STATUS_TONE } from '../constants/playerStatus.js';
import LoadingScreen from '../components/LoadingScreen.jsx';
import { useDemo } from '../hooks/useDemo.js';
import { canEditPlayerField } from '../lib/demo.js';

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'pending', label: 'Pending' },
  { value: 'inactive', label: 'Inactive' },
];

const BOOL_OPTIONS = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
];

function boolCell(value) {
  return value ? (
    <Check size={15} aria-label="Yes" style={{ color: 'var(--success)' }} />
  ) : (
    <span className="muted">—</span>
  );
}

/**
 * Players roster — the Excel-grade flagship grid. Columns are feature-gated
 * via the org feature config; all edits flow through the audited admin RPCs
 * with optimistic UI.
 */
export default function PlayersPage() {
  const {
    players,
    divisions,
    loading,
    error,
    updatePlayer,
    bulkUpdatePlayers,
    createPlayer,
    deletePlayers,
  } = usePlayersData();
  const { isEnabled, genderModel } = useFeatures();
  // A demo's people are read-only except where they play and how they are rated (D3 fences them on
  // the server; this hides the controls the server would refuse): no names, gender or buddy
  // request edits, no new players, no deletes.
  const { isDemo } = useDemo();
  const toast = useToast();
  const navigate = useNavigate();

  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  // The rows selected belong to the season they were selected in: a bulk Waitlist or Delete after
  // a switch must not carry them to the season now shown (20261108010000).
  const { currentSeasonSetting } = useOrganization();
  const seasonId = currentSeasonSetting?.id ?? null;
  const [selectionSeason, setSelectionSeason] = useState(seasonId);
  if (selectionSeason !== seasonId) {
    // Adjusted while rendering (React's way to reset state when a value changes), so the first
    // render of the new season never holds the old selection.
    setSelectionSeason(seasonId);
    setSelected(new Set());
  }
  const [divisionFilter, setDivisionFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  const waitlistOn = isEnabled(FEATURE_FLAGS.WAITLIST);

  const statusOptions = useMemo(
    () =>
      waitlistOn ? [...STATUS_OPTIONS, { value: 'waitlist', label: 'Waitlist' }] : STATUS_OPTIONS,
    [waitlistOn]
  );

  const divisionOptions = useMemo(
    () => divisionFilters(divisions, genderModel),
    [divisions, genderModel]
  );

  const divisionNameById = useMemo(() => {
    const map = new Map();
    divisions.forEach((division) => {
      map.set(division.id, divisionDisplayName(division.name, genderModel));
    });
    return map;
  }, [divisions, genderModel]);

  const rows = useMemo(() => {
    let list = players;
    if (divisionFilter !== 'all') {
      const option = divisionOptions.find((entry) => entry.key === divisionFilter);
      const ids = new Set(option?.divisionIds || []);
      list = list.filter((player) => ids.has(player.division_id));
    }
    if (statusFilter !== 'all') {
      list = list.filter((player) => (player.status || 'active') === statusFilter);
    }
    // Search keys need flat values; precompute the display name.
    return list.map((player) => ({
      ...player,
      _name: `${player.first_name || ''} ${player.last_name || ''}`.trim(),
      _division: divisionNameById.get(player.division_id) || '',
    }));
  }, [players, divisionFilter, statusFilter, divisionOptions, divisionNameById]);

  const report = (result, successMessage) => {
    if (result.success) {
      if (successMessage) toast(successMessage, 'success');
    } else {
      toast(result.error || 'Something went wrong', 'warning');
    }
  };

  const handleCellChange = async (playerId, key, value) => {
    /** @type {Record<string, any>} */
    let patch;
    switch (key) {
      case '_name': {
        const [first, ...rest] = String(value || '')
          .trim()
          .split(/\s+/);
        if (!first) return;
        patch = { first_name: first };
        if (rest.length > 0) patch.last_name = rest.join(' ');
        break;
      }
      case 'willing_to_coach':
        patch = { [key]: value === 'true' || value === true };
        break;
      case 'division_id':
        patch = { division_id: value || null };
        break;
      default:
        patch = { [key]: value };
    }
    report(await updatePlayer(playerId, patch));
  };

  const columns = useMemo(() => {
    const divisionSelectOptions = divisions.map((division) => ({
      value: division.id,
      label: divisionDisplayName(division.name, genderModel),
    }));
    /** @type {any[]} */
    const cols = [
      {
        key: '_name',
        label: 'Player',
        width: 190,
        sticky: true,
        editable:
          canEditPlayerField(isDemo, 'first_name') && canEditPlayerField(isDemo, 'last_name'),
        render: (row) => (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span className="linklike" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {row._name || <span className="muted">Unnamed</span>}
            </span>
          </span>
        ),
      },
      {
        key: 'gender',
        label: 'Gender',
        width: 80,
        editable: canEditPlayerField(isDemo, 'gender'),
        type: 'select',
        options: [
          { value: 'm', label: 'M' },
          { value: 'f', label: 'F' },
        ],
        optionLabel: (value) => (value ? String(value).toUpperCase() : null),
        center: true,
      },
      {
        key: 'division_id',
        label: 'Division',
        width: 120,
        editable: true,
        type: 'select',
        options: [{ value: '', label: '—' }, ...divisionSelectOptions],
        optionLabel: (value) => divisionNameById.get(value) || null,
        sortVal: (row) => row._division,
      },
      {
        key: 'status',
        label: 'Status',
        width: 110,
        editable: true,
        type: 'select',
        options: statusOptions,
        render: (row) => (
          <Badge tone={STATUS_TONE[row.status] || 'neutral'}>{row.status || 'active'}</Badge>
        ),
      },
    ];
    if (isEnabled(FEATURE_FLAGS.YEARS_PLAYED)) {
      cols.push({
        key: 'years_played',
        label: 'Yrs',
        width: 64,
        editable: true,
        type: 'number',
        num: true,
        min: 0,
        max: 30,
      });
    }
    if (isEnabled(FEATURE_FLAGS.PLAYER_RATING)) {
      cols.push({
        key: 'rating',
        label: 'Rating',
        width: 76,
        editable: true,
        type: 'number',
        num: true,
        min: 1,
        max: 5,
      });
    }
    cols.push({
      key: 'jersey_number',
      label: '#',
      width: 56,
      editable: true,
      type: 'number',
      num: true,
      min: 0,
      max: 999,
    });
    if (isEnabled(FEATURE_FLAGS.BUDDY_REQUESTS)) {
      cols.push({
        key: 'buddy_request',
        label: 'Buddy request',
        width: 160,
        editable: canEditPlayerField(isDemo, 'buddy_request'),
        placeholder: 'None',
      });
    }
    if (isEnabled(FEATURE_FLAGS.COACHING_INTEREST)) {
      cols.push({
        key: 'willing_to_coach',
        label: 'Coach?',
        width: 76,
        editable: true,
        type: 'select',
        options: BOOL_OPTIONS,
        center: true,
        render: (row) => boolCell(row.willing_to_coach),
      });
    }
    return cols;
  }, [divisions, genderModel, divisionNameById, statusOptions, isEnabled, isDemo]);

  if (loading) return <LoadingScreen />;

  // Only players on the page: a selection can never name a row that is not shown.
  const shownIds = new Set(players.map((player) => player.id));
  const selectedIds = [...selected].filter((id) => shownIds.has(id));

  const bulkPatch = async (patch, message) => {
    report(await bulkUpdatePlayers(selectedIds, patch), message);
    setSelected(new Set());
  };

  return (
    <Page
      flush
      header={
        <PageHeader
          title="Players"
          subtitle={`${players.length} registered · ${
            players.filter((player) => player.status === 'waitlist').length
          } waitlisted`}
          icon={
            <span className="page-obj-icon" style={{ background: 'var(--primary)' }}>
              <User size={20} aria-hidden="true" />
            </span>
          }
          actions={
            isDemo ? undefined : (
              <Button
                variant="primary"
                size="sm"
                icon={UserPlus}
                onClick={async () => {
                  const result = await createPlayer({ status: 'pending' });
                  report(result, result.success ? 'Player added — name them in the grid' : null);
                }}
              >
                Add player
              </Button>
            )
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
        label="Players grid"
        columns={columns}
        rows={rows}
        selected={selected}
        setSelected={setSelected}
        search={search}
        setSearch={setSearch}
        searchKeys={['_name', '_division', 'buddy_request', 'status']}
        onCellChange={handleCellChange}
        onAddRow={
          isDemo
            ? undefined
            : async () => {
                const result = await createPlayer({ status: 'pending' });
                report(result, result.success ? 'Player added — name them in the grid' : null);
              }
        }
        addLabel="Add player"
        rowActions={[
          { id: 'open', label: 'Open record', icon: ExternalLink },
          ...(isDemo ? [] : [{ id: 'delete', label: 'Delete player', icon: Trash2, danger: true }]),
        ]}
        onRowAction={async (action, row) => {
          if (action === 'open') {
            navigate(`/players/${row.id}`);
          } else if (action === 'delete') {
            report(await deletePlayers([row.id]), 'Player deleted');
          }
        }}
        toolbar={
          <>
            <select
              className="select"
              style={{ width: 150, height: 32 }}
              aria-label="Filter by division"
              value={divisionFilter}
              onChange={(event) => setDivisionFilter(event.target.value)}
            >
              <option value="all">All divisions</option>
              {divisionOptions.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
            <select
              className="select"
              style={{ width: 130, height: 32 }}
              aria-label="Filter by status"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="all">All statuses</option>
              {statusOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </>
        }
        bulkActions={
          <>
            {waitlistOn && (
              <Button
                variant="secondary"
                size="sm"
                icon={Clock}
                onClick={() => bulkPatch({ status: 'waitlist' }, 'Moved to waitlist')}
              >
                Waitlist
              </Button>
            )}
            {!isDemo && (
              <Button
                variant="ghost-danger"
                size="sm"
                icon={Trash2}
                onClick={async () => {
                  if (
                    window.confirm(`Delete ${selectedIds.length} players? This cannot be undone.`)
                  ) {
                    report(await deletePlayers(selectedIds), 'Players deleted');
                    setSelected(new Set());
                  }
                }}
              >
                Delete
              </Button>
            )}
          </>
        }
        emptyText="No players yet — import registrations or add players manually"
      />
    </Page>
  );
}
