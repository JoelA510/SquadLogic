/**
 * The DOM environment under every component test is the jsdom this repo
 * installed, at the major the upgrade took (jsdom 30, resume-queue.md), not an
 * older copy or a different implementation. A version bump that Vitest
 * silently resolved to another jsdom, or an `environment` option that fell back
 * to something else, would leave the component tests green against the wrong DOM.
 */
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { version: installed } = require('jsdom/package.json');

describe('the Vitest DOM environment', () => {
  afterEach(() => {
    document.head.querySelectorAll('style').forEach((node) => node.remove());
  });

  it('is jsdom 30 or later (meta: the user agent names the installed version)', () => {
    expect(Number(installed.split('.')[0])).toBeGreaterThanOrEqual(30);
    expect(navigator.userAgent).toContain(`jsdom/${installed}`);
  });

  it('rejects an invalid selectorText, as jsdom 29 and later do', () => {
    // jsdom 28 and earlier accepted any string here. An environment that is not
    // jsdom 29+ would turn the selector into garbage.
    const style = document.createElement('style');
    style.textContent = '.a { color: red; }';
    document.head.appendChild(style);
    const rule = /** @type {CSSStyleRule} */ (style.sheet?.cssRules[0]);
    rule.selectorText = '!!!not a selector';
    expect(rule.selectorText).toBe('.a');
  });
});
