/**
 * The Permits section of Field Management (`FieldPermitsSection`, `PermitDialog`, and the
 * `useFacilityPermits` hook under them): the warnings, add / replace file / delete, and how each
 * failure is announced. The supabase client is a stand-in whose calls the test reads; the database's
 * own refusals are the pgTAP suite's and `tests/mockFacilityPermits.test.js`'s.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const ORG = 'a1111111-1111-4111-8111-111111111111';
const PERMIT = 'f6000000-0000-4000-8000-00000000000a';
const FIELD = 'f1000000-0000-4000-8000-000000000011';
const VENUE = 'f1000000-0000-4000-8000-000000000001';
const NEW_PERMIT = 'f6000000-0000-4000-8000-0000000000bb';

// A keyboard or pointer press: focus first, as a real press does, so the dialog can give it back.
const press = (element) => {
  element.focus();
  fireEvent.click(element);
};
const typeInto = (element, value) => fireEvent.change(element, { target: { value } });

const rpc = vi.fn();
const upload = vi.fn();
const remove = vi.fn();
const createSignedUrl = vi.fn();
vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    rpc: (...args) => rpc(...args),
    storage: { from: () => ({ upload, remove, createSignedUrl }) },
  },
}));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({ currentOrganization: { id: ORG } }),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), log: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import FieldPermitsSection from '../frontend/src/components/setup/FieldPermitsSection.jsx';
import { useFacilityPermits } from '../frontend/src/hooks/useFacilityPermits.js';
import { permitWarnings } from '@squadlogic/core/facility/permits.js';

const locations = [{ id: VENUE, name: 'Permit Park', effective_to: null }];
const fields = [
  { id: FIELD, name: 'Pitch 1', location_id: VENUE, active: true, effective_to: null },
  {
    id: 'f1000000-0000-4000-8000-000000000012',
    name: 'Pitch 2',
    location_id: VENUE,
    active: true,
    effective_to: null,
  },
];

const permit = (over = {}) => ({
  id: PERMIT,
  organization_id: ORG,
  issuer: 'Parks Dept',
  permit_number: '0042',
  valid_from: '2026-09-01',
  valid_to: '2026-11-08',
  notes: null,
  status: 'expiring',
  days_left: 12,
  file: {
    path: `${ORG}/${PERMIT}/c0000000-0000-4000-8000-000000000001.pdf`,
    name: 'permit.pdf',
    mime: 'application/pdf',
    size: 52_000,
  },
  scopes: [
    {
      id: 's1',
      kind: 'field',
      field_id: FIELD,
      location_id: VENUE,
      field_name: 'Pitch 1',
      location_name: 'Permit Park',
      retired: false,
    },
  ],
  ...over,
});

let permits;
const readOk = () => ({ data: { today: '2026-10-27', lead_days: 30, permits }, error: null });

function Harness() {
  const permitState = useFacilityPermits();
  const warnings = permitState.today
    ? permitWarnings({ permits: permitState.permits, today: permitState.today, locations, fields })
    : null;
  return (
    <FieldPermitsSection
      permitState={permitState}
      warnings={warnings}
      locations={locations}
      fields={fields}
    />
  );
}

const pdfFile = (name = 'permit.pdf', size = 1000) => {
  const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])], name, {
    type: 'application/pdf',
  });
  Object.defineProperty(file, 'size', { value: size });
  return file;
};

beforeEach(() => {
  vi.clearAllMocks();
  permits = [permit()];
  rpc.mockImplementation(async (name) => {
    if (name === 'get_facility_permits') return readOk();
    throw new Error(`unexpected rpc ${name}`);
  });
  upload.mockResolvedValue({ data: { path: 'x' }, error: null });
  remove.mockResolvedValue({ data: [], error: null });
});

describe('the Permits section', () => {
  it('lists a permit with its status as text beside an icon, its dates, scopes and file', async () => {
    render(<Harness />);
    const item = await screen.findByTestId(`permit-${PERMIT}`);
    expect(within(item).getByText(/Parks Dept #0042/)).toBeInTheDocument();
    expect(within(item).getByText('Expires in 12 days')).toBeInTheDocument();
    expect(within(item).getByText(/Permit Park, Pitch 1/)).toBeInTheDocument();
    expect(within(item).getByText(/permit\.pdf/)).toBeInTheDocument();
  });

  it('warns about a permit expiring within 30 days and about a field with no current permit, as text', async () => {
    render(<Harness />);
    const warnings = await screen.findByTestId('permit-warnings');
    expect(within(warnings).getByTestId('permit-warning-expiring')).toHaveTextContent(
      '1 permit expires within 30 days'
    );
    // Pitch 2 is covered by no permit.
    expect(within(warnings).getByTestId('permit-warning-missing')).toHaveTextContent(
      '1 field has no current permit: Permit Park, Pitch 2'
    );
  });

  it('warns about an expired permit and says nothing is wrong when every field is covered', async () => {
    permits = [
      permit({ id: 'p-exp', status: 'expired', days_left: -3, valid_to: '2026-10-24', scopes: [] }),
    ];
    const { unmount } = render(<Harness />);
    expect(await screen.findByTestId('permit-warning-expired')).toHaveTextContent(
      '1 permit has expired'
    );
    expect(screen.getByText('Expired 3 days ago')).toBeInTheDocument();
    expect(screen.getByText(/no field \(the ground it covered was deleted\)/)).toBeInTheDocument();
    unmount();
    permits = [
      permit({
        status: 'valid',
        days_left: 90,
        scopes: [
          {
            id: 's1',
            kind: 'location',
            field_id: null,
            location_id: VENUE,
            location_name: 'Permit Park',
            field_name: null,
            retired: false,
          },
        ],
      }),
    ];
    render(<Harness />);
    expect(await screen.findByText(/Every live field has a current permit/)).toBeInTheDocument();
  });

  it('says the role cannot read permits when the server refuses (42501), not that there are none', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'Access denied' } });
    render(<Harness />);
    const message = await screen.findByText('Permits are not available to your role.');
    expect(message).toHaveAttribute('role', 'status');
    expect(screen.queryByText('No permits recorded yet.')).not.toBeInTheDocument();
  });
});

describe('adding a permit', () => {
  const openDialog = async () => {
    render(<Harness />);
    await screen.findByTestId(`permit-${PERMIT}`);
    press(screen.getByRole('button', { name: 'Add permit' }));
    return screen.findByRole('dialog', { name: 'Add permit' });
  };

  it('announces what is missing in one alert and creates nothing', async () => {
    const dialog = await openDialog();
    press(within(dialog).getByRole('button', { name: 'Save permit' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Enter who issued the permit');
    expect(alert).toHaveTextContent('Choose at least one venue or field');
    expect(rpc.mock.calls.filter(([name]) => name === 'admin_create_facility_permit')).toHaveLength(
      0
    );
  });

  it('returns focus to the Add permit button when the dialog is cancelled', async () => {
    const dialog = await openDialog();
    press(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add permit' })).toHaveFocus());
  });

  it('refuses a 12 MiB file the moment it is chosen, before anything is sent', async () => {
    const dialog = await openDialog();
    const input = within(dialog).getByLabelText(/The permit document/);
    fireEvent.change(input, { target: { files: [pdfFile('big.pdf', 12 * 1024 * 1024)] } });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('over 10 MB');
    expect(upload).not.toHaveBeenCalled();
    expect(rpc.mock.calls.filter(([name]) => name.startsWith('admin_'))).toHaveLength(0);
  });

  it('refuses a file that is not what it says it is', async () => {
    const dialog = await openDialog();
    const fake = new File([new TextEncoder().encode('<html>')], 'permit.pdf', {
      type: 'application/pdf',
    });
    fireEvent.change(within(dialog).getByLabelText(/The permit document/), {
      target: { files: [fake] },
    });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('not a real PDF');
  });

  it('creates the permit, uploads the file under its folder, and attaches it', async () => {
    rpc.mockImplementation(async (name, args) => {
      if (name === 'get_facility_permits') return readOk();
      if (name === 'admin_create_facility_permit')
        return { data: permit({ id: NEW_PERMIT, file: null }), error: null };
      if (name === 'admin_set_facility_permit_file')
        return { data: { permit: permit({ id: NEW_PERMIT }), previous_path: null }, error: null };
      throw new Error(`unexpected rpc ${name} ${JSON.stringify(args)}`);
    });
    const dialog = await openDialog();
    typeInto(within(dialog).getByLabelText(/Issued by/), 'City Parks');
    fireEvent.change(within(dialog).getByLabelText(/Valid from/), {
      target: { value: '2026-10-01' },
    });
    fireEvent.change(within(dialog).getByLabelText(/Valid through/), {
      target: { value: '2027-10-01' },
    });
    press(within(dialog).getByLabelText('Permit Park, Pitch 1'));
    fireEvent.change(within(dialog).getByLabelText(/The permit document/), {
      target: { files: [pdfFile()] },
    });
    // Save waits while the file's first bytes are read.
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Save permit' })).toBeEnabled()
    );
    press(within(dialog).getByRole('button', { name: 'Save permit' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const create = rpc.mock.calls.find(([name]) => name === 'admin_create_facility_permit')[1];
    expect(create).toMatchObject({
      p_organization_id: ORG,
      p_issuer: 'City Parks',
      p_field_ids: [FIELD],
      p_location_ids: [],
    });
    const path = upload.mock.calls[0][0];
    expect(path).toMatch(new RegExp(`^${ORG}/${NEW_PERMIT}/[0-9a-f-]{36}\\.pdf$`));
  });

  it('keeps the permit and says so when only the file failed to upload', async () => {
    upload.mockResolvedValue({
      data: null,
      error: { message: 'The object exceeded the maximum allowed size' },
    });
    rpc.mockImplementation(async (name) => {
      if (name === 'get_facility_permits') return readOk();
      if (name === 'admin_create_facility_permit')
        return { data: permit({ id: NEW_PERMIT, file: null }), error: null };
      throw new Error(`unexpected rpc ${name}`);
    });
    const dialog = await openDialog();
    typeInto(within(dialog).getByLabelText(/Issued by/), 'City Parks');
    fireEvent.change(within(dialog).getByLabelText(/Valid from/), {
      target: { value: '2026-10-01' },
    });
    fireEvent.change(within(dialog).getByLabelText(/Valid through/), {
      target: { value: '2027-10-01' },
    });
    press(within(dialog).getByLabelText('Permit Park, Pitch 1'));
    fireEvent.change(within(dialog).getByLabelText(/The permit document/), {
      target: { files: [pdfFile()] },
    });
    // Save waits while the file's first bytes are read.
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Save permit' })).toBeEnabled()
    );
    press(within(dialog).getByRole('button', { name: 'Save permit' }));
    const alert = await screen.findByText(/The permit was saved, but its file was not/);
    expect(alert).toHaveAttribute('role', 'alert');
  });
});

describe('a file', () => {
  it('says why when storage refuses the upload (a demo league keeps no files)', async () => {
    upload.mockResolvedValue({
      data: null,
      error: { statusCode: '403', message: 'new row violates row-level security policy' },
    });
    render(<Harness />);
    const item = await screen.findByTestId(`permit-${PERMIT}`);
    fireEvent.change(item.querySelector('input[type="file"]'), {
      target: { files: [pdfFile('new.pdf')] },
    });
    const alert = await screen.findByText(/A demo league keeps no files/);
    expect(alert).toHaveAttribute('role', 'alert');
    expect(
      rpc.mock.calls.filter(([name]) => name === 'admin_set_facility_permit_file')
    ).toHaveLength(0);
  });

  it('removes the upload when the attach fails, so no orphan stays', async () => {
    rpc.mockImplementation(async (name) => {
      if (name === 'get_facility_permits') return readOk();
      if (name === 'admin_set_facility_permit_file')
        return { data: null, error: { message: 'no uploaded object' } };
      throw new Error(`unexpected rpc ${name}`);
    });
    render(<Harness />);
    const item = await screen.findByTestId(`permit-${PERMIT}`);
    const input = item.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [pdfFile('new.pdf')] } });
    expect(
      await screen.findByText(/The file could not be attached: no uploaded object/)
    ).toHaveAttribute('role', 'alert');
    const uploaded = upload.mock.calls[0][0];
    expect(remove).toHaveBeenCalledWith([uploaded]);
  });

  it('removes the replaced object after the replace commits', async () => {
    const previous = permit().file.path;
    rpc.mockImplementation(async (name) => {
      if (name === 'get_facility_permits') return readOk();
      if (name === 'admin_set_facility_permit_file')
        return { data: { permit: permit(), previous_path: previous }, error: null };
      throw new Error(`unexpected rpc ${name}`);
    });
    render(<Harness />);
    const item = await screen.findByTestId(`permit-${PERMIT}`);
    fireEvent.change(item.querySelector('input[type="file"]'), {
      target: { files: [pdfFile('new.pdf')] },
    });
    await screen.findByText(/Replaced the file for the permit from Parks Dept/);
    expect(remove).toHaveBeenCalledWith([previous]);
  });

  it('announces a failed signed link and closes the tab it opened', async () => {
    createSignedUrl.mockResolvedValue({ data: null, error: { message: 'Object not found' } });
    const tab = { close: vi.fn(), location: { href: '' }, opener: {} };
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(/** @type {any} */ (tab));
    render(<Harness />);
    const item = await screen.findByTestId(`permit-${PERMIT}`);
    press(within(item).getByRole('button', { name: /Open the file/ }));
    expect(
      await screen.findByText(/The file could not be opened: Object not found/)
    ).toHaveAttribute('role', 'alert');
    expect(tab.close).toHaveBeenCalled();
    expect(createSignedUrl).toHaveBeenCalledWith(permit().file.path, 120, undefined);
    openSpy.mockRestore();
  });

  it('opens the signed link in the tab opened on the tap', async () => {
    createSignedUrl.mockResolvedValue({
      data: { signedUrl: 'https://signed.example/x' },
      error: null,
    });
    const tab = { close: vi.fn(), location: { href: '' }, opener: {} };
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(/** @type {any} */ (tab));
    render(<Harness />);
    const item = await screen.findByTestId(`permit-${PERMIT}`);
    press(within(item).getByRole('button', { name: /Open the file/ }));
    await waitFor(() => expect(tab.location.href).toBe('https://signed.example/x'));
    expect(tab.opener).toBeNull();
    openSpy.mockRestore();
  });
});

