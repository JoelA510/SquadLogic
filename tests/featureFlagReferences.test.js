/**
 * Every `FEATURE_FLAGS.<KEY>` the frontend names must exist in the registry.
 *
 * `WorkflowPage` guarded its organization panel with
 * `FEATURE_FLAGS.MULTI_TENANCY`, a key the registry never had: the guard read
 * `featureFlags[undefined]`, was always false, and the panel never rendered.
 * Its tests mocked `FeatureGuard` to render children unconditionally, so
 * nothing could see it. This scan reads the source instead.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FEATURE_FLAGS } from '../frontend/src/constants/featureFlags.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'frontend', 'src');
const REFERENCE = /FEATURE_FLAGS\.([A-Za-z_][A-Za-z0-9_]*)/g;

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(js|jsx)$/.test(name) ? [full] : [];
  });
}

/** Unknown references in `text`, as `KEY` strings. */
function unknownKeys(text) {
  return [...text.matchAll(REFERENCE)]
    .map((m) => m[1])
    .filter((k) => !Object.hasOwn(FEATURE_FLAGS, k));
}

describe('FEATURE_FLAGS references', () => {
  it('every key the frontend names is defined in the registry', () => {
    let references = 0;
    const unknown = [];
    for (const file of sources(ROOT)) {
      const text = readFileSync(file, 'utf8');
      references += [...text.matchAll(REFERENCE)].length;
      for (const key of unknownKeys(text)) unknown.push(`${path.relative(ROOT, file)}: ${key}`);
    }
    // The scan must have read real references, or "none unknown" means nothing.
    expect(references).toBeGreaterThan(5);
    expect(unknown).toEqual([]);
  });

  it('the scan reports an undefined key (the WorkflowPage shape)', () => {
    expect(unknownKeys('<FeatureGuard flag={FEATURE_FLAGS.MULTI_TENANCY}>')).toEqual([
      'MULTI_TENANCY',
    ]);
    expect(unknownKeys('isEnabled(FEATURE_FLAGS.HEAT_FORECAST)')).toEqual([]);
  });
});
