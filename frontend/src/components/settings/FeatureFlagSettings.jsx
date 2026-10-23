import React, { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { Check, Layers, Zap, Clock } from 'lucide-react';
import { useOrganization } from '../../contexts/OrganizationContext.jsx';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { supabase } from '../../lib/supabaseClient.js';
import {
  FEATURE_FLAGS,
  FEATURE_CATALOG,
  FEATURE_DEFAULTS,
  GENDER_MODEL_KEY,
  BUDDY_RULE_KEY,
  BUDDY_RULE_CHOICES,
} from '../../constants/featureFlags.js';
import { useFeatures } from '../../hooks/useFeatures.js';
import Toggle from '../ui/Toggle.jsx';
import Modal from '../ui/Modal.jsx';
import Button from '../ui/Button.jsx';
import LoadingScreen from '../LoadingScreen.jsx';

/** Legacy operational flags retained below the feature catalog. */
const ADVANCED_FLAGS = [
  {
    key: FEATURE_FLAGS.ADVANCED_FAIRNESS,
    label: 'Advanced Fairness Evaluation',
    description:
      'Enables multi-weighted metrics for team balancing including commute time and coach experience.',
  },
  {
    key: FEATURE_FLAGS.COACH_OVERLAP_STRICT,
    label: 'Strict Coach Conflict Enforcement',
    description:
      'Prevents any scheduling that results in a coach having overlapping practice slots across multiple teams.',
  },
  {
    key: FEATURE_FLAGS.LIST_VIEW_TOGGLE,
    label: 'Enable Dashboard List View',
    description: 'Allows users to toggle between graphical and tabular views of the dashboard.',
  },
  {
    key: FEATURE_FLAGS.FUZZY_IMPORT_MAPPING,
    label: 'Fuzzy Data Alignment (AI)',
    description:
      'Uses intelligent string matching to automatically align CSV headers with internal data fields.',
  },
];

const FORMAT_OPTIONS = [
  { value: 'split', title: 'Boys / Girls split', examples: ['U8B', 'U8G', 'U10B', 'U10G'] },
  { value: 'coed', title: 'Co-ed (combined)', examples: ['U8', 'U10', 'U12', 'U14'] },
];

/**
 * Feature configuration panel ("FeatureControls" in the design prototype):
 * division format (split/co-ed) cards, the optional-features catalog, and
 * legacy advanced flags. Persists via the audited update_org_feature_flags
 * RPC through OrganizationContext.updateFeatureFlags.
 *
 * When teams already exist, switching the division format asks whether to
 * apply to future placements only or to merge/regenerate now. The
 * regenerate path is wired to the Team Builder engine integration
 * (`onMergeRegenerate` / `onSplitRegenerate`); until a caller provides it,
 * the option is disabled with an explanatory note.
 */
export default function FeatureFlagSettings({
  onMergeRegenerate = null,
  onSplitRegenerate = null,
}) {
  const { updateFeatureFlags, loading, currentOrganization, featureFlags = {} } = useOrganization();
  const { features, genderModel, buddyRule } = useFeatures();
  const { user, isImpersonating } = useAuth();
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [formatPrompt, setFormatPrompt] = useState(null); // 'split' | 'coed' | null
  const [teamsExist, setTeamsExist] = useState(false);

  const orgId = currentOrganization?.id;

  useEffect(() => {
    if (!orgId) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase
          .from('teams')
          .select('id')
          .eq('organization_id', orgId);
        if (!cancelled && !error) setTeamsExist((data || []).length > 0);
      } catch {
        /* leave teamsExist=false */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const audit = async (action, metadata) => {
    if (!orgId) return;
    await supabase.rpc('record_audit_event', {
      p_organization_id: orgId,
      p_action: action,
      p_metadata: {
        user_id: user?.id,
        ...metadata,
        ...(isImpersonating && {
          target_user_id: user?.profile?.id,
          impersonated_by: user?.id,
          admin_email: user?.email,
        }),
      },
    });
  };

  const persist = async (changes, auditAction) => {
    setSaving(true);
    setMessage(null);
    try {
      // FEATURE_DEFAULTS are display-time defaults; persist only the org's
      // explicitly stored flags plus this change, so future default changes
      // still reach orgs that never touched a given toggle.
      const next = { ...featureFlags, ...changes };
      const result = await updateFeatureFlags(next);
      if (result.success) {
        await audit(auditAction, { flags: changes });
        setMessage({ type: 'success', text: 'Feature configuration updated.' });
      } else {
        setMessage({ type: 'error', text: result.error || 'Failed to update features.' });
      }
      return result.success;
    } catch {
      setMessage({ type: 'error', text: 'An unexpected error occurred.' });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = (key, next) => {
    persist({ [key]: next }, 'settings.flags_updated');
  };

  const chooseBuddyRule = (value) => {
    if (value === buddyRule || saving) return;
    persist({ [BUDDY_RULE_KEY]: value }, 'settings.flags_updated');
  };

  const buddyRuleChoice =
    BUDDY_RULE_CHOICES.find((choice) => choice.value === buddyRule) ?? BUDDY_RULE_CHOICES[0];

  const chooseFormat = (value) => {
    if (value === genderModel || saving) return;
    if (teamsExist) {
      setFormatPrompt(value);
      return;
    }
    persist({ [GENDER_MODEL_KEY]: value }, 'settings.gender_model_updated');
  };

  const applyFormat = async (value, moveNow) => {
    setFormatPrompt(null);
    const saved = await persist({ [GENDER_MODEL_KEY]: value }, 'settings.gender_model_updated');
    if (!saved || !moveNow) return;
    const result = value === 'coed' ? await onMergeRegenerate?.() : await onSplitRegenerate?.();
    if (!result) return;
    setMessage(
      result.success
        ? {
            type: 'success',
            text: `Moved ${result.moved} players into their new divisions. Rosters were cleared — rebuild teams in the Team Builder.`,
          }
        : { type: 'error', text: result.error || 'Division move failed.' }
    );
  };

  if (loading) return <LoadingScreen />;

  const regenerateAvailable = formatPrompt === 'coed' ? !!onMergeRegenerate : !!onSplitRegenerate;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {message && (
        <div
          role="status"
          className={`badge ${message.type === 'success' ? 'success' : 'danger'}`}
          style={{ height: 'auto', padding: '8px 12px', alignSelf: 'flex-start' }}
        >
          {message.text}
        </div>
      )}

      <div>
        <div className="section-title">Division format</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {FORMAT_OPTIONS.map((option) => {
            const on = genderModel === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => chooseFormat(option.value)}
                aria-pressed={on}
                className="card"
                style={{
                  textAlign: 'left',
                  padding: 14,
                  cursor: 'pointer',
                  borderColor: on ? 'var(--primary)' : 'var(--border)',
                  boxShadow: on ? '0 0 0 3px var(--ring)' : 'var(--shadow-sm)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 9 }}>
                  <span
                    className={`cbx ${on ? 'on' : ''}`}
                    style={{ borderRadius: '50%', flex: 'none' }}
                  >
                    {on && <Check size={12} strokeWidth={3} aria-hidden="true" />}
                  </span>
                  <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{option.title}</span>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {option.examples.map((example) => (
                    <span key={example} className="badge square">
                      {example}
                    </span>
                  ))}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div className="section-title">Optional features &amp; fields</div>
        <div className="card">
          <div className="card-body flush">
            {FEATURE_CATALOG.map((feature, index) => {
              const Icon = feature.icon;
              const enabled = !!(features[feature.key] ?? FEATURE_DEFAULTS[feature.key]);
              return (
                <div
                  key={feature.key}
                  style={{
                    display: 'flex',
                    gap: 12,
                    alignItems: 'center',
                    padding: '13px 16px',
                    borderBottom:
                      index < FEATURE_CATALOG.length - 1 ? '1px solid var(--border-soft)' : 'none',
                  }}
                >
                  <span
                    className="kpi-ico"
                    style={{
                      width: 32,
                      height: 32,
                      background: 'var(--bg-sunken)',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    <Icon size={17} aria-hidden="true" />
                  </span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                      {feature.label}
                      {feature.column && (
                        <span className="badge neutral" style={{ height: 17, fontSize: 10 }}>
                          Grid column
                        </span>
                      )}
                    </div>
                    <div className="muted" style={{ fontSize: 12.5 }}>
                      {feature.description}
                    </div>
                  </div>
                  <Toggle
                    checked={enabled}
                    onChange={(next) => handleToggle(feature.key, next)}
                    label={feature.label}
                    disabled={saving}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div>
        <label className="section-title block" htmlFor="buddy-rule-select">
          Buddy rule
        </label>
        <div className="card">
          <div className="card-body flex flex-col gap-2">
            <select
              id="buddy-rule-select"
              value={buddyRuleChoice.value}
              onChange={(event) => chooseBuddyRule(event.target.value)}
              disabled={saving}
              aria-describedby="buddy-rule-description"
              className="w-full bg-bg-surface border border-border-subtle rounded-lg px-4 py-3 text-text-primary focus:outline-none focus:border-brand-400 transition-colors"
            >
              {BUDDY_RULE_CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
            <div className="muted text-xs" id="buddy-rule-description">
              {buddyRuleChoice.description}
            </div>
          </div>
        </div>
      </div>

      <div>
        <div className="section-title">Advanced</div>
        <div className="card">
          <div className="card-body flush">
            {ADVANCED_FLAGS.map((flag, index) => (
              <div
                key={flag.key}
                style={{
                  display: 'flex',
                  gap: 12,
                  alignItems: 'center',
                  padding: '13px 16px',
                  borderBottom:
                    index < ADVANCED_FLAGS.length - 1 ? '1px solid var(--border-soft)' : 'none',
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{flag.label}</div>
                  <div className="muted" style={{ fontSize: 12.5 }} id={`flag-desc-${flag.key}`}>
                    {flag.description}
                  </div>
                </div>
                <Toggle
                  checked={!!features[flag.key]}
                  onChange={(next) => handleToggle(flag.key, next)}
                  label={flag.label}
                  disabled={saving}
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      {formatPrompt && (
        <Modal
          open
          title={
            formatPrompt === 'coed'
              ? 'Switch to co-ed divisions'
              : 'Switch to Boys / Girls divisions'
          }
          icon={<Layers size={18} aria-hidden="true" />}
          onClose={() => setFormatPrompt(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setFormatPrompt(null)}>
                Cancel
              </Button>
              <Button variant="secondary" onClick={() => applyFormat(formatPrompt, false)}>
                Future placements only
              </Button>
              <Button
                variant="primary"
                icon={Zap}
                disabled={!regenerateAvailable}
                title={
                  regenerateAvailable
                    ? undefined
                    : 'Player moves run through the co-ed transition hook once it is wired up.'
                }
                onClick={() => applyFormat(formatPrompt, true)}
              >
                {formatPrompt === 'coed' ? 'Merge & move players now' : 'Split players now'}
              </Button>
            </>
          }
        >
          <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 14 }}>
            Teams are already formed for this season. How should{' '}
            {formatPrompt === 'coed' ? 'co-ed' : 'the Boys/Girls split'} apply?
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="setup-step" style={{ borderColor: 'var(--primary)' }}>
              <div
                className="step-num"
                style={{
                  background: 'var(--primary)',
                  color: '#fff',
                  borderColor: 'var(--primary)',
                }}
              >
                <Zap size={15} aria-hidden="true" />
              </div>
              <div>
                <div style={{ fontWeight: 700 }}>
                  {formatPrompt === 'coed' ? 'Merge & move players now' : 'Split players now'}
                </div>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  {formatPrompt === 'coed'
                    ? "Move each age group's players into one co-ed division (U8, U10…). Current rosters are cleared — rebuild teams in the Team Builder or with a teaming re-run. Existing schedules are kept."
                    : "Move each co-ed division's players into gendered divisions (e.g. U8 → U8B + U8G). Current rosters are cleared — rebuild teams in the Team Builder or with a teaming re-run. Existing schedules are kept."}
                </div>
              </div>
            </div>
            <div className="setup-step">
              <div className="step-num">
                <Clock size={15} aria-hidden="true" />
              </div>
              <div>
                <div style={{ fontWeight: 700 }}>Future placements only</div>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  {formatPrompt === 'coed'
                    ? 'Keep current teams as-is and relabel divisions to U8, U10… New, unassigned players will be placed co-ed.'
                    : 'Keep current mixed teams as-is and relabel divisions to U8B, U8G… New, unassigned players will be placed by gender.'}
                </div>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

FeatureFlagSettings.propTypes = {
  onMergeRegenerate: PropTypes.func,
  onSplitRegenerate: PropTypes.func,
};
