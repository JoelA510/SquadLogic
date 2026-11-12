/**
 * Cancelling a deferred import that is no longer waiting (review of #725, R8).
 *
 * Since 20261122010000 `cancel_ready_import_job` refuses a job that is not `ready_to_apply` (22023,
 * `import_not_ready_to_apply`): one applied or cancelled in another tab. The Import page cleared its local state only
 * when the cancel succeeded, so Cancel then failed for good until a reload. `cancelDeferredImportJob` now reads the
 * job when it meets that refusal and says what the job IS, so the page can settle from it; every other failure throws
 * as before.
 */
import { describe, expect, it, vi } from 'vitest';
import { cancelDeferredImportJob } from '../frontend/src/utils/importDeferredActions.js';

const REFUSAL = {
  code: '22023',
  details: 'import_not_ready_to_apply',
  message:
    'Import job j1 is completed, not ready_to_apply: only a staged import that has not been applied can be cancelled',
};

function client({ rpc, job }) {
  const reads = [];
  return {
    reads,
    rpc: vi.fn(async () => rpc),
    from: (table) => {
      const read = { table, filters: [] };
      const b = {
        select: (columns) => {
          read.select = columns;
          return b;
        },
        eq: (column, value) => {
          read.filters.push([column, value]);
          return b;
        },
        maybeSingle: async () => {
          reads.push(read);
          return job;
        },
      };
      return b;
    },
  };
}

describe('cancelDeferredImportJob', () => {
  it('a cancel that works answers as before, and reads nothing', async () => {
    const c = client({ rpc: { data: { status: 'canceled' }, error: null }, job: null });
    expect(
      await cancelDeferredImportJob({ supabase: c, type: 'coaches', importJobId: 'j1' })
    ).toEqual({
      status: 'canceled',
    });
    expect(c.reads).toEqual([]);
  });

  it('refused because the import was applied elsewhere: says so, from the job as it is', async () => {
    const c = client({
      rpc: { data: null, error: REFUSAL },
      job: { data: { id: 'j1', status: 'completed_with_warnings' }, error: null },
    });
    const out = await cancelDeferredImportJob({ supabase: c, type: 'coaches', importJobId: 'j1' });
    expect(out).toEqual({
      status: 'not_cancelled',
      job_status: 'completed_with_warnings',
      applied: true,
      message:
        'This import was already applied, in another tab or by someone else, so there was nothing to cancel. It is listed with the finished imports.',
    });
    expect(c.reads).toEqual([
      { table: 'import_jobs', select: 'id, status', filters: [['id', 'j1']] },
    ]);
  });

  it.each(['failed', 'needs_fix', 'importing'])(
    'refused for a job that is %s: nothing to cancel, said as that',
    async (status) => {
      const c = client({
        rpc: { data: null, error: REFUSAL },
        job: { data: { id: 'j1', status }, error: null },
      });
      const out = await cancelDeferredImportJob({ supabase: c, type: 'fields', importJobId: 'j1' });
      expect(out).toMatchObject({ status: 'not_cancelled', job_status: status, applied: false });
      expect(out.message).toBe(
        'This import is no longer waiting to be applied (it was cancelled or closed elsewhere), so there was nothing to cancel. The form has been cleared.'
      );
    }
  );

  it('refused and the job cannot be read: the refusal is thrown, nothing is assumed', async () => {
    const c = client({
      rpc: { data: null, error: REFUSAL },
      job: { data: null, error: { message: 'boom' } },
    });
    await expect(
      cancelDeferredImportJob({ supabase: c, type: 'coaches', importJobId: 'j1' })
    ).rejects.toThrow(/not ready_to_apply/);
    const gone = client({ rpc: { data: null, error: REFUSAL }, job: { data: null, error: null } });
    await expect(
      cancelDeferredImportJob({ supabase: gone, type: 'coaches', importJobId: 'j1' })
    ).rejects.toThrow(/not ready_to_apply/);
  });

  it('CONTROL: any other failure throws as before, and reads nothing', async () => {
    const c = client({
      rpc: { data: null, error: { code: '42501', message: 'Access denied' } },
      job: null,
    });
    await expect(
      cancelDeferredImportJob({ supabase: c, type: 'coaches', importJobId: 'j1' })
    ).rejects.toThrow('Access denied');
    expect(c.reads).toEqual([]);
  });
});

describe('discardGameImport (review of #725, R10)', () => {
  /** A client whose job read answers the statuses in turn, and whose cancel answers `rpc`. */
  function gameClient(statuses, rpc) {
    const queue = [...statuses];
    const c = {
      rpcCalls: 0,
      rpc: async () => {
        c.rpcCalls += 1;
        return rpc;
      },
      from: () => {
        const b = {
          select: () => b,
          eq: () => b,
          maybeSingle: async () => ({
            data: { id: 'j1', status: queue.shift(), warning_summary: {} },
            error: null,
          }),
        };
        return b;
      },
    };
    return c;
  }

  it('a job applied between the read and the call: not discarded, and its status is read again, not thrown', async () => {
    const { discardGameImport } = await import('../frontend/src/utils/gameImportClient.js');
    const c = gameClient(['ready_to_apply', 'completed'], { data: null, error: REFUSAL });
    expect(await discardGameImport(c, 'j1')).toEqual({ discarded: false, status: 'completed' });
    expect(c.rpcCalls).toBe(1);
  });

  it('CONTROL: a job read as applied is not sent at all, and one that is waiting is discarded', async () => {
    const { discardGameImport } = await import('../frontend/src/utils/gameImportClient.js');
    const applied = gameClient(['completed'], { data: null, error: REFUSAL });
    expect(await discardGameImport(applied, 'j1')).toEqual({
      discarded: false,
      status: 'completed',
    });
    expect(applied.rpcCalls).toBe(0);
    const waiting = gameClient(['ready_to_apply'], { data: { status: 'canceled' }, error: null });
    expect(await discardGameImport(waiting, 'j1')).toEqual({
      discarded: true,
      status: 'ready_to_apply',
    });
  });

  it('another refusal of the cancel is thrown in words', async () => {
    const { discardGameImport } = await import('../frontend/src/utils/gameImportClient.js');
    const c = gameClient(['ready_to_apply'], {
      data: null,
      error: { code: '42501', message: 'Access denied' },
    });
    await expect(discardGameImport(c, 'j1')).rejects.toThrow('Access denied');
  });
});
