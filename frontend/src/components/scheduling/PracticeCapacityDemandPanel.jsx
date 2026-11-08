import React, { useId, useMemo } from 'react';
import PropTypes from 'prop-types';
import Badge from '../ui/Badge.jsx';
import DataErrorBanner from '../ui/DataErrorBanner.jsx';
import { useOrganization } from '../../contexts/OrganizationContext.jsx';
import { usePracticeCapacityDemand } from '../../hooks/usePracticeCapacityDemand.js';
import {
  CAPACITY_VERDICT,
  buildCapacityDemand,
  capacityDemandInputFromRows,
} from '@squadlogic/core/practice/capacityDemand.js';
import { describeNoSlotReason } from '@squadlogic/core/practice/capacityDemandText.js';
import { describeUnplacedReason } from '@squadlogic/core/practiceUnplacedReasons.js';

/**
 * The sentences on this panel's face (owner decisions 28 and 29, 2026-11-06): what the numbers are
 * based on, that nothing here knows of a time held outside the app, that every verdict is an upper
 * bound, and what is not checked. They are written out in `tests/practiceCapacityDemandPanel.test.jsx`
 * too, so a change here is a red test and a conscious edit. Nothing here promises to leave a held
 * time out of the room: the app does not record one (decision 28 = (a)).
 */
const HELD_OUTSIDE = 'Times held outside the app are unknown to this panel.';
const UPPER_BOUND =
  'Each verdict is an upper bound: the room it counts can only be too high, so “to spare” can be too high and “short by” can understate a shortage.';
const DECLARED =
  'Not checked here: coach overlap, coach must-keep rules, daylight, closures, permits, travel, saved exceptions and teams whose practice time is TBD. A run applies them, so it can place fewer practices than the room shown.';
const TOTAL_NOTE =
  'Whole season: a slot open to several divisions counts in each of their rows but once here, so the rows can add up to more than this line.';

const DAY_LABEL = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The verdict's badge label, tone and the sentence under it, from the model's verdict.
 *
 * @returns {{ tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info', label: string,
 *   detail: string | null }}
 */
function describeVerdict(verdict, row = undefined) {
  switch (verdict.kind) {
    case CAPACITY_VERDICT.SPARE:
      return { tone: 'success', label: `${verdict.spare} to spare`, detail: null };
    case CAPACITY_VERDICT.SHORT:
      return { tone: 'danger', label: `Short by ${verdict.short}`, detail: null };
    case CAPACITY_VERDICT.NONE_WANTED:
      return { tone: 'neutral', label: 'None wanted', detail: null };
    case CAPACITY_VERDICT.NO_TEAMS:
      return { tone: 'neutral', label: 'No teams', detail: null };
    case CAPACITY_VERDICT.NO_SLOT:
      return {
        tone: 'danger',
        label: 'No slot open',
        detail: `${describeNoSlotReason(verdict.reason, row?.practiceMinutes)} Short by ${verdict.short}.`,
      };
    default:
      return {
        tone: 'warning',
        label: 'Too few weekdays',
        detail:
          `${capitalise(describeUnplacedReason(verdict.reason))} ` +
          `(a team still needs ${row?.largestNeed ?? 0} practices; its open slots fall on ` +
          `${plural(row?.slots.weekdays.length ?? 0, 'weekday', 'weekdays')}).` +
          (verdict.short > 0 ? ` Short by ${verdict.short}.` : ''),
      };
  }
}

function Verdict({ verdict, row = undefined }) {
  const { tone, label, detail } = describeVerdict(verdict, row);
  return (
    <>
      <Badge tone={tone} dot>
        {label}
      </Badge>
      {detail && (
        <>
          <span className="sr-only">. </span>
          <span className="mt-1 block text-text-secondary">{detail}</span>
        </>
      )}
    </>
  );
}

Verdict.propTypes = { verdict: PropTypes.object.isRequired, row: PropTypes.object };

const slotsCell = (slots) =>
  `${plural(slots.open, 'slot', 'slots')}${
    slots.weekdays.length > 0 ? `: ${slots.weekdays.map((day) => DAY_LABEL[day]).join(', ')}` : ''
  }`;

