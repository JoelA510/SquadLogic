import React from 'react';

/** How many unmatched or invalid rows are named on screen; the rest are counted. */
const NAMED_ROWS = 10;

/**
 * One count of the summary: a term and its number, as a description-list pair.
 * @param {{ label: string, value: number, testId: string }} props
 */
function Count({ label, value, testId }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-3 py-2 min-w-0">
      <dt className="text-xs text-text-secondary">{label}</dt>
      <dd data-testid={testId} className="text-sm font-semibold text-text-primary tabular-nums">
        {value}
      </dd>
    </div>
  );
}

/**
 * A short list of named rows with the count of the rest.
 * @param {{ heading: string, items: string[], total: number, testId: string }} props
 */
function RowList({ heading, items, total, testId }) {
  if (total <= 0) return null;
  const shown = items.slice(0, NAMED_ROWS);
  const more = total - shown.length;
  return (
    <div data-testid={testId} className="px-3 py-2">
      <h4 className="text-xs font-semibold text-text-primary mb-1">{heading}</h4>
      <ul className="text-xs text-text-secondary space-y-0.5 break-words">
        {shown.map((item, index) => (
          <li key={`${index}-${item}`}>{item}</li>
        ))}
      </ul>
      {more > 0 && <p className="text-xs text-text-muted mt-1">{`and ${more} more`}</p>}
    </div>
  );
}

/**
 * What an evaluations import does (or did) to the season's players (E3c): the server's own counts,
 * from its dry run before the confirm and from the apply after it, and the rows it would skip.
 * An unmatched row is listed and never creates a player; a blank cell changes nothing.
 *
 * @param {Object} props
 * @param {Record<string, any> | null | undefined} props.result - `finalize_evaluation_import_job`'s
 *   result, with `dry_run` true for the preview
 * @param {Array<{ row?: number, field?: string, message?: string }>} [props.validationErrors] -
 *   the rows import-validation refused before they were staged
 * @param {string | null} [props.previewError] - why there is no preview, when there is none
 * @param {string} [props.seasonName]
 */
export default function EvaluationImportSummary({
  result,
  validationErrors = [],
  previewError = null,
  seasonName = '',
}) {
  const headingId = React.useId();
  const isPreview = result?.dry_run === true;

  if (!result) {
    return previewError ? (
      <section
        aria-labelledby={headingId}
        data-testid="evaluation-summary"
        className="w-full max-w-lg mb-8 text-left"
      >
        <h3 id={headingId} className="text-sm font-semibold text-text-primary mb-2">
          Preview unavailable
        </h3>
        <p role="alert" className="text-xs text-status-error-text">
          {previewError}
        </p>
      </section>
    ) : null;
  }

  const unmatchedItems = (Array.isArray(result.unmatched) ? result.unmatched : []).map(
    (item) => `Row ${item?.source_row_number ?? '?'}: ${item?.registration_id ?? ''}`
  );
  // The rows import-validation refused, then the ones the finalizer refused.
  const invalidItems = [
    ...(Array.isArray(validationErrors) ? validationErrors : []),
    ...(Array.isArray(result.invalid) ? result.invalid : []),
  ].map((item) => {
    const row = item?.row ?? item?.source_row_number ?? '?';
    return `Row ${row}: ${item?.message ?? 'not valid'}`;
  });
  const duplicateItems = (Array.isArray(result.duplicates) ? result.duplicates : []).map(
    (item) => `Row ${item?.source_row_number ?? '?'}: ${item?.registration_id ?? ''}`
  );

  const updated = Number(result.updated_players) || 0;
  const unchanged = Number(result.unchanged_players) || 0;
  const unmatched = Number(result.unmatched_rows) || 0;
  // import-validation reports one error per cell: the rows it refused are the distinct row numbers.
  const refusedRows =
    Array.isArray(validationErrors) && validationErrors.length > 0
      ? new Set(validationErrors.map((item) => item?.row)).size
      : Number(result.validation_error_rows) || 0;
  const invalid = (Number(result.invalid_rows) || 0) + refusedRows;
  const duplicates = Number(result.duplicate_rows) || 0;

  return (
    <section
      aria-labelledby={headingId}
      data-testid="evaluation-summary"
      className="w-full max-w-lg mb-8 text-left"
    >
      <h3 id={headingId} className="text-sm font-semibold text-text-primary mb-1">
        {isPreview ? 'What this import will change' : 'What this import changed'}
      </h3>
      <p className="text-xs text-text-secondary mb-2">
        {seasonName
          ? `Only players already in ${seasonName} are updated. `
          : 'Only players already in the season are updated. '}
        A blank cell leaves the stored value as it is, and no player is created.
      </p>
      <div className="rounded-lg border border-border bg-bg-sunken divide-y divide-border-soft">
        <dl className="divide-y divide-border-soft">
          <Count
            label={isPreview ? 'Players to update' : 'Players updated'}
            value={updated}
            testId="evaluation-updated"
          />
          <Count
            label="Players already up to date or with nothing to set"
            value={unchanged}
            testId="evaluation-unchanged"
          />
          <Count
            label="Rows matching no player (skipped)"
            value={unmatched}
            testId="evaluation-unmatched"
          />
          <Count label="Rows not valid (not applied)" value={invalid} testId="evaluation-invalid" />
          {duplicates > 0 && (
            <Count
              label="Repeated registration ids (skipped)"
              value={duplicates}
              testId="evaluation-duplicates"
            />
          )}
        </dl>
        <RowList
          heading="Registration ids that match no player"
          items={unmatchedItems}
          total={unmatched}
          testId="evaluation-unmatched-list"
        />
        <RowList
          heading="Rows that are not valid"
          items={invalidItems}
          total={invalid}
          testId="evaluation-invalid-list"
        />
        <RowList
          heading="Repeated registration ids"
          items={duplicateItems}
          total={duplicates}
          testId="evaluation-duplicates-list"
        />
      </div>
    </section>
  );
}
