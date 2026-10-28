import React, { useEffect, useId, useState } from 'react';
import { useOrganization } from '../../../contexts/OrganizationContext.jsx';
import { usePermission } from '../../../hooks/usePermission.js';
import { useSeasonAdmin } from '../../../hooks/useSeasonAdmin.js';
import { supabase } from '../../../lib/supabaseClient.js';
import { CUTOFF_MODES, CutoffSchema } from '../../../utils/seasonSchemas.js';
import Badge from '../../ui/Badge.jsx';
import Button from '../../ui/Button.jsx';
import Modal from '../../ui/Modal.jsx';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const STATUS_TONE = { active: 'success', draft: 'info', completed: 'neutral' };
const STATUS_LABEL = { active: 'Active', draft: 'Draft', completed: 'Completed' };

/** The database refuses an age rule change while a player import into the season is unfinished. */
const PENDING_IMPORT_TEXT =
  'A player import into this season is still waiting to be applied. Finish or cancel the pending import first, then change the age cutoff, season year or division window.';

const inputClass =
  'w-full bg-bg-surface border border-border-subtle rounded-lg px-3 py-2 text-text-primary focus:outline-none focus:border-brand-400 transition-colors disabled:opacity-60';

/** "Sep 1, 2026" from an ISO date, without a time zone shifting the day. */
function formatDate(value) {
  if (!value) return null;
  const [y, m, d] = String(value).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  return `${MONTHS[m - 1].slice(0, 3)} ${d}, ${y}`;
}

/** The season's dates in words, or why there are none. */
function datesOf(season) {
  const start = formatDate(season.season_start);
  const end = formatDate(season.season_end);
  if (start && end) return `${start} to ${end}`;
  if (start) return `Starts ${start}, no end date`;
  if (end) return `Ends ${end}, no start date`;
  return 'Dates not set';
}

/** The age cutoff in words. */
function describeCutoff(season) {
  if (season?.age_cutoff_mode === CUTOFF_MODES.CALENDAR_YEAR) return 'Calendar year (Jan 1)';
  if (season?.age_cutoff_mode === CUTOFF_MODES.CUSTOM) {
    const month = MONTHS[(season.age_cutoff_month ?? 0) - 1];
    return month ? `Custom: ${month} ${season.age_cutoff_day}` : 'Custom';
  }
  return 'School year (Aug 1)';
}

/** What stops a draft being activated, in words; empty when nothing does. */
function activationBlockers(season) {
  const out = [];
  if (!season.timezone) out.push('a timezone');
  if (!season.season_start || !season.season_end) out.push('a start and an end date');
  else if (season.season_end < season.season_start) out.push('an end date after the start');
  if (season.season_year == null) out.push('a season year');
  return out;
}

/**
 * Settings > Season > Seasons (Phase E3b; plans `docs/changes/2026-10-22-phase-e-seasons.md` and
 * `docs/changes/2026-10-27-season-enrollment.md`, C3).
 *
 * Lists the organization's seasons with their status. An admin starts the next season from any of
 * them (its divisions and programs are copied; no player, coach or team: a new season starts from its
 * own registration import), edits a draft (name, dates, the year the season starts, the age cutoff
 * and each division's optional birth-date window) and activates it, which completes the season that
 * was active. A completed season is history: it can be started from, never edited or activated again.
 *
 * Each change is one call to an audited admin RPC (`useSeasonAdmin`); a refusal is shown in the
 * database's words.
 *
 * @param {{ seasonFormat?: 'single' | 'dual' }} props - how a suggested season name is written
 */
