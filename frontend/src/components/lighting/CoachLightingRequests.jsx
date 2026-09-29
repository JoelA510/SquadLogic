import React, { useState } from 'react';
import PropTypes from 'prop-types';
import Button from '../ui/Button.jsx';
import {
  requestLightingOverride,
  useLightingSlotContext,
  usePracticeLightingOverrides,
  withdrawLightingOverride,
} from '../../hooks/usePracticeLightingOverrides.js';
import { WITHDRAWABLE_STATUSES, practiceSlotLabel } from '../../utils/lightingOverrides.js';
import {
  ActionMessage,
  LightingLoadError,
  LightingStatusBadge,
  OverrideWindowForm,
  outcomeOf,
} from './LightingOverrideFields.jsx';

function OverrideTable({
  caption,
  rows,
  slotById,
  fieldNames,
  emptyText,
  onWithdraw = undefined,
  busyId = null,
}) {
  if (rows.length === 0) return <p className="text-sm text-text-muted m-0">{emptyText}</p>;
  return (
    <div className="grid-wrap">
      <table className="grid">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Slot</th>
            <th scope="col">First date</th>
            <th scope="col">Last date</th>
            <th scope="col">Status</th>
            {onWithdraw && <th scope="col">Actions</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const label = practiceSlotLabel(slotById.get(String(row.practice_slot_id)), fieldNames);
            return (
              <tr key={row.id} data-testid="lighting-override-row">
                <td>{label}</td>
                <td>{row.from}</td>
                <td>{row.until}</td>
                <td>
                  <LightingStatusBadge status={row.status} />
                </td>
                {onWithdraw && (
                  <td>
                    {WITHDRAWABLE_STATUSES.includes(row.status) ? (
                      <Button
                        size="sm"
                        variant="ghost-danger"
                        disabled={busyId === row.id}
                        loading={busyId === row.id}
                        aria-label={`Withdraw the ${row.status} override on ${label} from ${row.from} to ${row.until}`}
                        onClick={() => onWithdraw(row)}
                      >
                        Withdraw
                      </Button>
                    ) : (
                      <span className="text-text-muted">&mdash;</span>
                    )}
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

OverrideTable.propTypes = {
  caption: PropTypes.string.isRequired,
  rows: PropTypes.array.isRequired,
  slotById: PropTypes.instanceOf(Map).isRequired,
  fieldNames: PropTypes.instanceOf(Map).isRequired,
  emptyText: PropTypes.string.isRequired,
  onWithdraw: PropTypes.func,
  busyId: PropTypes.string,
};

/**
 * The coach's view: request a portable-lighting window on a slot they coach,
 * and see and withdraw their own requests. No decision controls: only an admin
 * decides, and the decide RPC refuses anyone else anyway.
 */
export default function CoachLightingRequests({ orgId, userId, toast }) {
  const context = useLightingSlotContext(orgId, { userId, coachScoped: true });
  const { rows, loading, error, refresh } = usePracticeLightingOverrides(orgId, {
    enabled: !context.loading && !context.error,
  });
  const [busyId, setBusyId] = useState(/** @type {string|null} */ (null));
  const [outcome, setOutcome] = useState(/** @type {any} */ (null));

  if (context.loading) {
    return <p className="text-sm text-text-muted">Loading your practice slots…</p>;
  }
  if (context.error) {
    return <LightingLoadError error={context.error} what="your practice slots" />;
  }
  if (context.coaches.length === 0) {
    return (
      <div className="empty" role="status">
        Your account is not linked to a coach record in this organization, so there are no practice
        slots to request lighting for. Ask an admin to link it.
      </div>
    );
  }

  const slotById = new Map(context.slots.map((slot) => [String(slot.id), slot]));
  const coachedSlots = context.slots.filter((slot) => context.coachedSlotIds.has(String(slot.id)));
  // RLS already narrows a coach's read to the slots they coach; filtering here
  // keeps the view honest where it does not (the mock) and after a roster change.
  const onCoachedSlots = rows.filter((row) =>
    context.coachedSlotIds.has(String(row.practice_slot_id))
  );
  const mine = onCoachedSlots.filter((row) => String(row.requested_by) === String(userId));
  const others = onCoachedSlots.filter((row) => String(row.requested_by) !== String(userId));

  const submit = async (window) => {
    const result = await outcomeOf(
      () => requestLightingOverride(window),
      'Lighting override requested. It is not in force until an admin approves it.'
    );
    if (!result.error) {
      toast(result.message, 'success');
      await refresh();
    }
    return result;
  };

  const withdraw = async (row) => {
    setBusyId(row.id);
    const result = await outcomeOf(
      () => withdrawLightingOverride({ id: row.id }),
      'Lighting override withdrawn.'
    );
    setOutcome(result);
    setBusyId(null);
    if (!result.error) await refresh();
  };

  return (
    <div className="flex flex-col gap-6" data-testid="coach-lighting-view">
      <section aria-labelledby="coach-lighting-request-heading">
        <h2
          id="coach-lighting-request-heading"
          className="text-base font-bold text-text-primary mb-1"
        >
          Request portable lighting
        </h2>
        <p className="text-sm text-text-muted mb-3">
          Ask for dates on which your practice slot has portable lights, so the scheduler does not
          cut it for sunset. A request is not in force until an admin approves it.
        </p>
        {coachedSlots.length === 0 ? (
          <p className="text-sm text-text-muted m-0" data-testid="coach-lighting-no-slots">
            None of your current teams has a practice slot, so there is nothing to request lighting
            for.
          </p>
        ) : (
          <OverrideWindowForm
            idBase="coach-lighting"
            legend="New request"
            slots={coachedSlots}
            fieldNames={context.fieldNames}
            submitLabel="Request lighting override"
            onSubmit={submit}
            disabled={Boolean(error) || loading}
          />
        )}
      </section>
      <LightingLoadError error={error} what="lighting overrides" />
      {!error && !loading && (
        <>
          <section aria-labelledby="coach-lighting-mine-heading">
            <h2
              id="coach-lighting-mine-heading"
              className="text-base font-bold text-text-primary mb-3"
            >
              Your requests
            </h2>
            <ActionMessage outcome={outcome} />
            <OverrideTable
              caption="Your lighting override requests"
              rows={mine}
              slotById={slotById}
              fieldNames={context.fieldNames}
              emptyText="You have not requested any lighting overrides."
              onWithdraw={withdraw}
              busyId={busyId}
            />
          </section>
          <section aria-labelledby="coach-lighting-others-heading">
            <h2
              id="coach-lighting-others-heading"
              className="text-base font-bold text-text-primary mb-3"
            >
              Other overrides on your slots
            </h2>
            <OverrideTable
              caption="Lighting overrides on your slots requested or set by someone else"
              rows={others}
              slotById={slotById}
              fieldNames={context.fieldNames}
              emptyText="No one else has requested lighting on your slots."
            />
          </section>
        </>
      )}
    </div>
  );
}

CoachLightingRequests.propTypes = {
  orgId: PropTypes.string.isRequired,
  userId: PropTypes.string.isRequired,
  toast: PropTypes.func.isRequired,
};
