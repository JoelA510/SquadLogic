import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarOff, Plus, Trash2 } from 'lucide-react';
import {
  CLOSURE_SOURCE,
  findBlackoutConflicts,
  minutesToClock,
} from '@squadlogic/core/fieldAdmin/index.js';
import Page from '../components/chrome/Page.jsx';
import PageHeader from '../components/chrome/PageHeader.jsx';
import DataGrid from '../components/grid/DataGrid.jsx';
import Badge from '../components/ui/Badge.jsx';
import Button from '../components/ui/Button.jsx';
import BlackoutEditor from '../components/setup/BlackoutEditor.jsx';
import { useFields } from '../hooks/useFields.js';
import { useFieldClosures } from '../hooks/useFieldClosures.js';
import { supabase } from '../lib/supabaseClient.js';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { logger } from '../lib/logger.js';
import { toClosureInputs, toFieldBookings } from '../utils/fieldBookings.js';
import { todayIso } from '../utils/today.js';
import LoadingScreen from '../components/LoadingScreen.jsx';

/**
 * Blackout Dates — every closure over the club's ground, and the place an
 * administrator adds and removes one.
 *
 * **Reads `public.field_closures`, the single reader.** Windows authored here
 * (`field_blackouts`) and windows that arrived with a field-availability import
 * (`field_blackout_windows`) both appear, each labelled with its source. Only
 * the first kind is removable: the import table is FROZEN and no RPC deletes
 * from it, so a delete control on one of its rows would be a button that
 * cannot work. The row says why instead.
 *
 * The page used to read the import's windows through the availability-profile
 * embed on `useFields`. That embed is still what Fields & Venues uses to review
 * what an import SAID; this page asks the different question of what is CLOSED,
 * and that has exactly one answer.
 */
