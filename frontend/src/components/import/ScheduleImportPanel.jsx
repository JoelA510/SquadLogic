import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Papa from 'papaparse';
import { AlertCircle, CheckCircle, Info } from 'lucide-react';
import {
  describeScheduleImportReason,
  describeScheduleImportSkip,
  parseScheduleRows,
  proposeScheduleMapping,
  resolveScheduleRows,
  scheduleImportConfirmCounts,
  SCHEDULE_IMPORT_LIMITS,
} from '@squadlogic/core/scheduleImport/index.js';
import { supabase } from '../../lib/supabaseClient.js';
import { logger } from '../../lib/logger.js';
import { useOrganization } from '../../contexts/OrganizationContext.jsx';
import Button from '../ui/Button.jsx';
import { csvBlob, saveFile } from '../../utils/scheduleDownloads.js';
import {
  confirmGameImport,
  discardGameImport,
  previewGameImport,
  readGameImportLeague,
  readLatestGameImportJob,
  readSavedScheduleCsv,
  readStagedGameRows,
  rollbackGameImport,
  saveGameImportMapping,
  startGameImport,
} from '../../utils/gameImportClient.js';
import {
  MAPPING_GROUPS,
  UNDECIDED,
  choiceOptions,
  decisionsFromChoices,
  entryProblem,
  mappingForJob,
  recordsInScope,
  shownChoice,
} from '../../utils/gameImportMapping.js';

/**
 * The schedule import: upload, mapping, preview, confirm, result, roll back (plan
 * `docs/changes/2026-11-03-schedule-expansion.md` 4.2; PR 6, tasks F2, F7, F8).
 *
 * **One panel, a `kind` per file.** `KINDS` holds what differs between kinds (the words, the file's reader, the calls);
 * the steps, the mapping table and the confirm are the panel's. PR 11 adds the practice schedule as a second entry,
 * not a second panel.
 *
 * **What the admin sees is what the database staged and planned.** The mapping screen reads the rows the Edge function
 * staged (never the browser's own reading of the file); every count on the confirm screen is one function of the dry
 * run's result (`scheduleImportConfirmCounts`), and the same counts are what the confirm sends, so the apply is refused
 * when another admin's change made them untrue (`game_import_preview_stale`).
 *
 * **Nothing is created because nobody decided.** A label with no match opens undecided and its rows are listed as not
 * imported; a record is created only by a choice the admin made, and only after the confirm step listed it and the
 * admin ticked that list.
 */

const KINDS = Object.freeze({
  games: {
    noun: 'games',
    title: 'Import a game schedule',
    intro:
      'Bring in a schedule that already exists. Conflicts in the file are imported and flagged, never refused; a game with no time is kept on its date as TIME TBD.',
    columns:
      'Date, Start Time, End Time (or Length in minutes), Venue, Field, Division, Home Team, Away Team. Optional: Game ID, Week. Any other column is dropped and never stored.',
    parseFile: parseScheduleRows,
    start: startGameImport,
    readStaged: readStagedGameRows,
    readLeague: readGameImportLeague,
    propose: proposeScheduleMapping,
    resolve: resolveScheduleRows,
    saveMapping: saveGameImportMapping,
    preview: previewGameImport,
    confirm: confirmGameImport,
    rollback: rollbackGameImport,
    discard: discardGameImport,
    latest: readLatestGameImportJob,
    exportSaved: readSavedScheduleCsv,
    exportFileName: 'squadlogic-game-schedule.csv',
  },
});

/** How many rows of a list are named on screen; the rest are counted. */
const NAMED = 25;

/** The counts of a preview, in the order and the words the confirm screen shows them. */
const COUNT_ROWS = Object.freeze([
  ['rows.staged', 'Rows in the file'],
  ['rows.games', 'Rows that are placed games'],
  ['rows.time_tbd', 'Rows that are TIME TBD games'],
  ['rows.refused', 'Rows not imported (listed below)'],
  ['rows.skipped', 'Rows skipped by your choice'],
  ['games.inserted', 'Games added'],
  ['games.updated', 'Games changed'],
  ['games.unchanged', 'Games already as the file has them'],
  ['time_tbd.inserted', 'TIME TBD games added'],
  ['time_tbd.updated', 'TIME TBD games changed'],
  ['time_tbd.unchanged', 'TIME TBD games already as the file has them'],
  ['time_tbd.removed', 'TIME TBD games the file now places'],
  ['time_tbd.converted', 'Placed games the file makes TIME TBD'],
  ['created.slots', 'Game slots created'],
  ['not_in_file', 'Games in the schedule that this file does not name (kept as they are)'],
]);
const CREATED_ROWS = Object.freeze([
  ['created.divisions', 'divisions', 'Divisions'],
  ['created.venues', 'venues', 'Venues'],
  ['created.fields', 'fields', 'Fields'],
  ['created.teams', 'teamShells', 'Teams (no players or coach yet)'],
  ['created.outside_teams', 'outsideTeams', 'Outside clubs'],
]);

