import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
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
