/**
 * The races in the permit hook and dialog (Codex review of #669):
 *   - an attach whose response is lost may have committed: the upload is deleted only on proof
 *     that the stored file is not it;
 *   - a read for an organization that is no longer the active one never replaces the new one's list;
 *   - an older file check that resolves last never replaces the newest selection.
 * Each case fails without its fix.
 */
import React, { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const ORG_A = 'a1111111-1111-4111-8111-111111111111';
const ORG_B = 'b2222222-2222-4222-8222-222222222222';
const PERMIT = 'f6000000-0000-4000-8000-00000000000a';
const OLD_PATH = `${ORG_A}/${PERMIT}/c0000000-0000-4000-8000-000000000001.pdf`;

let currentOrg = ORG_A;
const rpc = vi.fn();
const upload = vi.fn();
const remove = vi.fn();
vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    rpc: (...args) => rpc(...args),
    storage: { from: () => ({ upload, remove, createSignedUrl: vi.fn() }) },
  },
}));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({ currentOrganization: { id: currentOrg } }),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), log: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { useFacilityPermits } from '../frontend/src/hooks/useFacilityPermits.js';
import PermitDialog from '../frontend/src/components/setup/PermitDialog.jsx';

const permit = (id, org, filePath = OLD_PATH) => ({
  id,
  organization_id: org,
  issuer: `Issuer ${id.slice(0, 2)}`,
  permit_number: null,
  valid_from: '2026-09-01',
  valid_to: '2026-12-31',
  notes: null,
  status: 'valid',
  days_left: 60,
  file: filePath ? { path: filePath, name: 'p.pdf', mime: 'application/pdf', size: 10 } : null,
  scopes: [],
});

const pdf = (name) =>
  new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])], name, {
    type: 'application/pdf',
  });