export default function SeasonsSection({ seasonFormat = 'single' }) {
  const { PERMISSIONS, can } = usePermission();
  const { availableSeasons = [], currentSeasonSetting, switchSeason } = useOrganization();
  const { createFrom, updateSeason, setDivisionWindow, activate } = useSeasonAdmin();
  const headingId = useId();
  const [starting, setStarting] = useState(/** @type {any} */ (null));
  const [editing, setEditing] = useState(/** @type {any} */ (null));
  const [activating, setActivating] = useState(/** @type {any} */ (null));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(
    /** @type {{ tone: 'ok' | 'error', text: string } | null} */ (null)
  );
  const canEdit = can(PERMISSIONS.MANAGE_ORGANIZATION);

  const seasons = availableSeasons;
  if (seasons.length === 0) return null;

  const activeSeason = seasons.find((s) => s.status === 'active') ?? null;

  const run = async (action, success) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await action();
      setMessage({ tone: 'ok', text: success });
      return result ?? true;
    } catch (err) {
      const text =
        err?.detail === 'import_pending'
          ? PENDING_IMPORT_TEXT
          : err?.issues?.[0]?.message || err?.message || 'The change could not be saved.';
      setMessage({ tone: 'error', text });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const onStart = async (event) => {
    event.preventDefault();
    const { source, name, year, start, end } = starting;
    const created = await run(
      () => createFrom(source.id, { name, year, start, end }),
      `Draft season "${name.trim()}" created from "${source.name}". Choose it in the header's season menu to import its registrations.`
    );
    if (created) setStarting(null);
  };

  const onActivate = async () => {
    const target = activating;
    const done = await run(
      () => activate(target.id),
      `"${target.name}" is now the active season${activeSeason ? `; "${activeSeason.name}" is completed` : ''}.`
    );
    if (done) {
      setActivating(null);
      // The header follows the season that is now live.
      switchSeason({ ...target, status: 'active' });
    }
  };

  return (
    <section
      aria-labelledby={headingId}
      className="space-y-4 border-t border-border-subtle pt-6"
      data-testid="seasons-section"
    >
      <div>
        <h3 id={headingId} className="text-base font-semibold text-text-primary">
          Seasons
        </h3>
        <p className="mt-1 text-sm text-text-secondary">
          Start next season from this one: its divisions and programs are copied, and no players,
          coaches or teams. A new season is a draft until you activate it; import its registrations
          into the draft first. Activating a draft completes the active season, and a completed
          season cannot be edited or activated again.
        </p>
      </div>

      <div aria-live="polite" className="min-h-[1.25rem] text-sm">
        {message && (
          <span
            className={message.tone === 'error' ? 'text-status-error-text' : 'text-text-secondary'}
            role={message.tone === 'error' ? 'alert' : undefined}
          >
            {message.text}
          </span>
        )}
      </div>

      <ul className="space-y-3" aria-label="Seasons of this league">
        {seasons.map((season) => {
          const draft = season.status === 'draft';
          const completed = season.status === 'completed';
          const blockers = draft ? activationBlockers(season) : [];
          return (
            <li
              key={season.id}
              className="rounded-lg border border-border-subtle bg-bg-surface p-4 space-y-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="font-medium text-text-primary">
                  {season.name}
                  {currentSeasonSetting?.id === season.id && (
                    <span className="ml-2 text-xs font-normal text-text-muted">(shown)</span>
                  )}
                </h4>
                <Badge tone={STATUS_TONE[season.status] ?? 'neutral'} dot>
                  {STATUS_LABEL[season.status] ?? season.status}
                </Badge>
              </div>
              <p className="text-sm text-text-secondary">
                {season.season_year ? `Season year ${season.season_year}. ` : ''}
                {datesOf(season)}. Age cutoff: {describeCutoff(season)}.
              </p>
              {draft && blockers.length > 0 && (
                <p className="text-sm text-text-muted">
                  To activate it, set {blockers.join(', ')}.
                </p>
              )}
              {canEdit && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    aria-label={`Start next season from ${season.name}`}
                    onClick={() => {
                      const year = (season.season_year ?? new Date().getFullYear()) + 1;
                      setStarting({
                        source: season,
                        name: seasonFormat === 'dual' ? `${year}-${year + 1}` : String(year),
                        year: String(year),
                        start: '',
                        end: '',
                      });
                    }}
                  >
                    Start next season from this
                  </Button>
                  {!completed && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      aria-label={`Edit ${season.name}`}
                      onClick={() => setEditing(season)}
                    >
                      Edit
                    </Button>
                  )}
                  {draft && (
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy || blockers.length > 0}
                      aria-label={`Activate ${season.name}`}
                      onClick={() => setActivating(season)}
                    >
                      Activate
                    </Button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <StartSeasonDialog
        starting={starting}
        setStarting={setStarting}
        onSubmit={onStart}
        busy={busy}
      />
      <EditSeasonDialog
        season={editing}
        onClose={() => setEditing(null)}
        updateSeason={updateSeason}
        setDivisionWindow={setDivisionWindow}
        run={run}
        busy={busy}
      />
      <Modal
        open={Boolean(activating)}
        onClose={() => setActivating(null)}
        title="Activate season"
        footer={
          <>
            <Button variant="ghost" onClick={() => setActivating(null)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy} onClick={onActivate}>
              Activate
            </Button>
          </>
        }
      >
        {activating && (
          <p className="text-sm text-text-secondary">
            {`Activating "${activating.name}" makes it the season everyone works in.`}
            {activeSeason
              ? ` "${activeSeason.name}" is completed: its players, coaches and teams stay, read only, and it cannot be activated again.`
              : ''}
          </p>
        )}
      </Modal>
    </section>
  );
}

function StartSeasonDialog({ starting, setStarting, onSubmit, busy }) {
  const nameId = useId();
  const yearId = useId();
  const startId = useId();
  const endId = useId();
  if (!starting) return null;
  const set = (key) => (e) => setStarting({ ...starting, [key]: e.target.value });
  return (
    <Modal
      open
      onClose={() => setStarting(null)}
      title="Start next season"
      footer={
        <>
          <Button variant="ghost" onClick={() => setStarting(null)}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="start-season-form"
            variant="primary"
            disabled={busy || starting.name.trim() === ''}
          >
            Create draft season
          </Button>
        </>
      }
    >
      <form id="start-season-form" onSubmit={onSubmit} className="space-y-4">
        <p className="text-sm text-text-secondary">
          {`Copies the divisions and programs of "${starting.source.name}" into a new draft. Players, coaches and teams are not copied: the new season starts from its own registration import.`}
        </p>
        <div>
          <label htmlFor={nameId} className="block text-sm font-medium text-text-secondary mb-1">
            Season name
          </label>
          <input
            id={nameId}
            type="text"
            value={starting.name}
            maxLength={80}
            onChange={set('name')}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor={yearId} className="block text-sm font-medium text-text-secondary mb-1">
            Season year (the year the season starts)
          </label>
          <input
            id={yearId}
            type="number"
            inputMode="numeric"
            min={2000}
            max={2100}
            value={starting.year}
            onChange={set('year')}
            className={inputClass}
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor={startId} className="block text-sm font-medium text-text-secondary mb-1">
              Start date (optional)
            </label>
            <input
              id={startId}
              type="date"
              value={starting.start}
              onChange={set('start')}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor={endId} className="block text-sm font-medium text-text-secondary mb-1">
              End date (optional)
            </label>
            <input
              id={endId}
              type="date"
              value={starting.end}
              onChange={set('end')}
              className={inputClass}
            />
          </div>
        </div>
        <p className="text-sm text-text-muted">
          Each division&apos;s birth-date window, if it has one, moves by the difference in season
          years.
        </p>
      </form>
    </Modal>
  );
}

function EditSeasonDialog({ season, onClose, updateSeason, setDivisionWindow, run, busy }) {
  const nameId = useId();
  const yearId = useId();
  const startId = useId();
  const endId = useId();
  const modeId = useId();
  const monthId = useId();
  const dayId = useId();
  const [form, setForm] = useState(/** @type {any} */ (null));
  const [hasPlayers, setHasPlayers] = useState(/** @type {boolean | null} */ (null));
  const [divisions, setDivisions] = useState(/** @type {any[]} */ ([]));
  const [windows, setWindows] = useState(
    /** @type {Record<string, { start: string, end: string }>} */ ({})
  );
  const [problem, setProblem] = useState(/** @type {string | null} */ (null));

  const seasonId = season?.id ?? null;
  useEffect(() => {
    if (!season) {
      setForm(null);
      return undefined;
    }
    setForm({
      name: season.name ?? '',
      year: season.season_year == null ? '' : String(season.season_year),
      start: season.season_start ?? '',
      end: season.season_end ?? '',
      mode: season.age_cutoff_mode ?? CUTOFF_MODES.SCHOOL_YEAR,
      month: season.age_cutoff_month == null ? '' : String(season.age_cutoff_month),
      day: season.age_cutoff_day == null ? '' : String(season.age_cutoff_day),
    });
    setProblem(null);
    setHasPlayers(null);
    let cancelled = false;
    (async () => {
      const [playerRead, divisionRead] = await Promise.all([
        supabase.from('players').select('id').eq('season_settings_id', season.id).limit(1),
        supabase
          .from('divisions')
          .select('id, name, birthdate_start, birthdate_end')
          .eq('season_settings_id', season.id)
          .order('name', { ascending: true }),
      ]);
      if (cancelled) return;
      setHasPlayers((playerRead.data ?? []).length > 0);
      const rows = divisionRead.data ?? [];
      setDivisions(rows);
      setWindows(
        Object.fromEntries(
          rows.map((d) => [d.id, { start: d.birthdate_start ?? '', end: d.birthdate_end ?? '' }])
        )
      );
    })();
    return () => {
      cancelled = true;
    };
    // A re-read of the same season (after a save) must not reset what the admin is typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seasonId]);

  if (!season || !form) return null;
  const draft = season.status === 'draft';
  // The age rule counts every player's age: once the season has players it is fixed.
  const ruleLocked = !draft || hasPlayers !== false;
  const windowsLocked = hasPlayers !== false;
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  const onSave = async (event) => {
    event.preventDefault();
    setProblem(null);
    /** @type {Record<string, any>} */
    const patch = {};
    if (form.name.trim() !== season.name) patch.name = form.name;
    if ((form.start || null) !== (season.season_start ?? null))
      patch.season_start = form.start || null;
    if ((form.end || null) !== (season.season_end ?? null)) patch.season_end = form.end || null;
    if (draft && !ruleLocked) {
      if (String(form.year) !== String(season.season_year ?? '')) {
        if (form.year === '') {
          setProblem('Enter the year the season starts.');
          return;
        }
        patch.season_year = Number(form.year);
      }
      const cutoff = CutoffSchema.safeParse({
        mode: form.mode,
        month: form.month === '' ? null : form.month,
        day: form.day === '' ? null : form.day,
      });
      if (!cutoff.success) {
        setProblem(cutoff.error.issues[0]?.message ?? 'The age cutoff is not valid.');
        return;
      }
      const next = cutoff.data;
      const month = next.mode === CUTOFF_MODES.CUSTOM ? next.month : null;
      const day = next.mode === CUTOFF_MODES.CUSTOM ? next.day : null;
      if (
        next.mode !== (season.age_cutoff_mode ?? CUTOFF_MODES.SCHOOL_YEAR) ||
        month !== (season.age_cutoff_month ?? null) ||
        day !== (season.age_cutoff_day ?? null)
      ) {
        patch.age_cutoff_mode = next.mode;
        patch.age_cutoff_month = month;
        patch.age_cutoff_day = day;
      }
    }
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    const saved = await run(() => updateSeason(season.id, patch), `"${form.name.trim()}" saved.`);
    if (saved) onClose();
  };

  const saveWindow = (division, clear) => {
    const w = windows[division.id] ?? { start: '', end: '' };
    return run(
      () => setDivisionWindow(division.id, clear ? null : w.start, clear ? null : w.end),
      clear ? `${division.name}: window cleared.` : `${division.name}: window saved.`
    ).then((ok) => {
      if (ok && clear) setWindows((all) => ({ ...all, [division.id]: { start: '', end: '' } }));
      if (ok) {
        setDivisions((rows) =>
          rows.map((row) =>
            row.id === division.id
              ? {
                  ...row,
                  birthdate_start: clear ? null : w.start,
                  birthdate_end: clear ? null : w.end,
                }
              : row
          )
        );
      }
    });
  };

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={`Edit ${season.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="edit-season-form"
            variant="primary"
            disabled={busy || form.name.trim() === ''}
          >
            Save season
          </Button>
        </>
      }
    >
      <form id="edit-season-form" onSubmit={onSave} className="space-y-4">
        {problem && (
          <p role="alert" className="text-sm text-status-error-text">
            {problem}
          </p>
        )}
        <div>
          <label htmlFor={nameId} className="block text-sm font-medium text-text-secondary mb-1">
            Season name
          </label>
          <input
            id={nameId}
            type="text"
            value={form.name}
            maxLength={80}
            onChange={set('name')}
            className={inputClass}
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor={startId} className="block text-sm font-medium text-text-secondary mb-1">
              Start date
            </label>
            <input
              id={startId}
              type="date"
              value={form.start}
              onChange={set('start')}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor={endId} className="block text-sm font-medium text-text-secondary mb-1">
              End date
            </label>
            <input
              id={endId}
              type="date"
              value={form.end}
              onChange={set('end')}
              className={inputClass}
            />
          </div>
        </div>
        <div>
          <label htmlFor={yearId} className="block text-sm font-medium text-text-secondary mb-1">
            Season year (the year the season starts)
          </label>
          <input
            id={yearId}
            type="number"
            inputMode="numeric"
            min={2000}
            max={2100}
            value={form.year}
            disabled={ruleLocked}
            onChange={set('year')}
            className={inputClass}
          />
        </div>
        <fieldset className="space-y-3" disabled={ruleLocked}>
          <legend className="block text-sm font-medium text-text-secondary mb-1">Age cutoff</legend>
          <div>
            <label htmlFor={modeId} className="block text-sm text-text-secondary mb-1">
              Cutoff
            </label>
            <select id={modeId} value={form.mode} onChange={set('mode')} className={inputClass}>
              <option value={CUTOFF_MODES.SCHOOL_YEAR}>School year, Aug 1 to Jul 31</option>
              <option value={CUTOFF_MODES.CALENDAR_YEAR}>Calendar year, Jan 1 to Dec 31</option>
              <option value={CUTOFF_MODES.CUSTOM}>Custom date</option>
            </select>
          </div>
          {form.mode === CUTOFF_MODES.CUSTOM && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor={monthId} className="block text-sm text-text-secondary mb-1">
                  Cutoff month
                </label>
                <select
                  id={monthId}
                  value={form.month}
                  onChange={set('month')}
                  className={inputClass}
                >
                  <option value="">Month</option>
                  {MONTHS.map((month, index) => (
                    <option key={month} value={String(index + 1)}>
                      {month}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor={dayId} className="block text-sm text-text-secondary mb-1">
                  Cutoff day
                </label>
                <input
                  id={dayId}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={31}
                  value={form.day}
                  onChange={set('day')}
                  className={inputClass}
                />
              </div>
            </div>
          )}
          <p className="text-sm text-text-muted">
            A player born on or after the cutoff day plays in the younger age group.
          </p>
        </fieldset>
        {ruleLocked && (
          <p className="text-sm text-text-muted">
            {!draft
              ? 'The season year and age cutoff can only change on a draft.'
              : hasPlayers === null
                ? 'Checking whether this season has players…'
                : 'This season has players, and their ages were counted with this rule, so the season year and age cutoff cannot change.'}
          </p>
        )}
      </form>

      {divisions.length > 0 && (
        <div className="mt-6 space-y-2">
          <h3 className="text-sm font-semibold text-text-primary">Division birth-date windows</h3>
          <p className="text-sm text-text-muted">
            Optional. A division with a window takes every player born in it, as that
            division&apos;s age (a U4 that also takes older 2-year-olds).
            {windowsLocked && hasPlayers
              ? ' This season has players, so the windows cannot change.'
              : ''}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" aria-label="Division birth-date windows">
              <thead>
                <tr className="border-b border-border-subtle text-text-secondary">
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Division
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Born from
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Born through
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {divisions.map((division) => {
                  const w = windows[division.id] ?? { start: '', end: '' };
                  const stored = {
                    start: division.birthdate_start ?? '',
                    end: division.birthdate_end ?? '',
                  };
                  const unchanged = w.start === stored.start && w.end === stored.end;
                  return (
                    <tr key={division.id} className="border-b border-border-subtle">
                      <td className="py-2 pr-3 text-text-primary">{division.name}</td>
                      <td className="py-2 pr-3">
                        <input
                          type="date"
                          aria-label={`${division.name}: born from`}
                          value={w.start}
                          disabled={windowsLocked}
                          onChange={(e) =>
                            setWindows({
                              ...windows,
                              [division.id]: { ...w, start: e.target.value },
                            })
                          }
                          className={inputClass}
                        />
                      </td>
                      <td className="py-2 pr-3">
                        <input
                          type="date"
                          aria-label={`${division.name}: born through`}
                          value={w.end}
                          disabled={windowsLocked}
                          onChange={(e) =>
                            setWindows({ ...windows, [division.id]: { ...w, end: e.target.value } })
                          }
                          className={inputClass}
                        />
                      </td>
                      <td className="py-2">
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy || windowsLocked || unchanged}
                            aria-label={`Save the window for ${division.name}`}
                            onClick={() => saveWindow(division, false)}
                          >
                            Save window
                          </Button>
                          {stored.start && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy || windowsLocked}
                              aria-label={`Clear the window for ${division.name}`}
                              onClick={() => saveWindow(division, true)}
                            >
                              Clear
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}
