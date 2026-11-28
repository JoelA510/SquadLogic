import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FieldImportRefusals from '../frontend/src/components/FieldImportRefusals.jsx';

const from = vi.hoisted(() => vi.fn());
vi.mock('../frontend/src/lib/supabaseClient.js', () => ({ supabase: { from } }));

describe('field import refusal details', () => {
  let query;
  beforeEach(() => {
    query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      range: vi.fn(),
    };
    from.mockReset().mockReturnValue(query);
  });

  it('reads just the row numbers and errors for the selected club and job, across pages', async () => {
    query.range
      .mockResolvedValueOnce({
        data: Array.from({ length: 1000 }, () => ({ validation_errors: [] })),
      })
      .mockResolvedValueOnce({
        data: [
          {
            source_row_number: 1001,
            validation_errors: [
              { message: 'Division not found.' },
              { message: 'Check the division name.' },
            ],
          },
        ],
      });
    render(<FieldImportRefusals organizationId="club-a" jobId="import-b" expected={1} />);
    const row = await screen.findByRole('listitem');
    expect(row).toHaveTextContent('Data row 1001 — Division not found. Check the division name.');
    expect(query.eq.mock.calls).toContainEqual(['organization_id', 'club-a']);
    expect(from).toHaveBeenCalledWith('staging_import_rows');
    expect(query.eq.mock.calls).toContainEqual(['import_job_id', 'import-b']);
    expect(query.eq.mock.calls).toContainEqual(['import_type', 'fields']);
    expect(query.is).toHaveBeenCalledWith('applied_at', null);
    expect(query.select).toHaveBeenCalledWith('source_row_number, validation_errors');
    expect(query.range).toHaveBeenCalledWith(1000, 1999);
  });

  it('lets an administrator retry a failed read and identifies unavailable details', async () => {
    query.range
      .mockResolvedValueOnce({ error: { message: 'Connection interrupted.' } })
      .mockResolvedValueOnce({ data: [{ source_row_number: null, validation_errors: [{}] }] });
    render(<FieldImportRefusals organizationId="club-a" jobId="import-b" expected={2} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection interrupted.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry row details' }));
    const panel = screen.getByRole('region', { name: 'Field rows to correct' });
    expect(await within(panel).findByRole('listitem')).toHaveTextContent(
      'Row number unavailable — No reason was recorded.'
    );
    expect(within(panel).getByRole('status')).toHaveTextContent('1 of 2 refused rows');
    expect(within(panel).queryByRole('alert')).toBeNull();
  });
});
