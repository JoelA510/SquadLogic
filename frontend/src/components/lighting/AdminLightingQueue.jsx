import React, { useState } from 'react';
import PropTypes from 'prop-types';
import Button from '../ui/Button.jsx';
import {
  decideLightingOverride,
  setLightingOverride,
  useLightingSlotContext,
  usePracticeLightingOverrides,
  withdrawLightingOverride,
} from '../../hooks/usePracticeLightingOverrides.js';
import {
  ActionMessage,
  LightingLoadError,
  NoLightsOffNote,
  OverrideTable,
  OverrideWindowForm,
  outcomeOf,
} from './LightingOverrideFields.jsx';

const NOTE_ID = 'lighting-no-lights-off-note';
const SELF_REASON =
  'You requested this, so you cannot decide it. Another admin must decide it, or withdraw it.';

/**
 * The admin view: the organization's requested overrides (approve or reject),
 * the approved ones (withdraw), and a direct set. An admin never decides their
 * own request: the controls are disabled with the reason, and the decide RPC
 * refuses it anyway.
 */
export default function AdminLightingQueue({ orgId, userId, toast }) {
  const context = useLightingSlotContext(orgId, { userId, coachScoped: false });
  const { rows, loading, loaded, error, refresh } = usePracticeLightingOverrides(orgId, {
    enabled: !context.loading && !context.error,
  });
  // One flag for every row: while any decision or withdrawal runs, all row
  // actions are disabled, so no second click can race the first.
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState(/** @type {any} */ (null));

  if (context.loading) {
    return <p className="text-sm text-text-muted">Loading practice slots…</p>;
  }
  if (context.error) {
    return <LightingLoadError error={context.error} what="practice slots" />;
  }

  const coachNames = new Map(
    context.coaches
      .filter((coach) => coach.user_id)
      .map((coach) => [String(coach.user_id), coach.full_name])
  );
  const requesterName = (row) =>
    String(row.requested_by) === String(userId)
      ? 'You'
      : (coachNames.get(String(row.requested_by)) ?? 'Another user (no coach record)');
  const labelOf = (row) => context.slotLabels.get(String(row.practice_slot_id)) ?? 'Unknown slot';
  const pending = rows.filter((row) => row.status === 'requested');
  const approved = rows.filter((row) => row.status === 'approved');

  const act = async (action, message) => {
    setBusy(true);
    const result = await outcomeOf(action, message);
    setOutcome(result);
    try {
      if (!result.error) {
        toast(result.message, 'success');
        await refresh();
      }
    } finally {
      // Held through the refresh, so a decided row cannot be decided twice.
      setBusy(false);
    }
  };

  const setDirect = async (window) => {
    const result = await outcomeOf(() => setLightingOverride(window), 'Lighting override set.');
    if (!result.error) {
      toast(result.message, 'success');
      await refresh();
    }
    return result;
  };

  return (
    <div className="flex flex-col gap-6" data-testid="admin-lighting-view" aria-busy={loading}>
      <LightingLoadError error={error} what="lighting overrides" />
      {!error && loaded && (
        <>
          <section aria-labelledby="admin-lighting-pending-heading">
            <h2
              id="admin-lighting-pending-heading"
              className="text-base font-bold text-text-primary mb-1"
            >
              Requests awaiting a decision ({pending.length})
            </h2>
            <div className="mb-3">
              <NoLightsOffNote id={NOTE_ID} />
            </div>
            <ActionMessage outcome={outcome} testId="lighting-list" />
            {pending.length === 0 ? (
              <p className="text-sm text-text-muted m-0">No requests are waiting.</p>
            ) : (
              <div className="grid-wrap">
                <table className="grid">
                  <caption className="sr-only">
                    Lighting override requests awaiting a decision
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Slot</th>
                      <th scope="col">First date</th>
                      <th scope="col">Last date</th>
                      <th scope="col">Requested by</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pending.map((row) => {
                      const label = labelOf(row);
                      const what = `the request for ${label} from ${row.from} to ${row.until}`;
                      const own = String(row.requested_by) === String(userId);
                      const reasonId = `lighting-self-${row.id}`;
                      return (
                        <tr key={row.id} data-testid="lighting-pending-row">
                          <td>
                            <div className="cell">{label}</div>
                          </td>
                          <td>
                            <div className="cell whitespace-nowrap">{row.from}</div>
                          </td>
                          <td>
                            <div className="cell whitespace-nowrap">{row.until}</div>
                          </td>
                          <td>
                            <div className="cell">{requesterName(row)}</div>
                          </td>
                          <td>
                            <div className="cell flex-wrap gap-2 py-1">
                              <Button
                                size="sm"
                                variant="primary"
                                disabled={own || busy}
                                aria-label={`Approve ${what}`}
                                aria-describedby={own ? `${reasonId} ${NOTE_ID}` : NOTE_ID}
                                onClick={() =>
                                  act(
                                    () =>
                                      decideLightingOverride({ id: row.id, decision: 'approve' }),
                                    'Lighting override approved.'
                                  )
                                }
                              >
                                Approve
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost-danger"
                                disabled={own || busy}
                                aria-label={`Reject ${what}`}
                                aria-describedby={own ? reasonId : undefined}
                                onClick={() =>
                                  act(
                                    () =>
                                      decideLightingOverride({ id: row.id, decision: 'reject' }),
                                    'Lighting override rejected.'
                                  )
                                }
                              >
                                Reject
                              </Button>
                              {own && (
                                <>
                                  <Button
                                    size="sm"
                                    variant="secondary"
                                    disabled={busy}
                                    aria-label={`Withdraw ${what}`}
                                    onClick={() =>
                                      act(
                                        () => withdrawLightingOverride({ id: row.id }),
                                        'Lighting override withdrawn.'
                                      )
                                    }
                                  >
                                    Withdraw
                                  </Button>
                                  <span
                                    id={reasonId}
                                    className="text-xs text-text-muted"
                                    data-testid="lighting-self-decide-reason"
                                  >
                                    {SELF_REASON}
                                  </span>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section aria-labelledby="admin-lighting-approved-heading">
            <h2
              id="admin-lighting-approved-heading"
              className="text-base font-bold text-text-primary mb-3"
            >
              Approved overrides ({approved.length})
            </h2>
            <OverrideTable
              caption="Approved lighting overrides"
              rows={approved}
              slotLabels={context.slotLabels}
              emptyText="No approved overrides."
              rowTestId="lighting-approved-row"
              onWithdraw={(row) =>
                act(() => withdrawLightingOverride({ id: row.id }), 'Lighting override withdrawn.')
              }
              canWithdraw={() => true}
              busy={busy}
            />
          </section>

          <section aria-labelledby="admin-lighting-set-heading">
            <h2
              id="admin-lighting-set-heading"
              className="text-base font-bold text-text-primary mb-3"
            >
              Set an override directly
            </h2>
            {context.slots.length === 0 ? (
              <p className="text-sm text-text-muted m-0">
                This organization has no practice slots.
              </p>
            ) : (
              <OverrideWindowForm
                idBase="admin-lighting-set"
                legend="Approved on save"
                slots={context.slots}
                slotLabels={context.slotLabels}
                submitLabel="Set lighting override"
                onSubmit={setDirect}
                describedBy={NOTE_ID}
              />
            )}
          </section>
        </>
      )}
    </div>
  );
}

AdminLightingQueue.propTypes = {
  orgId: PropTypes.string.isRequired,
  userId: PropTypes.string.isRequired,
  toast: PropTypes.func.isRequired,
};
