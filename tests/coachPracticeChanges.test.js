// @vitest-environment node
/**
 * The practices on the coach schedule are the weekly series, as they are in the master export: a saved practice
 * exception (a move, or a TIME TBD window) is not applied to them. The Exports panel says so through the existing
 * omission warning (`utils/practiceExportChanges.js`, 8.6 3b PR 12c, operator answer Q6), and the coach report uses
 * that helper as it is (PR 7 fix round, Codex finding 3): the count is the helper's, the unread text is the helper's,
 * and the report adds one sentence, that its practice clash column is computed on the series.
 *
 * What this file holds:
 * - a relocated or TIME TBD exception on the coach's practices is named by the helper's own sentence; a withdrawn one,
 *   one on another coach's practice, and none at all are not;
 * - a read that fails (as an error answer and as a rejected request) says it could not be checked, with the helper's
 *   own text, and never claims there are no changes;
 * - a view that has not read yet says "not checked yet", not "no changes".
 */
import { describe, expect, it } from 'vitest';

import {
  EXPORT_PRACTICE_CHANGES_UNREAD_TEXT,
  practiceChangesNoteOf,
} from '../frontend/src/utils/practiceExportChanges.js';
import {
  COACH_PRACTICE_SERIES_SENTENCE,
  coachPracticeChangesLines,
  coachPracticeHelperRows,
  readCoachPracticeChanges,
} from '../frontend/src/utils/coachPracticeChanges.js';
import { ORG_ID, practices } from './helpers/reportsWorld.js';

/** Alex's practices: p-1 (Tuesday 17:00, the Comets) and p-2 and p-3 (Tuesday 18:00 and Wednesday 17:00, the Planets). */
const alexPractices = () => practices().filter((p) => ['p-1', 'p-2', 'p-3'].includes(p.id));

const exception = (id, assignmentId, window, extra = {}) => ({
  id,
  assignment_id: assignmentId,
  window,
  kind: 'relocated',
  tbd_reason: null,
  withdrawn_at: null,
  ...extra,
});

/** A client answering `practice_exceptions` as PostgREST does, or failing it as an error answer or a rejected request. */
function clientWith(rows, failure = null) {
  const calls = [];
  return {
    calls,
    from(table) {
      const call = { table, filters: [] };
      calls.push(call);
      const builder = {
        select: () => builder,
        eq: (column, value) => {
          call.filters.push([column, value]);
          return builder;
        },
        order: () => builder,
        range: () => builder,
        then(resolve, reject) {
          if (failure === 'reject')
            return Promise.reject(new Error('network down')).then(resolve, reject);
          if (failure)
            return Promise.resolve({ data: null, error: { message: failure } }).then(
              resolve,
              reject
            );
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

describe('coachPracticeHelperRows: the coach’s practices as the helper reads stored rows', () => {
  it('names each practice by id, series range, weekday and organization, and nothing else', () => {
    const rows = coachPracticeHelperRows(alexPractices(), ORG_ID);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      id: 'p-1',
      organizationId: ORG_ID,
      effectiveDateRange: '[2026-09-08,2026-11-20)',
      practiceSlots: { dayOfWeek: 'tue' },
    });
  });
});

describe('readCoachPracticeChanges', () => {
  it('counts a relocated exception on the coach’s practice, through the helper', async () => {
    // Tue 2026-10-06 is one series date of p-1.
    const client = clientWith([exception('e-1', 'p-1', '[2026-10-06,2026-10-07)')]);
    const result = await readCoachPracticeChanges(client, alexPractices(), ORG_ID);
    expect(result).toEqual({ ok: true, count: 1 });
    expect(client.calls[0].table).toBe('practice_exceptions');
    expect(client.calls[0].filters).toContainEqual(['organization_id', ORG_ID]);
  });

  it('counts a TIME TBD window by the series dates it covers, and not a withdrawn one or another coach’s', async () => {
    const client = clientWith([
      // Two Tuesdays (10-06, 10-13) of p-1 and one Wednesday (10-07) of p-3.
      exception('e-1', 'p-1', '[2026-10-06,2026-10-14)', {
        kind: 'time_tbd',
        tbd_reason: 'contended',
      }),
      exception('e-2', 'p-3', '[2026-10-07,2026-10-08)'),
      exception('e-3', 'p-1', '[2026-10-20,2026-10-21)', { withdrawn_at: '2026-10-01T00:00:00Z' }),
      // Blake's practice, not Alex's.
      exception('e-4', 'p-4', '[2026-10-08,2026-10-09)'),
    ]);
    const result = await readCoachPracticeChanges(client, alexPractices(), ORG_ID);
    expect(result).toEqual({ ok: true, count: 3 });
  });

  it('is zero when there are none', async () => {
    expect(await readCoachPracticeChanges(clientWith([]), alexPractices(), ORG_ID)).toEqual({
      ok: true,
      count: 0,
    });
  });

  it('reads nothing, and says zero, for a coach with no practices', async () => {
    const client = clientWith([exception('e-1', 'p-1', '[2026-10-06,2026-10-07)')]);
    expect(await readCoachPracticeChanges(client, [], ORG_ID)).toEqual({ ok: true, count: 0 });
    expect(client.calls).toEqual([]);
  });

  it.each(['denied', 'reject'])(
    'is not ok when the read fails (%s): it could not be checked',
    async (failure) => {
      const result = await readCoachPracticeChanges(
        clientWith([], failure),
        alexPractices(),
        ORG_ID
      );
      expect(result).toEqual({ ok: false });
    }
  );
});

describe('coachPracticeChangesLines: what the report says', () => {
  it('says the helper’s own sentence for a count, and that the clash column is computed on the series', () => {
    const lines = coachPracticeChangesLines({ ok: true, count: 1 });
    expect(lines).toEqual([
      practiceChangesNoteOf({ ok: true, count: 1 }),
      COACH_PRACTICE_SERIES_SENTENCE,
    ]);
    expect(lines[0]).toBe('1 practice has temporary changes not shown in this export.');
    expect(coachPracticeChangesLines({ ok: true, count: 3 })[0]).toBe(
      '3 practices have temporary changes not shown in this export.'
    );
    expect(COACH_PRACTICE_SERIES_SENTENCE).toMatch(
      /practice clash column is computed on the weekly series/i
    );
  });

  it('says nothing when there are no changes: the helper’s own rule (null for zero)', () => {
    expect(coachPracticeChangesLines({ ok: true, count: 0 })).toEqual([]);
  });

  it('says it could not be checked, in the helper’s words and with the table, and never that there are no changes', () => {
    const lines = coachPracticeChangesLines({ ok: false });
    expect(lines[0]).toContain(EXPORT_PRACTICE_CHANGES_UNREAD_TEXT);
    expect(lines[0]).toContain('practice_exceptions');
    expect(lines[1]).toBe(COACH_PRACTICE_SERIES_SENTENCE);
    expect(lines.join(' ')).not.toMatch(/no (temporary )?changes|none/i);
  });

  it('says not checked yet before a read has answered, and nothing else', () => {
    expect(coachPracticeChangesLines(null)).toEqual(['Practice changes: not checked yet.']);
  });
});
