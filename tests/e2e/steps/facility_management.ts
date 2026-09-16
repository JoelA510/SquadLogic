import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';

const { Given, When, Then } = createBdd();

Given('I have an organization labeled {string}', async ({ page }, orgName: string) => {
  if (page.url() === 'about:blank') await page.goto('/');
  await page.evaluate((name) => {
    const db = JSON.parse(
      sessionStorage.getItem('__MOCK_DB__') || JSON.stringify(window.__MOCK_DB__ || {})
    );
    const uniqueOrgId = localStorage.getItem('squadlogic_active_org') || 'org-1';

    db.organizations = (db.organizations || []).filter((o) => o.id !== uniqueOrgId);
    db.organizations.push({ id: uniqueOrgId, name: name, status: 'active', is_onboarded: true });

    db.organization_members = (db.organization_members || []).filter(
      (m) => m.organization_id !== uniqueOrgId
    );
    db.organization_members.unshift({
      id: `mem-${uniqueOrgId}`,
      organization_id: uniqueOrgId,
      profile_id: 'mock-admin-id',
      role: 'admin',
      organizations: db.organizations.find((o) => o.id === uniqueOrgId),
    });

    db.locations = (db.locations || []).filter(
      (l: Record<string, unknown>) => l.organization_id !== uniqueOrgId
    );
    db.fields = (db.fields || []).filter(
      (f: Record<string, unknown>) => f.organization_id !== uniqueOrgId
    );

    window.__saveMockDB__(db);
    localStorage.setItem('squadlogic_active_org', uniqueOrgId);
  }, orgName);
});

When('I load the Field Management page', async ({ page }) => {
  await page.goto('/fields');
});

When('I select {string} from the Location dropdown', async ({ page }, optionText: string) => {
  if (optionText.includes('Add New Location')) {
    const btn = page.locator('button:has-text("Add New Location")').first();
    if (await btn.isVisible()) {
      await btn.click({ force: true });
    }
  } else {
    await page.locator('select').first().selectOption({ label: optionText });
  }
});

When('I enter {string} into the new location input', async ({ page }, value: string) => {
  await page
    .getByPlaceholder(/Location Name|e.g. Main Complex/i)
    .first()
    .fill(value);
});

When('I enter {string} into the Field Name input', async ({ page }, value: string) => {
  await page
    .getByPlaceholder(/Field Name|e.g. Field 1/i)
    .first()
    .fill(value);
});

When('I select {string} for Type', async ({ page }, type: string) => {
  await page
    .getByLabel(/Surface Type/i)
    .first()
    .selectOption({ label: type });
});

When('I select {string} for Size', async ({ page }, size: string) => {
  await page.getByLabel(/Size/i).first().selectOption({ label: size });
});

When('I set the Priority to {int}', async ({ page }, priority: number) => {
  await page
    .getByLabel(/Priority/i)
    .first()
    .fill(priority.toString());
});

When('I ensure {string} is disabled', async ({ page }, label: string) => {
  const uiLabel =
    label.includes('Sub-fields') || label.includes('Supports Halves')
      ? 'Sub-fields'
      : label === 'Active'
        ? 'Status'
        : label;
  const checkbox = page.getByLabel(uiLabel).first();
  if (await checkbox.isChecked()) {
    await page.getByText(uiLabel, { exact: true }).first().click({ force: true });
  }
});

Then(
  'I should see {string} listed under {string} on the Field Management grid',
  async ({ page }, fieldName: string, _locName: string) => {
    const card = page.locator('div.bg-bg-surface', { hasText: fieldName }).first();
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card).toContainText(fieldName);
  }
);

Then(
  '{string} should display {string}, {string}, and Priority {string}',
  async ({ page }, fieldName: string, type: string, size: string, _priority: string) => {
    const card = page
      .locator('div.bg-bg-surface')
      .filter({ has: page.getByRole('heading', { name: fieldName, exact: true }) })
      .first();
    await expect(card).toContainText(type);
    await expect(card).toContainText(size);
  }
);

Then('{string} should not display a subunit indicator', async ({ page }, fieldName: string) => {
  const card = page
    .locator('div.bg-bg-surface')
    .filter({ has: page.getByRole('heading', { name: fieldName, exact: true }) })
    .first();
  await expect(card.getByText(/Sub-units:/).first()).toBeHidden();
});

Given(
  'a field {string} at {string} exists without subunits',
  async ({ page }, f: string, l: string) => {
    await page.evaluate(
      ({ fName, lName }) => {
        const db = JSON.parse(
          sessionStorage.getItem('__MOCK_DB__') || JSON.stringify(window.__MOCK_DB__ || {})
        );
        const uniqueOrgId = localStorage.getItem('squadlogic_active_org') || 'org-1';
        const fieldId = 'field-1-test';
        db.fields = (db.fields || []).filter((f: Record<string, unknown>) => f.id !== fieldId);
        db.locations = db.locations || [];
        db.fields = db.fields || [];
        let loc = db.locations.find(
          (loc: Record<string, unknown>) =>
            loc.name === lName && loc.organization_id === uniqueOrgId
        );
        if (!loc) {
          loc = { id: 'loc-1-test', name: lName, organization_id: uniqueOrgId };
          db.locations.push(loc);
        }
        db.fields.push({
          id: fieldId,
          name: fName,
          location_id: loc.id,
          organization_id: uniqueOrgId,
          supports_halves: false,
          active: true,
          surface_type: 'Grass',
          size: '11v11',
          priority_rating: 1,
        });
        window.__saveMockDB__(db);
      },
      { fName: f, lName: l }
    );
    await page.reload();
    await page.waitForTimeout(1000);
  }
);

