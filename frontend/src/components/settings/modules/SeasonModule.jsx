import React, { useState } from 'react';
import { useTheme } from '../../../contexts/ThemeContext.jsx';
import { useAuth } from '../../../contexts/AuthContext.jsx';
import { useOrganization } from '../../../contexts/OrganizationContext.jsx';
import { supabase } from '../../../lib/supabaseClient.js';

/**
 * The zones this control offers by name.
 *
 * It is a shortlist, not the domain. `season_settings.timezone` holds any IANA
 * name the server recognises: `initialize_new_tenant` stores whatever
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` reported in the admin's
 * browser, and 20260913000000's backfill copies `organizations.contact_info`
 * verbatim. A season on `Europe/London` therefore has a perfectly good clock
 * and no option to render it against -- the select showed **blank**, and
 * `!timezone` is false so the "Not set" hint did not fire either. The operator
 * saw an empty control over a season that was working.
 *
 * `OrganizationCreation.jsx` already answers this by injecting an option for an
 * out-of-list value; that contract is adopted below rather than a third one
 * invented.
 */
const SEASON_TIMEZONE_OPTIONS = Object.freeze([
  { value: 'America/Los_Angeles', label: 'Pacific Time (US & Canada)' },
  { value: 'America/Denver', label: 'Mountain Time (US & Canada)' },
  { value: 'America/Chicago', label: 'Central Time (US & Canada)' },
  { value: 'America/New_York', label: 'Eastern Time (US & Canada)' },
  { value: 'UTC', label: 'UTC' },
]);

