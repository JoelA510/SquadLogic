import React from 'react';
import { describe, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import InlineField from '../frontend/src/components/ui/InlineField.jsx';
import AutoSchedulerPanel from '../frontend/src/components/scheduling/AutoSchedulerPanel.jsx';
import { expectVisibleTextInName } from './helpers/index.js';

// axe-core 4.14 enables label-content-name-mismatch (WCAG 2.5.3); the E2E axe scans fail on
// a button whose aria-label leaves out its visible text. These pin the components it found.
describe('Label in Name (WCAG 2.5.3)', () => {
  it('an editable InlineField names its button with the visible value', () => {
    render(<InlineField label="Team" value="Thunder" onSave={() => {}} />);
    const button = screen.getByRole('button', { name: /^Edit Team: Thunder$/ });
    expectVisibleTextInName(button);
  });

  it('a read-only InlineField names its button with the rendered value', () => {
    render(
      <InlineField
        label="Division"
        value="U8 Coed"
        editable={false}
        render={(value) => <span className="badge info">{value}</span>}
      />
    );
    expectVisibleTextInName(screen.getByRole('button', { name: /^Division: U8 Coed$/ }));
  });

  it('an empty InlineField still names its button with its label', () => {
    render(<InlineField label="Jersey #" value={null} onSave={() => {}} />);
    // The placeholder dash is not text axe compares; the name still says what the field is.
    screen.getByRole('button', { name: /^Edit Jersey #: —$/ });
  });

  it.each([
    ['idle', 'Auto-Generate: run auto-scheduler optimization'],
    ['running', 'Optimizing: optimization in progress'],
  ])('the auto-scheduler trigger, %s, carries its visible text in its name', (status, name) => {
    render(
      <AutoSchedulerPanel
        status={status}
        progress={null}
        result={null}
        error={null}
        onTrigger={() => {}}
        onCancel={() => {}}
        onReset={() => {}}
      />
    );
    expectVisibleTextInName(screen.getByRole('button', { name }));
  });
});
