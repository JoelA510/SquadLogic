import { describe, expect, it } from 'vitest';
import { describeFinalizeOutcome } from '../frontend/src/utils/importDeferredActions.js';

/**
 * The words an operator reads when the server refused a row.
 *
 * Both apply paths in ImportContext build their lines here -- the deferred one
 * and the direct one -- because the refusal reporting was added to the deferred
 * path first and the direct path went on printing only its insert counts, which
 * is the one-arm-and-not-its-twin shape this project keeps finding.
 *
 * The literals live in this file rather than in the context tests, so there is
 * one authority for the wording and the context tests can assert only that the
 * lines reach the log.
 */
describe('describeFinalizeOutcome', () => {
  it('says nothing when the finalize refused nothing', () => {
    expect(
      describeFinalizeOutcome({ status: 'completed', inserted_profiles: 15 }, 'field_availability')
    ).toEqual([]);
    expect(
      describeFinalizeOutcome({ invalid_rows: 0, unresolved_field_rows: 0 }, 'field_availability')
    ).toEqual([]);
    // A finalizer that returns neither key (or an error path that returns
    // nothing at all) must not produce a line claiming zero of something.
    expect(describeFinalizeOutcome(undefined, 'field_availability')).toEqual([]);
    expect(describeFinalizeOutcome(null, 'field_availability')).toEqual([]);
    expect(describeFinalizeOutcome({}, 'field_availability')).toEqual([]);
  });

  it('reports refused rows for any import type', () => {
    // `invalid_rows` is returned by all the finalizers, so the count is
    // reported whichever import this is.
    ['field_availability', 'fields', 'coaches'].forEach((type) => {
      const lines = describeFinalizeOutcome({ invalid_rows: 4 }, type);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('4 row(s) were not applied');
    });
  });

  /**
   * **Only field_availability replays a refused row.** The coach and field
   * finalizers exclude rows carrying validation_errors from every future
   * finalize, so a refusal there is terminal. Telling their operator the rows
   * are "still staged" would promise a recovery that does not exist.
   */
  it('promises replayability only for the import that actually replays', () => {
    const availability = describeFinalizeOutcome({ invalid_rows: 4 }, 'field_availability')[0];
    expect(availability).toContain('Nothing was discarded');
    expect(availability).toContain('still staged');

    ['fields', 'coaches', 'players', undefined].forEach((type) => {
      const line = describeFinalizeOutcome({ invalid_rows: 4 }, type)[0];
      expect(line).not.toMatch(/still staged/);
      expect(line).not.toMatch(/Nothing was discarded/);
      expect(line).toContain('will not retry them');
    });
  });

  it('names the unresolved-field case and what to do about it', () => {
    const lines = describeFinalizeOutcome(
      { invalid_rows: 3, unresolved_field_rows: 2 },
      'field_availability'
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('2 of those name a field this organization does not have');
    expect(lines[1]).toContain('Create the field');
    // **It must not promise a button that does not exist.** There is no UI path
    // that re-applies a finished job today, so the wording says the rows can be
    // applied without re-uploading -- which is true of the data -- and stops
    // short of telling anyone to "apply again".
    expect(lines[1]).not.toMatch(/apply again/i);
    expect(lines[1]).toContain('without re-uploading');
  });

  it('reports the unresolved line only when there is one to report', () => {
    const lines = describeFinalizeOutcome(
      { invalid_rows: 2, unresolved_field_rows: 0 },
      'field_availability'
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/does not have/);
  });

  it('does not trust the shape of the counts it is given', () => {
    // These come back over the wire as JSON; a string count must not produce
    // "NaN row(s)" or a line for a count that is not a number.
    expect(describeFinalizeOutcome({ invalid_rows: '3' }, 'fields')[0]).toContain('3 row(s)');
    expect(describeFinalizeOutcome({ invalid_rows: 'lots' }, 'fields')).toEqual([]);
    expect(describeFinalizeOutcome({ invalid_rows: -1 }, 'fields')).toEqual([]);
  });
});
