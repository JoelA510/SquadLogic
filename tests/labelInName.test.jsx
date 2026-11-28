import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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

  it('a read-only InlineField displays the rendered value as text', () => {
    render(
      <InlineField
        label="Division"
        value="U8 Coed"
        editable={false}
        render={(value) => <span className="badge info">{value}</span>}
      />
    );
    expect(screen.getByText('Division')).toBeVisible();
    expect(screen.getByText('U8 Coed')).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('discards an open editor when the field becomes read-only', () => {
    const props = { label: 'Team', value: 'Thunder', onSave: vi.fn() };
    const { rerender } = render(<InlineField {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Team: Thunder' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Unsaved change' } });
    rerender(<InlineField {...props} editable={false} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('Thunder')).toBeVisible();
    rerender(<InlineField {...props} />);
    expect(screen.getByRole('button', { name: 'Edit Team: Thunder' })).toBeEnabled();
    expect(props.onSave).not.toHaveBeenCalled();
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
