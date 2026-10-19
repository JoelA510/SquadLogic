import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { expectVisibleTextInName } from '../labelInName.js';

// Rule 9: the helper must fail on the mismatches axe 4.14 reported, not only pass on fixes.
describe('expectVisibleTextInName', () => {
  it.each([
    [
      'no space between label and value spans',
      <button key="a" aria-label="Active Season: Fall 2026">
        <span>Season</span>
        <span>Fall 2026</span>
      </button>,
    ],
    [
      'initials missing from the name',
      <button key="b" aria-label="Account menu for Avery Admin">
        AA
      </button>,
    ],
    [
      'visible text only in brackets',
      <button key="c" aria-label="Account menu (AA)">
        AA
      </button>,
    ],
    [
      'aria-label replacing the value',
      <button key="d" aria-label="Edit Team">
        Thunder
      </button>,
    ],
  ])('fails on %s', (_case, element) => {
    render(element);
    expect(() => expectVisibleTextInName(screen.getByRole('button'))).toThrow();
  });

  it('fails when the button shows no text, rather than passing vacuously', () => {
    render(<button aria-label="Close">—</button>);
    expect(() => expectVisibleTextInName(screen.getByRole('button'))).toThrow(/no visible text/);
  });

  it.each([
    [
      'a name led by its purpose',
      <button key="e" aria-label="Account menu for Avery Admin, AA">
        AA
      </button>,
    ],
    [
      'a name from content with a hidden prefix',
      <button key="f">
        <span className="sr-only">Edit Team:</span> <span>Thunder</span>
      </button>,
    ],
    [
      'a spaced switcher',
      <button key="g" aria-label="Active Season: Fall 2026">
        <span>Season</span> <span>Fall 2026</span>
      </button>,
    ],
  ])('passes on %s', (_case, element) => {
    render(element);
    expectVisibleTextInName(screen.getByRole('button'));
  });
});
