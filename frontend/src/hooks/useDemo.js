import { useMemo } from 'react';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { demoExpiryMs, isDemoOrganization } from '../lib/demo.js';

/**
 * Is the active organization a demo (D4)? `expiresAtMs` is the server's expiry as epoch
 * milliseconds; both are derived from the organization row, so a page that hides a control for a
 * demo and the header's timer cannot disagree.
 * @returns {{ isDemo: boolean, expiresAtMs: number | null }}
 */
export function useDemo() {
  const { currentOrganization } = useOrganization();
  return useMemo(
    () => ({
      isDemo: isDemoOrganization(currentOrganization),
      expiresAtMs: demoExpiryMs(currentOrganization),
    }),
    [currentOrganization]
  );
}
