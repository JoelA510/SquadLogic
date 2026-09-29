import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';

const { Given, When, Then } = createBdd();

const seedDatabase = async (page: Page) => {
  await page.addInitScript(() => {
    type MockTable = Array<Record<string, unknown>>;
    type MockDb = Record<string, MockTable>;
    const db = ((window as { __MOCK_DB__?: MockDb }).__MOCK_DB__ || {}) as MockDb;
    const orgId = localStorage.getItem('squadlogic_active_org') || 'org-1';
    db.organizations = db.organizations || [];
    if (!db.organizations.find((o: Record<string, unknown>) => o.id === orgId)) {
      db.organizations.push({ id: orgId, name: 'Test Org', is_onboarded: true });
    }

    db.season_settings = db.season_settings || [];
    if (!db.season_settings.find((s: Record<string, unknown>) => s.name === 'Fall 2026')) {
      db.season_settings.push({
        id: 'season-fall-26',
        organization_id: orgId,
        name: 'Fall 2026',
        status: 'active',
        timezone: 'America/Los_Angeles',
        created_at: new Date().toISOString(),
      });
    }

    db.registration_forms = db.registration_forms || [];
    if (
      !db.registration_forms.find((f: Record<string, unknown>) => f.title === 'Fall Registration')
    ) {
      db.registration_forms.push({
        id: 'f-fall',
        title: 'Fall Registration',
        organization_id: orgId,
        status: 'active',
        fields: [{ label: 'Emergency Contact', type: 'text', required: true }],
      });
    }

    db.registrations = db.registrations || [];
    if (!db.registrations.find((r: Record<string, unknown>) => r.id === 'reg-alex')) {
      db.registrations.push({
        id: 'reg-alex',
        organization_id: orgId,
        form_id: 'f-fall',
        player_id: 'player-1',
        profile_id: 'mock-parent-id',
        medical_cleared: false,
        waiver_signed: true,
        created_at: new Date().toISOString(),
      });

      db.players = db.players || [];
      if (!db.players.find((p: Record<string, unknown>) => p.id === 'player-1')) {
        db.players.push({
          id: 'player-1',
          first_name: 'Alex',
          last_name: 'Smith',
          organization_id: orgId,
        });
      }

      db.profile_players = db.profile_players || [];
      if (!db.profile_players.find((pp: Record<string, unknown>) => pp.player_id === 'player-1')) {
        db.profile_players.push({
          profile_id: 'mock-parent-id',
          player_id: 'player-1',
        });
      }
    }

    (window as { __MOCK_DB__?: unknown }).__MOCK_DB__ = db;
    sessionStorage.setItem('__MOCK_DB__', JSON.stringify(db));
    localStorage.setItem('squadlogic_active_org', orgId);
  });
};

Given('there is an active season {string}', async ({ page }, _seasonName: string) => {
  await seedDatabase(page);
});

When(
  'I create a new form for {string} titled {string}',
  async ({ page }, seasonName: string, formTitle: string) => {
    await page
      .getByRole('button', { name: /Create Form|New Form/i })
      .first()
      .click({ force: true });
    await page
      .getByLabel(/Form Title|Title/i)
      .first()
      .fill(formTitle);
    // Use the combobox role so the top bar's "Active Season" switcher
    // (a button) is never matched.
    const seasonSelect = page.getByRole('combobox', { name: /Season/i }).first();
    if (await seasonSelect.isVisible().catch(() => false)) {
      await seasonSelect.selectOption({ label: seasonName });
    }
    await page
      .getByLabel(/Description/i)
      .first()
      .fill('Test description');
  }
);

When('I add a custom text field labeled {string}', async ({ page }, fieldLabel: string) => {
  await page
    .getByRole('button', { name: /Add Field/i })
    .first()
    .click({ force: true });
  const lastField = page.locator('.form-field-editor').last();
  await lastField.getByLabel(/Label/i).first().fill(fieldLabel);
  await lastField.getByLabel(/Type/i).first().selectOption('text');
});

When(
  'I add a custom {string} field labeled {string}',
  async ({ page }, fieldType: string, fieldLabel: string) => {
    await page
      .getByRole('button', { name: /Add Field/i })
      .first()
      .click({ force: true });
    const lastField = page.locator('.form-field-editor').last();
    await lastField.getByLabel(/Label/i).first().fill(fieldLabel);
    await lastField
      .getByLabel(/Type/i)
      .first()
      .selectOption({ label: fieldType.charAt(0).toUpperCase() + fieldType.slice(1) });
  }
);

