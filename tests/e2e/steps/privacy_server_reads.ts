import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { waitForMockClient } from './mockReady.js';
import { MOCK_ORG_ID } from '../../../frontend/src/lib/mockSeedIds.js';

const { Given, When, Then } = createBdd();

Given(
  'the {string} have a teammate {string} with two guardian contacts',
  async ({ page }, teamName: string, childName: string) => {
    await waitForMockClient(page);
    await page.evaluate(
      ({ team, child, mockOrgId }) => {
        const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
        const orgId = localStorage.getItem('squadlogic_active_org') || mockOrgId;
        const teamId = team.toLowerCase().replace(/\s+/g, '-');
        const playerId = `player-${child.toLowerCase()}`;
        db.players = (db.players || []).filter((p: Record<string, unknown>) => p.id !== playerId);
        db.players.push({
          id: playerId,
          first_name: child,
          last_name: 'Test',
          organization_id: orgId,
          guardian_contacts: [
            { name: 'Rowan Primary', email: 'rowan.primary@example.test', phone: '555-0101' },
            { name: 'Rowan Second', email: 'rowan.second@example.test' },
          ],
        });
        db.team_players = (db.team_players || []).filter(
          (tp: Record<string, unknown>) => tp.player_id !== playerId
        );
        db.team_players.push({ team_id: teamId, player_id: playerId, organization_id: orgId });
        // The sanctioned write (lifts tombstones, as the client's own saves do).
        window.__saveMockDB__(db);
      },
      { team: teamName, child: childName, mockOrgId: MOCK_ORG_ID }
    );
  }
);

When('I open the roster of the {string}', async ({ page }, teamName: string) => {
  const teamId = teamName.toLowerCase().replace(/\s+/g, '-');
  await page.goto(`/team/${teamId}`);
  const rosterTab = page.getByRole('tab', { name: /Roster/i }).first();
  await expect(rosterTab).toBeVisible({ timeout: 15000 });
  await rosterTab.click();
});

Then('I should see the player {string} on the roster', async ({ page }, name: string) => {
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 15000 });
});

Then('I should not see the guardian contact {string}', async ({ page }, email: string) => {
  await expect(page.getByText(/Rowan Test/).first()).toBeVisible();
  await expect(page.getByRole('link', { name: email })).toHaveCount(0);
});

Then('I should see no phone or email link', async ({ page }) => {
  await expect(page.locator('a[href^="tel:"], a[href^="mailto:"]')).toHaveCount(0);
});

When('I open the player record {string}', async ({ page }, playerId: string) => {
  await page.goto(`/players/${playerId}`);
  await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible({ timeout: 15000 });
});

Then('the player record offers no guardians', async ({ page }) => {
  const tabs = page.getByRole('tab');
  await expect(tabs.first()).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Guardians' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add guardian' })).toHaveCount(0);
});

When('I open my account settings', async ({ page }) => {
  await page.goto('/account');
  await expect(page.getByRole('heading', { name: 'Account Settings' })).toBeVisible({
    timeout: 15000,
  });
});

Then('I should be offered no contact card', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Account Settings' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Contact card' })).toHaveCount(0);
  await expect(page.getByLabel('Share this phone and email')).toHaveCount(0);
});

When('I open my home page', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'My Dashboard' })).toBeVisible({
    timeout: 15000,
  });
});

Then('I should see no coach directory', async ({ page }) => {
  await expect(page.getByRole('link', { name: /^Open / }).first()).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByRole('heading', { name: 'Coach directory' })).toHaveCount(0);
  await expect(page.locator('a[href^="tel:"], a[href^="mailto:"]')).toHaveCount(0);
});
