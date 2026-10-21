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

Then('I should see the guardian contact {string}', async ({ page }, email: string) => {
  await expect(page.getByRole('link', { name: email })).toBeVisible();
});

Then('I should not see the guardian contact {string}', async ({ page }, email: string) => {
  await expect(page.getByText(/Rowan Test/).first()).toBeVisible();
  await expect(page.getByRole('link', { name: email })).toHaveCount(0);
});

When(
  'I save a contact card with phone {string} and choose to share it',
  async ({ page }, phone: string) => {
    await page.goto('/account');
    const card = page.getByRole('region', { name: 'Contact card' });
    await expect(card).toBeVisible({ timeout: 15000 });
    await card.getByLabel('Phone', { exact: true }).fill(phone);
    await card.getByLabel('Share this phone and email').check();
    await card.getByRole('button', { name: 'Save Contact Card' }).click();
  }
);

Then('the contact card should be saved', async ({ page }) => {
  const card = page.getByRole('region', { name: 'Contact card' });
  await expect(card.getByRole('status')).toHaveText('Contact card saved.');
});