const deferred = () => {
  /** @type {(value?: any) => void} */
  let resolve = () => {};
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

/** Holds the hook's latest value for the test to call into (set after each render). */
const latest = { value: null };
/** @type {any} */
const api = new Proxy({}, { get: (_target, key) => latest.value?.[key] });
function Probe() {
  const value = useFacilityPermits();
  useEffect(() => {
    latest.value = value;
  });
  return (
    <div>
      <output data-testid="ids">{value.permits.map((p) => p.id).join(',')}</output>
      <output data-testid="loading">{String(value.loading)}</output>
    </div>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  currentOrg = ORG_A;
  upload.mockResolvedValue({ data: { path: 'x' }, error: null });
  remove.mockResolvedValue({ data: [], error: null });
});

describe('an attach whose answer was lost', () => {
  let stored; // the permit as the database holds it
  const readOk = () => ({
    data: { today: '2026-10-27', lead_days: 30, permits: [stored] },
    error: null,
  });
  const arrange = (setFile) => {
    stored = permit(PERMIT, ORG_A);
    rpc.mockImplementation(async (name, args) => {
      if (name === 'get_facility_permits') return readOk();
      if (name === 'admin_set_facility_permit_file') return setFile(args);
      throw new Error(`unexpected rpc ${name}`);
    });
  };
  const attach = async () => {
    render(<Probe />);
    await waitFor(() => expect(api.loading).toBe(false));
    return api.replaceFile(stored, pdf('new.pdf'));
  };
  const commit = (args) => {
    stored = { ...stored, file: { ...stored.file, path: args.p_object_path } };
  };

  it('keeps the new object and removes only the replaced one when the attach committed (a fetch error)', async () => {
    arrange((args) => {
      commit(args);
      return { data: null, error: { message: 'TypeError: Failed to fetch', code: '' } };
    });
    const updated = await attach();
    const uploaded = upload.mock.calls[0][0];
    expect(updated.file.path).toBe(uploaded);
    expect(remove).not.toHaveBeenCalledWith([uploaded]);
    expect(remove).toHaveBeenCalledWith([OLD_PATH]);
  });

  it('does the same when the call throws instead of returning an error', async () => {
    arrange((args) => {
      commit(args);
      throw new TypeError('Failed to fetch');
    });
    await attach();
    expect(remove).not.toHaveBeenCalledWith([upload.mock.calls[0][0]]);
    expect(remove).toHaveBeenCalledWith([OLD_PATH]);
  });

  it('removes the upload when the stored file proves the attach did not commit', async () => {
    arrange(() => ({ data: null, error: { message: 'Failed to fetch', code: '' } }));
    await expect(attach()).rejects.toThrow(/could not be attached/);
    expect(remove).toHaveBeenCalledWith([upload.mock.calls[0][0]]);
  });

  it('keeps the upload and says what is not known when the stored file cannot be read', async () => {
    arrange(() => ({ data: null, error: { message: 'Failed to fetch', code: '' } }));
    render(<Probe />);
    await waitFor(() => expect(api.loading).toBe(false));
    rpc.mockImplementation(async (name) => {
      if (name === 'get_facility_permits') throw new TypeError('Failed to fetch');
      return { data: null, error: { message: 'Failed to fetch', code: '' } };
    });
    await expect(api.replaceFile(stored, pdf('new.pdf'))).rejects.toThrow(
      /could not be confirmed that it was attached/
    );
    expect(remove).not.toHaveBeenCalled();
  });

  it('removes the upload at once on a refusal the server confirmed (an error code), without a re-read', async () => {
    arrange(() => ({ data: null, error: { message: 'no uploaded object', code: '22023' } }));
    render(<Probe />);
    await waitFor(() => expect(api.loading).toBe(false));
    const reads = rpc.mock.calls.filter(([n]) => n === 'get_facility_permits').length;
    await expect(api.replaceFile(stored, pdf('new.pdf'))).rejects.toThrow(/no uploaded object/);
    expect(remove).toHaveBeenCalledWith([upload.mock.calls[0][0]]);
    expect(rpc.mock.calls.filter(([n]) => n === 'get_facility_permits').length).toBe(reads);
  });
});

describe('a read for the previous organization', () => {
  it("never replaces the new organization's list, and the old list is not shown meanwhile", async () => {
    const reads = { A1: deferred(), A2: deferred(), B: deferred() };
    const queue = [reads.A1, reads.A2];
    rpc.mockImplementation(async (name, args) => {
      if (name !== 'get_facility_permits') throw new Error(`unexpected rpc ${name}`);
      return (args.p_organization_id === ORG_A ? queue.shift() : reads.B).promise;
    });
    const answer = (permits) => ({
      data: { today: '2026-10-27', lead_days: 30, permits },
      error: null,
    });
    const idA = 'f6000000-0000-4000-8000-0000000000a1';
    const idB = 'f6000000-0000-4000-8000-0000000000b1';

    const { rerender } = render(<Probe />);
    await act(async () => reads.A1.resolve(answer([permit(idA, ORG_A)])));
    expect(screen.getByTestId('ids')).toHaveTextContent(idA);

    // A mutation's refresh for organization A is still outstanding when the admin switches to B.
    let refreshing;
    act(() => {
      refreshing = api.refresh();
    });
    currentOrg = ORG_B;
    rerender(<Probe />);
    // B's list is pending: A's is not shown in its place.
    expect(screen.getByTestId('ids')).toBeEmptyDOMElement();
    expect(screen.getByTestId('loading')).toHaveTextContent('true');

    await act(async () => reads.B.resolve(answer([permit(idB, ORG_B)])));
    expect(screen.getByTestId('ids')).toHaveTextContent(idB);

    // A's old refresh now lands: it is dropped.
    await act(async () => {
      reads.A2.resolve(answer([permit(idA, ORG_A)]));
      await refreshing;
    });
    expect(screen.getByTestId('ids')).toHaveTextContent(idB);
    expect(screen.getByTestId('ids')).not.toHaveTextContent(idA);
  });
});

describe('overlapping file checks in the dialog', () => {
  const FIELD = 'f1000000-0000-4000-8000-000000000011';
  const VENUE = 'f1000000-0000-4000-8000-000000000001';

  it('keeps the newest selection when an older check resolves last, and clears "checking" only for the newest', async () => {
    const checks = {};
    const checkFile = vi.fn((file) => {
      checks[file.name] = deferred();
      return checks[file.name].promise;
    });
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <PermitDialog
        locations={[{ id: VENUE, name: 'Permit Park' }]}
        fields={[{ id: FIELD, name: 'Pitch 1', location_id: VENUE }]}
        checkFile={checkFile}
        onSave={onSave}
        onClose={() => {}}
      />
    );
    const dialog = screen.getByRole('dialog', { name: 'Add permit' });
    fireEvent.change(within(dialog).getByLabelText(/Issued by/), { target: { value: 'City' } });
    fireEvent.change(within(dialog).getByLabelText(/Valid from/), {
      target: { value: '2026-10-01' },
    });
    fireEvent.change(within(dialog).getByLabelText(/Valid through/), {
      target: { value: '2027-10-01' },
    });
    fireEvent.click(within(dialog).getByLabelText('Permit Park, Pitch 1'));

    const input = within(dialog).getByLabelText(/The permit document/);
    const oldFile = pdf('old.pdf');
    const newest = pdf('newest.pdf');
    fireEvent.change(input, { target: { files: [oldFile] } });
    fireEvent.change(input, { target: { files: [newest] } });
    const save = within(dialog).getByRole('button', { name: 'Save permit' });
    expect(save).toBeDisabled();

    await act(async () => checks['newest.pdf'].resolve({}));
    // The newest check is done; the older one still pending must not keep Save disabled.
    expect(save).toBeEnabled();
    await act(async () => checks['old.pdf'].resolve({}));
    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][1]).toBe(newest);
  });

  it('ignores an older check that fails after a newer selection was accepted', async () => {
    const checks = {};
    const checkFile = vi.fn((file) => {
      checks[file.name] = deferred();
      return checks[file.name].promise;
    });
    render(
      <PermitDialog
        locations={[{ id: VENUE, name: 'Permit Park' }]}
        fields={[]}
        checkFile={checkFile}
        onSave={vi.fn()}
        onClose={() => {}}
      />
    );
    const dialog = screen.getByRole('dialog', { name: 'Add permit' });
    const input = within(dialog).getByLabelText(/The permit document/);
    fireEvent.change(input, { target: { files: [pdf('old.pdf')] } });
    fireEvent.change(input, { target: { files: [pdf('newest.pdf')] } });
    await act(async () => checks['newest.pdf'].resolve({}));
    await act(async () => {
      checks['old.pdf'].resolve(Promise.reject(new Error('The file is over 10 MB')));
      await Promise.resolve();
    });
    expect(within(dialog).queryByText(/over 10 MB/)).not.toBeInTheDocument();
  });
});
