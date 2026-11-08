/**
 * "Changes since publication": what the view shows follows the baseline that is SELECTED (PR 7 fix round, Codex
 * finding 4). The comparison a baseline made is kept in state keyed by that baseline's id, so:
 *
 * - with the selection cleared there is no comparison and no download, whatever was loaded before;
 * - A loaded, B requested, the selection cleared while B loads: nothing is shown, and B arriving later shows nothing
 *   either (its answer belongs to a selection that is gone);
 * - A selected, then B: the comparison under B's heading is never A's rows.
 *
 * The store hook is replaced so a read can be held open and released by the test (the real hook reads a mock table
 * that answers at once, which could not show a slow answer arriving late).
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ChangesView from '../frontend/src/components/reports/ChangesView.jsx';
import {
  FIELDS,
  ORG_ID,
  SLOTS,
  TEAMS,
  TZ,
  VENUES,
  baselineRows,
  savedGames,
  tbdGames,
} from './helpers/reportsWorld.js';

const hook = vi.hoisted(() => ({ /** @type {any} */ value: null }));
vi.mock('../frontend/src/hooks/usePublicationBaselines.js', () => ({
  usePublicationBaselines: () => hook.value,
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), log: vi.fn(), info: vi.fn() },
}));
vi.mock('../frontend/src/utils/scheduleDownloads.js', () => ({
  saveFile: vi.fn(),
  csvBlob: (csv) => csv,
}));

const summaryOf = (id, version, label) => ({
  id,
  baselineVersion: version,
  snapshotId: `s-${id}`,
  label,
  channel: 'storage',
  publishedAt: '2026-10-02T08:00:00',
  publishedBy: 'actor-1',
  notes: null,
  rowCount: 10,
  digest: '0123456789abcdef',
  recordedAt: '2026-10-02T12:00:00+00:00',
});
const BASELINES = [summaryOf('b-A', 1, 'Alpha files'), summaryOf('b-B', 2, 'Beta files')];
/** What each baseline held: A is the schedule as it is saved now; B had no Meteors v Rockets game (g3), so it is new. */
const ROWS = {
  'b-A': () => baselineRows(savedGames()),
  'b-B': () => baselineRows(savedGames({ g3: null })),
};

/** A read the test can hold open (`release`) and answer. */
function deferredReads() {
  /** @type {Record<string, () => void>} */
  const release = {};
  const readBaseline = vi.fn((id) => {
    const summary = BASELINES.find((b) => b.id === id);
    return new Promise((resolve) => {
      release[id] = () =>
        resolve({
          baseline: summary,
          snapshot: { rows: ROWS[id]() },
          readFindings: [],
        });
    });
  });
  return { readBaseline, release };
}

const client = { rpc: async () => ({ data: [], error: null }) };
const reference = () => ({
  teams: TEAMS,
  fields: FIELDS,
  venues: VENUES,
  slots: SLOTS,
  tbdGames: tbdGames(),
});

function mount() {
  const reads = deferredReads();
  hook.value = {
    baselines: BASELINES,
    loading: false,
    error: null,
    readBaseline: reads.readBaseline,
  };
  render(
    <ChangesView
      games={savedGames()}
      reference={reference()}
      timeZone={TZ}
      organizationId={ORG_ID}
      supabaseClient={client}
    />
  );
  return reads;
}
const select = () => screen.getByLabelText('Compare with baseline');
const choose = (id) => fireEvent.change(select(), { target: { value: id } });
const download = () => screen.queryByRole('button', { name: /download changes/i });
const nothingDrawn = () => {
  expect(screen.queryByTestId('changes-summary')).toBeNull();
  expect(screen.queryByTestId('changes-table')).toBeNull();
  expect(screen.queryByTestId('changes-nothing')).toBeNull();
  expect(screen.queryByTestId('changes-notes')).toBeNull();
  expect(download()).toBeNull();
};
/** Let a released read settle: the answer, then the audit read, then the state it sets. */
const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('the comparison follows the selected baseline', () => {
  it('shows nothing, and offers no download, until a baseline is chosen', () => {
    mount();
    nothingDrawn();
  });

  it('drops the comparison and the download when the selection is cleared', async () => {
    const reads = mount();
    choose('b-A');
    await act(async () => reads.release['b-A']());
    await settle();
    expect(await screen.findByTestId('changes-summary')).toHaveTextContent(/v1/);
    expect(download()).not.toBeNull();

    choose('');
    nothingDrawn();
  });

  it('shows nothing when B is requested and the selection is cleared while B loads, and when B arrives later', async () => {
    const reads = mount();
    choose('b-A');
    await act(async () => reads.release['b-A']());
    await settle();
    await screen.findByTestId('changes-summary');

    choose('b-B');
    // B is being read: the screen says so, and A's comparison is not under B's name.
    expect(screen.getByTestId('changes-reading')).toBeInTheDocument();
    expect(screen.queryByTestId('changes-summary')).toBeNull();

    choose('');
    nothingDrawn();
    expect(screen.queryByTestId('changes-reading')).toBeNull();

    // B's answer arrives for a selection that is gone: neither B's nor A's comparison appears.
    await act(async () => reads.release['b-B']());
    await settle();
    nothingDrawn();
  });

  it('never shows A’s rows under B’s heading when A is selected and then B', async () => {
    const reads = mount();
    choose('b-A');
    await act(async () => reads.release['b-A']());
    await settle();
    const first = await screen.findByTestId('changes-summary');
    expect(first).toHaveTextContent('Compared with published baseline v1 ("Alpha files"');
    expect(first).toHaveTextContent('6 games then, 6 now');

    choose('b-B');
    expect(screen.queryByTestId('changes-summary')).toBeNull();
    expect(screen.queryByTestId('changes-nothing')).toBeNull();
    expect(screen.getByTestId('changes-reading')).toBeInTheDocument();

    await act(async () => reads.release['b-B']());
    await settle();
    const second = await screen.findByTestId('changes-summary');
    expect(second).toHaveTextContent('Compared with published baseline v2 ("Beta files"');
    // B's own comparison: five games then, six now, and Meteors v Rockets is new.
    expect(second).toHaveTextContent('5 games then, 6 now');
    expect(screen.getByTestId('changes-table')).toHaveTextContent(
      'Synthetic Meteors v Synthetic Rockets'
    );
  });

  it('shows a late answer for A only while A is still the selection', async () => {
    const reads = mount();
    choose('b-A');
    choose('b-B');
    // A answers after B was chosen: B is the selection, and A's answer does not show.
    await act(async () => reads.release['b-A']());
    await settle();
    expect(screen.queryByTestId('changes-summary')).toBeNull();
    await act(async () => reads.release['b-B']());
    await settle();
    expect(await screen.findByTestId('changes-summary')).toHaveTextContent('v2');
  });
});
