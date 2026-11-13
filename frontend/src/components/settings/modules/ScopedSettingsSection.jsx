import React, { useId, useState } from 'react';
import {
  resolveScopedSetting,
  SCOPED_SETTING_KEYS,
  scopedLevelsFor,
  STANDINGS_COUNT_OUTSIDE_KEY,
} from '@squadlogic/core/scopedSettings.js';
import { useOrganization } from '../../../contexts/OrganizationContext.jsx';
import { useFeatures } from '../../../hooks/useFeatures.js';
import { useScopedSettings } from '../../../hooks/useScopedSettings.js';
import { FEATURE_FLAGS } from '../../../constants/featureFlags.js';
import { isAdminRole } from '../../../constants/permissions.js';

/**
 * The words a boolean setting is shown in: the choice ("Count") and what applies ("Counted"). The label is the
 * registry's (`scoped_setting_keys.label`, mirrored by core's SCOPED_SETTING_KEYS). A boolean key with no entry here
 * is shown in the generic words below.
 */
const BOOLEAN_WORDS = {
  [STANDINGS_COUNT_OUTSIDE_KEY]: {
    on: 'Count',
    off: "Don't count",
    appliedOn: 'Counted',
    appliedOff: 'Not counted',
    // when the feature it shapes is off, the panel says so (the stored values are left alone)
    feature: FEATURE_FLAGS.STANDINGS,
    featureOff:
      'Standings are off for this league: this setting takes effect once Standings is turned on (Settings, Features). What is set here is kept.',
  },
};
const GENERIC_WORDS = { on: 'On', off: 'Off', appliedOn: 'On', appliedOff: 'Off' };

const COMPLETED_REASON =
  'This season is completed: its programs’ and divisions’ settings are history and cannot be changed. The organization’s setting applies to the seasons to come.';

/** `value` of a select from a stored value: '' is Inherit. */
const optionValue = (value) => (typeof value === 'boolean' ? String(value) : '');
const fromOption = (option) => (option === '' ? null : option === 'true');
const lowerFirst = (text) => text.charAt(0).toLowerCase() + text.slice(1);

/** @param {number} n */
function frozenWords(n) {
  if (!n) return '';
  return n === 1
    ? ' 1 division in a completed season keeps its old value.'
    : ` ${n} divisions in completed seasons keep their old value.`;
}

/**
 * Settings > General > Season & Calendar > "Settings by program and division" (F11-4b; plan
 * `docs/changes/2026-11-13-settings-scope.md`, "The screen"; decisions S4, S5).
 *
 * One table per registered setting: the organization, then each program of the season being viewed with its
 * divisions, then "No program" (the season's default program, which holds no values: decision S4) with its
 * divisions. Each settable level has a native select (Inherit / Count / Don't count; on the organization "Inherit" is
 * the registry's default) and says what applies now and where it comes from, computed by core's twin of the resolver
 * (`resolveScopedSetting`, held to `scoped_setting_value` by tests/scopedSettingsParity.test.js). What the server
 * enforces is the SQL's; this is for display.
 *
 * Admins only: the setter refuses anyone else (is_org_admin), and the panel is not shown to them. A completed season's
 * programs and divisions are read-only (the setter refuses them); the organization's row stays editable, and the save
 * says how many completed-season divisions it held at their old value (`frozen_completed_divisions`). Every refusal is
 * said in words in the alert region.
 */
