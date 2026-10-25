import { describe, it, expect } from 'vitest';
import Papa from 'papaparse';
import { CSV_TEMPLATES } from '../frontend/src/utils/csvTemplates.js';
import {
  makeDedupeHeaderTransformer,
  isSensitiveHeader,
} from '../frontend/src/utils/gotsportCanonicalizer.js';
import { matchHeaders } from '../frontend/src/utils/telemetryUtils.js';
import { findMissingRequiredHeaders } from '../frontend/src/utils/importHeaders.js';

const BOM = String.fromCharCode(0xfeff);

// Mirror the exact bytes downloadTemplate() emits (UTF-8 BOM + CRLF rows) and
// the ImportContext PapaParse config, so this guards the real upload path.
function parseDownloadedTemplate(type) {
  const t = CSV_TEMPLATES[type];
  const csv = BOM + [t.headers, t.example].map((r) => r.join(',')).join('\r\n');
  return Papa.parse(csv, {
    header: true,
    skipEmptyLines: true,
    transformHeader: makeDedupeHeaderTransformer(),
  });
}

// Regression: PapaParse invokes transformHeader twice over the header row, which
// made the stateful dedupe transformer suffix every UNIQUE header `__2`, so no
// header matched its alias and every player/coach import failed validation.
describe('CSV import header dedupe', () => {
  it('does not spuriously suffix unique headers from the downloaded player template', () => {
    const { meta } = parseDownloadedTemplate('players');
    expect(meta.fields).toEqual(CSV_TEMPLATES.players.headers);
    expect(meta.fields.some((h) => /__\d+$/.test(h))).toBe(false);
  });

  it('resolves the required player columns end-to-end from the template', () => {
    const { meta } = parseDownloadedTemplate('players');
    const fields = meta.fields.filter((h) => !isSensitiveHeader(h));
    const { mappings } = matchHeaders(fields, [], {});
    expect(findMissingRequiredHeaders(fields, 'players', mappings)).toEqual([]);
  });

  it('still de-duplicates genuinely repeated headers', () => {
    const { meta } = Papa.parse('Playing Up,Playing Up\nx,y', {
      header: true,
      skipEmptyLines: true,
      transformHeader: makeDedupeHeaderTransformer(),
    });
    expect(meta.fields).toEqual(['Playing Up', 'Playing Up__2']);
  });

  it('keeps the coach and fields templates clean too', () => {
    expect(parseDownloadedTemplate('coaches').meta.fields).toEqual(CSV_TEMPLATES.coaches.headers);
    expect(parseDownloadedTemplate('fields').meta.fields).toEqual(CSV_TEMPLATES.fields.headers);
  });
});

describe('the Division column of the fields template (D2)', () => {
  it('maps to division_name, the key the field finalizer reads for a practice reservation', () => {
    const { meta } = parseDownloadedTemplate('fields');
    expect(meta.fields).toContain('Division');
    const { mappings } = matchHeaders(meta.fields, [], {});
    expect(mappings.Division).toBe('division_name');
  });
});
