import { within } from '@testing-library/react';
import { expect } from 'vitest';

// Close to axe's label-content-name-mismatch (its curateTokens): NFKD, bracketed text
// removed (axe drops it, so "Menu (AA)" does not contain "AA"), lower-case, punctuation to
// spaces, whitespace collapsed.
const normalize = (text) =>
  text
    .normalize('NFKD')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The text a sighted user sees on `element`: no `.sr-only` or `aria-hidden` content. */
export function visibleText(element) {
  const clone = element.cloneNode(true);
  clone.querySelectorAll('.sr-only, [aria-hidden="true"]').forEach((node) => node.remove());
  return normalize(clone.textContent ?? '');
}

/**
 * WCAG 2.5.3 Label in Name: the accessible name of `button` contains its visible text as
 * whole words. Fails on an empty visible text so the check cannot pass vacuously.
 */
export function expectVisibleTextInName(button) {
  const visible = visibleText(button);
  expect(visible, 'button has no visible text to check').not.toBe('');
  const matches = within(button.ownerDocument.body).queryAllByRole('button', {
    name: (name) => ` ${normalize(name)} `.includes(` ${visible} `),
  });
  expect(matches, `accessible name does not contain "${visible}"`).toContain(button);
}