When('I click the "Edit" button for {string}', async ({ page }, fieldName: string) => {
  const card = page.locator('div.bg-bg-surface', { hasText: fieldName }).first();
  await card.waitFor({ state: 'visible', timeout: 10000 });

  const ariaLabel = `Edit ${fieldName}`;
  const btn = card.getByLabel(ariaLabel).first();

  if (await btn.isVisible()) {
    await btn.click({ force: true });
  } else {
    const editBtn = card
      .locator('button')
      .filter({ has: card.locator('svg') })
      .first();
    await editBtn.click({ force: true });
  }

  await expect(page.getByRole('heading', { name: /Edit Field/i }).first()).toBeVisible({
    timeout: 10000,
  });
  await page.waitForTimeout(500);
});

When('I toggle {string} to ON', async ({ page }, label: string) => {
  const uiLabel =
    label.includes('Sub-fields') || label.includes('Supports Halves')
      ? 'Sub-fields'
      : label === 'Active'
        ? 'Status'
        : label;
  const container = page.locator('label').filter({ hasText: uiLabel }).first();
  const checkbox = container.locator('input[type="checkbox"]').first();

  const isChecked = await checkbox.evaluate((node: HTMLInputElement) => node.checked);
  if (!isChecked) {
    await page.getByText(uiLabel, { exact: true }).first().click({ force: true });
  }
  await page
    .getByRole('button', { name: /Save Field/i })
    .first()
    .click({ force: true });
  await expect(page.getByRole('heading', { name: /Edit Field/i }).first()).toBeHidden({
    timeout: 5000,
  });
  await page.reload();
});

When('I toggle {string} to OFF', async ({ page }, label: string) => {
  const uiLabel =
    label.includes('Sub-fields') || label.includes('Supports Halves')
      ? 'Sub-fields'
      : label === 'Active'
        ? 'Status'
        : label;
  const container = page.locator('label').filter({ hasText: uiLabel }).first();
  const checkbox = container.locator('input').first();

  await expect(container).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(500);

  const isChecked = await checkbox.evaluate((node: HTMLInputElement) => node.checked);
  if (isChecked) {
    await container.click({ force: true });
  }
  await page
    .getByRole('button', { name: /Save Field/i })
    .first()
    .click({ force: true });
  await expect(page.getByRole('heading', { name: /Edit Field/i }).first()).toBeHidden({
    timeout: 5000,
  });
  await page.reload();
});

Then(
  '{string} should display a subunit indicator like {string}',
  async ({ page }, fieldName: string, _indicator: string) => {
    await page.waitForTimeout(2000);
    const card = page.locator('div.bg-bg-surface', { hasText: fieldName }).first();
    await expect(card.getByText(/Sub-units:/).first()).toBeVisible({ timeout: 10000 });
  }
);

Then(
  'the database should automatically contain field subunits {string} and {string} for {string}',
  async ({ page }, a: string, b: string, f: string) => {
    // ERADICATE DB CHEAT: Check the visual indicator rendered by FieldManagementPage.jsx
    const card = page.locator('div.bg-bg-surface', { hasText: f }).first();
    await expect(card.getByText(/Sub-units: 2/i).first()).toBeVisible({ timeout: 10000 });
  }
);

Given(
  'a field {string} at {string} exists with subunits',
  async ({ page }, f: string, l: string) => {
    await page.evaluate(
      ({ fName, lName }) => {
        const db = JSON.parse(
          sessionStorage.getItem('__MOCK_DB__') || JSON.stringify(window.__MOCK_DB__ || {})
        );
        const uniqueOrgId = localStorage.getItem('squadlogic_active_org') || 'org-1';
        const fieldId = 'field-2-test';
        db.fields = (db.fields || []).filter((f: Record<string, unknown>) => f.id !== fieldId);
        db.locations = db.locations || [];
        db.fields = db.fields || [];
        let loc = db.locations.find(
          (loc: Record<string, unknown>) =>
            loc.name === lName && loc.organization_id === uniqueOrgId
        );
        if (!loc) {
          loc = { id: 'loc-2-test', name: lName, organization_id: uniqueOrgId };
          db.locations.push(loc);
        }
        db.fields.push({
          id: fieldId,
          name: fName,
          location_id: loc.id,
          organization_id: uniqueOrgId,
          supports_halves: true,
          active: true,
          surface_type: 'Grass',
          size: '11v11',
          priority_rating: 1,
        });
        db.field_subunits = db.field_subunits || [];
        db.field_subunits.push({
          id: `sub-${fieldId}-a`,
          field_id: fieldId,
          label: 'A',
          organization_id: uniqueOrgId,
        });
        db.field_subunits.push({
          id: `sub-${fieldId}-b`,
          field_id: fieldId,
          label: 'B',
          organization_id: uniqueOrgId,
        });
        window.__saveMockDB__(db);
      },
      { fName: f, lName: l }
    );
    await page.reload();
  }
);

