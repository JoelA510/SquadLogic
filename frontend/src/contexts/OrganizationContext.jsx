import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { useAuth } from './AuthContext.jsx';
import { ROLE_PERMISSIONS, isAdminRole } from '../constants/permissions.js';
import {
  chooseCurrentSeason,
  orderSeasons,
  readStoredSeasonId,
  visibleSeasons,
  writeStoredSeasonId,
} from '../utils/seasonSelection.js';
import { logger } from '../lib/logger.js';
import { FeatureFlagSchema } from '../constants/featureFlags.js';

/**
 * @typedef {Object} OrganizationContextValue
 * @property {any[]} organizations
 * @property {any} currentOrganization
 * @property {any} orgMember
 * @property {any[]} availableSeasons - season_settings rows for the current org, active
 *   first; drafts are listed for admins and staff only
 * @property {any} currentSeasonSetting - the season the pages show: the organization's one
 *   active season, or a draft an admin chose (E1; never "the newest")
 * @property {boolean} loading
 * @property {boolean} seasonSettingsLoading - true while the season_settings
 *   read for the CURRENT organization is in flight. Distinct from `loading`,
 *   which gates `ProtectedRoute` and therefore unmounts the page: an
 *   organization switch must not do that, but it does leave
 *   `currentSeasonSetting` stale or null for as long as the fetch takes, and a
 *   consumer that reads the season's clock has to be able to tell "not yet"
 *   from "there is none".
 * @property {Error | null} fetchError - surfaces org-fetch failures to AppContent
 * @property {(preferredOrgId?: string) => void} refetchOrgs - re-runs the initial
 *   organization_members fetch; given an organization id (a redeemed invite's), makes it the active one
 * @property {function} switchOrganization
 * @property {function} switchSeason
 * @property {function} updateFeatureFlags - persistence via secure RPC
 * @property {Object} featureFlags
 * @property {string[]} [permissions]
 */

/**
 * Tag future error reports with the active organization (M1.5): the user's ID,
 * the organization's ID and the role held in it. IDs only; `logger.setUser`
 * drops anything else.
 * @param {string} userId
 * @param {{ organization_id: string, role?: string }} member
 */
function reportActiveOrganization(userId, member) {
  logger.setUser({ id: userId, organization_id: member.organization_id, role: member.role });
}

/** @type {React.Context<OrganizationContextValue>} React context for sharing organization and season state. */
const OrganizationContext = createContext({});

/**
 * Hook for accessing the organization context.
 * @returns {OrganizationContextValue}
 */
export const useOrganization = () => useContext(OrganizationContext);

