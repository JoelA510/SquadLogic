import React, { useState, useMemo } from 'react';
import { BrainCircuit, ArrowRight, Info, AlertCircle, CheckCircle } from 'lucide-react';
import Button from './ui/Button.jsx';

/**
 * Canonical field definitions per import type. `required` entries gate the
 * Continue button; `optional` entries render with a softer badge and can be
 * left unmapped.
 *
 * `composite` means the user can combine two source columns with a separator
 * (currently only used for `full_name` to solve the GotSport First Name +
 * Last Name case).
 */
const FIELD_DEFS = {
  players: {
    required: [
      { key: 'first_name', label: 'First Name' },
      { key: 'last_name', label: 'Last Name' },
      { key: 'date_of_birth', label: 'Date of Birth' },
    ],
    optional: [
      { key: 'medical_info', label: 'Medical Info' },
      { key: 'skill_tier', label: 'Skill Tier' },
    ],
  },
  coaches: {
    required: [
      { key: 'full_name', label: 'Full Name', composite: true },
      { key: 'email', label: 'Email' },
    ],
    optional: [{ key: 'willing_to_coach', label: 'Willing to Coach' }],
  },
  fields: {
    required: [{ key: 'name', label: 'Field Name' }],
    optional: [],
  },
  field_availability: {
    required: [
      { key: 'season_label', label: 'Season' },
      { key: 'location', label: 'Location' },
      { key: 'name', label: 'Field Name' },
      { key: 'available_from', label: 'Available From' },
      { key: 'available_until', label: 'Available Until' },
    ],
    optional: [
      { key: 'primary_format', label: 'Primary Format' },
      { key: 'secondary_format', label: 'Secondary Format' },
      { key: 'record_status', label: 'Record Status' },
      { key: 'blackout_months', label: 'Blackout Months' },
      { key: 'goal_equipment', label: 'Equipment' },
    ],
  },
};

const STORAGE_KEY = (type) => `squadlogic:import-mapping:${type}`;

const isMappingComplete = (mapping, required) =>
  required.every((f) => {
    const entry = mapping[f.key];
    if (!entry) return false;
    if (entry.kind === 'composite') return entry.columns?.filter(Boolean).length >= 1;
    return !!entry.column;
  });

/**
 * Build an initial mapping from (1) persisted localStorage, falling back to
 * (2) the auto-match scores from `matchHeaders`, and finally to (3) a
 * "combine first + last" composite for full_name when first_name / last_name
 * are confidently matched but full_name itself isn't.
 */
function buildInitialMapping(importType, rawHeaders, autoMatches) {
  const defs = FIELD_DEFS[importType];
  const allFields = [...defs.required, ...defs.optional];
  const mapping = {};

  // 1. Try localStorage
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY(importType)) || 'null');
    if (saved && typeof saved === 'object') {
      for (const field of allFields) {
        const entry = saved[field.key];
        if (!entry) continue;
        if (
          entry.kind === 'single' &&
          typeof entry.column === 'string' &&
          rawHeaders.includes(entry.column)
        ) {
          mapping[field.key] = entry;
        } else if (
          entry.kind === 'composite' &&
          Array.isArray(entry.columns) &&
          entry.columns.every((c) => !c || rawHeaders.includes(c))
        ) {
          mapping[field.key] = entry;
        }
      }
    }
  } catch {
    // Ignore malformed localStorage
  }

  // 2. Fill remaining fields from auto-matches
  const reverseAuto = {};
  Object.entries(autoMatches || {}).forEach(([raw, canonical]) => {
    if (canonical && !reverseAuto[canonical]) reverseAuto[canonical] = raw;
  });

  for (const field of allFields) {
    if (mapping[field.key]) continue;
    const rawHit = reverseAuto[field.key];
    if (rawHit) {
      mapping[field.key] = { kind: 'single', column: rawHit };
    }
  }

  // 3. Auto-compose full_name from first + last when missing
  if (!mapping.full_name && reverseAuto.first_name && reverseAuto.last_name) {
    mapping.full_name = {
      kind: 'composite',
      columns: [reverseAuto.first_name, reverseAuto.last_name],
      separator: ' ',
    };
  }

  return mapping;
}

/**
 * Apply a confirmed mapping to a parsed row. Returns a new row keyed by
 * canonical field names, preserving any original columns that weren't
 * mapped (they may be custom fields the org schema picks up).
 */
