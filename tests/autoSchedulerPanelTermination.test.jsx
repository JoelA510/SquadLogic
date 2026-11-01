import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import AutoSchedulerPanel from '../frontend/src/components/scheduling/AutoSchedulerPanel.jsx';

// The Edge Function stops its search at the server's compute cap and answers
// `terminationReason: 'cpu-cap'`. The panel says so in plain words where it shows the outcome.
function renderCompleted(terminationReason) {
  return render(
    <AutoSchedulerPanel
      status="completed"
      progress={null}
      result={{
        assignments: [{ teamId: 't1', slotId: 's1' }],
        unassigned: [],
        optimization: {
          iterations: 14,
          elapsedMs: 1600,
          restarts: 0,
          bestScore: 0.9,
          improvement: 0.1,
          terminationReason,
        },
      }}
      error={null}
      onTrigger={() => {}}
      onCancel={() => {}}
      onReset={() => {}}
    />
  );
}

describe('the auto-scheduler panel says when the server stopped the search', () => {
  it('shows the time-limit notice, not the code, for cpu-cap', () => {
    renderCompleted('cpu-cap');
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/Stopped at the server's time limit/);
    expect(status).toHaveTextContent(/best schedule found in that time/);
    expect(status).not.toHaveTextContent(/cpu-cap/);
    expect(status).not.toHaveTextContent(/Terminated:/);
    // The run still completed.
    expect(status).toHaveTextContent('Optimization Complete');
  });

  it('keeps the plain "Terminated" line, and no notice, for every other reason', () => {
    renderCompleted('max-iterations');
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Terminated: max-iterations');
    expect(status).not.toHaveTextContent(/server's time limit/);
  });
});

// Phase D PR D (plan `docs/changes/2026-10-27-phase-d-scheduling.md`, D3): the search can run in the
// browser's Web Worker, so the panel shows what the run is doing, lets the admin cancel it, and says
// where it ran.
function renderRunning(progress, onCancel = () => {}) {
  return render(
    <AutoSchedulerPanel
      status="running"
      progress={progress}
      result={null}
      error={null}
      onTrigger={() => {}}
      onCancel={onCancel}
      onReset={() => {}}
    />
  );
}

describe('the auto-scheduler panel shows a run in progress', () => {
  it('says what the run is doing at each step, with its counts', () => {
    const base = { iteration: 1200, bestScore: 0.91, elapsedMs: 2500 };
    const labels = {
      preparing: "Loading the season's data from the server…",
      searching: 'Optimizing in your browser…',
      verifying: 'The server is checking the result…',
      server: 'Optimizing on the server…',
    };
    for (const [phase, label] of Object.entries(labels)) {
      const { unmount } = renderRunning({ ...base, phase });
      const progress = screen.getByRole('status', { name: 'Optimization progress' });
      expect(progress).toHaveTextContent(label);
      expect(progress).toHaveTextContent('1,200');
      expect(progress).toHaveTextContent('91.0%');
      expect(progress).toHaveTextContent('2.5s');
      unmount();
    }
  });

  it('keeps its own label when the run names no step (the game page, an older hook)', () => {
    renderRunning({ iteration: 1, bestScore: 0.5, elapsedMs: 100 });
    expect(screen.getByRole('status', { name: 'Optimization progress' })).toHaveTextContent(
      'Running Hill Climbing optimization...'
    );
  });

  it('offers Cancel while it runs, and Cancel is a button that cancels', () => {
    const onCancel = vi.fn();
    renderRunning({ iteration: 0, bestScore: 0, elapsedMs: 0, phase: 'searching' }, onCancel);
    const cancel = screen.getByRole('button', { name: 'Cancel the running optimization' });
    cancel.focus();
    expect(cancel).toHaveFocus();
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
    // The run is disabled while it runs, so a second press cannot start another.
    expect(
      screen.getByRole('button', { name: /Optimizing: optimization in progress/ })
    ).toBeDisabled();
  });
});

describe('the auto-scheduler panel says where the search ran', () => {
  const optimization = (terminationReason = 'max-iterations') => ({
    iterations: 300,
    elapsedMs: 4000,
    restarts: 0,
    bestScore: 0.9,
    improvement: 0.1,
    terminationReason,
  });
  function renderResult(result) {
    return render(
      <AutoSchedulerPanel
        status="completed"
        progress={null}
        result={{ assignments: [], unassigned: [], ...result }}
        error={null}
        onTrigger={() => {}}
        onCancel={() => {}}
        onReset={() => {}}
      />
    );
  }

  it('"ran in your browser" and that the server checked it', () => {
    renderResult({ ranIn: 'browser', optimization: optimization(), verified: { refused: [] } });
    const note = screen.getByTestId('ran-in');
    expect(note).toHaveTextContent('Ran in your browser; the server checked every placement.');
    expect(note).not.toHaveTextContent(/refused/);
    expect(note).not.toHaveTextContent(/limit/);
  });

  it('says how many placements the server refused, and that their practices are unassigned', () => {
    const { unmount } = renderResult({
      ranIn: 'browser',
      optimization: optimization(),
      verified: { refused: [{ teamId: 'a', slotId: 's', rule: 'capacity' }] },
    });
    expect(screen.getByTestId('ran-in')).toHaveTextContent(
      "The server's check refused 1 placement; its practice is left unassigned."
    );
    unmount();
    renderResult({
      ranIn: 'browser',
      optimization: optimization(),
      verified: { refused: [{}, {}, {}] },
    });
    expect(screen.getByTestId('ran-in')).toHaveTextContent(
      "The server's check refused 3 placements; their practices are left unassigned."
    );
  });

  it('says a search stopped at the time limit depends on the computer it ran on', () => {
    renderResult({
      ranIn: 'browser',
      optimization: optimization('time-budget'),
      verified: { refused: [] },
    });
    expect(screen.getByTestId('ran-in')).toHaveTextContent(
      'It stopped at the 20-second limit, so another computer could find a different schedule.'
    );
  });

  it('"ran on the server", and why not in the browser when it was tried first', () => {
    const cases = {
      unavailable: "This browser can't run the optimizer, so the server ran it.",
      'worker-error': 'The optimizer could not finish in this browser, so the server ran it.',
      'input-changed':
        'The season changed while this browser was working, so the server ran it again on the new data.',
      'prepare-failed':
        "The server could not hand this season's data to the browser, so it ran the search itself.",
    };
    for (const [ranNote, sentence] of Object.entries(cases)) {
      const { unmount } = renderResult({ ranIn: 'server', ranNote, optimization: optimization() });
      expect(screen.getByTestId('ran-in')).toHaveTextContent(`Ran on the server. ${sentence}`);
      unmount();
    }
    renderResult({ ranIn: 'server', ranNote: null, optimization: optimization() });
    expect(screen.getByTestId('ran-in')).toHaveTextContent(/^Ran on the server\.$/);
  });

  it('says nothing about it for a result that does not say (the game page)', () => {
    renderResult({ optimization: optimization() });
    expect(screen.queryByTestId('ran-in')).toBeNull();
  });
});