/** A warning or reason code in words; a code this build has no words for is shown as it is, never hidden. */
function words(code) {
  try {
    return describeScheduleImportReason(code);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return code;
  }
}

/**
 * A warning of the preview or the result as one line: where it is (a row of the file, a field, a team, by name) and
 * what it is, in words. The database names a field and a team by id; the league read for the mapping names them.
 *
 * @param {{ type: string, message?: string, details?: Record<string, any> }} warning
 * @param {{ fields: Array<{ id: string, name: string }>, teams: Array<{ id: string, name: string }> } | null} league
 */
function warningLine(warning, league) {
  const d = warning.details ?? {};
  const row = /^row-(\d+)$/.exec(String(d.rowKey ?? ''));
  const named = (list, id) => (list ?? []).find((item) => String(item.id) === String(id))?.name;
  const where = row
    ? `Row ${row[1]}`
    : d.fieldId
      ? `Field ${named(league?.fields, d.fieldId) ?? 'created by this import'}`
      : d.teamId
        ? `Team ${named(league?.teams, d.teamId) ?? 'created by this import'}`
        : null;
  return `${where ? `${where}: ` : ''}${words(warning.type)}`;
}

/**
 * A list of sentences, the first `NAMED` named and the rest counted.
 *
 * @param {{ items: string[], total: number, testId: string, heading: string }} props
 */
function NamedList({ items, total, testId, heading }) {
  if (total <= 0) return null;
  const shown = items.slice(0, NAMED);
  const more = total - shown.length;
  return (
    <section data-testid={testId} className="mt-4">
      <h4 className="text-sm font-semibold text-text-primary mb-1">{`${heading} (${total})`}</h4>
      <ul className="text-sm text-text-secondary space-y-1 break-words list-disc pl-5">
        {shown.map((item, index) => (
          <li key={`${index}-${item}`}>{item}</li>
        ))}
      </ul>
      {more > 0 && <p className="text-xs text-text-muted mt-1">{`and ${more} more`}</p>}
    </section>
  );
}

/**
 * A message with an icon and a word, never colour alone.
 *
 * @param {{ tone?: 'info' | 'error' | 'warning' | 'success', testId?: string, children: any, role?: string }} props
 */
