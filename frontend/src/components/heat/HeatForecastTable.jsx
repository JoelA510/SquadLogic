import React from 'react';
import PropTypes from 'prop-types';
import { heatRowDisplay } from '@squadlogic/core/heat/index.js';
import HeatBandBadge from './HeatBandBadge.jsx';

const hourLabel = (h) => `${String(h).padStart(2, '0')}:00`;
const surfaceLabel = (row) =>
  row.surface ? row.surface[0].toUpperCase() + row.surface.slice(1) : row.surfaceRaw || 'Not set';
const oneDecimal = (v) => (v === null ? null : v.toFixed(1));

/** The time a row covers, and which hour it took its values from. */
function windowText(row) {
  if (row.window.kind === 'hour') return hourLabel(row.window.localHour);
  const { startLabel, endLabel } = row.window;
  const span = startLabel ? `${startLabel}${endLabel ? `–${endLabel}` : ''}` : 'Time unreadable';
  return span;
}

function hottestNote(row) {
  if (row.status !== 'computed' || row.window.kind !== 'game' || row.hourly.length < 2) return null;
  return `hottest hour ${hourLabel(row.usedHour)} of ${row.hourly.map((h) => hourLabel(h.localHour)).join(', ')}`;
}

/**
 * One row per venue x surface x kickoff window (or hour, with no games).
 * A refused row keeps its place and says why, in the columns it could not fill.
 */
export default function HeatForecastTable({ rows, showNwsColumn, caption }) {
  return (
    <div className="overflow-x-auto">
      <table className="grid" data-testid="heat-forecast-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Venue</th>
            <th scope="col">Surface</th>
            <th scope="col">Time</th>
            <th scope="col">Air °F</th>
            <th scope="col">Dewpoint °F</th>
            <th scope="col">Wind mph</th>
            <th scope="col">Sky cover %</th>
            <th scope="col">WBGT °F</th>
            <th scope="col">Band</th>
            <th scope="col">
              <abbr title="Regional air temperature at which this field reaches Red, dewpoint and wind held">
                Red at air °F
              </abbr>
            </th>
            <th scope="col">
              <abbr title="Regional air temperature at which this field reaches Black, dewpoint and wind held">
                Black at air °F
              </abbr>
            </th>
            {showNwsColumn && <th scope="col">NWS WBGT °F</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const d = heatRowDisplay(row);
            const note = hottestNote(row);
            return (
              <tr key={row.key} data-testid="heat-row" data-status={row.status}>
                <th scope="row" className="text-left font-normal">
                  {/* `.cell` is a flex row: one child, so the parts stack and keep their spacing. */}
                  <div className="cell py-1">
                    <div>
                      <span className="font-medium">{row.venueName}</span>
                      {row.fieldNames.length > 0 && (
                        <span className="block text-xs text-text-muted">
                          {row.fieldNames.join(', ')}
                        </span>
                      )}
                    </div>
                  </div>
                </th>
                <td>
                  <div className="cell">{surfaceLabel(row)}</div>
                </td>
                <td>
                  <div className="cell py-1">
                    <div>
                      {windowText(row)}
                      {note && <span className="block text-xs text-text-muted">{note}</span>}
                      {row.notes.map((n) => (
                        <span key={n.code} className="block text-xs text-text-muted">
                          {n.message}
                        </span>
                      ))}
                    </div>
                  </div>
                </td>
                {d ? (
                  <>
                    <td>
                      <div className="cell">{d.airF}</div>
                    </td>
                    <td>
                      <div className="cell">{d.dewpointF}</div>
                    </td>
                    <td>
                      <div className="cell">{d.windMph}</div>
                    </td>
                    <td>
                      <div className="cell">{d.skyCoverPct}</div>
                    </td>
                    <td>
                      <div className="cell font-semibold" data-testid="heat-wbgt">
                        {oneDecimal(d.wbgtF)}
                      </div>
                    </td>
                    <td>
                      <div className="cell" data-testid="heat-band">
                        <HeatBandBadge band={row.band} />
                      </div>
                    </td>
                    <td>
                      <div className="cell" data-testid="heat-red-trigger">
                        {d.redTriggerF === null ? 'Not reached by 125' : oneDecimal(d.redTriggerF)}
                      </div>
                    </td>
                    <td>
                      <div className="cell" data-testid="heat-black-trigger">
                        {d.blackTriggerF === null
                          ? 'Not reached by 125'
                          : oneDecimal(d.blackTriggerF)}
                      </div>
                    </td>
                    {showNwsColumn && (
                      <td>
                        <div className="cell">
                          {d.nwsWbgtF === null ? 'Not supplied' : oneDecimal(d.nwsWbgtF)}
                        </div>
                      </td>
                    )}
                  </>
                ) : (
                  <td colSpan={showNwsColumn ? 9 : 8}>
                    <div
                      className="cell text-sm whitespace-normal py-1"
                      data-testid="heat-refusal"
                      data-code={row.reason?.code}
                    >
                      <span>
                        <span className="font-medium">Not computed:</span> {row.reason?.message}
                      </span>
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

HeatForecastTable.propTypes = {
  rows: PropTypes.arrayOf(PropTypes.object).isRequired,
  showNwsColumn: PropTypes.bool,
  caption: PropTypes.string.isRequired,
};
