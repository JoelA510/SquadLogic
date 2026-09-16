import React from 'react';
import PropTypes from 'prop-types';
import { AlertTriangle, HelpCircle } from 'lucide-react';

/**
 * What a mutation would cost, shown BEFORE it is committed.
 *
 * 8.4's third capability: "Every mutation that would invalidate an existing
 * booking shows the consequence BEFORE commit: which games and practices are
 * affected and what the repair from 8.6 proposes."
 *
 * Three things this component is careful about, each because the alternative is
 * a screen that reads as reassurance:
 *
 * 1. **An empty list is labelled, never blank.** "Nothing is booked on this
 *    ground" and "we have not looked" render identically as white space.
 * 2. **Disposition is per arm, and the retirement arm has none.**
 *    `admin_delete_field` returns `disposition: 'deleted' | 'unassigned'` per
 *    row, because a slot-linked assignment is destroyed while a free-standing
 *    one survives venueless — two different losses. `admin_retire_field`
 *    returns six keys and NO disposition, deliberately: a retirement writes a
 *    date and destroys nothing, so there is no answer to give. Inventing a
 *    third vocabulary here — rendering an em dash, or defaulting to "deleted" —
 *    would put a wrong word in front of the person deciding. The column is
 *    absent when the arm does not produce it, and a sentence says why.
 * 3. **The repair proposal is named as unavailable.** 8.6 does not exist. A
 *    blank space where a repair belongs reads as "no repair is needed", which
 *    is a stronger claim than "nothing has been computed" and a false one.
 *
 * @param {object} props
 * @param {string} props.subject - what is about to change, e.g. a field name
 * @param {string} props.operation - `'delete'` or `'retire'`
 * @param {number} props.affectedCount - the RPC's own count, NOT `rows.length`
 * @param {Array<Record<string, any>>} props.rows - the RPC's `affected` array
 * @param {{ available: false, finding: { code: string, message: string } }} props.repair
 * @param {string} [props.titleId] - id of the heading paragraph, for `aria-labelledby`
 */
export default function ConsequencePreview({
  subject,
  operation,
  affectedCount,
  rows,
  repair,
  titleId = undefined,
}) {
  const list = rows || [];
  // **The count comes from the RPC, the list is what it sent.** They should
  // agree; when they do not, the count is the authority (a refusal digest can
  // be sampled) and the disagreement is stated rather than hidden behind
  // whichever number the layout happened to use.
  const undercounted = affectedCount > list.length;
  const hasDisposition = list.some((row) => typeof row.disposition === 'string');

  return (
    <section aria-labelledby={titleId} data-testid="consequence-preview">
      <p id={titleId} className="text-sm" style={{ marginBottom: 8 }}>
        <AlertTriangle size={15} aria-hidden="true" style={{ verticalAlign: '-2px' }} />{' '}
        <strong>{affectedCount}</strong> booking{affectedCount === 1 ? '' : 's'} on{' '}
        <strong>{subject}</strong> {affectedCount === 1 ? 'is' : 'are'} affected.
      </p>

      {affectedCount === 0 ? (
        <p className="text-sm" data-testid="consequence-none">
          Nothing is booked on this ground
          {operation === 'retire' ? ' after that date' : ''}. This is an answer from the database,
          not an empty panel.
        </p>
      ) : (
        <>
          {operation === 'retire' && (
            <p className="text-sm" data-testid="consequence-retire-note">
              A retirement writes an end date and removes nothing, so these bookings survive — they
              simply fall on ground the estate no longer offers. That is why no per-row outcome is
              shown: the operation has none to report.
            </p>
          )}
          <div style={{ maxHeight: 220, overflow: 'auto', marginTop: 8 }}>
            <table className="grid" data-testid="consequence-rows">
              <caption className="sr-only">
                Bookings affected by {operation === 'retire' ? 'retiring' : 'deleting'} {subject}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Kind</th>
                  <th scope="col">Date</th>
                  {hasDisposition && <th scope="col">Outcome</th>}
                </tr>
              </thead>
              <tbody>
                {list.map((row) => (
                  <tr key={`${row.kind}-${row.id}`} data-testid={`consequence-row-${row.kind}`}>
                    <td>{String(row.kind || '').replace(/_/g, ' ')}</td>
                    <td>
                      {row.unbounded
                        ? 'runs indefinitely'
                        : row.undated || !row.on_date
                          ? 'date unknown'
                          : row.on_date}
                    </td>
                    {hasDisposition && (
                      <td>
                        {/*
                          **Three arms, not two.** A binary read every row that
                          was not `deleted` as `unassigned`, so a row with no
                          disposition -- or with a word this component does not
                          know -- asserted a survival the database never
                          promised. That is the failure this file's own second
                          note says it exists to avoid, one `else` in.
                        */}
                        {row.disposition === 'deleted'
                          ? 'destroyed with the field'
                          : row.disposition === 'unassigned'
                            ? 'survives, without a venue'
                            : 'outcome not stated'}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {undercounted && (
            <p className="text-sm" data-testid="consequence-sampled">
              Showing {list.length} of {affectedCount}.
            </p>
          )}
        </>
      )}

      {/*
        The repair half of the clause. Rendered whether or not anything is
        affected, because "there is no repair engine" is true either way and an
        operator who sees it only on the bad path learns the wrong lesson.
      */}
      <p
        className="text-sm"
        style={{ marginTop: 10 }}
        data-testid="repair-proposal-unavailable"
        data-reason-code={repair.finding.code}
      >
        <HelpCircle size={15} aria-hidden="true" style={{ verticalAlign: '-2px' }} />{' '}
        <strong>{repair.finding.code}</strong> — {repair.finding.message}
      </p>
    </section>
  );
}

ConsequencePreview.propTypes = {
  subject: PropTypes.string.isRequired,
  operation: PropTypes.oneOf(['delete', 'retire']).isRequired,
  affectedCount: PropTypes.number.isRequired,
  rows: PropTypes.array,
  repair: PropTypes.shape({
    available: PropTypes.bool,
    finding: PropTypes.shape({
      code: PropTypes.string.isRequired,
      message: PropTypes.string.isRequired,
    }).isRequired,
  }).isRequired,
  titleId: PropTypes.string,
};