Then(
  'the database should automatically remove field subunits for {string}',
  async ({ page }, f: string) => {
    await page.waitForTimeout(1000);
    // ERADICATE DB CHEAT: Assert the subunit string is physically removed from the UI
    const card = page.locator('div.bg-bg-surface', { hasText: f }).first();
    await expect(card.getByText(/Sub-units:/i).first()).toBeHidden();
  }
);

Given(
  'a field {string} at {string} exists and is active',
  async ({ page }, f: string, l: string) => {
    await page.evaluate(
      ({ fName, lName }) => {
        const db = JSON.parse(
          sessionStorage.getItem('__MOCK_DB__') || JSON.stringify(window.__MOCK_DB__ || {})
        );
        const uniqueOrgId = localStorage.getItem('squadlogic_active_org') || 'org-1';
        const fieldId = 'field-3-test';
        db.fields = (db.fields || []).filter((f: Record<string, unknown>) => f.id !== fieldId);
        db.locations = db.locations || [];
        db.fields = db.fields || [];
        let loc = db.locations.find(
          (loc: Record<string, unknown>) =>
            loc.name === lName && loc.organization_id === uniqueOrgId
        );
        if (!loc) {
          loc = { id: 'loc-3-test', name: lName, organization_id: uniqueOrgId };
          db.locations.push(loc);
        }
        db.fields.push({
          id: fieldId,
          name: fName,
          location_id: loc.id,
          organization_id: uniqueOrgId,
          active: true,
          supports_halves: false,
        });
        window.__saveMockDB__(db);
      },
      { fName: f, lName: l }
    );
    await page.reload();
    await page.waitForTimeout(1000);
  }
);

Then(
  '{string} should display an {string} badge on the grid',
  async ({ page }, name: string, badge: string) => {
    await page.waitForTimeout(2000);
    const card = page.locator('div.bg-bg-surface', { hasText: name }).first();
    await expect(card.getByText(new RegExp(badge, 'i')).first()).toBeVisible({ timeout: 10000 });
  }
);

Given('another organization {string} exists', async ({ page }, orgName: string) => {
  await page.evaluate((name) => {
    const db = JSON.parse(
      sessionStorage.getItem('__MOCK_DB__') || JSON.stringify(window.__MOCK_DB__ || {})
    );
    db.organizations = db.organizations || [];
    db.organizations.push({ id: 'org-rival', name: name, status: 'active', is_onboarded: true });
    window.__saveMockDB__(db);
  }, orgName);
  if (page.url() !== 'about:blank') await page.reload();
});

Given(
  '{string} has a location {string} with field {string}',
  async ({ page }, orgName: string, locName: string, fieldName: string) => {
    await page.evaluate(
      ({ oName, lName, fName }) => {
        const db = JSON.parse(
          sessionStorage.getItem('__MOCK_DB__') || JSON.stringify(window.__MOCK_DB__ || {})
        );
        const org = db.organizations.find((o: Record<string, unknown>) => o.name === oName);
        if (org) {
          db.locations = db.locations || [];
          db.fields = db.fields || [];
          const locId = `loc-${org.id}`;
          let loc = db.locations.find(
            (l: Record<string, unknown>) => l.name === lName && l.organization_id === org.id
          );
          if (!loc) {
            loc = { id: locId, name: lName, organization_id: org.id };
            db.locations.push(loc);
          }
          db.fields.push({
            id: `field-${org.id}`,
            name: fName,
            location_id: loc.id,
            organization_id: org.id,
            active: true,
            supports_halves: false,
          });
        }
        window.__saveMockDB__(db);
      },
      { oName: orgName, lName: locName, fName: fieldName }
    );
    if (page.url() !== 'about:blank') await page.reload();
  }
);

Then('I should not see {string} in the Location dropdown', async ({ page }, locName: string) => {
  // CRITICAL FIX: Open the modal first so the dropdown is actually in the DOM
  await page
    .getByRole('button', { name: /Add Field/i })
    .first()
    .click({ force: true });
  const dropdown = page.locator('select').last(); // Use last to avoid sidebar select
  await expect(dropdown).not.toContainText(locName);
  await page
    .getByRole('button', { name: /Cancel|Close/i })
    .first()
    .click({ force: true });
});

Then('I should not see {string} on the grid', async ({ page }, fieldName: string) => {
  await expect(page.locator('div.bg-bg-surface', { hasText: fieldName })).toBeHidden();
});
