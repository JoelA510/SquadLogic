/**
 * **Stage 4 is reachable by an operator, proved by driving the operator's path.**
 *
 * GAP-29's brief is explicit that *"a durable baseline whose only consumer is a
 * test is Stage 2 wearing Stage 4's name"*. `tests/publicationBaselineStore.test.js`
 * drives the hook; this drives the **panel**, with the real mock Supabase
 * client behind it, because a hook nothing renders is the same defect one layer
 * up. Every interaction here is one an operator performs: press Generate,
 * press Upload, choose a version, press Check.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, beforeEach, vi } from 'vitest';

import OutputGenerationPanel from '../frontend/src/components/OutputGenerationPanel.jsx';
import { getMockData } from '../frontend/src/lib/mockSupabaseClient.js';
import { useOrganization } from '../frontend/src/contexts/OrganizationContext.jsx';

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const mock = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mock.mockSupabase };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: vi.fn(),
}));
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'mock-admin-id' } }),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), log: vi.fn() },
}));

const ORG = 'org-1';

const TEAMS = [
  { id: 't-1', name: 'Blue Bears', division: 'U10' },
  { id: 't-2', name: 'Red Foxes', division: 'U10' },
];
const GAME = {
  homeTeamId: 't-1',
  awayTeamId: 't-2',
  start: '2026-04-11T09:00:00Z',
  end: '2026-04-11T10:00:00Z',
  fieldId: 'pitch-1',
  slotId: 's-1',
};
/** The same fixture, half an hour later, on other ground. */
const MOVED = {
  ...GAME,
  start: '2026-04-11T09:30:00Z',
  end: '2026-04-11T10:30:00Z',
  fieldId: 'pitch-7',
};

const renderPanel = (games) =>
  render(<OutputGenerationPanel teams={TEAMS} gameAssignments={games} supabaseClient={null} />);

async function generateAndPublish(games) {
  const view = renderPanel(games);
  fireEvent.click(screen.getByRole('button', { name: 'Generate CSVs' }));
  await screen.findByText('Generated Files');
  fireEvent.click(screen.getByRole('button', { name: 'Upload to Storage' }));
  await screen.findByText(/Recorded as published baseline v1\./);
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
  // @ts-expect-error [MOCK] - a partial organization context is enough here.
  vi.mocked(useOrganization).mockReturnValue({ currentOrganization: { id: ORG } });
  sessionStorage.clear();
  delete window.__MOCK_DB__;
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: 'mock-admin-id' } }));
});

