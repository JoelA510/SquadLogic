/**
 * What a permit's status and scopes read as, and what a field's card says about its permit.
 * Text beside an icon, never colour alone.
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import {
  formatPermitDate,
  permitScopeText,
  permitStatusText,
  permitStatusTone,
} from '../frontend/src/utils/permitText.js';
import FieldPermitStatus from '../frontend/src/components/setup/FieldPermitStatus.jsx';

describe('permit text', () => {
  const p = (status, days_left, over = {}) => ({
    status,
    days_left,
    valid_from: '2026-11-01',
    valid_to: '2026-12-31',
    ...over,
  });

  it('says how long a permit has, in words', () => {
    expect(permitStatusText(p('expiring', 12))).toBe('Expires in 12 days');
    expect(permitStatusText(p('expiring', 1))).toBe('Expires in 1 day');
    expect(permitStatusText(p('expiring', 0))).toBe('Expires today');
    expect(permitStatusText(p('expired', -1))).toBe('Expired yesterday');
    expect(permitStatusText(p('expired', -3))).toBe('Expired 3 days ago');
    expect(permitStatusText(p('not_yet_valid', 90))).toBe('Starts Nov 1, 2026');
    expect(permitStatusText(p('valid', 60))).toBe('Valid until Dec 31, 2026');
  });

  it('refuses a status it does not know rather than printing nothing', () => {
    expect(() => permitStatusText(p('pending', 1))).toThrow(/Unknown permit status/);
  });

  it('maps each status to a tone, and an unknown one to neutral', () => {
    expect(['expired', 'expiring', 'not_yet_valid', 'valid', 'x'].map(permitStatusTone)).toEqual([
      'danger',
      'warning',
      'info',
      'success',
      'neutral',
    ]);
  });

  it('shows a date as written, in UTC, whatever the browser zone', () => {
    expect(formatPermitDate('2026-01-01')).toBe('Jan 1, 2026');
    expect(formatPermitDate('not a date')).toBe('not a date');
  });

  it('names a venue scope, a field scope and a retired one', () => {
    expect(permitScopeText({ kind: 'location', location_name: 'Permit Park' })).toBe(
      'Permit Park (whole venue)'
    );
    expect(
      permitScopeText({ kind: 'field', location_name: 'Permit Park', field_name: 'Pitch 1' })
    ).toBe('Permit Park, Pitch 1');
    expect(
      permitScopeText({
        kind: 'field',
        location_name: 'Permit Park',
        field_name: 'Pitch 1',
        retired: true,
      })
    ).toBe('Permit Park, Pitch 1 (retired)');
  });
});

describe('FieldPermitStatus', () => {
  it('warns, in words, that a field has no current permit', () => {
    render(<FieldPermitStatus fieldId="f1" needsPermit current={null} coveringCount={0} />);
    expect(screen.getByTestId('field-permit-f1')).toHaveTextContent('No current permit');
  });

  it('says why when permits are on record but none is current', () => {
    render(<FieldPermitStatus fieldId="f1" needsPermit current={null} coveringCount={2} />);
    expect(screen.getByTestId('field-permit-f1')).toHaveTextContent(
      'The permits on record are expired, not yet valid, or have no file.'
    );
  });

  it('shows the current permit and when it expires', () => {
    render(
      <FieldPermitStatus
        fieldId="f1"
        needsPermit={false}
        coveringCount={1}
        current={{
          status: 'expiring',
          days_left: 5,
          issuer: 'Parks',
          permit_number: '7',
          valid_from: '2026-01-01',
          valid_to: '2026-11-01',
        }}
      />
    );
    expect(screen.getByTestId('field-permit-f1')).toHaveTextContent('Permit: Expires in 5 days');
  });

  it('says nothing for a field that does not need a permit', () => {
    const { container } = render(
      <FieldPermitStatus fieldId="f1" needsPermit={false} current={null} coveringCount={0} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