export function applyMapping(row, mapping) {
  const out = { ...row };
  for (const [canonical, entry] of Object.entries(mapping)) {
    if (!entry) continue;
    if (entry.kind === 'single' && entry.column) {
      if (entry.column !== canonical) {
        out[canonical] = row[entry.column];
      }
    } else if (entry.kind === 'composite' && Array.isArray(entry.columns)) {
      const sep = entry.separator ?? ' ';
      out[canonical] = entry.columns
        .filter(Boolean)
        .map((c) => (row[c] ?? '').toString().trim())
        .filter(Boolean)
        .join(sep);
    }
  }
  return out;
}

/**
 * Build a CSV string from canonical rows. Used to re-package the file for
 * `startImport` so the downstream pipeline sees clean canonical headers.
 */
export function serializeCanonicalCsv(rows, canonicalHeaders) {
  const escape = (val) => {
    const str = (val ?? '').toString();
    // RFC 4180: quote fields containing any quote, any part of a CRLF
    // line break, or a comma. `\r` is needed for values carrying a
    // bare CR (Gemini review on #184).
    if (/["\n\r,]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
  };
  const headerRow = canonicalHeaders.map(escape).join(',');
  const body = rows.map((r) => canonicalHeaders.map((h) => escape(r[h])).join(',')).join('\r\n');
  return `${headerRow}\r\n${body}`;
}

export default function ColumnMapper({
  importType,
  rawHeaders,
  sampleRows,
  autoMatches,
  onConfirm,
  onCancel,
}) {
  const defs = FIELD_DEFS[importType];
  const [mapping, setMapping] = useState(() =>
    buildInitialMapping(importType, rawHeaders, autoMatches)
  );

  const missingRequired = useMemo(
    () => defs.required.filter((f) => !isMappingComplete({ [f.key]: mapping[f.key] }, [f])),
    [mapping, defs.required]
  );

  const setField = (key, entry) => {
    setMapping((prev) => {
      const next = { ...prev };
      if (!entry) delete next[key];
      else next[key] = entry;
      return next;
    });
  };

  const handleConfirm = () => {
    try {
      localStorage.setItem(STORAGE_KEY(importType), JSON.stringify(mapping));
    } catch {
      // localStorage can throw in private mode — not fatal
    }
    onConfirm(mapping);
  };

  const previewRow = sampleRows?.[0] ?? {};

  const renderPreview = (entry) => {
    if (!entry) return <span className="opacity-20">—</span>;
    if (entry.kind === 'single') {
      const v = previewRow[entry.column];
      return v ? v : <span className="opacity-40 italic">empty</span>;
    }
    if (entry.kind === 'composite') {
      const joined = (entry.columns || [])
        .filter(Boolean)
        .map((c) => (previewRow[c] ?? '').toString().trim())
        .filter(Boolean)
        .join(entry.separator ?? ' ');
      return joined ? joined : <span className="opacity-40 italic">empty</span>;
    }
    return null;
  };

  const renderFieldRow = (field, isRequired) => {
    const entry = mapping[field.key];
    const isComposite = entry?.kind === 'composite';
    const canCompose = !!field.composite;

    return (
      <div
        key={field.key}
        className="flex flex-col lg:flex-row gap-3 lg:items-center min-w-0 py-3 border-b border-border-subtle/40 last:border-b-0"
      >
        <div className="lg:w-44 shrink-0 flex items-center gap-2">
          <span className="text-sm font-medium text-text-primary">{field.label}</span>
          {isRequired ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-status-error-text border border-red-500/20">
              required
            </span>
          ) : (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-surface text-text-muted border border-border-subtle">
              optional
            </span>
          )}
        </div>

        <div className="flex-1 min-w-0 flex flex-col sm:flex-row sm:items-center gap-2">
          {canCompose && (
            <div
              className="flex items-center gap-1 text-[11px] text-text-muted"
              role="group"
              aria-label={`${field.label} mapping mode`}
            >
              <button
                type="button"
                aria-pressed={!isComposite}
                onClick={() =>
                  setField(field.key, {
                    kind: 'single',
                    column: entry?.kind === 'single' ? entry.column : '',
                  })
                }
                className={`px-2 py-0.5 rounded ${
                  !isComposite ? 'bg-blue-500/20 text-text-accent' : 'hover:bg-bg-surface-hover'
                }`}
              >
                Single
              </button>
              <button
                type="button"
                aria-pressed={isComposite}
                onClick={() =>
                  setField(field.key, {
                    kind: 'composite',
                    columns: entry?.kind === 'composite' ? entry.columns : ['', ''],
                    separator: entry?.kind === 'composite' ? entry.separator : ' ',
                  })
                }
                className={`px-2 py-0.5 rounded ${
                  isComposite ? 'bg-blue-500/20 text-text-accent' : 'hover:bg-bg-surface-hover'
                }`}
              >
                Combine
              </button>
            </div>
          )}

          {isComposite ? (
            <div className="flex-1 min-w-0 flex flex-col sm:flex-row sm:items-center gap-1.5">
              <select
                aria-label={`${field.label} first source column`}
                value={entry.columns?.[0] || ''}
                onChange={(e) =>
                  setField(field.key, {
                    ...entry,
                    columns: [e.target.value, entry.columns?.[1] || ''],
                  })
                }
                className="w-full sm:flex-1 min-w-0 bg-bg-surface border border-border-subtle rounded px-2 py-1.5 text-sm text-text-primary"
              >
                <option value="">— choose column —</option>
                {rawHeaders.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
              <span className="text-text-muted text-xs text-center shrink-0" aria-hidden="true">
                +
              </span>
              <select
                aria-label={`${field.label} second source column`}
                value={entry.columns?.[1] || ''}
                onChange={(e) =>
                  setField(field.key, {
                    ...entry,
                    columns: [entry.columns?.[0] || '', e.target.value],
                  })
                }
                className="w-full sm:flex-1 min-w-0 bg-bg-surface border border-border-subtle rounded px-2 py-1.5 text-sm text-text-primary"
              >
                <option value="">— choose column —</option>
                {rawHeaders.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <select
              aria-label={`${field.label} source column`}
              value={entry?.column || ''}
              onChange={(e) => {
                const v = e.target.value;
                setField(field.key, v ? { kind: 'single', column: v } : null);
              }}
              className="flex-1 min-w-0 w-full bg-bg-surface border border-border-subtle rounded px-2 py-1.5 text-sm text-text-primary"
            >
              <option value="">— not mapped —</option>
              {rawHeaders.map((h) => {
                const autoHint = autoMatches?.[h] === field.key ? '  (suggested)' : '';
                return (
                  <option key={h} value={h}>
                    {h}
                    {autoHint}
                  </option>
                );
              })}
            </select>
          )}
        </div>

        <div className="lg:w-56 shrink-0 min-w-0 text-xs text-text-secondary break-words">
          <span className="text-text-muted mr-1">preview:</span>
          <span className="font-mono">{renderPreview(entry)}</span>
        </div>
      </div>
    );
  };

  return (
    <div className="bg-bg-surface border border-border-subtle rounded-lg overflow-hidden animate-fadeIn">
      <div className="p-4 border-b border-border-subtle bg-bg-surface">
        <div className="flex items-start gap-3">
          <div className="p-2 bg-blue-500/20 rounded-lg">
            <BrainCircuit className="text-text-accent" size={20} />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-text-primary">Map your columns</h3>
            <p className="text-sm text-text-secondary">
              We couldn&apos;t confidently match every required field. Pick the source column for
              each — combine two columns for Full Name if your export splits first/last.
            </p>
          </div>
        </div>
      </div>

      <div className="px-4 py-2">
        <div className="text-[11px] uppercase tracking-wide text-text-muted font-semibold pt-2 pb-1">
          Required
        </div>
        {defs.required.map((f) => renderFieldRow(f, true))}
        {defs.optional.length > 0 && (
          <>
            <div className="text-[11px] uppercase tracking-wide text-text-muted font-semibold pt-3 pb-1">
              Optional
            </div>
            {defs.optional.map((f) => renderFieldRow(f, false))}
          </>
        )}
      </div>

      <div className="p-4 border-t border-border-subtle flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-bg-surface">
        <div className="flex items-center gap-2 text-xs">
          {missingRequired.length === 0 ? (
            <>
              <CheckCircle size={14} className="text-status-success-text" />
              <span className="text-text-secondary">
                All required fields mapped — we&apos;ll remember this for next time.
              </span>
            </>
          ) : (
            <>
              <AlertCircle size={14} className="text-status-warning-text" />
              <span className="text-text-secondary">
                Still need: {missingRequired.map((f) => f.label).join(', ')}
              </span>
            </>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleConfirm}
            disabled={missingRequired.length > 0}
          >
            Continue
            <ArrowRight size={14} className="ml-1" />
          </Button>
        </div>
      </div>

      <div className="px-4 py-2 text-[11px] text-text-muted bg-bg-surface/50 border-t border-border-subtle flex items-center gap-1.5">
        <Info size={12} />
        <span>
          Unmapped columns are preserved and may be picked up as custom fields by your org schema.
        </span>
      </div>
    </div>
  );
}