describe('deleting a permit', () => {
  it('asks first, removes the file after the row goes, and puts focus on Add permit', async () => {
    rpc.mockImplementation(async (name) => {
      if (name === 'get_facility_permits') return readOk();
      if (name === 'admin_delete_facility_permit') {
        permits = []; // the row is gone when the list is read again
        return { data: { id: PERMIT, deleted: true, file_path: permit().file.path }, error: null };
      }
      throw new Error(`unexpected rpc ${name}`);
    });
    render(<Harness />);
    const item = await screen.findByTestId(`permit-${PERMIT}`);
    press(within(item).getByRole('button', { name: /Delete the permit from Parks Dept/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete permit' });
    expect(rpc.mock.calls.filter(([name]) => name === 'admin_delete_facility_permit')).toHaveLength(
      0
    );
    press(within(dialog).getByRole('button', { name: 'Delete permit' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith([permit().file.path]));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add permit' })).toHaveFocus());
  });

  it('keeps the permit when Cancel is chosen', async () => {
    render(<Harness />);
    const item = await screen.findByTestId(`permit-${PERMIT}`);
    press(within(item).getByRole('button', { name: /Delete the permit from Parks Dept/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete permit' });
    press(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(rpc.mock.calls.filter(([name]) => name === 'admin_delete_facility_permit')).toHaveLength(
      0
    );
    expect(screen.getByTestId(`permit-${PERMIT}`)).toBeInTheDocument();
  });
});