export default function ScopedSettingsSection() {
  const { currentOrganization, currentSeasonSetting, orgMember } = useOrganization();
  const { isEnabled } = useFeatures();
  const isAdmin = isAdminRole(orgMember?.role);
  const organizationId = isAdmin ? (currentOrganization?.id ?? null) : null;
  const seasonId = currentSeasonSetting?.id ?? null;
  const { loading, error, programs, divisions, rows, setValue } = useScopedSettings(
    organizationId,
    seasonId
  );
  const baseId = useId();
  const [busy, setBusy] = useState(false);
  // the choice on screen while its save is in flight (the select stays enabled, so focus stays where it is)
  const [pending, setPending] = useState(/** @type {Record<string, string>} */ ({}));
  const [message, setMessage] = useState(
    /** @type {{ tone: 'ok' | 'error', text: string } | null} */ (null)
  );

  if (!isAdmin || !organizationId) return null;

  const completed = currentSeasonSetting?.status === 'completed';
  const orgName = currentOrganization?.name ?? 'this organization';
  const defaultIds = new Set(programs.filter((p) => p.is_default).map((p) => String(p.id)));
  const ownPrograms = programs.filter((p) => !p.is_default);
  const ownProgramIds = new Set(ownPrograms.map((p) => String(p.id)));
  const inNoProgram = divisions.filter((d) => !ownProgramIds.has(String(d.program_id ?? '')));
  const showNoProgram = defaultIds.size > 0 || inNoProgram.length > 0;
  const completedReasonId = `${baseId}-completed`;

  /**
   * The rows of the table, in order: the organization, each program and its divisions, then "No program" and its.
   * @type {Array<{ id: string, scope: 'organization' | 'program' | 'division' | 'none', header: string,
   *   programId?: string | null, programName?: string, inProgram?: boolean }>}
   */
  const levels = [
    { id: organizationId, scope: 'organization', header: `Organization: ${orgName}` },
  ];
  for (const program of ownPrograms) {
    levels.push({ id: String(program.id), scope: 'program', header: `Program: ${program.name}` });
    for (const division of divisions.filter((d) => String(d.program_id) === String(program.id))) {
      levels.push({
        id: String(division.id),
        scope: 'division',
        header: `Division: ${division.name}`,
        programId: String(program.id),
        programName: program.name,
        inProgram: true,
      });
    }
  }
  if (showNoProgram) {
    levels.push({ id: 'no-program', scope: 'none', header: 'No program' });
    for (const division of inNoProgram) {
      levels.push({
        id: String(division.id),
        scope: 'division',
        header: `Division: ${division.name}`,
        programId: division.program_id ?? null,
        inProgram: false,
      });
    }
  }

  /** The level's own stored row of a key, or undefined. */
  const ownRow = (level, key) =>
    rows.find(
      (row) =>
        row.key === key &&
        (level.scope === 'organization'
          ? !row.program_id && !row.division_id
          : level.scope === 'program'
            ? String(row.program_id) === level.id
            : String(row.division_id) === level.id)
    );

  /** What applies at a level, and from where, through core's twin of the resolver. */
  const applied = (level, key) => {
    const own = scopedLevelsFor(
      rows,
      {
        organizationId,
        programId: level.scope === 'program' ? level.id : (level.programId ?? null),
        // a division in no program (or the default one) has no program level
        programIsDefault: level.scope === 'division' ? !level.inProgram : false,
        divisionId: level.scope === 'division' ? level.id : null,
      },
      key
    );
    return resolveScopedSetting(own, key);
  };

  const appliesWords = (level, key, words) => {
    const { value, source } = applied(level, key);
    const what = value === true ? words.appliedOn : words.appliedOff;
    if (source === level.scope) {
      return ownRow(level, key)?.frozen_from_organization
        ? `${what}, kept from the organization’s earlier value when it changed`
        : `${what}, set here`;
    }
    if (source === 'program') return `${what}, from the program ${level.programName}`;
    if (source === 'organization') return `${what}, from the organization`;
    return `${what}, by default`;
  };

  const optionsFor = (level, words) => [
    {
      value: '',
      text: level.scope === 'organization' ? `Default (${lowerFirst(words.off)})` : 'Inherit',
    },
    { value: 'true', text: words.on },
    { value: 'false', text: words.off },
  ];

  const onChange = async (level, key, words, option) => {
    if (busy) return;
    const slot = `${key}|${level.id}`;
    setBusy(true);
    setPending((p) => ({ ...p, [slot]: option }));
    setMessage(null);
    const chosen = optionsFor(level, words).find((o) => o.value === option)?.text ?? option;
    try {
      const result = await setValue({
        key,
        scope: /** @type {'organization' | 'program' | 'division'} */ (level.scope),
        scopeId: level.id,
        value: fromOption(option),
      });
      setMessage({
        tone: 'ok',
        text:
          result?.changed === false
            ? `Nothing changed: ${level.header} was already ${chosen}.`
            : `Saved. ${level.header}: ${chosen}.${frozenWords(Number(result?.frozen_completed_divisions ?? 0))}`,
      });
    } catch (err) {
      setMessage({ tone: 'error', text: err?.message || 'Not saved: the change failed.' });
    } finally {
      setPending((p) => {
        const next = { ...p };
        delete next[slot];
        return next;
      });
      setBusy(false);
    }
  };

  const headingId = `${baseId}-heading`;
  const keys = Object.keys(SCOPED_SETTING_KEYS);

  return (
    <section
      aria-labelledby={headingId}
      className="space-y-4 border-t border-border-subtle pt-6"
      data-testid="scoped-settings-section"
    >
      <div>
        <h3 id={headingId} className="text-base font-semibold text-text-primary">
          Settings by program and division
        </h3>
        <p className="mt-1 text-sm text-text-secondary">
          A division follows its own setting, else its program’s, else the organization’s. “Inherit”
          leaves a level to the one above it. Programs and divisions are this season’s.
        </p>
        {completed && (
          <p id={completedReasonId} className="mt-1 text-sm text-text-muted">
            {COMPLETED_REASON}
          </p>
        )}
      </div>

      <div aria-live="polite" className="min-h-[1.25rem] text-sm">
        {loading && <span className="text-text-muted">Loading settings…</span>}
        {message?.tone === 'ok' && (
          <p role="status" className="text-text-secondary">
            {message.text}
          </p>
        )}
        {message?.tone === 'error' && (
          <p role="alert" className="text-status-error-text">
            {message.text}
          </p>
        )}
        {error && !message && <p className="text-status-error-text">{error}</p>}
      </div>

      {!loading &&
        !error &&
        keys.map((key) => {
          const entry = SCOPED_SETTING_KEYS[key];
          const captionId = `${baseId}-${key}-caption`;
          if (entry.type !== 'boolean') {
            // Declared, not yet settable here: a set-valued setting (PR 12's) needs its own control.
            return (
              <p key={key} className="text-sm text-text-muted">
                {entry.label}: this screen cannot set this kind of setting yet.
              </p>
            );
          }
          const words = BOOLEAN_WORDS[key] ?? GENERIC_WORDS;
          return (
            <div key={key} className="space-y-2">
              {words.feature && !isEnabled(words.feature) && (
                <p className="text-sm text-text-muted">{words.featureOff}</p>
              )}
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <caption id={captionId} className="text-left font-medium text-text-primary pb-2">
                    {entry.label}
                  </caption>
                  <thead>
                    <tr className="border-b border-border-subtle text-text-secondary">
                      <th scope="col" className="py-2 pr-4 font-medium">
                        Level
                      </th>
                      <th scope="col" className="py-2 pr-4 font-medium">
                        Setting
                      </th>
                      <th scope="col" className="py-2 font-medium">
                        Applies now
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {levels.map((level) => {
                      const headerId = `${baseId}-${key}-${level.scope}-${level.id}`;
                      const indent = level.scope === 'division' ? 'pl-6' : '';
                      if (level.scope === 'none') {
                        return (
                          <tr key={level.id} className="border-b border-border-subtle">
                            <th
                              scope="row"
                              id={headerId}
                              className="py-2 pr-4 font-medium text-text-primary"
                            >
                              {level.header}
                            </th>
                            <td colSpan={2} className="py-2 text-text-muted">
                              Not settable: “No program” holds no settings. Its divisions follow the
                              organization.
                            </td>
                          </tr>
                        );
                      }
                      const readOnly = completed && level.scope !== 'organization';
                      const slot = `${key}|${level.id}`;
                      const stored = optionValue(ownRow(level, key)?.value);
                      return (
                        <tr key={level.id} className="border-b border-border-subtle">
                          <th
                            scope="row"
                            id={headerId}
                            className={`py-2 pr-4 font-medium text-text-primary ${indent}`}
                          >
                            {level.header}
                          </th>
                          <td className="py-2 pr-4">
                            <select
                              aria-labelledby={`${headerId} ${captionId}`}
                              aria-describedby={readOnly ? completedReasonId : undefined}
                              value={pending[slot] ?? stored}
                              disabled={readOnly}
                              onChange={(e) => onChange(level, key, words, e.target.value)}
                              className="bg-bg-app border border-border-subtle rounded-lg px-2 py-1 text-text-primary disabled:opacity-60"
                            >
                              {optionsFor(level, words).map((o) => (
                                <option key={o.value} value={o.value}>
                                  {o.text}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="py-2 text-text-secondary">
                            {appliesWords(level, key, words)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {Boolean(seasonId) && divisions.length === 0 && (
                <p className="text-sm text-text-muted">This season has no divisions yet.</p>
              )}
            </div>
          );
        })}
    </section>
  );
}
