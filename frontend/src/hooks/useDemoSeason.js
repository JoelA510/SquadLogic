import { useEffect, useState } from 'react';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { isDemoOrganization } from '../lib/demo.js';
import { logger } from '../lib/logger.js';
import { supabase } from '../lib/supabaseClient.js';

/**
 * The season the active demo was started in (plan docs/changes/2026-11-01-demo-season-selection.md):
 * `'Fall'` or `'Spring'`, read once from the demo's own season row, which `start_demo_session` wrote
 * (its label is the choice; its name is `Fall 2027`). `null` outside a demo, while the row is being
 * read, when it cannot be read, and for a demo started before the choice existed (its label is
 * `2026 Season`, not a choice): the banner then simply says nothing about a season.
 *
 * It asks the server rather than remembering the choice in the browser, so a reload of the page
 * names the same season the dates show.
 * @returns {'Fall' | 'Spring' | null}
 */
export function useDemoSeason() {
  const { currentOrganization } = useOrganization();
  const demoId = isDemoOrganization(currentOrganization) ? currentOrganization.id : null;
  const [read, setRead] = useState(
    /** @type {{ demoId: string, label: 'Fall' | 'Spring' | null } | null} */ (null)
  );

  useEffect(() => {
    if (!demoId) return undefined;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('season_settings')
        .select('season_label')
        .eq('organization_id', demoId)
        // The season the demo was started in is its first: a visitor who starts a next season from it
        // (an admin may, in a demo) adds later ones, and none of those is the choice.
        .order('created_at', { ascending: true })
        .limit(1);
      if (cancelled) return;
      if (error) {
        // The banner is a courtesy; the dates are on every page. Say so in the log and go on.
        logger.warn('[Demo] could not read the demo season', error);
        setRead({ demoId, label: null });
        return;
      }
      const label = data?.[0]?.season_label;
      setRead({ demoId, label: label === 'Fall' || label === 'Spring' ? label : null });
    })();
    return () => {
      cancelled = true;
    };
  }, [demoId]);

  // A reading belongs to the demo it was taken for: after the active organization changes, the old
  // label is not shown against the new one.
  return demoId && read?.demoId === demoId ? read.label : null;
}
