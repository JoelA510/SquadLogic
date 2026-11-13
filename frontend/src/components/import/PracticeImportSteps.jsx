import React, { useId, useMemo, useState } from 'react';
import Papa from 'papaparse';
import { PRACTICE_ALIAS_COLUMNS } from '@squadlogic/core/practiceImport/aliases.js';
import { practiceLabelKey } from '@squadlogic/core/practiceImport/slotKey.js';
import {
  divisionSettingsToApply,
  proposeDivisionSettings,
  proposePracticeMapping,
  readPracticeAliases,
  resolvePracticeRows,
} from '@squadlogic/core/practiceImport/index.js';
import Button from '../ui/Button.jsx';
import { importFileSizeProblem } from '../../utils/importFileLimits.js';
import { practiceProbableMoves } from '../../utils/practiceImportClient.js';
import { practiceImportWords, readablePracticeDetail } from '../../utils/practiceImportWords.js';
import {
  PRACTICE_MAPPING_GROUPS,
  UNDECIDED,
  choiceOptions,
  decisionsFromChoices,
  practiceMappingForJob,
  proposalWords,
  recordsInScope,
  shownChoice,
  shownProblem,
  withoutOutOfScopeChoices,
} from '../../utils/practiceImportMapping.js';
import { NAMED, NamedList, Notice } from './importParts.jsx';

/**
 * The Practices tab's steps after the upload (plan `docs/changes/2026-11-03-schedule-expansion.md` 4.11.5 and 4.11.6;
 * PR 11, task L2): the mapping, the preview and the result of a practice schedule import. A part of PR 6's panel
 * (`ScheduleImportPanel.jsx`, kind `practices`), not a second panel: the panel owns the job, the upload, the confirm
 * (with its stale check), the discard and the roll back; this file shows what differs.
 *
 * **What the admin sees is what the database staged and planned.** The mapping reads the rows the Edge function staged;
 * every count, flag, refusal, hold and probable move of the preview and the result is the dry run's or the apply's own
 * result (migration `20261123010000`), never a second reading in the browser. In particular the probable moves are the
 * rows the DATABASE flagged `probable_move` (it scopes them by dates), grouped by team (`practiceProbableMoves`); core's
 * `pairProbableMoves` sees no dates and is not called.
 *
 * **Nothing is created, sent or set because nobody decided.** A label with no exact match opens undecided; an alias or a
 * previous mapping is a proposal, said with its source; a division setting is saved only for a ticked division; a
 * probable move's new rows arrive unticked and only a ticked row's key is sent (`options.add_moved_rows`); and a
 * record is created only after the confirm listed it and the admin ticked that list.
 */

const words = practiceImportWords;
/** The label keys the alias file is read by: its columns, and `Venue` for `Location` (core's `aliases.js`). */
const ALIAS_HEADER_KEYS = new Set(
  [...Object.values(PRACTICE_ALIAS_COLUMNS), 'Venue'].map((name) => practiceLabelKey(name))
);
/** @param {string} header */
const practiceAliasReadsHeader = (header) => ALIAS_HEADER_KEYS.has(practiceLabelKey(header));
/** A code in words, as a clause (no closing full stop). */
const clause = (code) => words(code).replace(/\.$/, '');
const readable = readablePracticeDetail;
const capital = (text) => (text ? `${text[0].toUpperCase()}${text.slice(1)}` : text);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const sameList = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** How many probable-move teams are listed before "Show all N teams". */
const MOVES_SHOWN = 25;

/** What each checked rule of the coverage sentence is called. */
const CHECKED_WORDS = Object.freeze({
  capacity: 'slot capacity',
  reservation: 'division reservation',
  length: 'division practice length',
  weekday: 'one practice per weekday',
  count: 'practices per week',
  'coach-conflict': 'coach overlap at the same weekday and time',
  'team-on-both-halves': 'a team on both halves of a field at once',
  'hold-over-open-slot': 'a held cell over a slot',
});

/** The counts of a preview and a result, in the order and the words the screen shows them. */
const COUNT_ROWS = Object.freeze([
  ['rows', 'Rows in the file'],
  ['placements', 'Rows that place a team'],
  ['open', 'Open slots (rows with no team)'],
  ['holds', 'Cells held for a non-team activity'],
  ['refused', 'Rows not imported (listed below)'],
  ['skipped', 'Rows skipped by your choice'],
  ['inserted', 'Practices added'],
  ['unchanged', 'Practices already saved as the file has them'],
  ['held_back', 'New rows held back (probable moves not ticked)'],
  ['slots_created', 'Practice slots created'],
  ['slots_found', 'Practice slots found (never changed)'],
  ['leaving', 'Saved practices this file does not hold (kept)'],
  ['arriving', 'New rows in this file'],
  ['probable_move_teams', 'Teams with a probable move'],
]);
/** What the import may create, by its count and the list of names the mapping that was sent would create. */
const CREATED_ROWS = Object.freeze([
  ['divisions_created', 'divisions', 'Divisions'],
  ['locations_created', 'locations', 'Locations'],
  ['fields_created', 'fields', 'Fields'],
  ['subunits_created', 'subunits', 'Halves and sides'],
  ['team_shells_created', 'teamShells', 'Teams (no players or coach yet)'],
]);