export const OrganizationProvider = ({ children }) => {
  const { user } = useAuth();
  const [organizations, setOrganizations] = useState([]);
  const [currentOrganization, setCurrentOrganization] = useState(null);
  const [orgMember, setOrgMember] = useState(null);
  const [availableSeasons, setAvailableSeasons] = useState([]);
  const [currentSeasonSetting, setCurrentSeasonSetting] = useState(null);
  const [loading, setLoading] = useState(true);
  // **A second, narrower flag, and not a widening of `loading`.** `loading`
  // gates `ProtectedRoute`, so raising it around an organization switch would
  // unmount whatever page the operator is on. `switchOrganization()` swaps
  // `currentOrganization` synchronously and then awaits the season read, so
  // between those two the held season row belongs to the organization just
  // left -- or, if that one had no season, is null while the new one's is on
  // its way. A consumer reading `currentSeasonSetting?.timezone` cannot tell
  // either state from "this season has no clock", and GameSchedulingPage was
  // telling the operator to set a timezone that was already set.
  const [seasonSettingsLoading, setSeasonSettingsLoading] = useState(false);
  // Surfaced so AppContent can render a diagnostic instead of hanging on a
  // stuck LoadingScreen when the initial org fetch fails (e.g. stale RLS
  // policy returning 500 before the latest migration is applied).
  const [fetchError, setFetchError] = useState(null);
  const [refetchTick, setRefetchTick] = useState(0);
  // With an organization id, that organization becomes the active one when the refetch lands: an
  // admin who redeems an invite to a second organization is taken into it, not left in the first
  // (the refetch otherwise prefers the stored one). Anything that is not an id (a click event
  // handed straight to this function) is ignored.
  const refetchOrgs = useCallback((preferredOrgId) => {
    if (typeof preferredOrgId === 'string' && preferredOrgId) {
      try {
        localStorage.setItem('squadlogic_active_org', preferredOrgId);
      } catch (err) {
        // Storage blocked (private window): the refetch keeps the current organization.
        logger.warn('Could not store the active organization', err);
      }
    }
    setRefetchTick((n) => n + 1);
  }, []);

  // Fetch season_settings for a given organization.
  //
  // Accepts an optional `isCancelled` predicate (default: always false) so the
  // caller can propagate its own lifecycle signal — see the useEffect below.
  // Every setState after the await is guarded, so a stale response (from a
  // prior user / prior refetch / unmount) cannot clobber fresh state.
  /** @type {(orgId: string, isCancelled?: () => boolean, role?: string | null) => Promise<void>} */
  const fetchSeasonsForOrg = useCallback(async (orgId, isCancelled = () => false, role = null) => {
    setSeasonSettingsLoading(true);
    try {
      const { data, error } = await supabase
        .from('season_settings')
        .select('*')
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false });

      if (isCancelled()) return;
      if (error) throw error;

      // Phase E1: the current season is the organization's one active season. A stored choice
      // (an id, in its own key) is honoured when it is that season, or a draft an admin or
      // staff member chose; a draft is nobody else's to open. Never the newest season.
      const canSeeDrafts = isAdminRole(role);
      const rows = visibleSeasons(data, canSeeDrafts);
      setAvailableSeasons(orderSeasons(rows));
      setCurrentSeasonSetting(chooseCurrentSeason(rows, readStoredSeasonId(), canSeeDrafts));
    } catch (err) {
      if (isCancelled()) return;
      logger.error('Error fetching season_settings:', err);
      setAvailableSeasons([]);
      setCurrentSeasonSetting(null);
    } finally {
      // Lowered even when cancelled. A cancelled fetch is one a newer fetch
      // has already superseded, and that newer one raised the flag again on
      // its own way in; leaving it raised here would strand every consumer on
      // "still loading" for the rest of the session.
      setSeasonSettingsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!user) {
      setOrganizations([]);
      setCurrentOrganization(null);
      setOrgMember(null);
      setAvailableSeasons([]);
      setCurrentSeasonSetting(null);
      return;
    }

    // Cancellation flag addresses the race documented in Gemini PR #178:
    // if refetchOrgs is triggered multiple times OR the effect re-runs
    // (user change, refetchTick bump) OR the provider unmounts while the
    // fetch is in flight, responses can resolve out of order. Any setState
    // after an await short-circuits when `cancelled` is true so a stale
    // response can't overwrite fresher state.
    let cancelled = false;
    const isCancelled = () => cancelled;

    const fetchOrgs = async () => {
      setLoading(true);
      setFetchError(null);
      try {
        const { data, error } = await supabase
          .from('organization_members')
          .select('*, organizations(*)')
          .eq('profile_id', user.id);

        if (cancelled) return;
        if (error) throw error;

        if (data && data.length > 0) {
          setOrganizations(data);

          const storedOrgId = localStorage.getItem('squadlogic_active_org');
          const validOrgIds = data.map((m) => m.organization_id);
          const matchedMember =
            storedOrgId && validOrgIds.includes(storedOrgId)
              ? data.find((m) => m.organization_id === storedOrgId)
              : null;

          if (matchedMember) {
            setCurrentOrganization(matchedMember.organizations);
            setOrgMember({ role: matchedMember.role, ...matchedMember });
            reportActiveOrganization(user.id, matchedMember);
            await fetchSeasonsForOrg(
              matchedMember.organization_id,
              isCancelled,
              matchedMember.role
            );
          } else {
            const first = data[0];
            setCurrentOrganization(first.organizations);
            setOrgMember({ role: first.role, ...first });
            reportActiveOrganization(user.id, first);
            localStorage.setItem('squadlogic_active_org', first.organization_id);
            await fetchSeasonsForOrg(first.organization_id, isCancelled, first.role);
          }
        }
      } catch (err) {
        if (cancelled) return;
        logger.error('Error fetching organizations:', err);
        setFetchError(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchOrgs();

    return () => {
      cancelled = true;
    };
  }, [user, fetchSeasonsForOrg, refetchTick]);

  const switchOrganization = useCallback(
    async (orgId) => {
      const match = organizations.find((m) => m.organization_id === orgId);
      if (match) {
        setCurrentOrganization(match.organizations);
        setOrgMember({ role: match.role, ...match });
        if (user?.id) reportActiveOrganization(user.id, match);
        localStorage.setItem('squadlogic_active_org', orgId);
        await fetchSeasonsForOrg(orgId, undefined, match.role);
      }
    },
    [organizations, fetchSeasonsForOrg, user?.id]
  );

  const switchSeason = useCallback((seasonSetting) => {
    setCurrentSeasonSetting(seasonSetting);
    // The id, never the name (E1): a name is free text and not the season's identity.
    writeStoredSeasonId(seasonSetting?.id ?? null);
  }, []);

  /**
   * Updates organization feature flags via secure RPC.
   * Mandated by Governance Framework for Phase 2.
   * @param {Object} newFlags
   */
  const updateFeatureFlags = useCallback(
    async (newFlags) => {
      if (!currentOrganization) {
        logger.error('Cannot update feature flags: No organization selected');
        return { success: false, error: 'No organization selected' };
      }

      try {
        // Validate flags before transmission
        const validatedFlags = FeatureFlagSchema.parse(newFlags);

        const { error } = await supabase.rpc('update_org_feature_flags', {
          p_org_id: currentOrganization.id,
          p_flags: validatedFlags,
        });

        if (error) throw error;

        // Update local state to reflect changes immediately
        setCurrentOrganization((prev) => ({
          ...prev,
          feature_flags: validatedFlags,
        }));

        logger.info('Feature flags updated successfully via RPC');
        return { success: true };
      } catch (err) {
        logger.error('Failed to update feature flags via RPC:', err);
        return { success: false, error: err.message };
      }
    },
    [currentOrganization]
  );

  // Tag error reports from a demo (D4): set while the active organization is a demo, cleared when
  // it changes to a real one or to none (sign-out is cleared in AuthContext too).
  const activeIsDemo = Boolean(currentOrganization?.demo_expires_at);
  useEffect(() => {
    logger.setDemoContext(activeIsDemo);
  }, [activeIsDemo, currentOrganization?.id]);

  // Memoize validated feature flags based on the current organization's data.
  // Using Option B: Selective Ignore via Zod transform.
  const validatedFeatureFlags = useMemo(() => {
    try {
      const rawFlags = currentOrganization?.feature_flags || {};
      return FeatureFlagSchema.parse(rawFlags);
    } catch (err) {
      logger.error('[FeatureFlag] Validation failed, falling back to empty flags:', err);
      return {};
    }
  }, [currentOrganization?.feature_flags]);

  // Memoize permissions separately for stability
  const permissions = useMemo(() => {
    return orgMember?.role ? ROLE_PERMISSIONS[orgMember.role] || [] : [];
  }, [orgMember?.role]);

  const value = useMemo(
    () => ({
      organizations,
      currentOrganization,
      orgMember,
      availableSeasons,
      currentSeasonSetting,
      loading,
      seasonSettingsLoading,
      fetchError,
      refetchOrgs,
      switchOrganization,
      switchSeason,
      updateFeatureFlags,
      featureFlags: validatedFeatureFlags,
      permissions,
    }),
    [
      organizations,
      currentOrganization,
      orgMember,
      availableSeasons,
      currentSeasonSetting,
      loading,
      seasonSettingsLoading,
      fetchError,
      refetchOrgs,
      switchOrganization,
      switchSeason,
      updateFeatureFlags,
      validatedFeatureFlags,
      permissions,
    ]
  );

  return <OrganizationContext.Provider value={value}>{children}</OrganizationContext.Provider>;
};
