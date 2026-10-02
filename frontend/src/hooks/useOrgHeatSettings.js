import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_HEAT_CATEGORY, OrgHeatSettingsSchema } from '@squadlogic/core/heat/index.js';
import { supabase } from '../lib/supabaseClient.js';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { logger } from '../lib/logger.js';

/**
 * The organisation's heat forecast settings (`organization_heat_settings`,
 * migration 20261006000000): the U.S. Soccer threshold category and the
 * governing-body guidance links.
 *
 * No row reads as Category 1 with no links, and says so: `source` is
 * `'default'` rather than `'configured'`, so the forecast's provenance never
 * claims an admin chose Category 1 when nobody chose anything.
 *
 * A failed read is an error, not a default: banding against Category 1 because
 * a read failed would show thresholds nobody chose for this organisation.
 *
 * `save` validates with `OrgHeatSettingsSchema` before the RPC; the RPC
 * re-validates and audits.
 */
export function useOrgHeatSettings() {
  const { currentOrganization } = useOrganization() || {};
  const orgId = currentOrganization?.id ?? null;
  const [state, setState] = useState({
    thresholdCategory: DEFAULT_HEAT_CATEGORY,
    guidanceLinks: /** @type {Array<{ label: string, url: string }>} */ ([]),
    source: /** @type {'configured'|'default'} */ ('default'),
    loading: true,
    error: /** @type {string|null} */ (null),
  });
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      if (!orgId) {
        setState((s) => ({ ...s, loading: false, error: null }));
        return;
      }
      setState((s) => ({ ...s, loading: true, error: null }));
      const { data, error } = await supabase
        .from('organization_heat_settings')
        .select('threshold_category, guidance_links')
        .eq('organization_id', orgId)
        .maybeSingle();
      // A later load (an org switch, a save) owns the state now.
      if (request !== requestRef.current) return;
      if (error) throw error;
      if (!data) {
        setState({
          thresholdCategory: DEFAULT_HEAT_CATEGORY,
          guidanceLinks: [],
          source: 'default',
          loading: false,
          error: null,
        });
        return;
      }
      const parsed = OrgHeatSettingsSchema.safeParse({
        thresholdCategory: data.threshold_category,
        guidanceLinks: data.guidance_links ?? [],
      });
      if (!parsed.success) {
        throw new Error(
          `Stored heat settings are invalid: ${parsed.error.issues[0]?.message ?? 'unknown issue'}`
        );
      }
      const { thresholdCategory, guidanceLinks } = /** @type {{ thresholdCategory: 1|2|3,
        guidanceLinks: Array<{ label: string, url: string }> }} */ (parsed.data);
      setState({
        thresholdCategory,
        guidanceLinks,
        source: 'configured',
        loading: false,
        error: null,
      });
    } catch (err) {
      if (request !== requestRef.current) return;
      logger.error('Error fetching heat settings:', err);
      setState((s) => ({
        ...s,
        loading: false,
        error: err?.message || 'Heat settings could not be read.',
      }));
    }
  }, [orgId]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * @param {{ thresholdCategory: 1|2|3, guidanceLinks: Array<{ label: string, url: string }> }} next
   * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
   */
  const save = useCallback(
    async (next) => {
      if (!orgId) return { ok: false, error: 'No active organization.' };
      const parsed = OrgHeatSettingsSchema.safeParse(next);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return { ok: false, error: `${issue.path.join('.') || 'settings'}: ${issue.message}` };
      }
      const { error } = await supabase.rpc('admin_set_org_heat_settings', {
        p_organization_id: orgId,
        p_threshold_category: parsed.data.thresholdCategory,
        p_guidance_links: parsed.data.guidanceLinks,
      });
      if (error) return { ok: false, error: error.message || 'Heat settings could not be saved.' };
      await load();
      return { ok: true };
    },
    [orgId, load]
  );

  return { ...state, save };
}