/** One labelled figure: a term and its value, in a definition list. */
function Figure({ label, className = '', children }) {
  return (
    <div className={className}>
      <dt className="text-text-muted">{label}</dt>
      <dd className="m-0 text-text-primary">{children}</dd>
    </div>
  );
}

Figure.propTypes = {
  label: PropTypes.string.isRequired,
  className: PropTypes.string,
  children: PropTypes.node.isRequired,
};

/**
 * One division, or the whole season, as a card: the name, the verdict first (the figure the page
 * is for, labelled an upper bound), then the figures in a definition list. A card, not a table
 * row: the Practices page is one narrow column, and a nine-column table put the verdict off the
 * edge of it.
 */
function CapacityCard({ testId, name, row, total = false }) {
  const asks = total || row.wanted > 0;
  const slots = row.slots;
  let slotsText = '—';
  if (total) {
    slotsText = `${plural(slots.open, 'slot', 'slots')}${
      slots.inRows !== slots.open ? ` (the rows add up to ${slots.inRows})` : ''
    }`;
  } else if (asks) slotsText = slotsCell(slots);
  return (
    <li
      data-testid={testId}
      data-division-id={total ? undefined : row.divisionId}
      className="rounded-lg border border-border-subtle p-3"
    >
      <h3 className="m-0 text-sm font-semibold text-text-primary">{name}</h3>
      <dl className="m-0 mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
        <Figure label="Verdict (upper bound)" className="col-span-2 sm:col-span-4">
          <Verdict verdict={row.verdict} row={total ? undefined : row} />
        </Figure>
        <Figure label="Teams">{row.teams}</Figure>
        <Figure label="Wanted a week">{row.wanted}</Figure>
        <Figure label="Held">
          {!total && row.teamsOverCount > 0
            ? `${row.held} (${plural(row.teamsOverCount, 'team', 'teams')} over its count)`
            : row.held}
        </Figure>
        <Figure label="Still needed">{row.stillNeeded}</Figure>
        {!total && (
          <Figure label="Length">
            {row.practiceMinutes === null ? 'Any length' : `${row.practiceMinutes} min`}
          </Figure>
        )}
        <Figure label="Slots it may use" className="sm:col-span-2">
          {slotsText}
        </Figure>
        <Figure label="Room left">{asks ? `${slots.room} of ${slots.capacity}` : '—'}</Figure>
      </dl>
    </li>
  );
}

CapacityCard.propTypes = {
  testId: PropTypes.string.isRequired,
  name: PropTypes.string.isRequired,
  row: PropTypes.object.isRequired,
  total: PropTypes.bool,
};

/** The report, drawn: the sentences on its face, a card per division, and what is not checked. */
function CapacityReport({ report }) {
  const { basis, total } = report;
  return (
    <>
      <p className="m-0 mt-2 text-sm text-text-secondary" data-testid="capacity-basis">
        {`These figures are based on every open practice slot a division may use, live from today (${report.liveFrom}) on and as long as the division’s practice. A saved practice uses its place in its slot from today on.`}
      </p>
      <p className="m-0 mt-1 text-sm text-text-secondary" data-testid="capacity-slot-counts">
        {`${basis.slotsRead} ${basis.slotsRead === 1 ? 'slot was' : 'slots were'} read; ${basis.slotsLive} ${basis.slotsLive === 1 ? 'is' : 'are'} live from today; ${basis.slotsOpenToSomeDivision} ${basis.slotsOpenToSomeDivision === 1 ? 'is' : 'are'} open to at least one division.`}
        {basis.slotsUnreadable > 0 &&
          ` ${basis.slotsUnreadable} could not be read and ${basis.slotsUnreadable === 1 ? 'is' : 'are'} not counted.`}
        {basis.unreadableRanges > 0 &&
          ` ${plural(basis.unreadableRanges, 'saved practice has', 'saved practices have')} dates that cannot be read and ${basis.unreadableRanges === 1 ? 'is' : 'are'} counted as using the whole slot.`}
      </p>
      <p
        className="m-0 mt-1 text-sm font-medium text-text-primary"
        data-testid="capacity-held-outside"
      >
        {HELD_OUTSIDE}
      </p>
      <p className="m-0 mt-1 text-sm text-text-secondary" data-testid="capacity-upper-bound">
        {UPPER_BOUND}
      </p>

      {report.divisions.length === 0 ? (
        <p className="m-0 mt-3 text-sm" data-testid="capacity-no-divisions">
          This season has no divisions yet, so there is nothing to compare.
        </p>
      ) : (
        <ul
          className="m-0 mt-3 list-none space-y-3 p-0"
          aria-label="Capacity against demand, by division"
          data-testid="capacity-list"
        >
          {report.divisions.map((row) => (
            <CapacityCard key={row.divisionId} testId="capacity-row" name={row.name} row={row} />
          ))}
          <CapacityCard testId="capacity-total" name="Whole season" row={total} total />
        </ul>
      )}

      {report.divisions.length > 0 && (
        <p className="m-0 mt-2 text-sm text-text-secondary" data-testid="capacity-total-note">
          {TOTAL_NOTE}
        </p>
      )}
      <p className="m-0 mt-1 text-sm text-text-secondary" data-testid="capacity-declared">
        {DECLARED}
      </p>
    </>
  );
}

