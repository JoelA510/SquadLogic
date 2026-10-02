import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, RefreshCw, ThermometerSun } from 'lucide-react';
import { STALE_AFTER_HOURS } from '@squadlogic/core/heat/index.js';
import { seasonCalendarDate } from '@squadlogic/core/timing/index.js';
import Page from '../components/chrome/Page.jsx';
import PageHeader from '../components/chrome/PageHeader.jsx';
import DataErrorBanner from '../components/ui/DataErrorBanner.jsx';
import HeatForecastTable from '../components/heat/HeatForecastTable.jsx';
import HeatSourcesPanel from '../components/heat/HeatSourcesPanel.jsx';
import { FEATURE_FLAGS } from '../constants/featureFlags.js';
import { useFeatures } from '../hooks/useFeatures.js';
import { useHeatForecast } from '../hooks/useHeatForecast.js';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { todayIso } from '../utils/today.js';

/** `YYYY-MM-DD` one day after `date`, by calendar fields (no host zone). */
function nextDay(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/**
 * Field heat-stress (WBGT) forecast for a game day: per venue, surface and
 * kickoff window, the modeled WBGT, its U.S. Soccer Recognize to Recover band,
 * and the regional air temperatures that would push the field into Red and
 * Black. Decision support only -- on-site WBGT readings govern, and the page
 * says so before it shows a number.
 *
 * Admin-only (`MANAGE_ORGANIZATION`, at the route) and behind the
 * `heat_forecast` org feature.
 */
export default function HeatForecastPage() {
  const { isEnabled } = useFeatures();
  const enabled = isEnabled(FEATURE_FLAGS.HEAT_FORECAST);
  return (
    <Page
      header={
        <PageHeader
          title="Heat forecast"
          subtitle="Forecast Wet Bulb Globe Temperature at each venue, from the NWS forecast. On-site readings govern."
          icon={
            <span className="page-obj-icon" style={{ background: 'var(--accent-rose)' }}>
              <ThermometerSun size={20} aria-hidden="true" />
            </span>
          }
        />
      }
    >
      {enabled ? (
        <HeatForecastBody />
      ) : (
        <div className="empty" role="status" data-testid="heat-forecast-disabled">
          <p className="font-medium">The heat forecast is turned off for this organization.</p>
          <p className="text-sm text-text-muted">
            An admin can turn it on under <Link to="/settings">Settings</Link> → Features.
          </p>
        </div>
      )}
    </Page>
  );
}

function HeatForecastBody() {
  const { currentSeasonSetting } = useOrganization() || {};
  const timeZone = currentSeasonSetting?.timezone ?? null;
  // Until the admin picks a day, the default follows the season clock, so a
  // timezone that arrives after mount moves "tomorrow" onto the season's day.
  const [openedAt] = useState(() => Date.now());
  const [pickedDate, setDate] = useState(/** @type {string|null} */ (null));
  const date = pickedDate ?? nextDay(seasonCalendarDate(openedAt, timeZone) ?? todayIso());
  const forecast = useHeatForecast(date);

  const formatInstant = useMemo(() => {
    const fmt = timeZone
      ? new Intl.DateTimeFormat('en-US', {
          timeZone,
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          timeZoneName: 'short',
        })
      : null;
    return (iso) => (fmt ? fmt.format(new Date(iso)) : iso);
  }, [timeZone]);

  const computed = forecast.rows.filter((r) => r.status === 'computed');
  const refused = forecast.rows.filter((r) => r.status === 'refused');
  const showNwsColumn = computed.some((r) => r.nwsWbgtF !== null);
  const stale = forecast.grids.filter((g) => g.stale);
  const thresholdNote = computed[0]?.provenance?.thresholds?.note ?? null;

  return (
    <div className="space-y-4">
      <div
        className="p-4 rounded-xl border border-status-warning bg-status-warning-bg text-text-primary text-sm"
        role="note"
        data-testid="heat-disclaimer"
      >
        <p className="font-semibold">Decision support only. On-site WBGT readings govern.</p>
        <p>
          These are model estimates for a field in direct sun. Sheltered or low-wind fields can run
          several °F higher. An on-site WBGT measurement always overrides this forecast.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="field">
          <label htmlFor="heat-date" className="block text-sm font-medium text-text-secondary mb-1">
            Game day
          </label>
          <input
            id="heat-date"
            type="date"
            className="input"
            value={date}
            onChange={(e) => e.target.value && setDate(e.target.value)}
          />
        </div>
        <button type="button" className="btn btn-default" onClick={forecast.refresh}>
          <RefreshCw size={14} aria-hidden="true" /> Refresh
        </button>
        <p className="text-sm text-text-muted" data-testid="heat-category">
          U.S. Soccer Category {forecast.category}
          {forecast.categorySource === 'default' ? ' (default; not configured)' : ''}
          {timeZone ? ` · times in ${timeZone}` : ''}
        </p>
      </div>

      {forecast.grids.length > 0 && (
        <ul className="text-sm text-text-secondary" data-testid="heat-forecast-times">
          {forecast.grids.map((g) => (
            <li key={g.gridpointUrl}>
              NWS forecast {g.gridId} {g.gridX},{g.gridY}: updated {formatInstant(g.updateTime)};
              retrieved {formatInstant(g.retrievedAt)}
            </li>
          ))}
        </ul>
      )}

      {stale.length > 0 && (
        <div
          className="p-3 rounded-xl border border-status-error bg-status-error-bg text-text-primary text-sm flex gap-2"
          role="alert"
          data-testid="heat-stale-warning"
        >
          <AlertTriangle size={16} aria-hidden="true" className="shrink-0 mt-0.5" />
          <span>
            Stale forecast: NWS last updated{' '}
            {stale
              .map(
                (g) =>
                  `${g.gridId} ${g.gridX},${g.gridY} ${Math.floor(g.ageHours)} h before retrieval`
              )
              .join('; ')}
            , older than the {STALE_AFTER_HOURS} h this screen accepts. Check the NWS forecast
            before relying on these numbers.
          </span>
        </div>
      )}

      <DataErrorBanner message={forecast.error} />
      {forecast.planError && (
        <div
          className="p-3 rounded-xl border border-status-error bg-status-error-bg text-text-primary text-sm"
          role="alert"
          data-testid="heat-plan-error"
        >
          {forecast.planError}
        </div>
      )}

      {forecast.status === 'loading' && (
        <p className="text-sm text-text-muted" role="status">
          Loading the forecast…
        </p>
      )}

      {forecast.status === 'ready' && forecast.rows.length > 0 && (
        <>
          <p className="text-sm text-text-secondary" role="status" data-testid="heat-summary">
            {forecast.mode === 'games'
              ? 'One row per venue, surface and game window; a game across several hours shows its hottest hour.'
              : 'No games scheduled on this date: one row per venue, surface and hour, 08:00–17:00.'}{' '}
            {computed.length} computed
            {refused.length > 0 ? `, ${refused.length} not computed (reason shown in the row)` : ''}
            .
          </p>
          <HeatForecastTable
            rows={forecast.rows}
            showNwsColumn={showNwsColumn}
            caption={`Heat forecast for ${date}`}
          />
        </>
      )}

      {forecast.status === 'ready' && forecast.rows.length === 0 && !forecast.planError && (
        <div className="empty" role="status">
          <p>No venues to forecast. Add venues and fields on the Fields page.</p>
        </div>
      )}

      <HeatSourcesPanel
        sources={forecast.sources}
        grids={forecast.grids}
        category={forecast.category}
        categorySource={forecast.categorySource}
        thresholdNote={thresholdNote}
        guidanceLinks={forecast.guidanceLinks}
        formatInstant={formatInstant}
      />
    </div>
  );
}
