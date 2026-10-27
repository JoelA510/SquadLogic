/**
 * Steps for real_backend_permits.feature (plan docs/changes/2026-10-22-phase-c-permits.md, C3, as
 * docs/changes/2026-10-27-admin-only.md made it the admins'): field permits on the local stack. The
 * people are the permit league's three (tests/e2e/real-backend/seed.sql): an administrator, a staff
 * member (an admin too) and an account with no membership. Each calls the stack's own APIs with their own session, so the RLS and
 * Storage policies judge every read, as they do the app's; the last step drives the page.
 *
 * Statically reviewed, not run: no Docker or Supabase CLI was available where this was written, so
 * it has not met a real stack. The workflow that runs it is .github/workflows/e2e-real-backend.yml.
 * What it settles that only a real stack can: that hosted Storage enforces `allowed_mime_types` from
 * the declared type, and that signing a link needs the caller's SELECT policy (plan, "Investigation
 * notes").
 */
import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';

const { Given, When, Then } = createBdd();

const BACKEND_TIMEOUT = 120_000;
const PASSWORD = 'e2e-local-only-password';
const ORG = 'e2e0b000-0000-4000-8000-000000000002';
const PERMIT_PITCH = 'e2e0f000-0000-4000-8000-000000000003';
const PEOPLE = {
  admin: { email: 'e2e-permits-admin@example.test', id: 'e2e0a000-0000-4000-8000-000000000002' },
  staff: { email: 'e2e-permits-staff@example.test', id: 'e2e0a000-0000-4000-8000-000000000003' },
  member: { email: 'e2e-permits-member@example.test', id: 'e2e0a000-0000-4000-8000-000000000004' },
} as const;
type Person = keyof typeof PEOPLE;

const state = new WeakMap<Page, { permitId?: string; path?: string }>();
const stateOf = (page: Page) => {
  const current = state.get(page) ?? {};
  state.set(page, current);
  return current;
};

function stackUrl(): string {
  const url = process.env.E2E_REAL_BACKEND_SUPABASE_URL?.replace(/\/+$/, '');
  if (!url) throw new Error('E2E_REAL_BACKEND_SUPABASE_URL is not set');
  return url;
}
const anonKey = () => process.env.E2E_REAL_BACKEND_ANON_KEY ?? '';

