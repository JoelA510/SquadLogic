/**
 * The heat forecast screen: off-state behind the feature, the on-site
 * disclaimer before any number, the stale warning, refused rows that keep
 * their place, and a sources panel rendered from the rows' provenance.
 */
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  buildHeatPlan,
  computeHeatRows,
  sourcesForProvenance,
} from '@squadlogic/core/heat/index.js';

import HeatForecastPage from '../frontend/src/pages/HeatForecastPage.jsx';
import {
  REFERENCE_DATE,
  REFERENCE_TZ,
  loadTurbidity,
  referenceEstate,
  referenceForecasts,
} from './helpers/heatFixtures.js';

const state = vi.hoisted(() => ({ forecast: null, flags: {} }));

vi.mock('../frontend/src/hooks/useHeatForecast.js', () => ({
  useHeatForecast: () => state.forecast,
}));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    featureFlags: state.flags,
    currentSeasonSetting: { timezone: 'America/Los_Angeles' },
  }),
}));

function forecastFixture({ stale = false, refuseVenue = null } = {}) {
  const { venues, fields } = referenceEstate();
  const plan = buildHeatPlan({
    date: REFERENCE_DATE,
    timeZone: REFERENCE_TZ,
    venues,
    fields,
    games: [],
  });
  const forecasts = referenceForecasts();
  if (refuseVenue)
    forecasts[refuseVenue] = { error: { message: 'NWS 404: Unable to provide data' } };
  const rows = computeHeatRows({
    plan,
    venues,
    category: 1,
    categorySource: 'default',
    forecasts,
    turbidity: loadTurbidity(),
  });
  return {
    status: 'ready',
    mode: plan.mode,
    rows,
    planError: null,
    error: null,
    grids: [
      {
        gridpointUrl: 'https://api.weather.gov/gridpoints/MTR/97,99',
        gridId: 'MTR',
        gridX: 97,
        gridY: 99,
        updateTime: '2026-10-02T08:31:00+00:00',
        retrievedAt: stale ? '2026-10-02T21:00:00.000Z' : '2026-10-02T16:00:00.000Z',
        ageHours: stale ? 12.48 : 7.48,
        stale,
      },
    ],
    sources: sourcesForProvenance(rows.filter((r) => r.provenance).map((r) => r.provenance)),
    timeZone: REFERENCE_TZ,
    category: 1,
    categorySource: 'default',
    guidanceLinks: [{ label: 'League health and safety', url: 'https://example.org/health' }],
    refresh: vi.fn(),
  };
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <HeatForecastPage />
    </MemoryRouter>
  );

beforeEach(() => {
  state.flags = { heat_forecast: true };
  state.forecast = forecastFixture();
});

describe('HeatForecastPage', () => {
  it('is off until the org turns the feature on', () => {
    state.flags = {};
    renderPage();
    expect(screen.getByTestId('heat-forecast-disabled')).toHaveTextContent(/turned off/);
    expect(screen.queryByTestId('heat-forecast-table')).not.toBeInTheDocument();
  });

  it('states that on-site WBGT governs before showing any number', () => {
    renderPage();
    const disclaimer = screen.getByTestId('heat-disclaimer');
    expect(disclaimer).toHaveTextContent(/On-site WBGT readings govern/);
    expect(disclaimer).toHaveTextContent(/direct sun/);
    expect(disclaimer).toHaveTextContent(/Sheltered or low-wind fields can run several °F higher/);
    // The disclaimer precedes the table in document order.
    expect(
      disclaimer.compareDocumentPosition(screen.getByTestId('heat-forecast-table')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('renders the golden row with its band and triggers', () => {
    renderPage();
    const rows = screen.getAllByTestId('heat-row');
    expect(rows).toHaveLength(40);
    const canyon11 = rows.find(
      (r) => within(r).queryByText('Canyon MS') && within(r).queryByText('11:00')
    );
    expect(within(canyon11).getByTestId('heat-wbgt')).toHaveTextContent('77.3');
    expect(within(canyon11).getByTestId('heat-band')).toHaveTextContent('Yellow');
    expect(within(canyon11).getByTestId('heat-red-trigger')).toHaveTextContent('93.9');
    expect(within(canyon11).getByTestId('heat-black-trigger')).toHaveTextContent('98.0');
  });

  it('shows the NWS update and retrieval times, and no stale warning when fresh', () => {
    renderPage();
    expect(screen.getByTestId('heat-forecast-times')).toHaveTextContent(
      /MTR 97,99: updated .*retrieved/
    );
    expect(screen.queryByTestId('heat-stale-warning')).not.toBeInTheDocument();
  });

  it('warns when the forecast is older than the accepted age', () => {
    state.forecast = forecastFixture({ stale: true });
    renderPage();
    expect(screen.getByTestId('heat-stale-warning')).toHaveTextContent(/Stale forecast.*12 h/);
  });

  it('keeps a refused row in place, with the reason', () => {
    state.forecast = forecastFixture({ refuseVenue: 'loc-vannoy' });
    renderPage();
    const refused = screen.getAllByTestId('heat-refusal');
    expect(refused).toHaveLength(10);
    expect(refused[0]).toHaveTextContent(/Not computed: NWS 404/);
    expect(screen.getByTestId('heat-summary')).toHaveTextContent(/30 computed, 10 not computed/);
  });

  it('lists every source the provenance names, the category and its source, and the org links', () => {
    renderPage();
    const panel = screen.getByTestId('heat-sources');
    for (const id of [
      'nws-api',
      'nws-wbgt',
      'liljegren2008',
      'grundstein2020',
      'singh2024',
      'pryor2017',
      'reda2004',
      'us-soccer-rtr',
    ]) {
      expect(within(panel).getByTestId(`heat-source-${id}`)).toBeInTheDocument();
    }
    expect(
      within(panel).getByRole('link', { name: /doi:10\.1080\/15459620802310770/ })
    ).toHaveAttribute('href', 'https://doi.org/10.1080/15459620802310770');
    expect(within(panel).getByTestId('heat-threshold-category')).toHaveTextContent(
      /Category 1 \(default; not configured\)/
    );
    expect(within(panel).getByTestId('heat-guidance-links')).toHaveTextContent(
      'League health and safety'
    );
    expect(screen.getByTestId('heat-category')).toHaveTextContent(
      'U.S. Soccer Category 1 (default; not configured)'
    );
  });

  it('shows a plan error (no season clock) as an alert, with no table', () => {
    state.forecast = { ...forecastFixture(), rows: [], planError: 'The season has no timezone.' };
    renderPage();
    expect(screen.getByTestId('heat-plan-error')).toHaveTextContent(/no timezone/);
    expect(screen.queryByTestId('heat-forecast-table')).not.toBeInTheDocument();
  });
});
