import React, { Suspense, lazy, useId, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { Download } from 'lucide-react';
import Button from '../ui/Button.jsx';
import DataErrorBanner from '../ui/DataErrorBanner.jsx';
import { supabase } from '../../lib/supabaseClient.js';
import { logger } from '../../lib/logger.js';
import { useDemo } from '../../hooks/useDemo.js';
import { makeDedupeHeaderTransformer } from '../../utils/gotsportCanonicalizer.js';
import { databaseIsoDate } from '../../utils/coachPreferencePreview.js';
import {
  downloadPreferenceTemplate,
  readPreferenceFile,
} from '../../utils/practicePreferenceFile.js';
import { previewPracticePreferenceImport } from '../../utils/practicePreferenceImportPreview.js';
import {
  MAX_IMPORT_ROWS,
  runPracticePreferenceImport,
} from '../../utils/practicePreferenceImportRun.js';
import PreferenceImportPreview from './PreferenceImportPreview.jsx';

// A demo opens this instead of the file picker (the demo holds placeholder data and refuses imports).
const DemoImportNotice = lazy(() => import('../DemoImportNotice.jsx'));

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_COLUMNS = 1200;

/** The counts the finalizer returns that the preview also computed, and what to call each. */
const COMPARED = [
  ['inserted_rules', 'rules added'],
  ['replaced_rules', 'rules replaced'],
  ['pending_musts', 'musts pending'],
  ['teams_named', 'teams named'],
  ['unknown_coach_rows', 'unknown coach rows'],
  ['unknown_team_rows', 'unknown team rows'],
  ['invalid_rows', 'rows that could not be read'],
  ['no_team_rows', 'rows with no team'],
  ['coach_not_on_team_rows', 'rows for a team the coach does not coach'],
  ['duplicate_rule_rows', 'repeated rows'],
];

/** Where the preview and the finalizer disagree, as words (none when they agree). */
function differences(preview, result) {
  return COMPARED.filter(([key]) => Number(result?.[key] ?? 0) !== Number(preview[key] ?? 0)).map(
    ([key, label]) => `${label}: previewed ${preview[key] ?? 0}, applied ${result?.[key] ?? 0}`
  );
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * Importing a practice preference file (Phase D C2): choose a CSV, see what it will do, then
 * import it. The file is read in the browser, only the columns the import reads are uploaded, and
 * the preview is computed from the season's coaches, teams and rosters before anything is sent, so
 * the admin sees the rules per team, the unknown coaches and teams (listed, never created), the
 * musts that will wait for a decision and the imported rules a re-import replaces. After the
 * import the result is the database's own count, set beside the preview if the two differ.
 *
 * A completed season takes no import (the database refuses it): the file control is off and the page
 * says why. A demo takes none either, and says so as the other imports do.
 */
export default function PreferenceImportPanel({
  orgId,
  seasonId,
  seasonIsActive,
  readOnly,
  context,
  ruleRows,
  onImported,
  onReviewMusts,
}) {
  const fileInputId = useId();
  const inputRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  const { isDemo } = useDemo();
  const [demoNotice, setDemoNotice] = useState(false);
  /** @type {[any, Function]} */
  const [loaded, setLoaded] = useState(null);
  const [problem, setProblem] = useState(/** @type {string | null} */ (null));
  const [step, setStep] = useState(/** @type {string | null} */ (null));
  const [outcome, setOutcome] = useState(/** @type {any} */ (null));
  const [reading, setReading] = useState(false);

  const contextReady = !context.loading && !context.error && !context.previewError;
  const preview = useMemo(() => {
    if (!loaded || !contextReady) return null;
    return previewPracticePreferenceImport({
      staged: loaded.read.staged,
      context: {
        seasonId,
        coaches: context.coaches,
        teams: context.teams,
        divisions: context.divisions,
        assignments: context.rosterRows,
        locations: context.locations,
        ruleRows,
        today: databaseIsoDate(),
      },
    });
  }, [loaded, contextReady, seasonId, context, ruleRows]);
  const locationNames = useMemo(
    () => new Map(context.locations.map((location) => [String(location.id), location.name])),
    [context.locations]
  );

  const reset = () => {
    setLoaded(null);
    setProblem(null);
    setStep(null);
    setOutcome(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  const readFile = async (file) => {
    setProblem(null);
    setOutcome(null);
    setLoaded(null);
    if (!file) return;
    if (file.type !== 'text/csv' && !file.name.toLowerCase().endsWith('.csv')) {
      setProblem('Please choose a CSV file.');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setProblem(
        `The file is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). The limit is 10 MB.`
      );
      return;
    }
    setReading(true);
    try {
      const { default: Papa } = await import('papaparse');
      await new Promise((resolve) => {
        Papa.parse(file, {
          header: true,
          skipEmptyLines: true,
          transformHeader: makeDedupeHeaderTransformer(),
          complete: (results) => {
            const headers = results.meta.fields ?? [];
            const rows = results.data ?? [];
            if (headers.length === 0 || rows.length === 0) {
              setProblem(
                headers.length === 0
                  ? 'The file appears to be empty or is not a comma-separated CSV. Save it as CSV (UTF-8, comma-delimited) and try again.'
                  : 'The file has a header row and no rows under it.'
              );
            } else if (headers.length > MAX_COLUMNS) {
              setProblem(`The file has more than ${MAX_COLUMNS} columns.`);
            } else if (rows.length > MAX_IMPORT_ROWS) {
              setProblem(`The file has ${rows.length} rows; the limit is ${MAX_IMPORT_ROWS}.`);
            } else {
              const read = readPreferenceFile({ headers, rows });
              if (!read.hasEmailColumn) {
                setProblem(
                  'The file has no column for the coach’s email, which is how each row finds its coach. Name a column "Coach Email" or "Email" (the template shows the columns the import reads).'
                );
              } else if (!read.hasRuleColumn) {
                setProblem(
                  'The file has no days, start times or venues column, so no row could make a rule. The template shows the columns the import reads.'
                );
              } else {
                setLoaded({ fileName: file.name, read, rowCount: rows.length });
              }
            }
            resolve(undefined);
          },
          error: (err) => {
            setProblem(`Could not read the file: ${err.message}`);
            resolve(undefined);
          },
        });
      });
    } catch (err) {
      logger.error('Could not read the preference file', err);
      setProblem(`Could not read the file: ${err?.message || 'unknown error'}`);
    } finally {
      setReading(false);
    }
  };

  const importFile = async () => {
    if (!loaded || !preview) return;
    setProblem(null);
    setStep('Starting');
    try {
      const run = await runPracticePreferenceImport({
        supabase,
        organizationId: orgId,
        seasonSettingsId: seasonIsActive ? null : seasonId,
        fileName: loaded.fileName,
        rows: loaded.read.keptRows,
        onStep: setStep,
      });
      setOutcome({ ...run, preview, fileName: loaded.fileName });
      setLoaded(null);
      await onImported(run.result);
    } catch (err) {
      logger.error('The preference import failed', err);
      setProblem(
        `The import did not finish: ${err?.message || 'unknown error'}. Nothing from this file was applied unless the result below says so.`
      );
    } finally {
      setStep(null);
    }
  };

  const working = step !== null;

  if (outcome) {
    const { result, preview: previewed, fileName } = outcome;
    const differs = differences(previewed, result);
    const unknownCoaches = result?.unknown_coaches ?? [];
    const unknownTeams = result?.unknown_teams ?? [];
    return (
      <div className="flex flex-col gap-4" data-testid="preference-import-result">
        <h3 className="text-base font-bold m-0">Imported {fileName}</h3>
        <p role="status" className="text-sm m-0" data-testid="preference-import-summary">
          {plural(result?.inserted_rules ?? 0, 'rule added', 'rules added')} for{' '}
          {plural(result?.teams_named ?? 0, 'team', 'teams')};{' '}
          {plural(result?.replaced_rules ?? 0, 'imported rule replaced', 'imported rules replaced')}
          ; {plural(result?.pending_musts ?? 0, 'must waiting', 'musts waiting')} for your decision.
        </p>
        {differs.length > 0 && (
          <p role="alert" className="text-sm m-0" data-testid="preference-import-differs">
            The result differs from the preview, so the data changed while you were looking (
            {differs.join('; ')}). The numbers above are what the database applied.
          </p>
        )}
        {(result?.invalid_rows ?? 0) +
          (result?.unknown_coach_rows ?? 0) +
          (result?.unknown_team_rows ?? 0) +
          (result?.no_team_rows ?? 0) +
          (result?.coach_not_on_team_rows ?? 0) +
          (result?.validation_error_rows ?? 0) >
          0 && (
          <section
            aria-labelledby="preference-import-warnings"
            data-testid="preference-import-warnings"
          >
            <h4 id="preference-import-warnings" className="text-sm font-bold m-0 mb-1">
              Rows not applied
            </h4>
            <ul className="m-0 pl-5 text-sm">
              {result.validation_error_rows > 0 && (
                <li>
                  {plural(result.validation_error_rows, 'row was', 'rows were')} refused by the file
                  check.
                </li>
              )}
              {result.invalid_rows > 0 && (
                <li>{plural(result.invalid_rows, 'row', 'rows')} could not be read.</li>
              )}
              {result.no_team_rows > 0 && (
                <li>
                  {plural(result.no_team_rows, 'row', 'rows')} named no team for a coach who coaches
                  none this season.
                </li>
              )}
              {result.coach_not_on_team_rows > 0 && (
                <li>
                  {plural(result.coach_not_on_team_rows, 'row', 'rows')} named a team the coach does
                  not coach.
                </li>
              )}
              {unknownCoaches.length > 0 && (
                <li>
                  {plural(result.unknown_coach_rows, 'row', 'rows')} named a coach who is not in
                  this season (never created):{' '}
                  {unknownCoaches.map((item) => `row ${item.row} ${item.email}`).join(', ')}.
                </li>
              )}
              {unknownTeams.length > 0 && (
                <li>
                  {plural(result.unknown_team_rows, 'row', 'rows')} named a team that is not in this
                  season (never created):{' '}
                  {unknownTeams.map((item) => `row ${item.row} “${item.team}”`).join(', ')}.
                </li>
              )}
            </ul>
          </section>
        )}
        <div className="flex flex-wrap gap-3">
          {(result?.pending_musts ?? 0) > 0 && (
            <Button variant="primary" onClick={onReviewMusts}>
              {`Review ${plural(result.pending_musts, 'pending must', 'pending musts')}`}
            </Button>
          )}
          <Button variant="secondary" onClick={reset}>
            Import another file
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="preference-import-panel">
      <div className="text-sm text-text-secondary max-w-prose flex flex-col gap-2">
        <p className="m-0">
          Import a file of practice preferences: one row is one rule, found by the coach&apos;s
          email and, optionally, the team&apos;s name. Import the players, the coaches and the teams
          first; a row for a coach or team that is not in this season is listed and never created.
        </p>
        <p className="m-0">
          A row with no team makes a rule for each team the coach coaches. A must in the file stays
          pending, counted as a prefer, until you accept it. Importing again replaces the imported
          rules of the teams the file names.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" size="sm" icon={Download} onClick={downloadPreferenceTemplate}>
          Download the CSV template
        </Button>
      </div>

      {readOnly && (
        <p role="note" className="text-sm m-0" data-testid="preference-import-readonly">
          This season is completed and takes no import. Choose the active season in the header to
          import preferences.
        </p>
      )}

      {problem && (
        <div data-testid="preference-import-problem">
          <DataErrorBanner message={problem} />
        </div>
      )}
      {context.error || context.previewError ? (
        <DataErrorBanner
          message={`What this file would do cannot be shown: the season’s coaches, teams and rosters did not load (${
            (context.error || context.previewError).message || 'unknown error'
          }). Reload the page to try again.`}
        />
      ) : null}

      {!loaded && (
        <div className="field max-w-md">
          <label htmlFor={fileInputId}>Choose a CSV file</label>
          <input
            id={fileInputId}
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            className="input file-input"
            disabled={readOnly || reading || working}
            onClick={(event) => {
              // Before the picker opens, so a demo visitor never sees it.
              if (isDemo) {
                event.preventDefault();
                setDemoNotice(true);
              }
            }}
            onChange={(event) => readFile(event.target.files?.[0])}
          />
        </div>
      )}

      {loaded && preview && (
        <div className="flex flex-col gap-4">
          <h3 className="text-base font-bold m-0">
            What {loaded.fileName} will do ({plural(loaded.rowCount, 'row', 'rows')} read)
          </h3>
          <PreferenceImportPreview
            preview={preview}
            serverRefused={loaded.read.refused}
            ignoredColumns={loaded.read.ignoredColumns}
            locationNames={locationNames}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              onClick={importFile}
              loading={working}
              disabled={readOnly || working || preview.nothingToApply}
            >
              {preview.nothingToApply
                ? 'Nothing to import'
                : `Import ${plural(preview.inserted_rules, 'rule', 'rules')}`}
            </Button>
            <Button variant="secondary" onClick={reset} disabled={working}>
              Choose another file
            </Button>
            {working && (
              <span role="status" className="text-sm text-text-muted">
                {step}…
              </span>
            )}
          </div>
        </div>
      )}
      {loaded && !preview && !context.error && !context.previewError && (
        <p className="text-sm text-text-muted m-0">Reading the season’s coaches and teams…</p>
      )}

      {demoNotice && (
        <Suspense fallback={null}>
          <DemoImportNotice open onClose={() => setDemoNotice(false)} />
        </Suspense>
      )}
    </div>
  );
}

PreferenceImportPanel.propTypes = {
  orgId: PropTypes.string.isRequired,
  seasonId: PropTypes.string.isRequired,
  seasonIsActive: PropTypes.bool.isRequired,
  readOnly: PropTypes.bool.isRequired,
  context: PropTypes.object.isRequired,
  ruleRows: PropTypes.array.isRequired,
  onImported: PropTypes.func.isRequired,
  onReviewMusts: PropTypes.func.isRequired,
};
