import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ImportPanel from '../frontend/src/components/ImportPanel.jsx';

const mocks = vi.hoisted(() => ({
  parse: vi.fn(),
  importState: null,
  startImport: vi.fn(),
  applyDeferredImport: vi.fn(),
  cancelDeferredImport: vi.fn(),
  resetImport: vi.fn(),
  setNotifyOnComplete: vi.fn(),
  rollbackImport: vi.fn(),
}));

vi.mock('papaparse', () => ({
  default: {
    parse: mocks.parse,
  },
}));

vi.mock('../frontend/src/contexts/ImportContext.jsx', () => ({
  useImport: () => mocks.importState,
}));

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: 'org-1' },
  }),
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    auth: { getUser: vi.fn() },
    rpc: vi.fn(),
  },
}));

const expectTooltipFor = (element, text) => {
  const describedBy = element.getAttribute('aria-describedby');
  expect(describedBy).toBeTruthy();

  const tooltip = describedBy
    .split(/\s+/)
    .map((id) => document.getElementById(id))
    .find((node) => node?.getAttribute('role') === 'tooltip' && node.textContent.includes(text));

  expect(tooltip).toBeInTheDocument();
  expect(tooltip).toHaveClass(
    'group-hover/tooltip:visible',
    'group-hover/tooltip:opacity-100',
    'group-focus-within/tooltip:visible',
    'group-focus-within/tooltip:opacity-100'
  );
  return tooltip;
};

