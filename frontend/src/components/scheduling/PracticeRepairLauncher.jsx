import React, { Suspense, lazy, useState } from 'react';
import PropTypes from 'prop-types';
import { usePermission } from '../../hooks/usePermission.js';
import { PERMISSIONS } from '../../constants/permissions.js';
import Button from '../ui/Button.jsx';

// Lazy: the repair, its search and the adapter are only loaded when an admin
// asks for recommendations, never with the page that hosts the dialog.
const PracticeRepairPanel = lazy(() => import('./PracticeRepairPanel.jsx'));

/**
 * The button that opens the practice repair recommendation panel (8.6 3b
 * PR 10), shared by the field retirement dialog and the blackout editor so the
 * two arms have one contract. Admin-only: anyone else sees the button
 * disabled with the reason beside it.
 *
 * @param {{ loss: Object, subject: string }} props - `loss` in the adapter's
 *   shape: `{kind:'retirement', field}` or `{kind:'blackout', blackout}`
 */
export default function PracticeRepairLauncher({ loss, subject }) {
  const { can } = usePermission();
  const isAdmin = can(PERMISSIONS.MANAGE_ORGANIZATION);
  const [open, setOpen] = useState(false);

  return (
    <div data-testid="practice-repair-launcher" style={{ marginTop: 10 }}>
      <Button
        variant="secondary"
        size="sm"
        disabled={!isAdmin}
        aria-expanded={open}
        aria-controls={open ? 'practice-repair-region' : undefined}
        aria-describedby={isAdmin ? undefined : 'practice-repair-admin-only'}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? 'Hide practice repair recommendations' : 'Show practice repair recommendations'}
      </Button>
      {!isAdmin && (
        <p id="practice-repair-admin-only" className="text-sm">
          Only an organization admin can see practice repair recommendations.
        </p>
      )}
      {open && isAdmin && (
        <div id="practice-repair-region">
          <Suspense
            fallback={
              <p className="text-sm" role="status">
                Loading the practice repair…
              </p>
            }
          >
            <PracticeRepairPanel loss={loss} subject={subject} />
          </Suspense>
        </div>
      )}
    </div>
  );
}

PracticeRepairLauncher.propTypes = {
  loss: PropTypes.object.isRequired,
  subject: PropTypes.string.isRequired,
};