CapacityReport.propTypes = { report: PropTypes.object.isRequired };

/**
 * "Before you run: slots against what each division needs" (schedule expansion, PR 13; plan
 * `docs/changes/2026-11-03-schedule-expansion.md`, 5.9): one row per division of the season, the
 * practices its teams still lack against the room in the practice slots it may use, and a total.
 * Read-only; nothing is stored or sent. The page lazy-loads this file.
 *
 * Until its inputs have been read it says "not checked yet" and shows no figure; a failed read
 * names its table and draws no row; data it cannot work out is an alert and no row (lessons 90 and
 * 93). `refreshKey` is bumped by the page when it saves, so the figures are never those of before.
 *
 * @param {{ refreshKey?: number|string }} props
 */
export default function PracticeCapacityDemandPanel({ refreshKey = 0 }) {
  const { currentOrganization, currentSeasonSetting, seasonSettingsLoading } = useOrganization();
  const orgId = currentOrganization?.id ? String(currentOrganization.id) : null;
  const headingId = `capacity-heading-${useId().replace(/:/g, '')}`;
  const demand = usePracticeCapacityDemand({
    organizationId: orgId,
    season: currentSeasonSetting,
    seasonLoading: Boolean(seasonSettingsLoading),
    refreshKey,
  });

  const { rows, liveFrom } = demand;
  const built = useMemo(() => {
    if (demand.status !== 'ready' || !rows || !liveFrom) return null;
    try {
      return {
        ok: true,
        report: buildCapacityDemand(
          capacityDemandInputFromRows({ liveFrom, season: currentSeasonSetting, ...rows })
        ),
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }, [demand.status, rows, liveFrom, currentSeasonSetting]);

  let body;
  if (demand.status === 'no-season' || demand.status === 'no-zone') {
    body = (
      <p className="m-0 mt-2 text-sm" data-testid="capacity-blocked">
        {demand.message}
      </p>
    );
  } else if (demand.status === 'unreadable') {
    body = (
      <div className="mt-2" data-testid="capacity-unreadable">
        <DataErrorBanner
          message={`The panel could not read the season, so no capacity figures are shown: ${demand.message}`}
        />
      </div>
    );
  } else if (built === null) {
    body = (
      <p className="m-0 mt-2 text-sm text-text-muted" data-testid="capacity-unchecked">
        Not checked yet: the divisions, teams, practice slots and saved practices have not been
        read.
      </p>
    );
  } else if (!built.ok) {
    body = (
      <div className="mt-2" data-testid="capacity-error">
        <DataErrorBanner
          message={`The capacity figures could not be worked out over this season’s data, so nothing is shown: ${built.message}`}
        />
      </div>
    );
  } else {
    body = <CapacityReport report={built.report} />;
  }

  return (
    <section
      aria-labelledby={headingId}
      data-testid="capacity-panel"
      className="rounded-xl border border-border-subtle bg-bg-glass p-4"
    >
      <h2 id={headingId} className="m-0 text-base font-semibold text-text-primary">
        Before you run: slots against what each division needs
      </h2>
      {body}
    </section>
  );
}

PracticeCapacityDemandPanel.propTypes = {
  refreshKey: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
};