function Notice({ tone = 'info', testId, children, role }) {
  const styles = {
    info: 'border-border-subtle bg-bg-surface text-text-secondary',
    error: 'border-status-error/30 bg-status-error-bg text-status-error-text',
    warning: 'border-status-warning/30 bg-status-warning/10 text-status-warning-text',
    success: 'border-border-subtle bg-bg-surface text-status-success-text',
  };
  const Icon = tone === 'success' ? CheckCircle : tone === 'info' ? Info : AlertCircle;
  return (
    <div
      data-testid={testId}
      role={role ?? (tone === 'error' ? 'alert' : 'status')}
      className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${styles[tone]}`}
    >
      <Icon size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}

/**
 * @param {Object} props
 * @param {'games'} [props.kind]
 * @param {boolean} [props.isDemo] - a demo league reads no file: the parent's notice opens instead
 * @param {() => void} [props.onDemoBlocked]
 * @param {() => void} [props.onDone] - "Continue" after an applied import
 * @param {() => void} [props.onDownloadTemplate]
 * @param {any} [props.supabaseClient] - injected for tests
 */
export default function ScheduleImportPanel(props) {
  const { currentOrganization, currentSeasonSetting } = useOrganization();
  // One import belongs to ONE organization and season. The page stays mounted when the header switches either, so the
  // whole workflow is keyed by them: a switch discards the staged file, the preview, the pending confirm, the result
  // and its roll back, and an answer still in flight for the old scope lands in a component that is gone.
  const scopeKey = `${props.kind ?? 'games'}:${currentOrganization?.id ?? ''}:${currentSeasonSetting?.id ?? ''}`;
  return <ScheduleImportWorkflow key={scopeKey} {...props} />;
}

/** @param {Parameters<typeof ScheduleImportPanel>[0]} props */
function ScheduleImportWorkflow({
  kind = 'games',
  isDemo = false,
  onDemoBlocked,
  onDone,
  onDownloadTemplate,
  supabaseClient,
}) {
  const K = KINDS[kind];
  const client = supabaseClient ?? supabase;
  const { currentOrganization, currentSeasonSetting } = useOrganization();
  const organizationId = currentOrganization?.id ?? null;
  const seasonSettingsId = currentSeasonSetting?.id ?? null;
  const headingId = useId();
  const fileInputId = useId();
  const publishedId = useId();
  const createAckId = useId();
  const stepHeadingRef = useRef(/** @type {HTMLHeadingElement | null} */ (null));

  const [step, setStep] = useState(
    /** @type {'upload' | 'mapping' | 'preview' | 'result'} */ ('upload')
  );
  const [busy, setBusy] = useState(/** @type {string | null} */ (null));
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [fileName, setFileName] = useState('');
  const [jobId, setJobId] = useState(/** @type {string | null} */ (null));
  const [staging, setStaging] = useState(/** @type {any} */ (null));
  const [rows, setRows] = useState(/** @type {any[]} */ ([]));
  const [league, setLeague] = useState(/** @type {any} */ (null));
  const [choices, setChoices] = useState(
    /** @type {Record<string, Record<string, string>>} */ ({})
  );
  const [arrivePublished, setArrivePublished] = useState(true);
  const [preview, setPreview] = useState(/** @type {any} */ (null));
  const [stale, setStale] = useState(/** @type {any} */ (null));
  const [createAck, setCreateAck] = useState(false);
  const [result, setResult] = useState(/** @type {any} */ (null));
  const [rolledBack, setRolledBack] = useState(/** @type {any} */ (null));
  const [lastImport, setLastImport] = useState(/** @type {any} */ (null));

  // The step's heading takes focus when the step changes, so a keyboard or screen-reader user lands on what is new.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    stepHeadingRef.current?.focus();
  }, [step]);

  // The season's last applied import, so it can still be rolled back after a reload. `lastKey` asks for it again
  // (after an apply or a roll back).
  const [lastKey, setLastKey] = useState(0);
  const refreshLast = useCallback(() => setLastKey((n) => n + 1), []);
  useEffect(() => {
    if (!organizationId || !seasonSettingsId) return undefined;
    let current = true;
    K.latest(client, { organizationId, seasonSettingsId }).then(
      (job) => {
        if (current) setLastImport(job);
      },
      (err) => {
        // Said, not swallowed: the upload still works without it.
        logger.warn('The last schedule import could not be read:', err);
        if (current) setLastImport(null);
      }
    );
    return () => {
      current = false;
    };
  }, [K, client, organizationId, seasonSettingsId, lastKey]);

  const decisions = useMemo(() => decisionsFromChoices(choices), [choices]);
  const proposal = useMemo(
    () => (league ? K.propose({ rows, league, decisions }) : null),
    [K, rows, league, decisions]
  );
  // What the rows resolve to under the mapping AS IT IS STORED (the admin's choices, and a match they left standing),
  // read the way the database reads it: a label with no stored decision is unknown, never matched for them.
  const resolved = useMemo(
    () =>
      league && proposal
        ? K.resolve({
            rows,
            league,
            decisions: mappingForJob(proposal, choices, true),
            explicitOnly: true,
          })
        : null,
    [K, rows, league, proposal, choices]
  );
  const undecided = useMemo(() => {
    if (!proposal) return 0;
    return MAPPING_GROUPS.reduce(
      (n, { group }) =>
        n +
        proposal[group].filter((e) => shownChoice(e, choices[group]?.[e.key]) === UNDECIDED).length,
      0
    );
  }, [proposal, choices]);

  const reset = useCallback(() => {
    setStep('upload');
    setBusy(null);
    setError(null);
    setFileName('');
    setJobId(null);
    setStaging(null);
    setRows([]);
    setLeague(null);
    setChoices({});
    setArrivePublished(true);
    setPreview(null);
    setStale(null);
    setCreateAck(false);
    setResult(null);
    setRolledBack(null);
  }, []);

  // False once this workflow is gone (the scope changed, or the page closed): a step that was waiting does not go on
  // to start the next one for a scope nobody is looking at.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const fail = (err, fallback) => {
    logger.error(fallback, err);
    setError(err?.message || fallback);
    setBusy(null);
  };

  const handleFile = (file) => {
    if (!file) return;
    if (isDemo) {
      onDemoBlocked?.();
      return;
    }
    setError(null);
    if (file.type !== 'text/csv' && !file.name.toLowerCase().endsWith('.csv')) {
      setError('Please upload a CSV file.');
      return;
    }
    if (!organizationId || !seasonSettingsId) {
      setError('Choose an organization and a season first.');
      return;
    }
    setFileName(file.name);
    setBusy('Reading the file');
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      error: (err) => fail(err, 'The file could not be read as CSV.'),
      complete: async ({ data, meta }) => {
        try {
          const headers = meta.fields ?? [];
          // The browser's own reading is only the early answer for a file that cannot be imported at all (nothing is
          // created for it). What is imported is what the server reads and stages.
          const local = K.parseFile({
            headers,
            rows: data,
            season: {
              timeZone: currentSeasonSetting?.timezone ?? null,
              startDate: currentSeasonSetting?.season_start ?? null,
              endDate: currentSeasonSetting?.season_end ?? null,
            },
          });
          if (!local.ok) {
            setError(local.refusal?.message ?? 'The file cannot be imported.');
            setBusy(null);
            return;
          }
          if (data.length === 0) {
            setError('The file has a header row and no games.');
            setBusy(null);
            return;
          }
          if (!alive.current) return;
          setBusy('Checking the file');
          const started = await K.start(client, {
            organizationId,
            seasonSettingsId,
            fileName: file.name,
            headers,
            rows: data,
          });
          const [stagedRows, leagueView] = await Promise.all([
            K.readStaged(client, started.jobId),
            K.readLeague(client, { organizationId, seasonSettingsId }),
          ]);
          setJobId(started.jobId);
          setStaging(started.summary);
          setRows(stagedRows);
          setLeague(leagueView);
          setChoices({});
          setBusy(null);
          setStep('mapping');
        } catch (err) {
          fail(err, 'The file could not be checked.');
        }
      },
    });
  };

  const runPreview = async (published) => {
    if (!jobId || !proposal) return;
    setError(null);
    setStale(null);
    setCreateAck(false);
    setBusy('Working out what the import would do');
    try {
      await K.saveMapping(client, jobId, mappingForJob(proposal, choices, published));
      if (!alive.current) return;
      setPreview(await K.preview(client, jobId));
      setBusy(null);
      setStep('preview');
    } catch (err) {
      fail(err, 'The preview could not be made.');
    }
  };

  const counts = useMemo(() => (preview ? scheduleImportConfirmCounts(preview) : null), [preview]);
  const createdTotal = counts
    ? CREATED_ROWS.reduce((n, [key]) => n + Number(counts[key] ?? 0), 0)
    : 0;

  const handleConfirm = async () => {
    if (!jobId || !counts || !organizationId) return;
    setError(null);
    setBusy('Importing');
    try {
      const outcome = await K.confirm(client, { organizationId, jobId, confirmed: counts });
      if (outcome.status === 'stale') {
        // Nothing was written. The new preview replaces the old one, and what changed is said.
        setStale(outcome);
        setPreview(outcome.preview);
        setCreateAck(false);
        setBusy(null);
        return;
      }
      setResult(outcome.result);
      setBusy(null);
      setStep('result');
      refreshLast();
    } catch (err) {
      fail(err, 'The import could not be applied.');
    }
  };

  const handleRollback = async (id) => {
    setError(null);
    setBusy('Rolling the import back');
    try {
      const undone = await K.rollback(client, { jobId: id, organizationId, seasonSettingsId });
      setRolledBack(undone);
      setBusy(null);
      refreshLast();
    } catch (err) {
      fail(err, 'The import could not be rolled back.');
    }
  };

  // G3: the saved schedule as a file this import reads (a file exported here imports here, with no change).
  const [exportNote, setExportNote] = useState(/** @type {string | null} */ (null));
  const handleExport = async () => {
    if (!organizationId || !seasonSettingsId) return;
    setError(null);
    setExportNote(null);
    setBusy('Reading the saved schedule');
    try {
      const saved = await K.exportSaved(client, {
        organizationId,
        seasonSettingsId,
        timeZone: currentSeasonSetting?.timezone ?? null,
      });
      setBusy(null);
      if (saved.rows.length === 0) {
        setExportNote('There is no saved game to download yet.');
        return;
      }
      saveFile(K.exportFileName, csvBlob(saved.csv));
      const left = saved.omitted.noPlace + saved.omitted.unknownRecord;
      setExportNote(
        `Downloaded ${saved.rows.length} games.${
          left > 0
            ? ` ${left} saved games could not be written (no readable time, field or team) and are not in the file.`
            : ''
        }${
          saved.omitted.undatedTbd > 0
            ? ` ${saved.omitted.undatedTbd} TIME TBD games have no date and are not in the file (the file needs a date).`
            : ''
        }`
      );
    } catch (err) {
      fail(err, 'The saved schedule could not be read.');
    }
  };

  const handleDiscard = async () => {
    if (jobId) {
      try {
        await K.discard(client, jobId);
      } catch (err) {
        // Nothing was written by a staged import; it is left to expire, and the reason is logged.
        logger.warn('The staged import could not be discarded:', err);
      }
    }
    reset();
  };

  const setChoice = (group, key, value) =>
    setChoices((prev) => ({ ...prev, [group]: { ...(prev[group] ?? {}), [key]: value } }));
  const setAllUndecided = (group, value) => {
    if (!proposal) return;
    setChoices((prev) => {
      const next = { ...(prev[group] ?? {}) };
      for (const entry of proposal[group]) {
        if (shownChoice(entry, prev[group]?.[entry.key]) === UNDECIDED) next[entry.key] = value;
      }
      return { ...prev, [group]: next };
    });
  };

  const stepTitle = {
    upload: `1 of 4: choose the file`,
    mapping: '2 of 4: say what each name in the file is',
    preview: '3 of 4: review and confirm',
    result: rolledBack ? '4 of 4: the import was rolled back' : '4 of 4: the import is applied',
  }[step];

  return (
    <section
      data-testid="schedule-import-panel"
      data-kind={kind}
      aria-labelledby={headingId}
      className="bg-bg-surface border border-border-subtle rounded-lg p-4 sm:p-6 max-w-full min-w-0 text-left"
    >
      <h3 id={headingId} className="text-lg font-semibold text-text-primary">
        {K.title}
      </h3>
      <p className="text-sm text-text-secondary max-w-prose mt-1">{K.intro}</p>
      <h4
        ref={stepHeadingRef}
        tabIndex={-1}
        data-testid="schedule-import-step"
        className="text-sm font-semibold text-text-primary mt-4 mb-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/80 rounded-sm"
      >
        {`Step ${stepTitle}`}
      </h4>

      <div aria-live="polite" className="space-y-2 mb-3">
        {busy && <Notice testId="schedule-import-busy">{`${busy}...`}</Notice>}
        {error && (
          <Notice tone="error" testId="schedule-import-error">
            {error}
          </Notice>
        )}
      </div>

      {step === 'upload' && (
        <div>
          <p className="text-sm text-text-secondary max-w-prose">
            <span className="font-semibold text-text-primary">Columns: </span>
            {K.columns}
          </p>
          <p className="text-sm text-text-secondary max-w-prose mt-2">
            {`Times are read on the season's clock${
              currentSeasonSetting?.timezone ? ` (${currentSeasonSetting.timezone})` : ''
            }. One file holds at most ${SCHEDULE_IMPORT_LIMITS.MAX_ROWS.toLocaleString('en-US')} rows. The import goes into ${
              currentSeasonSetting?.name || 'the active season'
            }.`}
          </p>
          <div className="flex flex-wrap items-center gap-3 mt-4">
            <label
              htmlFor={fileInputId}
              className="btn btn-primary cursor-pointer focus-within:outline-none focus-within:ring-2 focus-within:ring-blue-400/80 focus-within:ring-offset-2 focus-within:ring-offset-bg-surface"
            >
              Choose a CSV file
              <input
                id={fileInputId}
                data-testid="schedule-import-file"
                type="file"
                accept=".csv"
                className="sr-only"
                disabled={busy !== null}
                onClick={(event) => {
                  if (isDemo) {
                    event.preventDefault();
                    onDemoBlocked?.();
                  }
                }}
                onChange={(event) => {
                  handleFile(event.target.files?.[0]);
                  event.target.value = '';
                }}
              />
            </label>
            {onDownloadTemplate && (
              <Button variant="secondary" onClick={onDownloadTemplate}>
                Download the template
              </Button>
            )}
            <Button variant="ghost" disabled={busy !== null} onClick={handleExport}>
              Download the saved schedule as CSV
            </Button>
          </div>
          {exportNote && (
            <div className="mt-3">
              <Notice testId="schedule-import-export-note">{exportNote}</Notice>
            </div>
          )}

          {lastImport && !rolledBack && (
            <section
              data-testid="schedule-import-last"
              aria-label="The last import"
              className="mt-6 border-t border-border-subtle pt-4"
            >
              <h4 className="text-sm font-semibold text-text-primary">The last import</h4>
              <p className="text-sm text-text-secondary mt-1 break-words">
                {`${lastImport.fileName || 'A file'}: ${Number(lastImport.result?.games?.inserted ?? 0)} games added, ${Number(
                  lastImport.result?.games?.updated ?? 0
                )} changed, ${Number(lastImport.result?.time_tbd?.inserted ?? 0)} TIME TBD games added.`}
              </p>
              <p className="text-xs text-text-muted mt-1 max-w-prose">
                It can be rolled back while no game it wrote has been changed, cancelled or had
                changes allowed since.
              </p>
              <div className="mt-2">
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => handleRollback(lastImport.id)}
                >
                  Roll back the last import
                </Button>
              </div>
            </section>
          )}
          {rolledBack && (
            <div className="mt-4">
              <Notice tone="success" testId="schedule-import-rolled-back">
                {`The import was rolled back: ${Number(rolledBack?.games?.deleted ?? 0)} games removed, ${Number(
                  rolledBack?.games?.restored ?? 0
                )} put back as they were.`}
              </Notice>
            </div>
          )}
        </div>
      )}

      {step === 'mapping' && proposal && staging && (
        <div>
          <p
            className="text-sm text-text-secondary max-w-prose"
            data-testid="schedule-import-staged"
          >
            {`${fileName}: ${staging.rows} rows read. ${staging.ok} placed games, ${staging.tbd} with no time (TIME TBD), ${staging.refused} that cannot be imported.`}
            {staging.dropped_columns.length > 0 &&
              ` Columns not read and not stored: ${staging.dropped_columns.join(', ')}.`}
          </p>
          <NamedList
            testId="schedule-import-upload-warnings"
            heading="Rows the import kept and changed"
            total={staging.warnings.length}
            items={staging.warnings.map((w) => `Row ${w.row}: ${w.message}`)}
          />
          <NamedList
            testId="schedule-import-upload-refused"
            heading="Rows that cannot be imported"
            total={staging.refused_rows.length}
            items={staging.refused_rows.map((r) => `Row ${r.row}: ${r.message}`)}
          />
          <p className="text-sm text-text-secondary max-w-prose mt-4">
            A name that matches exactly one of your records is matched for you; change it if it is
            wrong. A name with no match is not imported until you say what it is. Nothing is created
            until you confirm the list on the next step.
          </p>

          {MAPPING_GROUPS.map(({ group, title, noun, kind: entryKind }) => {
            const entries = proposal[group];
            if (entries.length === 0) return null;
            const open = entries.filter(
              (e) => shownChoice(e, choices[group]?.[e.key]) === UNDECIDED
            ).length;
            return (
              <section key={group} data-testid={`schedule-import-map-${group}`} className="mt-5">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                  <h5 className="text-sm font-semibold text-text-primary">
                    {`${title} (${entries.length}${open > 0 ? `, ${open} not decided` : ''})`}
                  </h5>
                  {open > 0 && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setAllUndecided(group, 'create')}
                      >
                        {`Create every undecided ${noun}`}
                      </Button>
                      {entryKind === 'team' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setAllUndecided(group, 'outside')}
                        >
                          Mark every undecided team an outside club
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setAllUndecided(group, 'skip')}
                      >
                        {`Skip every undecided ${noun}`}
                      </Button>
                    </div>
                  )}
                </div>
                <div className="overflow-x-auto max-w-full">
                  <table className="w-full text-left text-sm text-text-secondary">
                    <thead className="text-xs uppercase text-text-muted border-b border-border-subtle">
                      <tr>
                        <th scope="col" className="px-2 py-2">
                          In the file
                        </th>
                        <th scope="col" className="px-2 py-2">
                          Rows
                        </th>
                        <th scope="col" className="px-2 py-2">
                          What it is
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-subtle">
                      {entries.map((entry) => {
                        const value = shownChoice(entry, choices[group]?.[entry.key]);
                        const records = recordsInScope(entry, league, proposal, choices);
                        const options = choiceOptions(entry, records);
                        const parent = entry.divisionLabel ?? entry.venueLabel ?? null;
                        const problem = value === UNDECIDED ? null : entryProblem(entry);
                        const name = parent ? `${entry.label} (${parent})` : entry.label;
                        return (
                          <tr key={entry.key} data-testid={`schedule-import-entry-${group}`}>
                            <th scope="row" className="px-2 py-2 font-medium text-text-primary">
                              {entry.label}
                              {parent && (
                                <span className="block text-xs font-normal text-text-muted">
                                  {`in ${parent}`}
                                </span>
                              )}
                            </th>
                            <td className="px-2 py-2 tabular-nums">{entry.rowCount}</td>
                            <td className="px-2 py-2">
                              <select
                                aria-label={`What ${name} is`}
                                className="w-full max-w-md rounded-md border border-border-subtle bg-bg-surface text-text-primary px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/80"
                                value={options.some((o) => o.value === value) ? value : UNDECIDED}
                                onChange={(event) =>
                                  setChoice(group, entry.key, event.target.value)
                                }
                              >
                                {options.map((option) => (
                                  <option key={option.value} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                              {value === UNDECIDED && (
                                <span className="block text-xs text-status-warning-text mt-1">
                                  Not decided: its rows will not be imported.
                                </span>
                              )}
                              {problem && (
                                <span className="block text-xs text-status-error-text mt-1">
                                  {problem}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          })}

          {resolved && (
            <p
              data-testid="schedule-import-mapping-summary"
              className="text-sm text-text-secondary mt-4"
            >
              {`With these choices: ${resolved.counts.ok} placed games and ${resolved.counts.tbd} TIME TBD games would be imported, ${resolved.counts.refused} rows not imported, ${resolved.counts.skipped} skipped.${
                undecided > 0 ? ` ${undecided} names are not decided.` : ''
              }`}
            </p>
          )}
          <div className="flex flex-wrap gap-3 mt-4">
            <Button
              variant="primary"
              disabled={busy !== null}
              onClick={() => runPreview(arrivePublished)}
            >
              Preview the import
            </Button>
            <Button variant="secondary" disabled={busy !== null} onClick={handleDiscard}>
              Cancel this import
            </Button>
          </div>
        </div>
      )}

      {step === 'preview' && preview && counts && (
        <div>
          {stale && (
            <div className="mb-4">
              <Notice tone="warning" testId="schedule-import-stale" role="alert">
                <p>{stale.message}</p>
                <ul className="list-disc pl-5 mt-1">
                  {stale.differing.slice(0, NAMED).map((key) => (
                    <li key={key}>
                      {`${COUNT_ROWS.find(([k]) => k === key)?.[1] ?? CREATED_ROWS.find(([k]) => k === key)?.[2] ?? key}: was ${String(
                        stale.confirmed?.[key] ?? 0
                      )}, now ${String(stale.current?.[key] ?? 0)}`}
                    </li>
                  ))}
                </ul>
              </Notice>
            </div>
          )}

          {counts.nothing_to_apply ? (
            <Notice testId="schedule-import-nothing">
              Nothing to apply: the schedule already holds every game of this file as the file has
              it.
            </Notice>
          ) : (
            <p className="text-sm text-text-secondary max-w-prose">
              This is what the import will do. Nothing has been written yet.
            </p>
          )}

          <dl
            data-testid="schedule-import-counts"
            className="mt-3 rounded-lg border border-border-subtle divide-y divide-border-subtle max-w-xl"
          >
            {COUNT_ROWS.map(([key, label]) => (
              <div key={key} className="flex items-baseline justify-between gap-3 px-3 py-2">
                <dt className="text-sm text-text-secondary">{label}</dt>
                <dd
                  data-testid={`schedule-import-count-${key}`}
                  className="text-sm font-semibold text-text-primary tabular-nums"
                >
                  {Number(counts[key] ?? 0)}
                </dd>
              </div>
            ))}
          </dl>

          <section data-testid="schedule-import-creations" className="mt-4">
            <h4 className="text-sm font-semibold text-text-primary mb-1">
              {`What will be created (${createdTotal})`}
            </h4>
            {createdTotal === 0 ? (
              <p className="text-sm text-text-secondary">
                Nothing: every game uses records you already have.
              </p>
            ) : (
              <ul className="text-sm text-text-secondary space-y-2">
                {CREATED_ROWS.filter(([key]) => Number(counts[key] ?? 0) > 0).map(
                  ([key, listKey, label]) => {
                    const names = (resolved?.creations?.[listKey] ?? []).map((c) => c.name);
                    return (
                      <li key={key} data-testid={`schedule-import-created-${listKey}`}>
                        <span className="font-semibold text-text-primary">{`${label}: ${Number(counts[key])}`}</span>
                        <span className="block break-words">
                          {names.slice(0, NAMED).join(', ')}
                          {names.length > NAMED ? `, and ${names.length - NAMED} more` : ''}
                        </span>
                      </li>
                    );
                  }
                )}
              </ul>
            )}
          </section>

          <NamedList
            testId="schedule-import-refused"
            heading="Rows that will not be imported"
            total={Number(counts['rows.refused'] ?? 0)}
            items={(preview.listed?.refused ?? []).map(
              (r) => `Row ${r.row_number}: ${r.message || words(r.reason)}`
            )}
          />
          <NamedList
            testId="schedule-import-skipped"
            heading="Rows skipped by your choice"
            total={Number(counts['rows.skipped'] ?? 0)}
            items={(preview.listed?.skipped ?? []).map(
              (r) => `Row ${r.row_number}: the ${r.kind} "${r.label}" is skipped`
            )}
          />
          <NamedList
            testId="schedule-import-skipped-games"
            heading="Games the import will not change"
            total={(preview.listed?.skipped_games ?? []).length}
            items={(preview.listed?.skipped_games ?? []).map(
              (g) => `Row ${g.row_number}: ${describeScheduleImportSkip(g.reason)}`
            )}
          />
          <NamedList
            testId="schedule-import-warnings"
            heading="Flagged, and imported anyway"
            total={(preview.warnings ?? []).length}
            items={(preview.warnings ?? []).map((w) => warningLine(w, league))}
          />
          {staging && (
            <NamedList
              testId="schedule-import-kept-warnings"
              heading="Rows the import kept and changed when it read the file"
              total={
                staging.warnings.filter((w) => ['bad-time', 'bad-week'].includes(w.code)).length
              }
              items={staging.warnings
                .filter((w) => ['bad-time', 'bad-week'].includes(w.code))
                .map((w) => `Row ${w.row}: ${w.message}`)}
            />
          )}

          <p
            data-testid="schedule-import-coverage"
            className="text-xs text-text-muted max-w-prose mt-4"
          >
            Checked: a field with two games at once, a team with two games at once. Not checked by
            the import: coach overlap, hosting balance, shared space, travel time between fields.
          </p>

          <div className="mt-4 space-y-3">
            <label
              htmlFor={publishedId}
              className="flex items-start gap-2 text-sm text-text-primary"
            >
              <input
                id={publishedId}
                type="checkbox"
                className="mt-1"
                checked={arrivePublished}
                disabled={busy !== null}
                onChange={(event) => {
                  setArrivePublished(event.target.checked);
                  runPreview(event.target.checked);
                }}
              />
              <span>
                Games arrive Published
                <span className="block text-xs text-text-muted">
                  A Published game is held where it is: regeneration and moves leave it alone until
                  you allow changes to it.
                </span>
              </span>
            </label>
            {createdTotal > 0 && (
              <label
                htmlFor={createAckId}
                className="flex items-start gap-2 text-sm text-text-primary"
              >
                <input
                  id={createAckId}
                  data-testid="schedule-import-create-ack"
                  type="checkbox"
                  className="mt-1"
                  checked={createAck}
                  onChange={(event) => setCreateAck(event.target.checked)}
                />
                <span>{`Create the ${createdTotal} records listed above`}</span>
              </label>
            )}
          </div>

          <div className="flex flex-wrap gap-3 mt-4">
            <Button
              variant="primary"
              disabled={
                busy !== null ||
                counts.nothing_to_apply === true ||
                (createdTotal > 0 && !createAck)
              }
              onClick={handleConfirm}
            >
              Confirm and import
            </Button>
            <Button variant="secondary" disabled={busy !== null} onClick={() => setStep('mapping')}>
              Back to the names
            </Button>
            <Button variant="ghost" disabled={busy !== null} onClick={handleDiscard}>
              Cancel this import
            </Button>
          </div>
        </div>
      )}

      {step === 'result' && result && (
        <div>
          {rolledBack ? (
            <Notice tone="success" testId="schedule-import-rolled-back">
              {`The import was rolled back: ${Number(rolledBack?.games?.deleted ?? 0)} games removed, ${Number(
                rolledBack?.games?.restored ?? 0
              )} put back as they were.${
                (rolledBack?.kept ?? []).length > 0
                  ? ` ${(rolledBack.kept ?? []).length} records it created are still in use and were kept.`
                  : ''
              }`}
            </Notice>
          ) : (
            <Notice tone="success" testId="schedule-import-applied">
              {`Imported: ${Number(result.games?.inserted ?? 0)} games added, ${Number(
                result.games?.updated ?? 0
              )} changed, ${Number(result.time_tbd?.inserted ?? 0)} TIME TBD games added.${
                result.arrive_published ? ' The new games are Published.' : ''
              }`}
            </Notice>
          )}
          <dl
            data-testid="schedule-import-result-counts"
            className="mt-3 rounded-lg border border-border-subtle divide-y divide-border-subtle max-w-xl"
          >
            {COUNT_ROWS.map(([key, label]) => (
              <div key={key} className="flex items-baseline justify-between gap-3 px-3 py-2">
                <dt className="text-sm text-text-secondary">{label}</dt>
                <dd className="text-sm font-semibold text-text-primary tabular-nums">
                  {Number(scheduleImportConfirmCounts(result)[key] ?? 0)}
                </dd>
              </div>
            ))}
          </dl>
          <NamedList
            testId="schedule-import-result-refused"
            heading="Rows that were not imported"
            total={Number(result.rows?.refused ?? 0)}
            items={(result.listed?.refused ?? []).map(
              (r) => `Row ${r.row_number}: ${r.message || words(r.reason)}`
            )}
          />
          <NamedList
            testId="schedule-import-result-warnings"
            heading="Flagged, and imported anyway"
            total={(result.warnings ?? []).length}
            items={(result.warnings ?? []).map((w) => warningLine(w, league))}
          />
          <div className="flex flex-wrap gap-3 mt-4">
            {!rolledBack && jobId && (
              <Button
                variant="danger"
                disabled={busy !== null}
                onClick={() => handleRollback(jobId)}
              >
                Roll back this import
              </Button>
            )}
            <Button variant="secondary" disabled={busy !== null} onClick={reset}>
              Import another file
            </Button>
            {onDone && !rolledBack && (
              <Button variant="primary" disabled={busy !== null} onClick={onDone}>
                Continue
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
