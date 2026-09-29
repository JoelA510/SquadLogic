import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';

const { When, Then } = createBdd();

/**
 * 8.6 3b PR 11c: enacting one practice repair recommendation. The seed and
 * the panel steps are `practice_repair_panel.ts`'s; the retirement steps are
 * `field_blackout_admin.ts`'s. DOM assertions only.
 */

Then(
  'every Enact button should be disabled because the retirement is not saved',
  async ({ page }) => {
    const rows = page.getByTestId('practice-repair-window');
    await expect(rows.first()).toBeVisible();
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i += 1) {
      await expect(rows.nth(i).getByTestId('practice-repair-enact')).toBeDisabled();
      await expect(rows.nth(i).getByTestId('practice-repair-enact-why')).toContainText(
        'Save the retirement first'
      );
    }
  }
);

/** The "Retires after" strip of the field card whose heading is `fieldName`. */
const cardOf = (page, fieldName: string) =>
  page
    .locator('div.rounded-xl')
    .filter({ has: page.getByRole('heading', { name: fieldName, exact: true }) })
    .getByTestId(/^retired-/);

Then(
  'the card of {string} should offer to repair practices after {string}',
  async ({ page }, fieldName: string, date: string) => {
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const retired = cardOf(page, fieldName).first();
    await expect(retired).toContainText(`Retires after ${date}`);
    await expect(retired.getByRole('button', { name: 'Repair practices' })).toBeEnabled();
  }
);

When(
  'I open the practice repair from the card of {string}',
  async ({ page }, fieldName: string) => {
    const retired = cardOf(page, fieldName).first();
    const button = retired.getByRole('button', { name: 'Repair practices' });
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(retired.getByTestId('practice-repair-panel')).toBeVisible();
    await expect(retired.getByTestId('practice-repair-rows')).toBeVisible();
  }
);

When(
  'I enact the recommendation for {string}, accepting the override',
  async ({ page }, team: string) => {
    const enact = page.getByRole('button', { name: `Enact the recommendation for ${team}` });
    await expect(enact).toBeEnabled();
    await enact.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('practice-enact-heading')).toBeFocused();
    const confirm = dialog.getByTestId('practice-enact-confirm');
    await expect(confirm).toBeDisabled();
    await dialog.getByRole('checkbox', { name: new RegExp(`Move and lock ${team}`) }).check();
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(dialog).toHaveCount(0);
  }
);

Then(
  'the practice of {string} should be shown enacted and locked',
  async ({ page }, team: string) => {
    const enacted = page.getByTestId('practice-repair-enacted-row').filter({ hasText: team });
    await expect(enacted).toBeVisible();
    await expect(enacted.getByTestId('practice-repair-enacted-locked')).toContainText('Locked');
    await expect(enacted.getByTestId('practice-repair-enacted-locked')).toContainText(
      'Repair Pitch 2'
    );
    await expect(page.getByTestId('practice-repair-announce')).toContainText(
      `Enacted the recommendation for ${team}`
    );
    // The enacted series left the displaced list; the other one is still offered.
    await expect(page.getByTestId('practice-repair-window').filter({ hasText: team })).toHaveCount(
      0
    );
  }
);
