import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { routeAutoSchedulerToEdgeSolver, type EdgeSolverPage } from './edgeAutoSchedulerRoute.js';

/**
 * The auto-scheduler's browser path (Phase D PR D): where the search ran, as the panel says it and
 * as the requests the page made show it. Every check is a DOM assertion or a read of the requests the
 * route (`edgeAutoSchedulerRoute.ts`) answered; no step writes a result.
 */

const { Given, When, Then } = createBdd();

const panel = (page: EdgeSolverPage) => page.locator('section[aria-label="Auto-Scheduler"]');

Given('this browser cannot run web workers', async ({ page }) => {
  // `typeof Worker !== 'function'`: the hook then runs the server's search, as it did before.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'Worker', { value: undefined, configurable: true });
  });
});

Given("the function is slow to answer the run's first request", async ({ page }) => {
  // Never released: the run is cancelled while it waits, and the page is closed with the request
  // still pending.
  (page as EdgeSolverPage).__edgeHoldPrepare = new Promise<void>(() => {});
});

When('I start the auto-scheduler on the Practice Scheduling page', async ({ page }) => {
  await routeAutoSchedulerToEdgeSolver(page);
  await page.goto('/schedule/practice');
  const run = page.getByRole('button', { name: 'Run auto-scheduler optimization' });
  await expect(run).toBeEnabled({ timeout: 15000 });
  await run.click();
});

Then("the panel says it is loading the season's data", async ({ page }) => {
  await expect(
    page
      .getByRole('status', { name: 'Optimization progress' })
      .getByText(/Loading the season's data/)
  ).toBeVisible();
});

When('I cancel the run', async ({ page }) => {
  await page.getByRole('button', { name: 'Cancel the running optimization' }).click();
});

Then('the run has ended without a schedule', async ({ page }) => {
  const section = panel(page as EdgeSolverPage);
  // Idle again: the run control is pressable, and neither a result nor an error is shown.
  await expect(page.getByRole('button', { name: 'Run auto-scheduler optimization' })).toBeEnabled();
  await expect(section.getByText('Optimization Complete')).toHaveCount(0);
  await expect(section.getByRole('alert')).toHaveCount(0);
  expect((page as EdgeSolverPage).__edgeSolverRuns).toBe(0);
});

/** The modes of the requests the function was sent, in order. */
const modes = (page: EdgeSolverPage) => () => page.__edgeSolverModes ?? [];

Then('the page asked the function to prepare and then to verify', async ({ page }) => {
  await expect.poll(modes(page as EdgeSolverPage)).toEqual(['prepare', 'verify']);
});

Then('the page asked the function to solve and nothing else', async ({ page }) => {
  await expect.poll(modes(page as EdgeSolverPage)).toEqual(['solve']);
});

Then('the page asked the function to prepare and nothing else', async ({ page }) => {
  await expect.poll(modes(page as EdgeSolverPage)).toEqual(['prepare']);
});

Then('the panel says the search ran in the browser', async ({ page }) => {
  await expect(page.getByTestId('ran-in')).toHaveText(
    'Ran in your browser; the server checked every placement.'
  );
});

Then(
  'the panel says the search ran on the server because this browser cannot run the optimizer',
  async ({ page }) => {
    await expect(page.getByTestId('ran-in')).toHaveText(
      "Ran on the server. This browser can't run the optimizer, so the server ran it."
    );
  }
);
