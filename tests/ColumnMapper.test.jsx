import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ColumnMapper from '../frontend/src/components/ColumnMapper.jsx';

const rawHeaders = ['First Name', 'Last Name', 'Email', 'Phone'];
const sampleRows = [
  {
    'First Name': 'Alex',
    'Last Name': 'Smith',
    Email: 'alex@example.com',
    Phone: '555-1212',
  },
];
const autoMatches = {
  'First Name': 'first_name',
  'Last Name': 'last_name',
  Email: 'email',
};

describe('ColumnMapper', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('exposes composite mapping mode as a pressed segmented control', () => {
    render(
      <ColumnMapper
        importType="coaches"
        rawHeaders={rawHeaders}
        sampleRows={sampleRows}
        autoMatches={autoMatches}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    const modeGroup = screen.getByRole('group', { name: 'Full Name mapping mode' });
    const singleButton = screen.getByRole('button', { name: 'Single' });
    const combineButton = screen.getByRole('button', { name: 'Combine' });

    expect(modeGroup).toContainElement(singleButton);
    expect(modeGroup).toContainElement(combineButton);
    expect(singleButton).toHaveAttribute('aria-pressed', 'false');
    expect(combineButton).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Full Name first source column')).toHaveValue('First Name');
    expect(screen.getByLabelText('Full Name second source column')).toHaveValue('Last Name');
  });

  it('labels source column selects after switching back to single-column mode', () => {
    render(
      <ColumnMapper
        importType="coaches"
        rawHeaders={rawHeaders}
        sampleRows={sampleRows}
        autoMatches={autoMatches}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    const singleButton = screen.getByRole('button', { name: 'Single' });
    fireEvent.click(singleButton);

    expect(singleButton).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Combine' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    expect(screen.getByLabelText('Full Name source column')).toHaveValue('');
    expect(screen.getByLabelText('Email source column')).toHaveValue('Email');
  });

  it('lets the user choose the second combine column independently and emits both', () => {
    const onConfirm = vi.fn();
    render(
      <ColumnMapper
        importType="coaches"
        rawHeaders={rawHeaders}
        sampleRows={sampleRows}
        autoMatches={autoMatches}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    );

    const firstSelect = screen.getByLabelText('Full Name first source column');
    const secondSelect = screen.getByLabelText('Full Name second source column');

    // The combine default pre-fills BOTH slots (First + Last). The second
    // slot must stay independently reachable and editable — regression: it
    // used to overflow off-screen, so only "First Name" was selectable.
    expect(firstSelect).toHaveValue('First Name');
    expect(secondSelect).toHaveValue('Last Name');

    fireEvent.change(secondSelect, { target: { value: 'Phone' } });

    expect(firstSelect).toHaveValue('First Name');
    expect(secondSelect).toHaveValue('Phone');

    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][0].full_name).toEqual({
      kind: 'composite',
      columns: ['First Name', 'Phone'],
      separator: ' ',
    });
  });

  it('keeps both combine source selects shrinkable (min-w-0) so long headers cannot overflow', () => {
    render(
      <ColumnMapper
        importType="coaches"
        rawHeaders={rawHeaders}
        sampleRows={sampleRows}
        autoMatches={autoMatches}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(screen.getByLabelText('Full Name first source column')).toHaveClass('min-w-0');
    expect(screen.getByLabelText('Full Name second source column')).toHaveClass('min-w-0');
  });

  // E3c: the evaluations import needs an id and at least one value column; no single value is required.
  describe('the evaluations import', () => {
    const headers = ['Ref', 'Notes', 'Experience', 'Score'];
    const mapper = (onConfirm = vi.fn()) =>
      render(
        <ColumnMapper
          importType="evaluations"
          rawHeaders={headers}
          sampleRows={[{ Ref: 'GS-1', Notes: 'x', Experience: '2', Score: '3' }]}
          autoMatches={{}}
          onConfirm={onConfirm}
          onCancel={vi.fn()}
        />
      );

    it('asks for the id and one value column, and enables Continue only when both are mapped', () => {
      const onConfirm = vi.fn();
      mapper(onConfirm);
      const next = screen.getByRole('button', { name: /^continue/i });
      expect(next).toBeDisabled();
      expect(
        screen.getByText(/still need: registration id, one of the value columns/i)
      ).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('Registration ID source column'), {
        target: { value: 'Ref' },
      });
      expect(next).toBeDisabled();
      expect(screen.getByText(/still need: one of the value columns/i)).toBeInTheDocument();

      // Any one of the three satisfies it; the others stay unmapped (a blank leaves a value alone).
      fireEvent.change(screen.getByLabelText('Rating source column'), {
        target: { value: 'Score' },
      });
      expect(next).toBeEnabled();
      fireEvent.click(next);
      expect(onConfirm).toHaveBeenCalledWith({
        external_registration_id: { kind: 'single', column: 'Ref' },
        rating: { kind: 'single', column: 'Score' },
      });
    });

    it('offers the three values as optional and the id as required', () => {
      mapper();
      expect(screen.getByLabelText('Years Played source column')).toBeInTheDocument();
      expect(screen.getByLabelText('Skill Tier source column')).toBeInTheDocument();
      expect(screen.getByLabelText('Rating source column')).toBeInTheDocument();
      expect(screen.getAllByText('required')).toHaveLength(1);
      expect(screen.getAllByText('optional')).toHaveLength(3);
    });
  });
});
