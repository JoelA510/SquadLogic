import React, { useState } from 'react';
import PropTypes from 'prop-types';
import { Plus, Trash2 } from 'lucide-react';
import { HEAT_BANDS, MAX_GUIDANCE_LINKS } from '@squadlogic/core/heat/index.js';
import { useOrgHeatSettings } from '../../../hooks/useOrgHeatSettings.js';
import { usePermission } from '../../../hooks/usePermission.js';

const CATEGORY_HELP = {
  1: 'Cooler regions',
  2: 'Moderate regions',
  3: 'Hottest regions',
};

const bandsText = (cat) =>
  HEAT_BANDS[cat].map(([name, upper]) => `${name} ≤${upper.toFixed(1)}`).join(', ') +
  `, Black >${HEAT_BANDS[cat][3][1].toFixed(1)} °F`;

/**
 * Heat forecast settings: the U.S. Soccer Recognize to Recover region
 * category the forecast bands against, and the governing-body links shown in
 * its sources panel. Written through `admin_set_org_heat_settings` (validated
 * client-side by `OrgHeatSettingsSchema` first, re-validated and audited by the
 * RPC). Nothing here is hard-coded for any organisation.
 */
export default function HeatSafetyModule() {
  const settings = useOrgHeatSettings();
  // Held here, not in the form: a successful save reloads the settings, which
  // unmounts the form and remounts it under a new key, and a message kept in
  // the form's own state was lost with it.
  const [message, setMessage] = useState(
    /** @type {{ kind: 'error'|'ok', text: string }|null} */ (null)
  );
  if (settings.loading) {
    return (
      <p className="text-sm text-text-muted" role="status">
        Loading heat settings…
      </p>
    );
  }
  // A failed read is an error, not a default: an editable form here would show
  // Category 1 with no links and let a save overwrite settings nobody saw.
  if (settings.error) {
    return (
      <p role="alert" className="text-sm text-status-error">
        {settings.error}
      </p>
    );
  }
  // Keyed on the stored values, so a save or an org switch remounts the form
  // with what the database now holds rather than syncing state in an effect.
  return (
    <HeatSafetyForm
      key={`${settings.source}|${settings.thresholdCategory}|${JSON.stringify(settings.guidanceLinks)}`}
      settings={settings}
      message={message}
      setMessage={setMessage}
    />
  );
}

/**
 * @param {{ settings: ReturnType<typeof useOrgHeatSettings>,
 *   message: { kind: 'error'|'ok', text: string }|null,
 *   setMessage: (m: { kind: 'error'|'ok', text: string }|null) => void }} props
 */
function HeatSafetyForm({ settings, message, setMessage }) {
  const { can, PERMISSIONS } = usePermission();
  const canEdit = can(PERMISSIONS.MANAGE_ORGANIZATION);
  const [category, setCategory] = useState(settings.thresholdCategory);
  const [links, setLinks] = useState(settings.guidanceLinks);
  const [saving, setSaving] = useState(false);

  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    const result = await settings.save({ thresholdCategory: category, guidanceLinks: links });
    setSaving(false);
    setMessage(
      result.ok
        ? { kind: 'ok', text: 'Heat settings saved.' }
        : { kind: 'error', text: result.error }
    );
  };

  const setLink = (i, key, value) =>
    setLinks((ls) => ls.map((l, j) => (j === i ? { ...l, [key]: value } : l)));

  return (
    <form
      className="space-y-6 animate-fadeIn"
      onSubmit={save}
      aria-labelledby="heat-settings-heading"
    >
      <h3 id="heat-settings-heading" className="text-base font-semibold text-text-primary">
        Heat forecast
      </h3>
      <fieldset disabled={!canEdit || saving}>
        <legend className="block text-sm font-medium text-text-secondary mb-2">
          U.S. Soccer heat guidelines region category
        </legend>
        <p className="text-xs text-text-muted mb-2">
          {settings.source === 'default'
            ? 'Not configured: the forecast uses Category 1 and says so.'
            : 'Configured for this organization.'}
        </p>
        <div className="space-y-2">
          {[1, 2, 3].map((cat) => (
            <label key={cat} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="heat-category"
                value={cat}
                checked={category === cat}
                onChange={() => setCategory(/** @type {1|2|3} */ (cat))}
              />
              <span>
                <span className="font-medium">
                  Category {cat}: {CATEGORY_HELP[cat]}
                </span>
                <span className="block text-xs text-text-muted">{bandsText(cat)}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset disabled={!canEdit || saving}>
        <legend className="block text-sm font-medium text-text-secondary mb-2">
          Governing-body guidance links
        </legend>
        <p className="text-xs text-text-muted mb-2">
          Shown in the heat forecast&apos;s sources panel, e.g. your league&apos;s player health and
          safety page or your club&apos;s cancellation policy. https only, up to{' '}
          {MAX_GUIDANCE_LINKS}.
        </p>
        <ul className="space-y-2">
          {links.map((link, i) => (
            <li key={i} className="flex flex-wrap gap-2 items-end">
              <div className="field grow">
                <label htmlFor={`heat-link-label-${i}`}>Label</label>
                <input
                  id={`heat-link-label-${i}`}
                  className="input"
                  value={link.label}
                  maxLength={80}
                  onChange={(e) => setLink(i, 'label', e.target.value)}
                />
              </div>
              <div className="field grow">
                <label htmlFor={`heat-link-url-${i}`}>URL</label>
                <input
                  id={`heat-link-url-${i}`}
                  className="input"
                  type="url"
                  inputMode="url"
                  value={link.url}
                  maxLength={500}
                  placeholder="https://"
                  onChange={(e) => setLink(i, 'url', e.target.value)}
                />
              </div>
              <button
                type="button"
                className="btn btn-ghost-danger sm"
                onClick={() => setLinks((ls) => ls.filter((_, j) => j !== i))}
                aria-label={`Remove link ${i + 1}${link.label ? ` (${link.label})` : ''}`}
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
        {links.length < MAX_GUIDANCE_LINKS && (
          <button
            type="button"
            className="btn btn-subtle sm mt-2"
            onClick={() => setLinks((ls) => [...ls, { label: '', url: '' }])}
          >
            <Plus size={14} aria-hidden="true" /> Add link
          </button>
        )}
      </fieldset>

      {canEdit && (
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save heat settings'}
        </button>
      )}
      {message && (
        <p
          role={message.kind === 'error' ? 'alert' : 'status'}
          className={`text-sm ${message.kind === 'error' ? 'text-status-error' : 'text-text-secondary'}`}
        >
          {message.text}
        </p>
      )}
    </form>
  );
}

HeatSafetyForm.propTypes = {
  settings: PropTypes.shape({
    thresholdCategory: PropTypes.oneOf([1, 2, 3]).isRequired,
    guidanceLinks: PropTypes.arrayOf(PropTypes.object).isRequired,
    source: PropTypes.oneOf(['configured', 'default']).isRequired,
    save: PropTypes.func.isRequired,
  }).isRequired,
  message: PropTypes.shape({
    kind: PropTypes.oneOf(['error', 'ok']).isRequired,
    text: PropTypes.string.isRequired,
  }),
  setMessage: PropTypes.func.isRequired,
};