export default function BlackoutsPage() {
  const { locations, fields, loading: fieldsLoading, error: fieldsError } = useFields();
  const {
    closures,
    loading: closuresLoading,
    error,
    createBlackout,
    removeBlackout,
  } = useFieldClosures();
  const { currentOrganization } = useOrganization();
  const [search, setSearch] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [actionError, setActionError] = useState(/** @type {string|null} */ (null));
  const [bookings, setBookings] = useState({ dated: [], recurring: [], unreadable: [] });

  const loadBookings = useCallback(async () => {
    if (!currentOrganization?.id) {
      setBookings({ dated: [], recurring: [], unreadable: [] });
      return;
    }
    try {
      const [{ data: gameSlots, error: gameError }, { data: practiceSlots, error: practiceError }] =
        await Promise.all([
          supabase
            .from('game_slots')
            // No division embed: the label this page shows is generic and a
            // nested read here would be a second shape to keep in step for
            // nothing. `GameSchedulingPage` already loads the division and
            // `toFieldBookings` uses it there.
            .select('id, field_id, slot_date, start_time, end_time')
            .eq('organization_id', currentOrganization.id),
          supabase
            .from('practice_slots')
            .select('id, field_id, day_of_week, start_time, end_time, valid_from, valid_until')
            .eq('organization_id', currentOrganization.id),
        ]);
      if (gameError) throw gameError;
      if (practiceError) throw practiceError;
      setBookings(
        toFieldBookings({ gameSlots: gameSlots || [], practiceSlots: practiceSlots || [] })
      );
    } catch (err) {
      logger.error('Error fetching bookings for the blackout preview:', err);
      setBookings({ dated: [], recurring: [], unreadable: [] });
    }
  }, [currentOrganization?.id]);

  useEffect(() => {
    loadBookings();
  }, [loadBookings]);

  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  useEffect(() => {
    if (!fieldsLoading && !closuresLoading) setHasLoadedOnce(true);
  }, [fieldsLoading, closuresLoading]);

  const fieldRows = useMemo(
    () =>
      (fields || []).map((field) => ({
        id: String(field.id),
        locationId: field.location_id ? String(field.location_id) : null,
      })),
    [fields]
  );

  const nameOfField = useMemo(
    () => new Map((fields || []).map((field) => [String(field.id), field.name])),
    [fields]
  );
  const nameOfLocation = useMemo(
    () => new Map((locations || []).map((location) => [String(location.id), location.name])),
    [locations]
  );

  /** How many existing bookings each closure covers. One run, all closures. */
  const conflictsByClosure = useMemo(() => {
    const { findings } = findBlackoutConflicts({
      closures: toClosureInputs(closures),
      fields: fieldRows,
      dated: bookings.dated,
      recurring: bookings.recurring,
    });
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const finding of findings) {
      const key = String(finding.details.closureId);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [closures, fieldRows, bookings]);

  const rows = useMemo(
    () =>
      closures.map((closure) => ({
        id: closure.id,
        ground:
          closure.closesFieldId !== null
            ? (nameOfField.get(closure.closesFieldId) ?? 'Unknown field')
            : closure.closesLocationId !== null
              ? `${nameOfLocation.get(closure.closesLocationId) ?? 'Unknown venue'} (whole venue)`
              : 'Unattributed — no field resolved',
        from: closure.blackoutFrom,
        until: closure.blackoutUntil,
        hours:
          closure.startMinutes === null
            ? 'All day'
            : `${minutesToClock(closure.startMinutes)}–${minutesToClock(closure.endMinutes)}`,
        reason: closure.reason ?? closure.sourceReasonText ?? '',
        source: closure.source,
        conflicts: conflictsByClosure.get(closure.id) ?? 0,
        closure,
      })),
    [closures, nameOfField, nameOfLocation, conflictsByClosure]
  );

  const onRemove = useCallback(
    async (closure) => {
      setActionError(null);
      try {
        await removeBlackout(closure);
        await loadBookings();
      } catch (err) {
        setActionError(err?.message || 'The blackout could not be removed.');
      }
    },
    // `removeBlackout` is rebuilt on every render of the hook, so this callback
    // is too. That is deliberate: memoising it against a stale `[]` would have
    // frozen the organisation it closes over at whatever it was on the first
    // render -- which is null while the org context is still loading.
    [removeBlackout, loadBookings]
  );

  const onCreate = async (draft) => {
    setActionError(null);
    const created = await createBlackout(draft);
    await loadBookings();
    return created;
  };

  const columns = useMemo(
    () =>
      /** @type {any[]} */ ([
        { key: 'ground', label: 'Ground', width: 220 },
        { key: 'from', label: 'From', width: 110 },
        { key: 'until', label: 'Until', width: 110 },
        { key: 'hours', label: 'Hours', width: 120 },
        { key: 'reason', label: 'Reason', width: 180, placeholder: 'No reason given' },
        {
          key: 'conflicts',
          label: 'Bookings closed',
          width: 130,
          render: (row) =>
            row.conflicts > 0 ? (
              <Badge tone="danger">{row.conflicts}</Badge>
            ) : (
              <span className="text-text-muted">0</span>
            ),
        },
        {
          key: 'source',
          label: 'Source',
          width: 150,
          render: (row) => (
            <Badge tone={row.source === CLOSURE_SOURCE.ADMIN ? 'info' : 'neutral'}>
              {row.source === CLOSURE_SOURCE.ADMIN ? 'entered here' : 'from an import'}
            </Badge>
          ),
        },
        {
          key: 'actions',
          label: 'Actions',
          width: 120,
          render: (row) =>
            row.source === CLOSURE_SOURCE.ADMIN ? (
              <Button
                variant="ghost-danger"
                size="sm"
                icon={Trash2}
                onClick={() => onRemove(row.closure)}
                aria-label={`Remove the blackout on ${row.ground} from ${row.from}`}
              >
                Remove
              </Button>
            ) : (
              <span
                className="text-text-muted"
                title="Import-owned windows are changed by the import"
              >
                import-owned
              </span>
            ),
        },
      ]),
    [onRemove]
  );

  // **Only on the FIRST load.** `useFieldClosures.refresh` sets `loading` on
  // every call and both writes await it, so gating the whole page on it
  // unmounted the open editor mid-submit -- the `setForm`/`setIssues` after the
  // await then ran against a component that no longer existed, and every
  // Remove flashed the spinner. The E2E step could not catch it either: it
  // asserts the dialog is gone after Save, which a full-page spinner satisfies.
  if (!hasLoadedOnce) return <LoadingScreen />;

  return (
    <Page
      flush
      header={
        <PageHeader
          title="Blackout Dates"
          subtitle={
            <>
              Every closure over the club&apos;s ground — entered here, or arrived with an import on{' '}
              <Link to="/fields" className="linklike">
                Fields &amp; Venues
              </Link>
              .
            </>
          }
          icon={
            <span className="page-obj-icon" style={{ background: 'var(--accent-rose)' }}>
              <CalendarOff size={20} aria-hidden="true" />
            </span>
          }
          actions={
            <Button variant="primary" icon={Plus} onClick={() => setEditorOpen(true)}>
              Add blackout
            </Button>
          }
        />
      }
    >
      {/*
        **Both reads, not just the closures one.** A failed `useFields` read
        leaves every row reading "Unknown field" and, worse, empties the field
        registry -- so every venue-scoped closure reports 0 conflicts, because
        `closureReachesField` refuses ground the registry does not hold. A
        clean-looking grid built on a failed read is the exact shape this phase
        keeps finding.
      */}
      {[fieldsError, error].filter(Boolean).map((message) => (
        <div key={message} className="badge danger" role="alert" style={{ margin: 12 }}>
          {message}
        </div>
      ))}
      {actionError && (
        <div className="badge danger" role="alert" style={{ margin: 12 }}>
          {actionError}
        </div>
      )}
      {bookings.unreadable.length > 0 && (
        <div className="badge warning" role="status" style={{ margin: 12 }}>
          {bookings.unreadable.length} booking(s) could not be placed on a calendar and are not
          counted in the conflict totals below.
        </div>
      )}
      <DataGrid
        label="Blackout windows grid"
        columns={columns}
        rows={rows}
        selectable={false}
        search={search}
        setSearch={setSearch}
        searchKeys={['ground', 'reason', 'from', 'until', 'source']}
        emptyText="No closures on file — add one, or import field availability"
      />
      {editorOpen && (
        <BlackoutEditor
          open={editorOpen}
          onClose={() => setEditorOpen(false)}
          onCreate={onCreate}
          locations={locations || []}
          fields={fields || []}
          dated={bookings.dated}
          recurring={bookings.recurring}
          defaultDate={todayIso()}
        />
      )}
    </Page>
  );
}
