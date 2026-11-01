/**
 * Opening and downloading a permit's file, written once (docs/changes/2026-11-01-followups-f1.md,
 * item 4). `FieldPermitsSection` and `PermitsPage` each carried a copy of these two handlers; the
 * tests of both call sites (`FieldManagementPermits.test.jsx`, `permitsPage.test.jsx`) hold their
 * behaviour, and this file holds the helper's own: the order of the steps, and the two edges the
 * call sites' tests could not reach (a blocked tab that falls back to the window, a tab that is
 * closed when the link fails).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadPermitFile, openPermitFile } from '../frontend/src/utils/permitFile.js';

const file = { path: 'org/permit/abc.pdf', name: 'Park permit.pdf' };

/** A stand-in for the browser window: `open` returns the given tab, `location.assign` is spied. */
function fakeWindow(tab) {
  return { open: vi.fn(() => tab), location: { assign: vi.fn() } };
}

describe('openPermitFile', () => {
  it('opens the tab on the tap, before the link is asked for, and cuts its opener', async () => {
    const order = [];
    const tab = { opener: {}, location: { href: '' }, close: vi.fn() };
    const win = fakeWindow(tab);
    win.open.mockImplementation(() => {
      order.push('open');
      return tab;
    });
    const signedUrl = vi.fn(async () => {
      order.push('link');
      return 'https://files.example.test/signed';
    });

    await openPermitFile(signedUrl, file, win);

    expect(order).toEqual(['open', 'link']);
    expect(win.open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(signedUrl).toHaveBeenCalledWith(file.path);
    expect(tab.opener).toBeNull();
    expect(tab.location.href).toBe('https://files.example.test/signed');
    expect(tab.close).not.toHaveBeenCalled();
    expect(win.location.assign).not.toHaveBeenCalled();
  });

  it('closes the empty tab and rethrows the very error when the link cannot be made', async () => {
    const tab = { opener: {}, location: { href: '' }, close: vi.fn() };
    const win = fakeWindow(tab);
    const failure = new Error('The file could not be opened: Object not found');

    await expect(openPermitFile(async () => Promise.reject(failure), file, win)).rejects.toBe(
      failure
    );

    expect(tab.close).toHaveBeenCalledTimes(1);
    expect(tab.location.href).toBe('');
  });

  it('goes to the link in this window when the browser blocked the tab', async () => {
    const win = fakeWindow(null);
    await openPermitFile(async () => 'https://files.example.test/signed', file, win);
    expect(win.location.assign).toHaveBeenCalledWith('https://files.example.test/signed');
  });

  it('leaves the window alone, and rethrows, when the tab was blocked and the link failed', async () => {
    const win = fakeWindow(null);
    const failure = new Error('Failed to fetch');
    await expect(openPermitFile(async () => Promise.reject(failure), file, win)).rejects.toBe(
      failure
    );
    expect(win.location.assign).not.toHaveBeenCalled();
  });
});

describe('downloadPermitFile', () => {
  afterEach(() => vi.restoreAllMocks());

  it('asks for a link that saves the file under its own name, clicks an anchor, and removes it', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
      // The anchor is in the page while it is clicked, as a browser needs.
      expect(document.body.contains(/** @type {any} */ (this))).toBe(true);
    });
    const signedUrl = vi.fn(async () => 'https://files.example.test/signed?download=1');

    await downloadPermitFile(signedUrl, file);

    expect(signedUrl).toHaveBeenCalledWith(file.path, file.name);
    expect(click).toHaveBeenCalledTimes(1);
    const link = /** @type {HTMLAnchorElement} */ (click.mock.contexts[0]);
    expect(link.href).toBe('https://files.example.test/signed?download=1');
    expect(link.download).toBe('Park permit.pdf');
    expect(link.rel).toBe('noopener');
    expect(document.body.contains(link)).toBe(false);
  });

  it('clicks nothing and rethrows the very error when the link cannot be made', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const failure = new Error('The file could not be opened: no link was made');
    await expect(downloadPermitFile(async () => Promise.reject(failure), file)).rejects.toBe(
      failure
    );
    expect(click).not.toHaveBeenCalled();
    expect(document.querySelector('a[download]')).toBeNull();
  });
});
