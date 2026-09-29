import React, { useState } from 'react';
import PropTypes from 'prop-types';
import {
  requestLightingOverride,
  useLightingSlotContext,
  usePracticeLightingOverrides,
  withdrawLightingOverride,
} from '../../hooks/usePracticeLightingOverrides.js';
import { WITHDRAWABLE_STATUSES } from '../../utils/lightingOverrides.js';
import {
  ActionMessage,
  LightingLoadError,
  OverrideTable,
  OverrideWindowForm,
  outcomeOf,
} from './LightingOverrideFields.jsx';

const canWithdrawOwn = (row) => WITHDRAWABLE_STATUSES.includes(row.status);

/**
 * The coach's view: request a portable-lighting window on a slot they coach,
 * and see and withdraw their own requests. No decision controls: only an admin
 * decides, and the decide RPC refuses anyone else anyway.
 */
export default function CoachLightingRequests({ orgId, userId, toast }) {
  const context = useLightingSlotContext(orgId, { userId, coachScoped: true });
  const { rows, loading, loaded, error, refresh } = usePracticeLightingOverrides(orgId, {
    enabled: !context.loading && !context.error && context.coaches.length > 0,
  });
  const [busy, setBusy] = useState(false);
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
    setBusy(true);
    const result = await outcomeOf(
      () => withdrawLightingOverride({ id: row.id }),
      'Lighting override withdrawn.'
    );
    setOutcome(result);
    try {
      if (!result.error) {
        toast(result.message, 'success');
        await refresh();
      }
    } finally {
      // Held through the refresh, so the row just withdrawn cannot be clicked again.
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6" data-testid="coach-lighting-view" aria-busy={loading}>
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
            slotLabels={context.slotLabels}
            submitLabel="Request lighting override"
            onSubmit={submit}
            disabled={Boolean(error) || !loaded}
          />
        )}
      </section>
      <LightingLoadError error={error} what="lighting overrides" />
      {!error && loaded && (
        <>
          <section aria-labelledby="coach-lighting-mine-heading">
            <h2
              id="coach-lighting-mine-heading"
              className="text-base font-bold text-text-primary mb-3"
            >
              Your requests
            </h2>
            <ActionMessage outcome={outcome} testId="lighting-list" />
            <OverrideTable
              caption="Your lighting override requests"
              rows={mine}
              slotLabels={context.slotLabels}
              emptyText="You have not requested any lighting overrides."
              rowTestId="lighting-override-row"
              onWithdraw={withdraw}
              canWithdraw={canWithdrawOwn}
              busy={busy}
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
              slotLabels={context.slotLabels}
              emptyText="No one else has requested lighting on your slots."
              rowTestId="lighting-override-row"
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
