import React from 'react';
import PropTypes from 'prop-types';
import Badge from '../ui/Badge.jsx';
import { LEVEL_LABEL, PRIORITY_LABEL, describeRule } from '../../utils/coachPreferencePreview.js';
import { ROW_REFUSAL } from '../../utils/practicePreferenceImportPreview.js';

/** Rules listed in the preview before "and N more" (the counts above are of all of them). */
const RULES_LISTED = 50;

/** A rule of the preview in the store's shape, for `describeRule`. */
const rowShape = (rule) => ({
  weekdays: rule.weekdays,
  start_minutes: rule.startMinutes,
  venue_ids: rule.venueIds,
});

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const REFUSAL_HEADING = {
  [ROW_REFUSAL.UNKNOWN_COACH]: 'No coach with this email in the season (never created)',
  [ROW_REFUSAL.UNKNOWN_TEAM]: 'No team with this name in the season (never created)',
  [ROW_REFUSAL.NOT_ON_TEAM]: 'The coach does not coach the team named',
  [ROW_REFUSAL.NO_TEAM]: 'No team named, and the coach coaches none this season',
  [ROW_REFUSAL.INVALID]: 'The row could not be read',
};

function Metric({ label, value, note = null }) {
  return (
    <div className="metric-tile">
      <dt className="mt-label">{label}</dt>
      <dd className="mt-val m-0">{value}</dd>
      {note && <dd className="text-xs text-text-muted m-0 mt-1">{note}</dd>}
    </div>
  );
}

Metric.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.oneOfType([PropTypes.number, PropTypes.string]).isRequired,
  note: PropTypes.string,
};

/**
 * What the file will do (Phase D C2), before anything is uploaded: the rules it adds per team,
 * the musts that stay pending until accepted, the imported rules it replaces, and every row it will
 * not apply with the reason. An unknown coach or team is listed and never created; a row with no
 * team makes a rule for each team the coach coaches today, and says which.
 *
 * @param {Object} props
 * @param {ReturnType<typeof import('../../utils/practicePreferenceImportPreview.js').previewPracticePreferenceImport>} props.preview
 * @param {Array<{ row: number, message: string }>} props.serverRefused - rows `import-validation` refuses
 * @param {string[]} props.ignoredColumns
 * @param {Map<string, string>} props.locationNames
 */
