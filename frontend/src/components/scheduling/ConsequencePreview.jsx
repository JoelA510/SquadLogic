import React from 'react';
import PropTypes from 'prop-types';
import { AlertTriangle, HelpCircle, Layers } from 'lucide-react';

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
 * 4. **A venue retirement's consequence has TWO halves, and only one is a
 *    booking list.** `admin_retire_location` returns `contained` beside
 *    `affected`: every field and sub-surface the venue holds, each flagged
 *    `already_retired` where its own window already ends no later than this
 *    date. These are not bookings -- they are ground -- and they are the
 *    *point* of the containment decision (20260911000000 section 2): the
 *    retirement writes one date on one row and copies nothing down, so the
 *    only way an operator can act on "this closes those pitches too" is to be
 *    shown which. It is rendered as its own table with its own caption, never
 *    folded into the bookings table, and **it is absent rather than empty at
 *    sub-surface depth** -- `admin_retire_field_subunit` ships no `contained`
 *    key at all, because a sub-surface is the leaf of the estate, and "nothing
 *    below" must not render as "nobody looked" or vice versa.
 *
 * @param {object} props
 * @param {string} props.subject - what is about to change, e.g. a field name
 * @param {string} props.operation - `'delete'` or `'retire'`
 * @param {number} props.affectedCount - the RPC's own count, NOT `rows.length`
 * @param {Array<Record<string, any>>} props.rows - the RPC's `affected` array
 * @param {{ available: false, finding: { code: string, message: string } }} props.repair
 * @param {string} [props.titleId] - id of the heading paragraph, for `aria-labelledby`
 * @param {Array<Record<string, any>>} [props.contained] - the RPC's `contained`
 *   array. **Pass it only when the RPC produced one**; leave it `undefined` at
 *   a depth that contains nothing, and never substitute `[]`.
 * @param {number} [props.containedCount] - the RPC's own `contained_count`,
 *   which counts only the nodes NOT already retired. Not derived from `contained`.
 */
export default function ConsequencePreview({
  subject,
  operation,
  affectedCount,
  rows,
  repair,
  titleId = undefined,
  contained = undefined,
  containedCount = undefined,
}) {
  const list = rows || [];
  // **The count comes from the RPC, the list is what it sent.** They should
  // agree; when they do not, the count is the authority (a refusal digest can
  // be sampled) and the disagreement is stated rather than hidden behind
  // whichever number the layout happened to use.
  const undercounted = affectedCount > list.length;
  const hasDisposition = list.some((row) => typeof row.disposition === 'string');

  // **`undefined` and `[]` are different answers and stay different here.**
  // `undefined` is "this depth reports no containment" -- a sub-surface, or a
  // field, neither of which holds anything. `[]` is "this venue holds nothing",
  // which an operator retiring a site they believe has four pitches needs to
  // see. Collapsing them with `contained || []` would render the second as the
  // first, and the whole section would vanish for the case that most needs a
  // sentence.
  const containedRows = Array.isArray(contained) ? contained : null;
  const containedStillLive = containedRows
    ? containedRows.filter((row) => !row.already_retired)
    : [];
  // A cross-check between the two readings the RPC sent -- its own aggregate
  // count and the rows it serialised -- not a derivation of one from the other.
  // They are produced by separate expressions over `estate_contained_nodes`, so
  // a disagreement is real news and is stated rather than papered over with
  // whichever number the layout happened to reach for.
  const containedCountDisagrees =
    containedRows !== null &&
    typeof containedCount === 'number' &&
    containedCount !== containedStillLive.length;

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

      {containedRows !== null && (
        <div data-testid="consequence-contained" style={{ marginTop: 12 }}>
          <p className="text-sm" style={{ marginBottom: 6 }}>
            <Layers size={15} aria-hidden="true" style={{ verticalAlign: '-2px' }} />{' '}
            <strong>{subject}</strong> holds{' '}
            <strong data-testid="contained-total">{containedRows.length}</strong> field
            {containedRows.length === 1 ? '' : 's'} and sub-surface
            {containedRows.length === 1 ? '' : 's'}.{' '}
            {containedRows.length === 0 ? (
              <span data-testid="contained-none">
                Nothing sits at this venue, so this retirement closes only the venue itself.
              </span>
            ) : (
              <span data-testid="contained-live">
                <strong>{containedStillLive.length}</strong> of them stop being offered after that
                date.
              </span>
            )}
          </p>
          {containedRows.length > 0 && (
            <>
              <p className="text-sm" data-testid="consequence-contained-note">
                These are ground, not bookings. No end date is written onto any of them and nothing
                below is changed — they stop being offered because the venue above them has closed,
                and clearing the venue&rsquo;s date brings back every one that has no date of its
                own.
              </p>
              <div style={{ maxHeight: 220, overflow: 'auto', marginTop: 8 }}>
                <table className="grid" data-testid="contained-rows">
                  <caption className="sr-only">
                    Fields and sub-surfaces contained by {subject}, and whether each already ends on
                    or before that date
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Kind</th>
                      <th scope="col">Name</th>
                      <th scope="col">Its own end date</th>
                      <th scope="col">Effect</th>
                    </tr>
                  </thead>
                  <tbody>
                    {containedRows.map((row) => (
                      <tr key={`${row.kind}-${row.id}`} data-testid={`contained-row-${row.kind}`}>
                        <td>{row.kind === 'field_subunit' ? 'sub-surface' : 'field'}</td>
                        <td>{row.name || '(unnamed)'}</td>
                        <td>{row.own_effective_to || 'none'}</td>
                        <td>
                          {row.already_retired ? (
                            <span className="badge neutral" data-testid="contained-already-retired">
                              already ends by then
                            </span>
                          ) : (
                            <span className="badge warning">closes with the venue</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {containedCountDisagrees && (
            <p className="text-sm" data-testid="contained-count-disagrees">
              The database counted {containedCount} still-live node
              {containedCount === 1 ? '' : 's'} but sent {containedStillLive.length}. Treat the
              count as the authority.
            </p>
          )}
        </div>
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
  contained: PropTypes.array,
  containedCount: PropTypes.number,
};