/** The day `days` from today in the permit league's own zone (its season is Los Angeles). */
const dayPlus = (days: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(
    new Date(Date.now() + days * 86_400_000)
  );

const sessions = new WeakMap<Page, Partial<Record<Person, string>>>();
/** A person's access token, by the auth API with the seed's password; one sign-in each per scenario. */
async function tokenOf(page: Page, who: Person): Promise<string> {
  const cached = sessions.get(page)?.[who];
  if (cached) return cached;
  const response = await page.request.post(`${stackUrl()}/auth/v1/token?grant_type=password`, {
    headers: { apikey: anonKey(), 'Content-Type': 'application/json' },
    data: { email: PEOPLE[who].email, password: PASSWORD },
    timeout: BACKEND_TIMEOUT,
  });
  const body = (await response.json()) as { access_token?: string; user?: { id?: string } };
  expect(response.status(), JSON.stringify(body)).toBe(200);
  expect(body.user?.id, `the session is ${who}`).toBe(PEOPLE[who].id);
  const token = body.access_token ?? '';
  sessions.set(page, { ...(sessions.get(page) ?? {}), [who]: token });
  return token;
}

const authHeaders = (token: string) => ({ apikey: anonKey(), Authorization: `Bearer ${token}` });

const PDF = Buffer.from('%PDF-1.4\n% an invented permit, example data only\n%%EOF\n', 'utf8');

/** `POST /storage/v1/object/sign/...` as `who`; the response status and, if made, the full link. */
async function signLink(page: Page, who: Person, path: string) {
  const response = await page.request.post(
    `${stackUrl()}/storage/v1/object/sign/facility-permits/${path}`,
    {
      headers: { ...authHeaders(await tokenOf(page, who)), 'Content-Type': 'application/json' },
      data: { expiresIn: 120 },
      timeout: BACKEND_TIMEOUT,
    }
  );
  const body = (await response.json().catch(() => ({}))) as { signedURL?: string };
  return {
    status: response.status(),
    link: body.signedURL ? `${stackUrl()}/storage/v1${body.signedURL}` : null,
    body,
  };
}

Given(
  "the permit league's administrator has recorded a permit with a PDF for a field",
  async ({ page }) => {
    const admin = await tokenOf(page, 'admin');
    const created = await page.request.post(
      `${stackUrl()}/rest/v1/rpc/admin_create_facility_permit`,
      {
        headers: authHeaders(admin),
        data: {
          p_organization_id: ORG,
          p_issuer: 'Example City Parks (E2E)',
          p_permit_number: '0042',
          p_valid_from: dayPlus(-30),
          p_valid_to: dayPlus(12),
          p_notes: null,
          p_location_ids: [],
          p_field_ids: [PERMIT_PITCH],
        },
        timeout: BACKEND_TIMEOUT,
      }
    );
    const permit = (await created.json()) as { id?: string };
    expect(created.status(), JSON.stringify(permit)).toBe(200);
    expect(permit.id, 'the permit was created').toBeTruthy();

    const path = `${ORG}/${permit.id}/c0000000-0000-4000-8000-0000000000e2.pdf`;
    const uploaded = await page.request.post(
      `${stackUrl()}/storage/v1/object/facility-permits/${path}`,
      {
        headers: { ...authHeaders(admin), 'Content-Type': 'application/pdf', 'x-upsert': 'false' },
        data: PDF,
        timeout: BACKEND_TIMEOUT,
      }
    );
    expect(uploaded.status(), await uploaded.text()).toBe(200);

    const attached = await page.request.post(
      `${stackUrl()}/rest/v1/rpc/admin_set_facility_permit_file`,
      {
        headers: authHeaders(admin),
        data: {
          p_organization_id: ORG,
          p_permit_id: permit.id,
          p_object_path: path,
          p_file_name: 'permit.pdf',
        },
        timeout: BACKEND_TIMEOUT,
      }
    );
    expect(attached.status(), await attached.text()).toBe(200);
    Object.assign(stateOf(page), { permitId: permit.id, path });
  }
);

Then(
  'the administrator and the staff member can make a signed link to the file, and the link returns the PDF',
  async ({ page }) => {
    const { path } = stateOf(page);
    expect(path, 'the permit step ran').toBeTruthy();
    const asAdmin = await signLink(page, 'admin', path as string);
    expect(asAdmin.status, JSON.stringify(asAdmin.body)).toBe(200);
    const signed = await signLink(page, 'staff', path as string);
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    expect(signed.link, 'a link was made').not.toBeNull();
    // The link carries its own token: fetched with no session at all, as a new tab would.
    const file = await page.request.get(signed.link as string, { timeout: BACKEND_TIMEOUT });
    expect(file.status()).toBe(200);
    expect((await file.body()).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  }
);

Then('an account with no membership cannot make a signed link to it', async ({ page }) => {
  const { path } = stateOf(page);
  const signed = await signLink(page, 'member', path as string);
  // Storage answers a missing or unreadable object with a 4xx and no link; which 4xx is its own.
  expect(signed.status, JSON.stringify(signed.body)).toBeGreaterThanOrEqual(400);
  expect(signed.status).toBeLessThan(500);
  expect(signed.link, 'no link was made').toBeNull();
  // And the permits are refused to them, not shown empty.
  const read = await page.request.post(`${stackUrl()}/rest/v1/rpc/get_facility_permits`, {
    headers: authHeaders(await tokenOf(page, 'member')),
    data: { p_organization_id: ORG },
    timeout: BACKEND_TIMEOUT,
  });
  expect(read.status()).toBeGreaterThanOrEqual(400);
});

Then('the bucket refuses a file declared as text\\/html', async ({ page }) => {
  const { permitId } = stateOf(page);
  const refused = `${ORG}/${permitId}/c0000000-0000-4000-8000-0000000000e3.pdf`;
  const response = await page.request.post(
    `${stackUrl()}/storage/v1/object/facility-permits/${refused}`,
    {
      headers: {
        ...authHeaders(await tokenOf(page, 'admin')),
        'Content-Type': 'text/html',
        'x-upsert': 'false',
      },
      data: Buffer.from('<html><body>not a permit</body></html>', 'utf8'),
      timeout: BACKEND_TIMEOUT,
    }
  );
  expect(response.status(), await response.text()).toBeGreaterThanOrEqual(400);
  expect(response.status()).toBeLessThan(500);
  // Nothing was stored under that name: not even the administrator can sign a link to it.
  const signed = await signLink(page, 'admin', refused);
  expect(signed.link, 'no object exists under the refused name').toBeNull();
});

When('the administrator signs in', async ({ page }) => {
  await page.goto('/');
  await page.locator('#email').fill(PEOPLE.admin.email);
  await page.locator('#password').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page.locator('#password')).toHaveCount(0, { timeout: 30_000 });
});

Then(
  'the permits page lists the permit, and opens its file through a signed link',
  async ({ page }) => {
    await page
      .locator('aside')
      .getByRole('link', { name: /^Field Permits/ })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'Field permits' })).toBeVisible({
      timeout: 30_000,
    });
    const item = page.getByTestId('permits-page-list').getByRole('listitem');
    await expect(item).toContainText('Example City Parks (E2E)', { timeout: 30_000 });
    await expect(item).toContainText('0042');
    await expect(item).toContainText(/Expires in 1[1-3] days/);
    // The new tab is sent to the signed link. Where the browser has no PDF viewer (the headless
    // shell CI uses) the navigation becomes a download and the tab stays `about:blank`, so the tab's
    // address is not what is read: the request the tab makes to the signed link, and Storage's
    // answer to it, are.
    const signed = page.context().waitForEvent('request', {
      predicate: (request) =>
        request.method() === 'GET' &&
        /\/storage\/v1\/object\/sign\/facility-permits\/.+\?token=/.test(request.url()),
      timeout: 30_000,
    });
    await Promise.all([
      page.waitForEvent('popup', { timeout: 30_000 }),
      page
        .getByRole('button', { name: /^Open the file for the permit from Example City Parks/ })
        .click(),
    ]);
    const request = await signed;
    const response = await request.response();
    expect(response?.status(), 'Storage answered the signed link').toBe(200);
    await expect(page.getByRole('alert')).toHaveCount(0);
  }
);