export default function PreferenceImportPreview({
  preview,
  serverRefused,
  ignoredColumns,
  locationNames,
}) {
  const notApplied =
    preview.invalid_rows +
    preview.unknown_coach_rows +
    preview.unknown_team_rows +
    preview.no_team_rows +
    preview.coach_not_on_team_rows +
    serverRefused.length;
  const kinds = Object.values(ROW_REFUSAL).filter((kind) =>
    preview.refusals.some((refusal) => refusal.kind === kind)
  );

  return (
    <div className="flex flex-col gap-4" data-testid="preference-import-preview">
      <dl className="m-0 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Metric
          label="Rules to add"
          value={preview.inserted_rules}
          note={`for ${plural(preview.teams_named, 'team', 'teams')}`}
        />
        <Metric
          label="Musts waiting for you"
          value={preview.pending_musts}
          note="in force as prefer until you accept them"
        />
        <Metric
          label="Imported rules replaced"
          value={preview.replaced_rules}
          note={
            preview.accepted_musts_replaced > 0
              ? `${plural(preview.accepted_musts_replaced, 'accepted must comes', 'accepted musts come')} back pending`
              : 'on the teams this file names'
          }
        />
        <Metric label="Rows not applied" value={notApplied} note="listed below, never created" />
        <Metric
          label="Repeated rows"
          value={preview.duplicate_rule_rows}
          note="an identical rule counts once"
        />
      </dl>

      {preview.nothingToApply && (
        <p role="alert" className="text-sm m-0 field-error" data-testid="preview-nothing">
          Nothing in this file can be applied: it would add no rule and replace none.
          {preview.rows_read === 0 && ' No row passed the check below.'}
        </p>
      )}

      <p className="text-sm text-text-muted m-0">
        Re-importing replaces only the imported rules of the teams this file names. Rules you added
        in the app, and imported rules of other teams, are left as they are.
      </p>

      {preview.fanOut.length > 0 && (
        <section aria-labelledby="preview-fanout-heading">
          <h4 id="preview-fanout-heading" className="text-sm font-bold m-0 mb-1">
            Rows with no team: one rule for each team the coach coaches ({preview.fanOut.length})
          </h4>
          <ul className="m-0 pl-5 text-sm" data-testid="preview-fanout">
            {preview.fanOut.map((entry) => (
              <li key={entry.row}>
                Row {entry.row} ({entry.email}): {entry.teams.join(', ')}
              </li>
            ))}
          </ul>
        </section>
      )}

      {kinds.map((kind) => {
        const items = preview.refusals.filter((refusal) => refusal.kind === kind);
        return (
          <section key={kind} aria-labelledby={`preview-refused-${kind}`}>
            <h4 id={`preview-refused-${kind}`} className="text-sm font-bold m-0 mb-1">
              {REFUSAL_HEADING[kind]} ({items.length})
            </h4>
            <ul className="m-0 pl-5 text-sm" data-testid={`preview-refused-${kind}`}>
              {items.map((item) => (
                <li key={item.row}>
                  Row {item.row}
                  {item.email ? ` (${item.email})` : ''}
                  {item.team ? `, team “${item.team}”` : ''}
                  {kind === ROW_REFUSAL.INVALID || kind === ROW_REFUSAL.NO_TEAM
                    ? `: ${item.message}`
                    : ''}
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {serverRefused.length > 0 && (
        <section aria-labelledby="preview-refused-server">
          <h4 id="preview-refused-server" className="text-sm font-bold m-0 mb-1">
            Refused by the file check before any rule is read ({serverRefused.length})
          </h4>
          <ul className="m-0 pl-5 text-sm" data-testid="preview-refused-server">
            {serverRefused.map((item) => (
              <li key={item.row}>
                Row {item.row}: {item.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      {ignoredColumns.length > 0 && (
        <p className="text-sm text-text-muted m-0" data-testid="preview-ignored">
          Columns this import does not read, which stay in your browser and are not uploaded:{' '}
          {ignoredColumns.join(', ')}.
        </p>
      )}

      {preview.rules.length > 0 && (
        <div className="grid-wrap">
          <table className="grid">
            <caption className="sr-only">Rules this file would add</caption>
            <thead>
              <tr>
                <th scope="col">Row</th>
                <th scope="col">Coach</th>
                <th scope="col">Team</th>
                <th scope="col">Asked as</th>
                <th scope="col">Rule</th>
                <th scope="col">Coach&apos;s priority</th>
              </tr>
            </thead>
            <tbody>
              {preview.rules.slice(0, RULES_LISTED).map((rule) => (
                <tr key={`${rule.row}-${rule.teamId}`}>
                  <td>{rule.row}</td>
                  <td>{rule.coachName}</td>
                  <td>{rule.teamName}</td>
                  <td>
                    {LEVEL_LABEL[rule.requestedLevel]}
                    {rule.requestedLevel === 'must' && (
                      <>
                        {' '}
                        <Badge tone="warning">Pending until accepted</Badge>
                      </>
                    )}
                  </td>
                  <td>
                    {describeRule(rowShape(rule), locationNames)}
                    {(rule.effectiveFrom || rule.effectiveTo) && (
                      <span className="block text-xs text-text-muted">
                        {rule.effectiveFrom ? `from ${rule.effectiveFrom}` : ''}
                        {rule.effectiveFrom && rule.effectiveTo ? ' ' : ''}
                        {rule.effectiveTo ? `until ${rule.effectiveTo}` : ''}
                      </span>
                    )}
                  </td>
                  <td>{rule.coachPriority ? PRIORITY_LABEL[rule.coachPriority] : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.rules.length > RULES_LISTED && (
            <p className="text-xs text-text-muted m-0 mt-2">
              and {preview.rules.length - RULES_LISTED} more rules
            </p>
          )}
        </div>
      )}
    </div>
  );
}

PreferenceImportPreview.propTypes = {
  preview: PropTypes.object.isRequired,
  serverRefused: PropTypes.arrayOf(
    PropTypes.shape({ row: PropTypes.number, message: PropTypes.string })
  ).isRequired,
  ignoredColumns: PropTypes.arrayOf(PropTypes.string).isRequired,
  locationNames: PropTypes.instanceOf(Map).isRequired,
};