Given('I navigate to the compliance dashboard', async ({ page }) => {
  await seedDatabase(page);
  await page.goto('/admin/compliance');
  await page.waitForSelector('table tbody tr:not(:has-text("Loading"))', { timeout: 10000 });
});

When('I save the form', async ({ page }) => {
  await page
    .getByRole('button', { name: /Save Form/i })
    .first()
    .click({ force: true });
  await page
    .getByText(/Form saved successfully|Success/i)
    .first()
    .waitFor();
});

Then('the form {string} should appear in the forms list', async ({ page }, formTitle: string) => {
  await expect(page.locator('table').first()).toContainText(formTitle);
});

Given('I navigate to the registration link for {string}', async ({ page }, _formTitle: string) => {
  await seedDatabase(page);
  await page.goto('/register/f-fall');
  await page.waitForLoadState('networkidle');
});

When('I select my child {string}', async ({ page }, childName: string) => {
  await page.waitForTimeout(1000);
  await page
    .getByRole('button', { name: new RegExp(childName, 'i') })
    .first()
    .click({ force: true });
  await page
    .getByRole('button', { name: /Next Step/i })
    .first()
    .click({ force: true });
});

When(
  'I fill out the custom field {string} with {string}',
  async ({ page }, fieldLabel: string, value: string) => {
    await page.getByLabel(new RegExp(fieldLabel, 'i')).first().fill(value);
  }
);

When('I agree to the waiver', async ({ page }) => {
  const nextBtn = page.getByRole('button', { name: /Next Step/i }).first();
  if (await nextBtn.isVisible()) {
    await nextBtn.click({ force: true });
  }
  await page.evaluate(() => {
    const cb = document.querySelector('#waiver') as HTMLInputElement;
    if (cb && !cb.checked) cb.click();
  });
});

When('I submit the registration', async ({ page }) => {
  await page
    .getByRole('button', { name: /Complete Registration|Submit/i })
    .first()
    .click({ force: true });
  await page.waitForLoadState('networkidle');
});

Then('I should see a success message', async ({ page }) => {
  await expect(
    page.getByRole('heading', { name: /Registration Complete|Success/i }).first()
  ).toBeVisible();
});

When('I filter for {string}', async ({ page }, formTitle: string) => {
  await expect(
    page.locator('select#form-filter option', { hasText: formTitle }).first()
  ).toBeAttached({ timeout: 10000 });
  // Target the select directly — loose label regexes can collide with the
  // roster-compliance toggle aria-labels ("medical form received for ...").
  await page.locator('select#form-filter').selectOption({ label: formTitle });
});

Then('I should see a registration for {string}', async ({ page }, childName: string) => {
  await expect(page.getByRole('cell', { name: new RegExp(childName, 'i') }).first()).toBeVisible();
});

Then('the waiver status should be {string}', async ({ page }, status: string) => {
  // Scope to the registrations table (the roster-compliance grid above also
  // has rows containing "Alex").
  const regTable = page
    .getByRole('table')
    .filter({ has: page.getByText('Waiver Signed') })
    .first();
  const row = regTable.getByRole('row').filter({ hasText: 'Alex' }).first();
  const expectedText = status.toLowerCase() === 'signed' ? 'Confirmed' : 'Pending';

  // CRITICAL FIX: Target the specific UI badge and verify its semantic color class
  const badge = row
    .locator('span')
    .filter({ hasText: new RegExp(expectedText, 'i') })
    .first();
  await expect(badge).toBeVisible();

  if (expectedText === 'Confirmed') {
    await expect(badge).toHaveClass(/text-status-success/);
  } else {
    await expect(badge).toHaveClass(/text-status-warning/);
  }
});

Then('the medical status should be {string}', async ({ page }, status: string) => {
  const uiStatus = status === 'Pending' ? 'Reviewing' : status;
  const regTable = page
    .getByRole('table')
    .filter({ has: page.getByText('Waiver Signed') })
    .first();
  const row = regTable.getByRole('row').filter({ hasText: 'Alex' }).first();

  // CRITICAL FIX: Target the specific interactive button and verify its state
  const button = row.getByRole('button', { name: new RegExp(uiStatus, 'i') }).first();
  await expect(button).toBeVisible();

  if (uiStatus === 'Reviewing') {
    await expect(button).toHaveClass(/text-text-muted/);
  } else {
    await expect(button).toHaveClass(/text-white/);
  }
});