/** The name a label's `<select>` is called by: the label, and the labels it sits under. */
function entryName(entry) {
  if (entry.kind === 'field') return `${entry.label} (${entry.locationLabel})`;
  if (entry.kind === 'subunit')
    return `${entry.label} (${entry.locationLabel}, ${entry.fieldLabel})`;
  if (entry.kind === 'team') return `${entry.label} (${entry.divisionLabel})`;
  return entry.label;
}

/** A division's proposed settings in words, beside what is stored. */
function settingsWords(p) {
  const ppw = p.practicesPerWeek;
  const min = p.practiceMinutes;
  const perWeek = ppw.tie
    ? `no proposal for practices a week (a tie between ${ppw.tied.join(' and ')})`
    : ppw.proposed === null
      ? 'no proposal for practices a week'
      : ppw.differs
        ? `${ppw.proposed} a week (stored: ${ppw.stored ?? 'none yet'})${ppw.storable ? '' : ', which cannot be stored (0 to 7)'}`
        : `${ppw.proposed} a week, as stored`;
  const storedMinutes = min.stored === null ? 'any length' : `${min.stored} minutes`;
  const length =
    min.proposed === null
      ? 'no proposal for a length'
      : min.proposed === 'any'
        ? `any length (the file has ${min.lengths.join(', ')} minutes)${min.differs ? ` (stored: ${storedMinutes})` : ', as stored'}`
        : min.differs
          ? `length ${min.proposed} minutes (stored: ${storedMinutes})${min.storable ? '' : ', which cannot be stored (15 to 240)'}`
          : `length ${min.proposed} minutes, as stored`;
  return `${p.label}${p.isNew ? ' (created by this import)' : ''}: ${perWeek}; ${length}.`;
}

/** A patch of `divisionSettingsToApply` in words. */
function patchWords(patch, label) {
  const parts = [];
  if (patch.practicesPerWeek !== undefined)
    parts.push(`${patch.practicesPerWeek} practices a week`);
  if (patch.practiceMinutes !== undefined) {
    parts.push(
      patch.practiceMinutes === 'any'
        ? 'any practice length'
        : `practice length ${patch.practiceMinutes} minutes`
    );
  }
  return `${label}: ${parts.join(', ')}`;
}

/**
 * @param {Object} props
 * @param {'mapping' | 'preview' | 'result'} props.step
 * @param {string} props.fileName
 * @param {any} props.staging  the Edge function's summary of the file
 * @param {any[]} props.rows  the staged rows, read back
 * @param {any} props.league
 * @param {Record<string, Record<string, string>>} props.choices
 * @param {(update: any) => void} props.setChoices
 * @param {{ dates: any, aliasFile: { name: string, headers: string[], rows: any[] } | null, previous: any,
 *   settingsTicks: Record<string, boolean>, moveTicks: string[] }} props.practice
 * @param {(update: any) => void} props.setPractice
 * @param {{ creations: Record<string, Array<{ name: string }>>, mapping?: any, settings?: any[] } | null} props.sent
 *   the stored mapping, the names it would create, and the ticked division settings the confirm saves after the apply
 * @param {any} props.preview
 * @param {any} props.stale
 * @param {Record<string, number | boolean> | null} props.counts
 * @param {boolean} props.createAck
 * @param {(value: boolean) => void} props.setCreateAck
 * @param {any} props.result
 * @param {any} props.settingsOutcome
 * @param {string | null} props.busy
 * @param {boolean} props.unknown
 * @param {boolean} props.rolledBackHere
 * @param {any} props.undone
 * @param {string | null} props.jobId
 * @param {(mapping: any, creations: any, settings: any[]) => void} props.onPreview
 * @param {() => void} props.onConfirm
 * @param {() => void} props.onBack
 * @param {() => void} props.onCancel
 * @param {(jobId: string) => void} props.onRollback
 * @param {() => void} props.onReset
 * @param {(() => void) | undefined} props.onDone
 * @param {(undone: any) => string} props.describeRolledBack
 */
