import { useEffect, useState } from 'react';
import { fetchAllPages } from '../lib/pagedFetch.js';
import { supabase } from '../lib/supabaseClient.js';
import Button from './ui/Button.jsx';

/** The field finalizer records its refusal on each unapplied staging row. */
export default function FieldImportRefusals({ organizationId, jobId, expected }) {
  const [result, setResult] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    async function read() {
      try {
        const rows = await fetchAllPages(
          () =>
            supabase
              .from('staging_import_rows')
              .select('source_row_number, validation_errors')
              .eq('organization_id', organizationId)
              .eq('import_job_id', jobId)
              .eq('import_type', 'fields')
              .is('applied_at', null),
          { orderBy: 'source_row_number' }
        );
        const refused = rows.filter(
          (row) => Array.isArray(row.validation_errors) && row.validation_errors.length > 0
        );
        if (current) setResult({ refused });
      } catch (error) {
        if (current)
          setResult({ error: error?.message || 'The import details could not be read.' });
      }
    }
    read();
    return () => {
      current = false;
    };
  }, [organizationId, jobId, attempt]);

  return (
    <section aria-labelledby="field-refusals-heading" className="w-full max-w-lg mb-6 text-left">
      <h3 id="field-refusals-heading" className="text-sm font-semibold text-text-primary">
        Field rows to correct
      </h3>
      <p className="text-sm text-text-secondary">
        The first row after the CSV header is data row 1. Fix the source file and import the
        corrected rows.
      </p>
      {!result && <p role="status">Loading row details…</p>}
      {result?.error && (
        <div>
          <p role="alert">Could not load the row details. {result.error}</p>
          <Button
            variant="secondary"
            onClick={() => {
              setResult(null);
              setAttempt((n) => n + 1);
            }}
          >
            Retry row details
          </Button>
        </div>
      )}
      {result?.refused && (
        <>
          <ul className="space-y-1 text-sm text-text-primary">
            {result.refused.map((row, i) => {
              const messages = row.validation_errors
                .map((error) => (typeof error === 'string' ? error : error?.message))
                .filter((message) => typeof message === 'string' && message.trim());
              return (
                <li key={i}>
                  {Number.isInteger(row.source_row_number) && row.source_row_number > 0
                    ? `Data row ${row.source_row_number}`
                    : 'Row number unavailable'}
                  {' — '}
                  {messages.join(' ') || 'No reason was recorded.'}
                </li>
              );
            })}
          </ul>
          {result.refused.length < expected && (
            <p role="status">
              Row details available for {result.refused.length} of {expected} refused rows.
            </p>
          )}
        </>
      )}
    </section>
  );
}