export default function SeasonModule() {
  const { currentSeason, updateCurrentSeason, availableSeasons } = useTheme();
  const { user, isImpersonating } = useAuth();
  // **`season_settings.timezone`, not the ThemeContext copy.** That copy is
  // localStorage-backed and ThemeContext's own header calls it legacy state
  // slated for removal. Until GAP-30 it was the only thing this control wrote,
  // so the column three surfaces read had no writer at all and every season
  // read as having no clock.
  //
  // The select renders straight from the season row and `refetchOrgs()` is the
  // update. No local mirror of the value: a copy held in context state and a
  // column in the database are two answers to "what is this season's clock",
  // and they disagree for exactly as long as a refetch is in flight. That is
  // the same second-source-of-truth this gap is made of, one layer up.
  const { currentOrganization, currentSeasonSetting, refetchOrgs } = useOrganization();
  const timezone = currentSeasonSetting?.timezone ?? '';

  const [seasonFormat, setSeasonFormat] = useState('single');
  const [localCurrentSeason, setLocalCurrentSeason] = useState(currentSeason);
  const [timezoneError, setTimezoneError] = useState(null);
  const [timezoneSaving, setTimezoneSaving] = useState(false);

  return (
    <div className="space-y-6 animate-fadeIn">
      <div>
        <p id="season-format-label" className="block text-sm font-medium text-text-secondary mb-2">
          Season Naming Format
        </p>
        <div className="grid grid-cols-2 gap-4" role="group" aria-labelledby="season-format-label">
          <button
            type="button"
            aria-pressed={seasonFormat === 'single'}
            onClick={async () => {
              setSeasonFormat('single');
              const orgId = user?.profile?.organization_id;
              if (orgId) {
                await supabase.rpc('record_audit_event', {
                  p_organization_id: orgId,
                  p_action: 'settings.season_format_updated',
                  p_metadata: {
                    format: 'single',
                    ...(isImpersonating && {
                      target_user_id: user.profile.id,
                      impersonated_by: user.id,
                      admin_email: user.email,
                    }),
                  },
                });
              }
            }}
            className={`p-4 rounded-lg border text-left transition-all ${
              seasonFormat === 'single'
                ? 'bg-brand-glow border-brand-400 text-text-primary'
                : 'bg-bg-surface border-border-subtle text-text-muted hover:bg-bg-surface-hover'
            }`}
          >
            <div className="font-medium mb-1">Single Year</div>
            <div className="text-xs opacity-70">e.g., &quot;2025&quot;, &quot;2026&quot;</div>
          </button>
          <button
            type="button"
            aria-pressed={seasonFormat === 'dual'}
            onClick={async () => {
              setSeasonFormat('dual');
              const orgId = user?.profile?.organization_id;
              if (orgId) {
                await supabase.rpc('record_audit_event', {
                  p_organization_id: orgId,
                  p_action: 'settings.season_format_updated',
                  p_metadata: {
                    format: 'dual',
                    ...(isImpersonating && {
                      target_user_id: user.profile.id,
                      impersonated_by: user.id,
                      admin_email: user.email,
                    }),
                  },
                });
              }
            }}
            className={`p-4 rounded-lg border text-left transition-all ${
              seasonFormat === 'dual'
                ? 'bg-brand-glow border-brand-400 text-text-primary'
                : 'bg-bg-surface border-border-subtle text-text-muted hover:bg-bg-surface-hover'
            }`}
          >
            <div className="font-medium mb-1">Dual Year</div>
            <div className="text-xs opacity-70">e.g., &quot;2025-2026&quot;</div>
          </button>
        </div>
      </div>

      <div>
        <label
          htmlFor="current-season-label"
          className="block text-sm font-medium text-text-secondary mb-2"
        >
          Current Season Label
        </label>
        <div className="space-y-3">
          <div className="relative">
            <input
              id="current-season-label"
              type="text"
              value={localCurrentSeason}
              onChange={(e) => setLocalCurrentSeason(e.target.value)}
              onBlur={async () => {
                updateCurrentSeason(localCurrentSeason);
                const orgId = user?.profile?.organization_id;
                if (orgId) {
                  await supabase.rpc('record_audit_event', {
                    p_organization_id: orgId,
                    p_action: 'settings.season_updated',
                    p_metadata: {
                      season: localCurrentSeason,
                      ...(isImpersonating && {
                        target_user_id: user.profile.id,
                        impersonated_by: user.id,
                        admin_email: user.email,
                      }),
                    },
                  });
                }
              }}
              className="w-full bg-bg-surface border border-border-subtle rounded-lg px-4 py-3 text-text-primary focus:outline-none focus:border-brand-400 transition-colors"
              placeholder={seasonFormat === 'single' ? '2025' : '2025-2026'}
            />
            {availableSeasons.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {availableSeasons.map((season) => (
                  <button
                    key={season}
                    type="button"
                    aria-pressed={localCurrentSeason === season}
                    aria-label={`Select ${season} as current season`}
                    onClick={() => {
                      setLocalCurrentSeason(season);
                      updateCurrentSeason(season);
                    }}
                    className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                      localCurrentSeason === season
                        ? 'bg-brand-500/20 text-brand-400 border-brand-500/30'
                        : 'bg-bg-surface text-text-muted border-border-subtle hover:bg-bg-surface-hover'
                    }`}
                  >
                    {season}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <label
            htmlFor="season-timezone"
            className="block text-sm font-medium text-text-secondary mb-2"
          >
            Timezone
          </label>
          <select
            id="season-timezone"
            value={timezone}
            disabled={timezoneSaving || !currentSeasonSetting?.id}
            aria-describedby={timezoneError ? 'season-timezone-error' : undefined}
            aria-invalid={timezoneError ? 'true' : undefined}
            onChange={async (e) => {
              const newVal = e.target.value;
              const orgId = currentOrganization?.id ?? user?.profile?.organization_id;
              const seasonId = currentSeasonSetting?.id;
              if (!orgId || !seasonId) {
                setTimezoneError('No active season to set a timezone on.');
                return;
              }
              setTimezoneSaving(true);
              setTimezoneError(null);
              // The audit row is written inside the RPC, atomically with the
              // column, rather than beside it from here: a timezone change that
              // is audited but not persisted is the shape this control had.
              //
              // **One row, not two.** Under impersonation this used to fire a
              // second `record_audit_event` of the SAME action beside the RPC,
              // and neither row was complete -- the RPC's carried
              // `previous_timezone` and nothing about the impersonation, the
              // client's carried the impersonation and nothing about what the
              // value had been. `p_actor_context` (20260917000000) carries the
              // one fact the server cannot know, the profile being viewed as;
              // the RPC derives `impersonated_by` from `auth.uid()` and the
              // admin's email from `profiles`, because a client-asserted actor
              // in an audit row is decoration.
              const { error } = await supabase.rpc('admin_set_season_timezone', {
                p_organization_id: orgId,
                p_season_settings_id: seasonId,
                p_timezone: newVal,
                p_actor_context: isImpersonating
                  ? { target_user_id: user?.profile?.id ?? null }
                  : {},
              });
              setTimezoneSaving(false);
              if (error) {
                // Surface it. The previous version could not fail, because it
                // never reached the database.
                setTimezoneError(error.message || 'Season timezone could not be saved.');
                return;
              }
              refetchOrgs();
            }}
            className="w-full bg-bg-surface border border-border-subtle rounded-lg px-4 py-3 text-text-primary focus:outline-none focus:border-brand-400 transition-colors"
          >
            {/* An unset season has no clock and the game scheduler refuses
                (GAP-30), so the empty state is named rather than defaulted to a
                zone nobody chose. */}
            {!timezone && <option value="">Not set — game scheduling is disabled</option>}
            {/* A stored zone the shortlist does not carry gets its own option,
                the same contract OrganizationCreation.jsx uses. Without it the
                control renders blank over a season that has a clock. */}
            {timezone && !SEASON_TIMEZONE_OPTIONS.some((tz) => tz.value === timezone) && (
              <option value={timezone}>{timezone}</option>
            )}
            {SEASON_TIMEZONE_OPTIONS.map((tz) => (
              <option key={tz.value} value={tz.value}>
                {tz.label}
              </option>
            ))}
          </select>
          {timezoneError && (
            <p id="season-timezone-error" role="alert" className="mt-2 text-sm text-danger">
              {timezoneError}
            </p>
          )}
        </div>

        <div>
          <label
            htmlFor="school-day-end"
            className="block text-sm font-medium text-text-secondary mb-2"
          >
            School Day End (Earliest Practice)
          </label>
          <input
            id="school-day-end"
            type="time"
            defaultValue="16:00"
            className="w-full bg-bg-surface border border-border-subtle rounded-lg px-4 py-3 text-text-primary focus:outline-none focus:border-brand-400 transition-colors"
          />
        </div>
      </div>
    </div>
  );
}