export default function PracticeImportSteps(props) {
  const { step, rows, league, choices, practice, preview } = props;
  const aliasInputId = useId();
  const movesListId = useId();
  // Every probable-move team is ticked on its own: the first few are shown, and the rest one press away (Codex on #732:
  // a list cut at a number left the teams past it with no tick of their own).
  const [showAllMoves, setShowAllMoves] = useState(false);
  const ackId = useId();

  // The alias file, read in this browser against the league (never uploaded or stored).
  const aliasRead = useMemo(() => {
    if (!practice.aliasFile) return null;
    return readPracticeAliases({
      headers: practice.aliasFile.headers,
      rows: practice.aliasFile.rows,
      league,
    });
  }, [practice.aliasFile, league]);
  const aliases = aliasRead?.ok ? aliasRead.aliases : undefined;
  const previous = practice.previous ?? undefined;

  // Core's reading of the labels: proposed once without the admin's decisions (for each choice's source), then with.
  const bare = useMemo(
    () => proposePracticeMapping({ rows, league, aliases, previous }),
    [rows, league, aliases, previous]
  );
  const decisions = useMemo(() => decisionsFromChoices(choices, bare), [choices, bare]);
  const proposal = useMemo(
    () => proposePracticeMapping({ rows, league, decisions, aliases, previous }),
    [rows, league, decisions, aliases, previous]
  );
  const resolved = useMemo(
    () => resolvePracticeRows({ rows, league, decisions, aliases, previous }),
    [rows, league, decisions, aliases, previous]
  );
  const settings = useMemo(
    () => proposeDivisionSettings({ rows: resolved.rows, league }),
    [resolved, league]
  );
  // A division this import creates is not offered a setting: its row would then differ from what the apply wrote, and
  // a roll back would keep it as changed. It is set on the Team Analysis page after the confirm.
  const offered = settings.filter(
    (p) =>
      !p.isNew &&
      ((p.practicesPerWeek.differs && p.practicesPerWeek.storable) ||
        (p.practiceMinutes.differs && p.practiceMinutes.storable))
  );
  // Only a ticked division, and only values the database would take (decision 26: never silent).
  const patches = useMemo(() => {
    const ticked = offered.filter((p) => practice.settingsTicks[p.divisionId] === true);
    return divisionSettingsToApply(
      settings,
      ticked.map((p) => p.divisionId)
    )
      .filter(
        (patch) => patch.practicesPerWeek !== undefined || patch.practiceMinutes !== undefined
      )
      .map((patch) => {
        const p = settings.find((x) => x.divisionId === patch.divisionId);
        const stored = league.divisions.find((d) => d.id === patch.divisionId);
        // the division's other rules as this import read them: the save refuses if they have changed since
        return { ...patch, name: stored?.name ?? p?.label ?? '', roster: stored?.roster ?? null };
      });
  }, [offered, settings, practice.settingsTicks, league]);

  // The probable moves of the preview on screen: the database's flagged rows, team by team.
  const moves = useMemo(() => (preview ? practiceProbableMoves(preview) : []), [preview]);
  const moveRows = useMemo(
    () => new Set(moves.flatMap((m) => m.arriving.map((a) => String(a.row_key)))),
    [moves]
  );
  // A tick is sent only for a row the database flagged a probable move, and the confirm waits for a preview with it.
  const ticked = practice.moveTicks.filter((key) => moveRows.has(key));
  const storedTicks = props.sent?.mapping?.options?.add_moved_rows ?? [];
  const ticksChanged = preview !== null && !sameList(ticked, storedTicks);

  // Every change of the choices drops a `map:<id>` its label's scope no longer holds (a team of the division its
  // division label was mapped to before): it would be sent and refused, or hidden behind a select that shows "not
  // decided".
  const proposeFor = (/** @type {Record<string, Record<string, string>>} */ next) =>
    proposePracticeMapping({
      rows,
      league,
      decisions: decisionsFromChoices(next, bare),
      aliases,
      previous,
    });
  const settle = (next) => withoutOutOfScopeChoices(next, proposeFor, league);
  const setChoice = (group, key, value) =>
    props.setChoices((prev) =>
      settle({ ...prev, [group]: { ...(prev[group] ?? {}), [key]: value } })
    );
  const setAllUndecided = (group, value) =>
    props.setChoices((prev) => {
      const next = { ...(prev[group] ?? {}) };
      for (const entry of proposal[group]) {
        if (shownChoice(entry, prev[group]?.[entry.key]) === UNDECIDED) next[entry.key] = value;
      }
      return settle({ ...prev, [group]: next });
    });

  // The proposals an admin may take in one press: a label nobody decided, with one record every proposal names and no
  // disagreement. Taken in rounds, as a field's proposals depend on its location's decision (core's own rule).
  const proposable = (p, current) =>
    PRACTICE_MAPPING_GROUPS.flatMap(({ group }) =>
      p[group]
        .filter(
          (e) =>
            typeof current[group]?.[e.key] !== 'string' && !e.effective && e.proposed && !e.conflict
        )
        .map((e) => ({ group, key: e.key, id: e.proposed.id }))
    );
  const proposableNow = proposable(proposal, choices).length;
  const useEveryProposal = () => {
    let next = { ...choices };
    for (let round = 0; round < 6; round += 1) {
      const p = proposePracticeMapping({
        rows,
        league,
        decisions: decisionsFromChoices(next, bare),
        aliases,
        previous,
      });
      const take = proposable(p, next);
      if (take.length === 0) break;
      for (const { group, key, id } of take) {
        next = { ...next, [group]: { ...(next[group] ?? {}), [key]: `map:${id}` } };
      }
    }
    props.setChoices(settle(next));
  };

  const preview_ = () => {
    // The mapping that is sent, the names IT would create, and the ticked settings: taken once, here.
    const mapping = practiceMappingForJob(proposal, choices, ticked, resolved.rows);
    props.onPreview(mapping, resolved.creations, patches);
  };
  const previewWithTicks = () => {
    if (!props.sent?.mapping) return;
    props.onPreview(
      {
        ...props.sent.mapping,
        options: { ...props.sent.mapping.options, add_moved_rows: [...ticked].sort() },
      },
      props.sent.creations,
      props.sent.settings ?? []
    );
  };
  const setTicks = (keys, on) =>
    props.setPractice((prev) => {
      const next = new Set(prev.moveTicks);
      for (const key of keys) {
        if (on) next.add(key);
        else next.delete(key);
      }
      return { ...prev, moveTicks: [...next].sort() };
    });

  const handleAliasFile = (file) => {
    if (!file) return;
    const tooLarge = importFileSizeProblem(file);
    if (tooLarge) {
      props.setPractice((prev) => ({
        ...prev,
        aliasFile: { name: file.name, headers: [], rows: [], problem: tooLarge },
      }));
      return;
    }
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: ({ data, meta }) => {
        // The CSV reader renames a repeated header (`Location`, `Location_1`) and goes on, so the alias reader would
        // never see the second column, and one of two conflicting columns would be used without a word. A repeat of a
        // column the alias file is read by refuses the file, as the main upload does.
        const repeated = Object.values(meta.renamedHeaders ?? {}).find((original) =>
          practiceAliasReadsHeader(String(original))
        );
        props.setPractice((prev) => ({
          ...prev,
          aliasFile:
            repeated !== undefined
              ? {
                  name: file.name,
                  headers: [],
                  rows: [],
                  problem: `the file has the column "${String(repeated).trim()}" more than once (or two names for it). Remove one and choose it again`,
                }
              : { name: file.name, headers: meta.fields ?? [], rows: data },
        }));
      },
      error: (err) =>
        props.setPractice((prev) => ({
          ...prev,
          aliasFile: {
            name: file.name,
            headers: [],
            rows: [],
            problem: String(err?.message ?? err),
          },
        })),
    });
  };

  const busy = props.busy !== null;

  // ------------------------------------------------------------------------------------------------ the mapping
  if (step === 'mapping') {
    const s = props.staging;
    const undecided = PRACTICE_MAPPING_GROUPS.reduce(
      (n, { group }) =>
        n +
        proposal[group].filter((e) => shownChoice(e, choices[group]?.[e.key]) === UNDECIDED).length,
      0
    );
    const aliasProblem = /** @type {any} */ (practice.aliasFile)?.problem ?? null;
    return (
      <div>
        <p className="text-sm text-text-secondary max-w-prose" data-testid="practice-import-staged">
          {`${props.fileName}: ${s.rows} rows read. ${plural(s.placements, 'practice', 'practices')}, ${plural(
            s.open,
            'open slot',
            'open slots'
          )}, ${plural(s.holds, 'held cell', 'held cells')}, ${s.refused} that cannot be imported.`}
          {s.dropped_columns.length > 0 &&
            ` Columns not read and not stored: ${s.dropped_columns.join(', ')}.`}
        </p>
        <NamedList
          testId="schedule-import-upload-warnings"
          heading="Rows the import kept, with a note"
          total={s.warnings.length}
          items={s.warnings.map((w) => `Row ${w.row}: ${w.message}`)}
        />
        <NamedList
          testId="schedule-import-upload-refused"
          heading="Rows that cannot be imported"
          total={s.refused_rows.length}
          items={s.refused_rows.map((r) => `Row ${r.row}: ${r.message}`)}
        />

        <section className="mt-5 max-w-prose" aria-label="Alias file">
          <p className="text-sm text-text-secondary">
            An alias file says which of your locations, fields or halves a name in the file means
            (columns Alias, Location, Field, Subunit). It is read in this browser, never uploaded or
            stored, and its proposals are shown beside each name; none is applied until you choose
            it.
          </p>
          <div className="flex flex-wrap items-center gap-3 mt-2">
            <label
              htmlFor={aliasInputId}
              className="btn btn-secondary cursor-pointer focus-within:outline-none focus-within:ring-2 focus-within:ring-blue-400/80"
            >
              Choose an alias file (optional)
              <input
                id={aliasInputId}
                data-testid="practice-import-alias-file"
                type="file"
                accept=".csv"
                className="sr-only"
                disabled={busy}
                onChange={(event) => {
                  handleAliasFile(event.target.files?.[0]);
                  event.target.value = '';
                }}
              />
            </label>
            {practice.aliasFile && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => props.setPractice((prev) => ({ ...prev, aliasFile: null }))}
              >
                Stop using the alias file
              </Button>
            )}
          </div>
          {practice.aliasFile && (
            <div className="mt-2" data-testid="practice-import-alias-summary">
              {aliasProblem ? (
                <Notice tone="error">{`${practice.aliasFile.name} could not be read: ${aliasProblem}`}</Notice>
              ) : aliasRead && !aliasRead.ok ? (
                <Notice tone="error">{`${practice.aliasFile.name}: ${aliasRead.refusal?.message}`}</Notice>
              ) : (
                aliasRead && (
                  <Notice>
                    {`${practice.aliasFile.name}: ${plural(aliasRead.counts.ok, 'alias', 'aliases')} read${
                      aliasRead.counts.refused > 0 ? `, ${aliasRead.counts.refused} not read` : ''
                    }.`}
                    {aliasRead.rows
                      .filter((r) => r.status === 'refused')
                      .slice(0, NAMED)
                      .map((r) => (
                        <span
                          key={r.rowNumber}
                          className="block"
                        >{`Row ${r.rowNumber}: ${r.message}`}</span>
                      ))}
                  </Notice>
                )
              )}
            </div>
          )}
          {practice.previous && (
            <p className="text-xs text-text-muted mt-2" data-testid="practice-import-previous">
              The choices of this season’s previous practice import are shown as proposals.
            </p>
          )}
        </section>

        <p className="text-sm text-text-secondary max-w-prose mt-4">
          A name that matches exactly one of your records is matched for you; change it if it is
          wrong. A name with no match is not imported until you say what it is. Nothing is created
          until you confirm the list on the next step.
        </p>
        {proposableNow > 0 && (
          <div className="mt-3">
            <Button variant="secondary" size="sm" disabled={busy} onClick={useEveryProposal}>
              {`Use every proposal nothing disagrees with (${proposableNow})`}
            </Button>
            <p className="text-xs text-text-muted mt-1 max-w-prose">
              Takes the record the alias file or the previous import proposes, for each name you
              have not decided and whose proposals agree. A name whose proposals disagree stays for
              you.
            </p>
          </div>
        )}

        {PRACTICE_MAPPING_GROUPS.map(({ group, title, noun }) => {
          const entries = proposal[group];
          if (entries.length === 0) return null;
          const open = entries.filter(
            (e) => shownChoice(e, choices[group]?.[e.key]) === UNDECIDED
          ).length;
          return (
            <section key={group} data-testid={`practice-import-map-${group}`} className="mt-5">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                <h5 className="text-sm font-semibold text-text-primary">
                  {`${title} (${entries.length}${open > 0 ? `, ${open} not decided` : ''})`}
                </h5>
                {open > 0 && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => setAllUndecided(group, 'create')}
                    >
                      {`Create every undecided ${noun}`}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
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
                      const choice = choices[group]?.[entry.key];
                      const value = shownChoice(entry, choice);
                      const options = choiceOptions(
                        entry,
                        recordsInScope(entry, league, proposal, choices)
                      );
                      const problem = value === UNDECIDED ? null : shownProblem(entry, choice);
                      const parent =
                        entry.kind === 'field'
                          ? entry.locationLabel
                          : entry.kind === 'subunit'
                            ? `${entry.locationLabel}, ${entry.fieldLabel}`
                            : entry.kind === 'team'
                              ? entry.divisionLabel
                              : null;
                      const said =
                        entry.conflict || (entry.proposals ?? []).some((p) => p.source !== 'exact')
                          ? proposalWords(entry, league)
                          : null;
                      return (
                        <tr key={entry.key} data-testid={`practice-import-entry-${group}`}>
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
                              aria-label={`What ${entryName(entry)} is`}
                              disabled={busy}
                              className="w-full max-w-md rounded-md border border-border-subtle bg-bg-surface text-text-primary px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/80"
                              value={options.some((o) => o.value === value) ? value : UNDECIDED}
                              onChange={(event) => setChoice(group, entry.key, event.target.value)}
                            >
                              {options.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                            {said && (
                              <span
                                className="block text-xs text-text-muted mt-1"
                                data-testid="practice-import-proposal"
                              >
                                {said}
                              </span>
                            )}
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

        {settings.length > 0 && (
          <section data-testid="practice-import-settings" className="mt-6 max-w-prose">
            <h5 className="text-sm font-semibold text-text-primary">
              Practice settings the file suggests
            </h5>
            <p className="text-xs text-text-muted mt-1">
              For each division: the most common number of practices a week its teams hold in the
              file, and the length when every practice has one length, beside what is stored. One a
              week with any length is also what a division holds when nobody set it, so it is shown
              and asked, never assumed. A ticked division’s settings are saved after the import,
              with its other rules as they are; an unticked one is left as it is.
            </p>
            <ul className="mt-2 space-y-2 text-sm text-text-secondary">
              {settings.map((p) => {
                const tickable = offered.includes(p);
                const label = `Save these settings for ${p.label}`;
                return (
                  <li key={p.divisionId}>
                    {tickable ? (
                      <label className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          className="mt-1"
                          aria-label={label}
                          checked={practice.settingsTicks[p.divisionId] === true}
                          disabled={busy}
                          onChange={(event) => {
                            const on = event.target.checked;
                            props.setPractice((prev) => ({
                              ...prev,
                              settingsTicks: { ...prev.settingsTicks, [p.divisionId]: on },
                            }));
                          }}
                        />
                        <span>{settingsWords(p)}</span>
                      </label>
                    ) : p.isNew ? (
                      <span>{`${settingsWords(p)} This import creates the division, so its settings are not saved here: set them on the Team Analysis page after you confirm.`}</span>
                    ) : (
                      <span>{`${settingsWords(p)} Nothing to save.`}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <p
          data-testid="practice-import-mapping-summary"
          className="text-sm text-text-secondary mt-4"
        >
          {`With these choices: ${plural(resolved.counts.placements, 'practice', 'practices')} and ${plural(
            resolved.counts.open,
            'open slot',
            'open slots'
          )} would be imported, ${resolved.counts.refused} rows not imported, ${resolved.counts.skipped} skipped.${
            undecided > 0 ? ` ${undecided} names are not decided.` : ''
          } The preview says what the database would do.`}
        </p>
        <div className="flex flex-wrap gap-3 mt-4">
          <Button variant="primary" disabled={busy} onClick={preview_}>
            Preview the import
          </Button>
          <Button variant="secondary" disabled={busy} onClick={props.onCancel}>
            Cancel this import
          </Button>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------------------------------------ shared lists
  /** The name of a team the database names by id: the league's, else one this import creates. */
  const teamName = (id) =>
    league.teams.find((t) => String(t.id) === String(id))?.name ?? 'A team this import creates';
  /** @param {any} r */
  const flagLines = (r) =>
    (r?.flagged ?? []).map(
      (f) =>
        `Row ${f.row}: ${words(f.code)} ${capital(readable(f.detail))}${/[.!?]$/.test(readable(f.detail)) ? '' : '.'}`
    );
  /** @param {any} r */
  const refusedLines = (r) =>
    (r?.refused ?? []).map((x) => {
      const said = readable(x.message);
      return `Row ${x.row}: ${words(x.reason)}${said ? ` ${said}` : ''}`;
    });
  /** @param {any} r @param {string} testPrefix */
  const lists = (r, testPrefix, shortNote = null, teamsNow = null) => {
    const inFile = new Set([
      ...(r?.time_tbd?.teams ?? []).filter((t) => t.in_file).map((t) => String(t.team_id)),
      ...(r?.arriving ?? []).map((a) => String(a.team_id)),
    ]);
    const teams = teamsNow
      ? teamsNow.map((t) => ({ ...t, in_file: inFile.has(String(t.team_id)) }))
      : (r?.time_tbd?.teams ?? []);
    const short = teams.filter((t) => t.in_file);
    const elsewhere = teams.filter((t) => !t.in_file);
    return (
      <>
        <NamedList
          testId={`${testPrefix}-refused`}
          heading="Rows that will not be imported"
          total={Number(r?.counts?.refused ?? 0)}
          items={refusedLines(r)}
        />
        <NamedList
          testId={`${testPrefix}-skipped`}
          heading="Rows skipped by your choice"
          total={Number(r?.counts?.skipped ?? 0)}
          items={(r?.skipped ?? []).map(
            (x) => `Row ${x.row}: the ${x.kind} "${x.label}" is skipped`
          )}
        />
        <NamedList
          testId={`${testPrefix}-holds`}
          heading="Cells held for a non-team activity"
          total={(r?.holds ?? []).length}
          items={(r?.holds ?? []).map(
            (h) =>
              `Row ${h.row}: held for a non-team activity; it makes no slot${
                h.ground_known
                  ? ', and its ground is one of yours.'
                  : '. Its ground is not one of yours, so nothing was checked against it.'
              }`
          )}
        />
        {Object.keys(r?.flags ?? {}).length > 0 && (
          <section data-testid={`${testPrefix}-flags`} className="mt-4">
            <h4 className="text-sm font-semibold text-text-primary mb-1">
              Flagged, and imported anyway, by rule
            </h4>
            <ul className="text-sm text-text-secondary space-y-1 list-disc pl-5">
              {Object.entries(r.flags).map(([code, n]) => (
                <li key={code}>
                  {`${clause(code)}: ${plural(Number(n.rows), 'row', 'rows')}${
                    n.teams ? `, ${plural(Number(n.teams), 'team', 'teams')}` : ''
                  }`}
                </li>
              ))}
            </ul>
          </section>
        )}
        <NamedList
          testId={`${testPrefix}-flagged`}
          heading="Flagged rows"
          total={(r?.flagged ?? []).length}
          items={flagLines(r)}
        />
        {(short.length > 0 || elsewhere.length > 0) && (
          <section data-testid={`${testPrefix}-short`} className="mt-4">
            <h4 className="text-sm font-semibold text-text-primary mb-1">
              {`Teams short of their division’s practices a week (${short.length + elsewhere.length})`}
            </h4>
            <p className="text-xs text-text-muted mb-1 max-w-prose">
              They are on the TIME TBD list, and the next practice run places only them; every saved
              practice stays where it is.
              {shortNote && ` ${shortNote}`}
            </p>
            <ul className="text-sm text-text-secondary space-y-1 list-disc pl-5">
              {short.slice(0, NAMED).map((t) => (
                <li key={t.team_id}>
                  {`${teamName(t.team_id)}: ${plural(Number(t.missing_count), 'practice', 'practices')} short`}
                </li>
              ))}
            </ul>
            {short.length > NAMED && (
              <p className="text-xs text-text-muted mt-1">{`and ${short.length - NAMED} more`}</p>
            )}
            {elsewhere.length > 0 && (
              <p className="text-xs text-text-muted mt-1">
                {`and ${plural(elsewhere.length, 'team', 'teams')} of the season this file does not name.`}
              </p>
            )}
          </section>
        )}
      </>
    );
  };
  /** @param {any} r @param {boolean} withTestIds */
  const countTable = (r, withTestIds) => (
    <dl
      data-testid={withTestIds ? 'practice-import-counts' : 'practice-import-result-counts'}
      className="mt-3 rounded-lg border border-border-subtle divide-y divide-border-subtle max-w-xl"
    >
      {COUNT_ROWS.map(([key, label]) => (
        <div key={key} className="flex items-baseline justify-between gap-3 px-3 py-2">
          <dt className="text-sm text-text-secondary">{label}</dt>
          <dd
            data-testid={withTestIds ? `practice-import-count-${key}` : undefined}
            className="text-sm font-semibold text-text-primary tabular-nums"
          >
            {Number(r?.counts?.[key] ?? 0)}
          </dd>
        </div>
      ))}
    </dl>
  );

  // ------------------------------------------------------------------------------------------------ the preview
  if (step === 'preview' && preview && props.counts) {
    const c = preview.counts;
    const recordsTotal = CREATED_ROWS.reduce((n, [key]) => n + Number(c[key] ?? 0), 0);
    const slots = Number(c.slots_created ?? 0);
    const createdTotal = recordsTotal + slots;
    const cov = preview.coverage ?? {};
    const movesTeams = new Set(moves.map((m) => m.teamId));
    const leavingOnly = (preview.leaving ?? []).filter((l) => !movesTeams.has(String(l.team_id)));
    const pending = props.sent?.settings ?? [];
    return (
      <div>
        {props.stale && (
          <div className="mb-4">
            <Notice tone="warning" testId="schedule-import-stale" role="alert">
              <p>{props.stale.message}</p>
              <ul className="list-disc pl-5 mt-1">
                {props.stale.differing.slice(0, NAMED).map((key) => (
                  <li key={key}>
                    {`${COUNT_ROWS.find(([k]) => k === key)?.[1] ?? CREATED_ROWS.find(([k]) => k === key)?.[2] ?? key}: was ${String(
                      props.stale.confirmed?.[key] ?? 0
                    )}, now ${String(props.stale.current?.[key] ?? 0)}`}
                  </li>
                ))}
              </ul>
            </Notice>
          </div>
        )}
        <p className="text-sm text-text-secondary max-w-prose">
          This is what the import will do, as the database worked it out with every write undone.
          Nothing has been written yet.
        </p>
        {countTable(preview, true)}

        <section data-testid="practice-import-creations" className="mt-4">
          <h4 className="text-sm font-semibold text-text-primary mb-1">
            {`What will be created (${createdTotal})`}
          </h4>
          {recordsTotal === 0 ? (
            <p className="text-sm text-text-secondary">
              Nothing: every practice uses records you already have.
            </p>
          ) : (
            <ul className="text-sm text-text-secondary space-y-2">
              {CREATED_ROWS.filter(([key]) => Number(c[key] ?? 0) > 0).map(
                ([key, listKey, label]) => {
                  const names = (props.sent?.creations?.[listKey] ?? []).map((x) => x.name);
                  return (
                    <li key={key} data-testid={`practice-import-created-${listKey}`}>
                      <span className="font-semibold text-text-primary">{`${label}: ${Number(c[key])}`}</span>
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
          {slots > 0 && (
            <p className="text-sm text-text-secondary mt-2">
              <span className="font-semibold text-text-primary">{`Practice slots: ${slots}`}</span>{' '}
              (every timed row is a slot, used or not; a slot that exists is found and never
              changed)
            </p>
          )}
          {(Number(c.locations_created ?? 0) > 0 || Number(c.fields_created ?? 0) > 0) && (
            <p className="text-xs text-text-muted mt-2 max-w-prose">
              Locations and fields created here have no coordinates and unknown lighting: their
              practices read sunset-unknown on the Practice daylight page until you enter them.
            </p>
          )}
        </section>

        {pending.length > 0 && (
          <section data-testid="practice-import-settings-pending" className="mt-4 max-w-prose">
            <h4 className="text-sm font-semibold text-text-primary mb-1">
              {`Division settings saved after the import (${pending.length})`}
            </h4>
            <ul className="text-sm text-text-secondary list-disc pl-5">
              {pending.map((patch) => (
                <li key={patch.divisionId}>{patchWords(patch, patch.name)}</li>
              ))}
            </ul>
            <p className="text-xs text-text-muted mt-1">
              The flags below are judged with the settings stored now; the TIME TBD list is counted
              again with the saved ones. A roll back of this import does not undo them.
            </p>
          </section>
        )}

        {moves.length > 0 && (
          <section data-testid="practice-import-moves" className="mt-4 max-w-prose">
            <h4 className="text-sm font-semibold text-text-primary mb-1">
              {`Probable moves (${moves.length})`}
            </h4>
            <Notice tone="warning" testId="practice-import-moves-held">
              These teams already have saved practices in these dates; their new rows are held back
              until you tick them. On a first import into a season the practice run already filled,
              that is every such team. Nothing saved is moved or deleted: a saved practice stays
              until you remove it on the Practices page, with a reason.
            </Notice>
            <div className="mt-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={busy || ticked.length === moveRows.size}
                onClick={() => setTicks([...moveRows], true)}
              >
                Tick all probable moves
              </Button>
            </div>
            <p
              className="text-sm text-text-secondary mt-2"
              data-testid="practice-import-moves-count"
            >
              {`${plural(
                moves.filter((m) => m.arriving.every((a) => ticked.includes(String(a.row_key))))
                  .length,
                'team',
                'teams'
              )} of ${moves.length} ticked. ${
                showAllMoves || moves.length <= MOVES_SHOWN
                  ? `Showing all ${plural(moves.length, 'team', 'teams')}.`
                  : `Showing the first ${MOVES_SHOWN} of ${moves.length} teams.`
              }`}
            </p>
            <ul id={movesListId} className="mt-2 space-y-2 text-sm text-text-secondary">
              {(showAllMoves ? moves : moves.slice(0, MOVES_SHOWN)).map((m) => {
                const keys = m.arriving.map((a) => String(a.row_key));
                const on = keys.every((k) => ticked.includes(k));
                return (
                  <li key={m.teamId}>
                    <span className="block font-medium text-text-primary">{m.summary}</span>
                    <span className="block text-xs text-text-muted">
                      {`Leaving (kept): ${
                        m.leaving
                          .map((l) => `${l.day} ${l.start_time} to ${l.end_time}`)
                          .join('; ') || 'none'
                      }. Arriving: ${m.arriving.map((a) => `row ${a.row}`).join(', ')}.`}
                    </span>
                    <label className="flex items-start gap-2 mt-1">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={on}
                        disabled={busy}
                        onChange={(event) => setTicks(keys, event.target.checked)}
                      />
                      <span>{`Add ${m.team}'s ${plural(keys.length, 'new row', 'new rows')}`}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
            {moves.length > MOVES_SHOWN && (
              <div className="mt-2">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-expanded={showAllMoves}
                  aria-controls={movesListId}
                  onClick={() => setShowAllMoves((open) => !open)}
                >
                  {showAllMoves
                    ? `Show only the first ${MOVES_SHOWN} teams`
                    : `Show all ${moves.length} teams`}
                </Button>
              </div>
            )}
          </section>
        )}
        {ticksChanged && (
          <div className="mt-3">
            <Notice tone="warning" testId="practice-import-ticks-changed">
              <p>
                Your ticks are not in this preview yet. Make the preview again with them before you
                confirm.
              </p>
              <div className="mt-2">
                <Button variant="secondary" size="sm" disabled={busy} onClick={previewWithTicks}>
                  Update the preview with these ticks
                </Button>
              </div>
            </Notice>
          </div>
        )}
        <NamedList
          testId="practice-import-leaving"
          heading="Saved practices this file does not hold (kept as they are)"
          total={leavingOnly.length}
          items={leavingOnly.map(
            (l) => `${l.team ?? teamName(l.team_id)}: ${l.day} ${l.start_time} to ${l.end_time}`
          )}
        />

        {lists(preview, 'practice-import')}

        <p
          data-testid="practice-import-coverage"
          className="text-xs text-text-muted max-w-prose mt-4"
        >
          {`Checked: ${(cov.checked ?? []).map((k) => CHECKED_WORDS[k] ?? k).join(', ')}. Not checked: ${(
            cov.not_checked ?? []
          ).join(
            ', '
          )}. Coach overlap was judged only for the ${Number(cov.coach_judged_teams ?? 0)} teams (of ${Number(
            cov.file_teams ?? 0
          )}) that have a coach assigned.`}
        </p>

        {createdTotal > 0 && (
          <label htmlFor={ackId} className="flex items-start gap-2 text-sm text-text-primary mt-4">
            <input
              id={ackId}
              data-testid="practice-import-create-ack"
              type="checkbox"
              className="mt-1"
              checked={props.createAck}
              onChange={(event) => props.setCreateAck(event.target.checked)}
            />
            <span>{`Create the ${createdTotal} records listed above`}</span>
          </label>
        )}
        <div className="flex flex-wrap gap-3 mt-4">
          <Button
            variant="primary"
            disabled={
              busy || props.unknown || ticksChanged || (createdTotal > 0 && !props.createAck)
            }
            onClick={props.onConfirm}
          >
            Confirm and import
          </Button>
          <Button variant="secondary" disabled={busy || props.unknown} onClick={props.onBack}>
            Back to the names
          </Button>
          <Button variant="ghost" disabled={busy || props.unknown} onClick={props.onCancel}>
            Cancel this import
          </Button>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------------------------------------ the result
  if (step === 'result' && props.result) {
    const r = props.result;
    const c = r.counts ?? {};
    const pending = props.sent?.settings ?? [];
    const outcome = props.settingsOutcome;
    return (
      <div>
        {props.rolledBackHere ? (
          <Notice tone="success" testId="schedule-import-rolled-back">
            {props.describeRolledBack(props.undone)}
          </Notice>
        ) : (
          <Notice tone="success" testId="practice-import-applied">
            {`Imported: ${plural(Number(c.inserted ?? 0), 'practice', 'practices')} added, ${Number(
              c.unchanged ?? 0
            )} already saved, ${Number(c.held_back ?? 0)} held back (probable moves not ticked), ${plural(
              Number(c.slots_created ?? 0),
              'practice slot',
              'practice slots'
            )} created. Saved practices are locked: a later save keeps them, and one moves only through the Practices page's unlock, with a reason.`}
          </Notice>
        )}
        {!props.rolledBackHere && pending.length > 0 && (
          <div className="mt-2">
            {outcome ? (
              <Notice
                tone={outcome.failed.length > 0 || !outcome.refreshed ? 'warning' : 'success'}
                testId="practice-import-settings-saved"
              >
                <p>
                  {outcome.saved.length > 0
                    ? `Saved: ${outcome.saved.map((x) => x.name).join(', ')}.`
                    : 'No division settings were saved.'}
                </p>
                {outcome.failed.map((x) => (
                  <p
                    key={x.name}
                  >{`Not saved: ${x.name} (${x.message}). Set it on the Team Analysis page.`}</p>
                ))}
                {outcome.saved.length > 0 && !outcome.refreshed && (
                  <p>{`The TIME TBD list could not be counted again with them (${outcome.refreshMessage}); the next practice save counts it.`}</p>
                )}
              </Notice>
            ) : (
              <Notice tone="warning" testId="practice-import-settings-saved">
                The import is applied, but the division settings you ticked were not saved (its
                answer was read from the job). Set them on the Team Analysis page.
              </Notice>
            )}
          </div>
        )}
        {countTable(r, false)}
        {lists(
          r,
          'practice-import-result',
          // After the ticked division settings were saved the list was counted again and read back: those are the
          // teams short NOW. When it could not be read back, the apply's own list is said to be from before them.
          outcome?.saved?.length > 0
            ? outcome.tbd
              ? 'Counted again after the division settings were saved.'
              : 'As counted before the division settings were saved; the next practice save counts it again.'
            : null,
          outcome?.saved?.length > 0 && outcome.tbd ? outcome.tbd : null
        )}
        <div className="flex flex-wrap gap-3 mt-4">
          {!props.rolledBackHere && props.jobId && (
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => props.onRollback(/** @type {string} */ (props.jobId))}
            >
              Roll back this import
            </Button>
          )}
          <Button variant="secondary" disabled={busy} onClick={props.onReset}>
            Import another file
          </Button>
          {props.onDone && !props.rolledBackHere && (
            <Button variant="primary" disabled={busy} onClick={props.onDone}>
              Continue
            </Button>
          )}
        </div>
      </div>
    );
  }
  return null;
}