describe('ImportPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.importState = {
      isImporting: false,
      progress: 0,
      importStatus: 'idle',
      startImport: mocks.startImport,
      applyDeferredImport: mocks.applyDeferredImport,
      cancelDeferredImport: mocks.cancelDeferredImport,
      resetImport: mocks.resetImport,
      notifyOnComplete: false,
      setNotifyOnComplete: mocks.setNotifyOnComplete,
      importedPlayers: null,
      importedCoaches: null,
      importedFields: null,
      importedFieldAvailability: null,
      rollbackImport: mocks.rollbackImport,
      telemetryLogs: [],
      importLogs: [],
      activeJob: null,
    };
    mocks.parse.mockImplementation((_file, options) => {
      options.complete({
        data: [{ first_name: 'Alex', last_name: 'Smith', date_of_birth: '2016-01-01' }],
        meta: { fields: ['first_name', 'last_name', 'date_of_birth'] },
      });
    });
  });

  it('exposes smart mapping confidence tooltips to keyboard focus', async () => {
    render(<ImportPanel onImport={vi.fn()} />);

    const input = screen.getByLabelText(/browse files/i);
    const file = new File(
      ['first_name,last_name,date_of_birth\nAlex,Smith,2016-01-01'],
      'players.csv',
      {
        type: 'text/csv',
      }
    );

    fireEvent.change(input, { target: { files: [file] } });

    await screen.findByText('players.csv');
    const badges = screen.getAllByLabelText(/header match confidence/i);
    const firstBadge = badges[0];
    const tooltipId = firstBadge.getAttribute('aria-describedby');

    expect(firstBadge).toHaveAttribute('tabindex', '0');
    expect(tooltipId).toBeTruthy();

    const tooltip = document.getElementById(tooltipId);
    expect(tooltip).toHaveAttribute('role', 'tooltip');
    expect(tooltip).toHaveClass('group-focus-visible:opacity-100');

    firstBadge.focus();
    await waitFor(() => expect(firstBadge).toHaveFocus());
  });

  it('uses keyboard-accessible controls for import notifications and file picking', () => {
    const { unmount } = render(<ImportPanel onImport={vi.fn()} />);

    expect(screen.getByTestId('import-panel')).toHaveClass(
      'max-w-full',
      'min-w-0',
      'overflow-visible'
    );
    expect(screen.getByTestId('import-type-selector')).toHaveClass(
      'grid',
      'grid-cols-1',
      'sm:grid-cols-4'
    );

    const notifyButton = screen.getByRole('button', { name: /notify when import completes/i });
    expect(notifyButton).toHaveAttribute('type', 'button');
    expect(notifyButton).toHaveAttribute('aria-pressed', 'false');
    expect(notifyButton).toHaveAccessibleName('Notify when import completes');
    expect(notifyButton).toHaveClass('focus-visible:ring-2');
    expectTooltipFor(notifyButton, 'Notify when complete.');

    fireEvent.click(notifyButton);
    expect(mocks.setNotifyOnComplete).toHaveBeenCalledWith(true);

    const playersButton = screen.getByRole('button', { name: /^players\b/i });
    const coachesButton = screen.getByRole('button', { name: /^coaches\b/i });
    const fieldAvailabilityButton = screen.getByRole('button', { name: /^field_availability\b/i });
    expect(playersButton).toHaveClass('w-full', 'min-w-0');
    expect(playersButton).toHaveAttribute('aria-pressed', 'true');
    expect(playersButton).toHaveClass('focus-visible:ring-2');
    expectTooltipFor(playersButton, 'Requires first name, last name, and date of birth columns.');
    expect(coachesButton).toHaveAttribute('aria-pressed', 'false');
    expectTooltipFor(coachesButton, 'Requires full name and email columns.');
    expectTooltipFor(
      fieldAvailabilityButton,
      'Requires season_label, location, name, available_from, and available_until columns.'
    );

    fireEvent.click(coachesButton);
    expect(coachesButton).toHaveAttribute('aria-pressed', 'true');

    const templateButton = screen.getByRole('button', { name: /download coaches template/i });
    expect(templateButton).toHaveAccessibleName('Download coaches template');
    expect(templateButton).toHaveClass('focus-visible:ring-2');
    expectTooltipFor(templateButton, 'Download a coaches CSV template.');

    const fileInput = screen.getByLabelText(/browse files/i);
    expect(fileInput).toHaveAttribute('type', 'file');
    expect(fileInput).toHaveClass('sr-only');
    expect(fileInput.closest('label')).toHaveClass('focus-within:ring-2');

    unmount();
    mocks.importState = {
      ...mocks.importState,
      notifyOnComplete: true,
    };
    render(<ImportPanel onImport={vi.fn()} />);
    expect(
      screen.getByRole('button', { name: /disable import completion email notifications/i })
    ).toHaveAttribute('aria-describedby');
    expectTooltipFor(
      screen.getByRole('button', { name: /disable import completion email notifications/i }),
      'Disable notifications.'
    );
  });

  it('keeps preview controls contained in responsive wrappers', async () => {
    render(<ImportPanel onImport={vi.fn()} />);

    const input = screen.getByLabelText(/browse files/i);
    const file = new File(
      ['first_name,last_name,date_of_birth\nAlex,Smith,2016-01-01'],
      'players.csv',
      {
        type: 'text/csv',
      }
    );

    fireEvent.change(input, { target: { files: [file] } });

    await screen.findByText('players.csv');

    expect(screen.getByTestId('import-preview-card')).toHaveClass(
      'max-w-full',
      'min-w-0',
      'overflow-visible'
    );
    expect(screen.getByTestId('import-preview-header')).toHaveClass(
      'flex-col',
      'xl:flex-row',
      'gap-4',
      'min-w-0'
    );
    expect(screen.getByTestId('import-preview-file-summary')).toHaveClass('min-w-0');
    expect(screen.getByTestId('import-preview-actions')).toHaveClass(
      'flex-wrap',
      'w-full',
      'xl:w-auto'
    );
    expect(screen.getByTestId('import-preview-table-wrapper')).toHaveClass(
      'overflow-x-auto',
      'max-w-full',
      'pt-12',
      '-mt-12'
    );

    expectTooltipFor(
      screen.getByRole('button', { name: /adjust mapping/i }),
      'Review or edit column mapping.'
    );
    expectTooltipFor(
      screen.getByRole('button', { name: /cancel/i }),
      'Clear this file and choose another.'
    );
    expectTooltipFor(
      screen.getByRole('button', { name: /start import/i }),
      'Validate and import this CSV.'
    );
    // Focus-visible ring styling comes from the shared .btn class (styles/page.css).
    expect(screen.getByRole('button', { name: /start import/i })).toHaveClass('btn');
  });

  it('describes validate-only imports before starting deferred field imports', async () => {
    mocks.parse.mockImplementation((_file, options) => {
      options.complete({
        data: [
          {
            location: 'North Park',
            name: 'Field 1',
            type: 'grass',
            start: '2026-05-01 08:00',
            end: '2026-05-01 10:00',
          },
        ],
        meta: { fields: ['location', 'name', 'type', 'start', 'end'] },
      });
    });

    render(<ImportPanel onImport={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /^fields\b/i }));

    const input = screen.getByLabelText(/browse files/i);
    const file = new File(
      ['location,name,type,start,end\nNorth Park,Field 1,grass,2026-05-01 08:00,2026-05-01 10:00'],
      'fields.csv',
      {
        type: 'text/csv',
      }
    );

    fireEvent.change(input, { target: { files: [file] } });

    await screen.findByText('fields.csv');

    const validateOnlyButton = screen.getByRole('button', { name: /validate only/i });
    expectTooltipFor(validateOnlyButton, 'Validate without applying records.');

    fireEvent.click(validateOnlyButton);
    await waitFor(() =>
      expect(mocks.startImport).toHaveBeenCalledWith(file, 'fields', { deferApply: true })
    );
  });

  it('field_availability preview does not require day/start/end and shows metadata warning copy', async () => {
    mocks.parse.mockImplementation((_file, options) => {
      options.complete({
        data: [
          {
            season_label: 'Fall 2026',
            location: 'San Lorenzo',
            name: 'Main Field',
            primary_format: '11v11',
            available_from: '2026-08-01',
            available_until: '2026-11-30',
            blackout_months: 'Sep',
            record_status: 'active',
            goal_equipment: 'portable goals',
          },
        ],
        meta: {
          fields: [
            'season_label',
            'location',
            'name',
            'primary_format',
            'available_from',
            'available_until',
            'blackout_months',
            'record_status',
            'goal_equipment',
          ],
        },
      });
    });

    render(<ImportPanel onImport={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /field_availability/i }));

    const input = screen.getByLabelText(/browse files/i);
    const file = new File(['x'], 'availability.csv', { type: 'text/csv' });
    fireEvent.change(input, { target: { files: [file] } });

    await screen.findByText('availability.csv');
    expect(screen.queryByTestId('import-error-banner')).not.toBeInTheDocument();
    expect(screen.getByText(/stores seasonal field availability metadata/i)).toBeInTheDocument();
    expect(
      screen.getAllByText(
        /No explicit day\/time slots were provided; schedule slots were not created\./i
      ).length
    ).toBeGreaterThan(0);
    expect(
      screen.getByText(
        /Required fields: Season, Location, Field Name, Available From, Available Until/i
      )
    ).toBeInTheDocument();
  });

  it('fields preview still requires slot fields', async () => {
    mocks.parse.mockImplementation((_file, options) => {
      options.complete({
        data: [{ location: 'North Park', name: 'Field 1', type: 'grass' }],
        meta: { fields: ['location', 'name', 'type'] },
      });
    });

    render(<ImportPanel onImport={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /fields/i }));

    const input = screen.getByLabelText(/browse files/i);
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'fields.csv', { type: 'text/csv' })] },
    });

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /map your columns/i })).toBeInTheDocument()
    );
  });

  it('field_availability missing available_from triggers mapping/validation path', async () => {
    mocks.parse.mockImplementation((_file, options) => {
      options.complete({
        data: [
          {
            season_label: 'Fall 2026',
            location: 'North Park',
            name: 'Field 1',
            available_until: '2026-11-30',
          },
        ],
        meta: { fields: ['season_label', 'location', 'name', 'available_until'] },
      });
    });

    render(<ImportPanel onImport={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /field_availability/i }));

    const input = screen.getByLabelText(/browse files/i);
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'availability.csv', { type: 'text/csv' })] },
    });

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /map your columns/i })).toBeInTheDocument()
    );
  });
  it('describes deferred import action controls', () => {
    mocks.importState = {
      ...mocks.importState,
      importStatus: 'ready_to_apply',
      progress: 100,
      activeJob: {
        warning_summary: {
          deferred_apply: {
            import_type: 'fields',
          },
        },
      },
    };

    render(<ImportPanel onImport={vi.fn()} />);

    expectTooltipFor(
      screen.getByRole('button', { name: /apply field import/i }),
      'Apply the validated field import.'
    );
    expectTooltipFor(
      screen.getByRole('button', { name: /cancel deferred import/i }),
      'Cancel this validated import.'
    );
  });

  it('supports deferred field availability action controls and copy', () => {
    mocks.importState = {
      ...mocks.importState,
      importStatus: 'ready_to_apply',
      progress: 100,
      importedFieldAvailability: { persistence: { durable: true } },
      activeJob: {
        warning_summary: {
          deferred_apply: {
            import_type: 'field_availability',
          },
        },
      },
    };

    render(<ImportPanel onImport={vi.fn()} />);
    expectTooltipFor(
      screen.getByRole('button', { name: /apply field availability import/i }),
      'Apply the validated field availability import.'
    );
  });

  it('describes completed import follow-up controls', () => {
    mocks.importState = {
      ...mocks.importState,
      importStatus: 'completed',
      progress: 100,
    };

    render(<ImportPanel onImport={vi.fn()} />);

    expectTooltipFor(
      screen.getByRole('button', { name: /upload another file/i }),
      'Reset and choose another CSV.'
    );
    expectTooltipFor(
      screen.getByRole('button', { name: /continue/i }),
      'Continue to the next workflow step.'
    );
  });

  it('keeps the importing notification checkbox focusable', () => {
    mocks.importState = {
      ...mocks.importState,
      isImporting: true,
      progress: 35,
      importStatus: 'importing',
    };

    render(<ImportPanel onImport={vi.fn()} />);

    const checkbox = screen.getByRole('checkbox', { name: /email me when complete/i });
    expect(checkbox).toHaveClass('sr-only');
    expect(checkbox.closest('label')).toHaveClass('focus-within:ring-2');
    expect(checkbox.closest('label')?.querySelector('[aria-hidden="true"]')).not.toBeNull();

    fireEvent.click(checkbox);
    expect(mocks.setNotifyOnComplete).toHaveBeenCalledWith(true);
  });
  /**
   * **The refusal has to reach a person.**
   *
   * `completeImport` has always told the operator to "check the import log"
   * when a job finishes with warnings, and until this panel rendered them
   * there was no import log to check: `ImportContext` accumulated `importLogs`
   * and no component read them. An availability CSV naming a field the
   * organisation does not have produced "Import Applied with Warnings", zero
   * profiles, and no statement on screen of why.
   *
   * The text asserted here is `describeFinalizeOutcome`'s, taken from that
   * function rather than restated, because it owns the wording and
   * tests/importFinalizeOutcome.test.js pins it against literals.
   */
  it('renders the import log so a refused row reaches the operator', async () => {
    const { describeFinalizeOutcome } =
      await import('../frontend/src/utils/importDeferredActions.js');
    const lines = describeFinalizeOutcome(
      { invalid_rows: 2, unresolved_field_rows: 2 },
      'field_availability'
    );
    expect(lines).toHaveLength(2);

    mocks.importState = {
      ...mocks.importState,
      importStatus: 'completed_with_warnings',
      importLogs: lines.map((message) => ({ timestamp: new Date(), message })),
    };
    render(<ImportPanel onImport={vi.fn()} />);

    expect(screen.getByText('Import Applied with Warnings')).toBeInTheDocument();
    const log = screen.getByTestId('import-log');
    // The reason, on screen, in the words the operator can act on.
    lines.forEach((line) => expect(within(log).getByText(line)).toBeInTheDocument());
    // Labelled rather than a bare box, so a screen reader reaches it by name.
    expect(log).toHaveAccessibleName('Import log');
  });

  it('renders no import log region when there is nothing to report', () => {
    mocks.importState = {
      ...mocks.importState,
      importStatus: 'completed',
      importLogs: [],
    };
    render(<ImportPanel onImport={vi.fn()} />);

    expect(screen.getByText('Import Applied')).toBeInTheDocument();
    // An empty box captioned "Import log" is worse than no box: it reads as
    // "nothing happened" on a screen that exists to report what did.
    expect(screen.queryByTestId('import-log')).toBeNull();
  });
});
