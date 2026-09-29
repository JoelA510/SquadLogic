import React, { Suspense, lazy, useId, useState } from 'react';
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
 * 8.6 3b PR 11c: the field card of a RETIRED field opens it too, with the
 * loss built from the stored `effective_to`. `preview` marks the retirement
 * dialog's dry run: the panel then disables every Enact button (Q3).
 *
 * @param {{ loss: Object, subject: string, preview?: boolean, label?: string }} props - `loss`
 *   in the adapter's shape: `{kind:'retirement', field}` or `{kind:'blackout', blackout}`
 */
export default function PracticeRepairLauncher({ loss, subject, preview = false, label = null }) {
  const { can } = usePermission();
  const isAdmin = can(PERMISSIONS.MANAGE_ORGANIZATION);
  const [open, setOpen] = useState(false);
  // A retired field's card holds one launcher each, so the region is per launcher.
  const regionId = `practice-repair-region${useId().replace(/:/g, '')}`;

  return (
    <div data-testid="practice-repair-launcher" className="mt-2">
      <Button
        variant="secondary"
        size="sm"
        disabled={!isAdmin}
        aria-expanded={open}
        aria-controls={open ? regionId : undefined}
        aria-describedby={isAdmin ? undefined : 'practice-repair-admin-only'}
        onClick={() => setOpen((value) => !value)}
      >
        {open
          ? 'Hide practice repair recommendations'
          : (label ?? 'Show practice repair recommendations')}
      </Button>
      {!isAdmin && (
        <p id="practice-repair-admin-only" className="text-sm">
          Only an organization admin can see practice repair recommendations.
        </p>
      )}
      {open && isAdmin && (
        <div id={regionId}>
          <Suspense
            fallback={
              <p className="text-sm" role="status">
                Loading the practice repair…
              </p>
            }
          >
            <PracticeRepairPanel
              loss={loss}
              subject={subject}
              isAdmin={isAdmin}
              preview={preview}
            />
          </Suspense>
        </div>
      )}
    </div>
  );
}

PracticeRepairLauncher.propTypes = {
  loss: PropTypes.object.isRequired,
  subject: PropTypes.string.isRequired,
  preview: PropTypes.bool,
  label: PropTypes.string,
};