describe('OutputGenerationPanel :: the published baseline, on the publish path', () => {
  it('says nothing has been published before anything has', async () => {
    renderPanel([GAME]);
    expect(await screen.findByTestId('no-baselines')).toBeInTheDocument();
    expect(screen.queryByTestId('baseline-select')).toBeNull();
  });

  it('records a baseline when the operator uploads, and says which version', async () => {
    await generateAndPublish([GAME]);

    const stored = getMockData('publication_baselines');
    expect(stored).toHaveLength(1);
    expect(stored[0].organization_id).toBe(ORG);
    expect(stored[0].baseline_version).toBe(1);
    // Two rows: one fixture, per team.
    expect(stored[0].row_count).toBe(2);
    // **The upload message carries both outcomes.** A publication whose
    // baseline silently failed to record is the state incident 1 could not
    // recover from, so the panel never reports a bare success.
    // Three files: the master CSV plus one per team.
    expect(screen.getByText(/Uploaded 3 files to 'exports' bucket\./)).toBeInTheDocument();
  });

  it('lets the operator compare that baseline against a changed schedule, and names what moved', async () => {
    // Publish, then re-render the panel with the schedule the operator now
    // has -- the fixture moved by thirty minutes onto other ground.
    const view = await generateAndPublish([GAME]);
    view.unmount();

    renderPanel([MOVED]);
    fireEvent.click(screen.getByRole('button', { name: 'Generate CSVs' }));
    await screen.findByText('Generated Files');

    const select = await screen.findByTestId('baseline-select');
    const option = /** @type {HTMLOptionElement} */ (
      within(select).getByRole('option', { name: /^v1 — / })
    );
    fireEvent.change(select, { target: { value: option.value } });

    fireEvent.click(screen.getByTestId('check-parity-btn'));

    const report = await screen.findByTestId('parity-report');
    expect(within(report).getByTestId('parity-verdict').textContent).toMatch(
      /has moved since this was published: 2 row\(s\) changed, 0 row\(s\) gone/
    );
    expect(within(report).getByTestId('parity-differing')).toHaveTextContent('2');
    expect(within(report).getByTestId('parity-matched')).toHaveTextContent('0');
    expect(within(report).getByTestId('parity-removed')).toHaveTextContent('0');

    // The rows are NAMED, with the fields that changed. A count that said "2"
    // and nothing else is incident 1's own shape.
    const changed = within(report).getAllByTestId('parity-differing-row');
    expect(changed).toHaveLength(2);
    for (const row of changed) {
      expect(row.textContent).toMatch(/field/);
      expect(row.textContent).toMatch(/startMinutes/);
    }
  });

  it('reports parity as clean when the schedule has not moved', async () => {
    // The other half of the pair: a verdict that can only ever say "moved" is
    // not a verdict. Same panel, same baseline, unchanged schedule.
    const view = await generateAndPublish([GAME]);
    view.unmount();

    renderPanel([GAME]);
    fireEvent.click(screen.getByRole('button', { name: 'Generate CSVs' }));
    await screen.findByText('Generated Files');
    const select = await screen.findByTestId('baseline-select');
    fireEvent.change(select, {
      target: {
        value: /** @type {HTMLOptionElement} */ (
          within(select).getByRole('option', { name: /^v1 — / })
        ).value,
      },
    });
    fireEvent.click(screen.getByTestId('check-parity-btn'));

    const report = await screen.findByTestId('parity-report');
    expect(within(report).getByTestId('parity-verdict').textContent).toMatch(
      /still matches what was published/
    );
    expect(within(report).getByTestId('parity-matched')).toHaveTextContent('2');
    expect(within(report).queryAllByTestId('parity-differing-row')).toHaveLength(0);
  });

  it('will not offer a comparison before the CSVs exist', async () => {
    // Publish once so the select has something in it, then re-mount without
    // generating: the button is disabled and the reason is on screen rather
    // than the operator pressing a control that quietly does nothing.
    const view = await generateAndPublish([GAME]);
    view.unmount();

    renderPanel([GAME]);
    const select = await screen.findByTestId('baseline-select');
    fireEvent.change(select, {
      target: {
        value: /** @type {HTMLOptionElement} */ (
          within(select).getByRole('option', { name: /^v1 — / })
        ).value,
      },
    });
    expect(screen.getByTestId('check-parity-btn')).toBeDisabled();
    expect(
      screen.getByText(
        /Generate the CSVs first — there is no current schedule to compare against\./
      )
    ).toBeInTheDocument();
  });

  it('says a read failed rather than saying nothing was ever published', async () => {
    // **A `/code-review` finding.** The hook empties the list on a read error,
    // so without the error branch the operator is told "nothing has been
    // published yet" when the truth is that we could not find out -- which is
    // the exact false statement `docs/sql/20260920000000_revert.sql` promises
    // this surface will not make.
    const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
    const spy = vi.spyOn(mockSupabase, 'from').mockImplementation(
      () =>
        /** @type {any} */ ({
          select: () => ({
            eq: () => ({
              order: () => Promise.resolve({ data: null, error: { message: 'permission denied' } }),
            }),
          }),
        })
    );
    try {
      renderPanel([GAME]);
      const banner = await screen.findByTestId('baselines-error');
      expect(banner.textContent).toMatch(/says nothing about whether any exist/);
      expect(banner.textContent).toMatch(/permission denied/);
      expect(screen.queryByTestId('no-baselines')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses to call a comparison clean when it could not read the kickoffs', async () => {
    // **A `/code-review` finding, and the nastiest of them.** With both sides
    // in the `toLocaleString` spelling (GAP-36) every row lands in `matched`
    // with `startMinutes` absent, so the bucket-only verdict printed, in
    // green, that the schedule still matched -- having compared no kickoff at
    // all. The verdict is now gated on the findings.
    const view = await generateAndPublish([GAME]);
    view.unmount();

    // Re-publish is not needed; what is needed is a baseline whose Start
    // cells nobody can read. Rewrite the stored rows into the locale spelling
    // through the sanctioned saver.
    const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__'));
    for (const row of db.publication_baselines[0].export_rows) {
      row.Start = '4/11/2026, 9:00:00 AM';
    }
    window.__saveMockDB__(db);

    renderPanel([GAME]);
    fireEvent.click(screen.getByRole('button', { name: 'Generate CSVs' }));
    await screen.findByText('Generated Files');
    const select = await screen.findByTestId('baseline-select');
    fireEvent.change(select, {
      target: {
        value: /** @type {HTMLOptionElement} */ (
          within(select).getByRole('option', { name: /^v1 — / })
        ).value,
      },
    });
    fireEvent.click(screen.getByTestId('check-parity-btn'));

    const report = await screen.findByTestId('parity-report');
    const verdict = within(report).getByTestId('parity-verdict').textContent;
    expect(verdict).toMatch(/cannot be read as a verdict/);
    // The reason is named, not merely asserted: an operator who is told the
    // numbers are unreadable needs to know which check said so.
    expect(verdict).toContain('PARITY_FIELD_ABSENT');
    expect(within(report).getByTestId('parity-verdict')).toHaveClass('text-red-400');
    expect(within(report).getAllByTestId('parity-blocking').length).toBeGreaterThan(0);
  });

  it('says out loud what the numbers are silent about', async () => {
    // `PARITY_FIELD_UNCOMPARED` is `compromise` and fires on every real run:
    // the export carries Coaches, Notes, Slot and Event Type and the parity
    // vocabulary models none of them. Rendering only `blocking` put that
    // narrowing back into the silence `baseline.js` exists to break.
    const view = await generateAndPublish([GAME]);
    view.unmount();

    renderPanel([GAME]);
    fireEvent.click(screen.getByRole('button', { name: 'Generate CSVs' }));
    await screen.findByText('Generated Files');
    const select = await screen.findByTestId('baseline-select');
    fireEvent.change(select, {
      target: {
        value: /** @type {HTMLOptionElement} */ (
          within(select).getByRole('option', { name: /^v1 — / })
        ).value,
      },
    });
    fireEvent.click(screen.getByTestId('check-parity-btn'));

    const report = await screen.findByTestId('parity-report');
    const qualified = within(report).getAllByTestId('parity-qualified');
    expect(qualified.length).toBeGreaterThan(0);
    expect(qualified.map((node) => node.textContent).join(' ')).toMatch(/PARITY_FIELD_UNCOMPARED/);
  });

  it('drops a parity report the moment the schedule it described is regenerated', async () => {
    // A green "still matches" left on screen after a regenerate describes a
    // row set that no longer exists.
    const view = await generateAndPublish([GAME]);
    view.unmount();

    renderPanel([GAME]);
    fireEvent.click(screen.getByRole('button', { name: 'Generate CSVs' }));
    await screen.findByText('Generated Files');
    const select = await screen.findByTestId('baseline-select');
    fireEvent.change(select, {
      target: {
        value: /** @type {HTMLOptionElement} */ (
          within(select).getByRole('option', { name: /^v1 — / })
        ).value,
      },
    });
    fireEvent.click(screen.getByTestId('check-parity-btn'));
    await screen.findByTestId('parity-report');

    fireEvent.click(screen.getByRole('button', { name: 'Generate CSVs' }));
    await waitFor(() => expect(screen.queryByTestId('parity-report')).toBeNull());
  });

  it('never reports a successful publish when the baseline did not record', async () => {
    // A caller who is not an admin of the organisation: the upload still
    // happens (the files really did go out) and the message says the baseline
    // did not, at `error` rather than `success`.
    sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: 'not-a-member' } }));
    renderPanel([GAME]);
    fireEvent.click(screen.getByRole('button', { name: 'Generate CSVs' }));
    await screen.findByText('Generated Files');
    fireEvent.click(screen.getByRole('button', { name: 'Upload to Storage' }));

    const message = await screen.findByText(/NO published baseline was recorded/);
    expect(message.textContent).toMatch(/Uploaded 3 files/);
    expect(message.textContent).toMatch(/Access denied/);
    // Rendered in the error style, which is what `status === 'error'` drives.
    expect(message).toHaveClass('text-red-400');
    await waitFor(() => expect(getMockData('publication_baselines')).toEqual([]));
  });
});
