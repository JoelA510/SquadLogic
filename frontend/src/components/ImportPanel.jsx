import React, { useState } from 'react';
import Papa from 'papaparse';
import {
  UploadCloud,
  FileText,
  CheckCircle,
  AlertCircle,
  Bell,
  BrainCircuit,
  Info,
  Download,
  SlidersHorizontal,
} from 'lucide-react';
import { PERSISTENCE_THEMES } from '../utils/themes.js';
import { useImport } from '../contexts/ImportContext.jsx';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { matchHeaders, HEADER_ALIASES } from '../utils/telemetryUtils.js';
import { downloadTemplate } from '../utils/csvTemplates.js';
import { supabase } from '../lib/supabaseClient.js';
import Button from './ui/Button.jsx';
import ProgressBar from './ui/ProgressBar.jsx';
import Tooltip from './ui/Tooltip.jsx';
import ColumnMapper, { applyMapping, serializeCanonicalCsv } from './ColumnMapper.jsx';
import { logger } from '../lib/logger.js';

const REQUIRED_HEADERS = {
  players: ['first_name', 'last_name', 'date_of_birth'],
  coaches: ['full_name', 'email'],
  fields: ['location', 'name', 'type', 'start', 'end'],
  field_availability: ['season_label', 'location', 'name', 'available_from', 'available_until'],
};

/** @typedef {'players' | 'coaches' | 'fields' | 'field_availability'} ImportType */
/** @type {readonly ImportType[]} */
const IMPORT_TYPES = Object.freeze(['players', 'coaches', 'fields', 'field_availability']);
const COMPLETED_IMPORT_STATUSES = new Set(['completed', 'completed_with_warnings']);
const IMPORT_TYPE_TOOLTIPS = {
  players: 'Requires first name, last name, and date of birth columns.',
  coaches: 'Requires full name and email columns.',
  fields: 'Requires location, name, type, start, and end columns.',
  field_availability:
    'Requires season_label, location, name, available_from, and available_until columns.',
};

/**
 * Smart Confidence Badge component for high-fidelity mapping indicators.
 */

const REQUIRED_FIELD_LABELS = {
  field_availability: {
    season_label: 'Season',
    location: 'Location',
    name: 'Field Name',
    available_from: 'Available From',
    available_until: 'Available Until',
  },
};

const FIELD_AVAILABILITY_PREVIEW_FIELDS = [
  'season_label',
  'location',
  'name',
  'primary_format',
  'secondary_format',
  'available_from',
  'available_until',
  'blackout_months',
  'record_status',
  'goal_equipment',
];

const SmartBadge = ({ score, rationale }) => {
  const tooltipId = React.useId();
  const matchPercent = (score * 100).toFixed(0);

  const getColor = () => {
    if (score >= 0.9) return 'text-green-400 bg-green-400/10 border-green-400/20';
    if (score >= 0.7) return 'text-blue-400 bg-blue-400/10 border-blue-400/20';
    return 'text-amber-400 bg-amber-400/10 border-amber-400/20';
  };

  return (
    <div
      tabIndex={0}
      role="status"
      aria-label={`${matchPercent}% header match confidence`}
      aria-describedby={tooltipId}
      className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] whitespace-nowrap group relative cursor-help animate-fadeIn outline-none focus-visible:ring-2 focus-visible:ring-blue-400/80 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface ${getColor()}`}
    >
      <BrainCircuit size={10} />
      <span>{matchPercent}% Match</span>

      {/* Tooltip */}
      <div
        id={tooltipId}
        role="tooltip"
        className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 w-48 p-2 bg-bg-surface border border-border-highlight rounded-lg shadow-md opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 pointer-events-none transition-opacity z-50 text-text-primary text-[11px] leading-snug"
      >
        <div className="flex items-start gap-1.5">
          <Info size={12} className="shrink-0 mt-0.5 text-blue-400" />
          <span>{rationale}</span>
        </div>
        <div className="absolute top-full left-1/2 -translate-x-1/2 border-8 border-transparent border-t-bg-surface"></div>
      </div>
    </div>
  );
};

export default function ImportPanel({ onImport }) {
  const notifyCheckboxId = React.useId();
  const fileInputId = React.useId();
  const [isDragging, setIsDragging] = useState(false);
  const [file, setFile] = useState(null);
  const [error, setError] = useState(null);
  const [previewData, setPreviewData] = useState(null);
  const [importType, setImportType] = useState(/** @type {ImportType} */ ('players'));
  // When the required-headers check fails (or the user clicks "Adjust
  // mapping"), we park the parsed CSV here and render ColumnMapper instead
  // of the preview. The mapper re-emits a rewritten file that we thread
  // back through the preview path.
  const [mappingStage, setMappingStage] = useState(null);
  // Snapshot of the first-ever parse for this upload (raw headers, raw
  // rows, auto-match output). "Adjust mapping" re-opens the mapper
  // against this — never against the post-confirmation rewritten data,
  // which would present canonical headers as "raw" (Gemini review on
  // #186).
  const [originalParse, setOriginalParse] = useState(null);

  const {
    isImporting,
    progress,
    importStatus,
    startImport,
    applyDeferredImport,
    cancelDeferredImport,
    resetImport,
    notifyOnComplete,
    setNotifyOnComplete,
    importedPlayers,
    importedCoaches,
    importedFields,
    importedFieldAvailability,
    rollbackImport,
    telemetryLogs,
    importLogs,
    activeJob,
  } = useImport();

  const { currentOrganization } = useOrganization();

  const theme = PERSISTENCE_THEMES.green;
  const isComplete = COMPLETED_IMPORT_STATUSES.has(importStatus);
  const isReadyToApply = importStatus === 'ready_to_apply';
  const deferredImportType = activeJob?.warning_summary?.deferred_apply?.import_type;
  const workflowImportType =
    isReadyToApply && IMPORT_TYPES.includes(deferredImportType) ? deferredImportType : importType;
  const coachRollbackComplete = importedCoaches?.persistence?.rollback?.status === 'rolled_back';
  const fieldRollbackComplete = importedFields?.persistence?.rollback?.status === 'rolled_back';
  const canRollbackImport =
    isComplete &&
    ((workflowImportType === 'coaches' &&
      importedCoaches?.persistence?.durable &&
      !coachRollbackComplete) ||
      (workflowImportType === 'fields' &&
        importedFields?.persistence?.durable &&
        !fieldRollbackComplete) ||
      (workflowImportType === 'field_availability' &&
        importedFieldAvailability?.persistence?.durable &&
        !(importedFieldAvailability?.persistence?.rollback?.status === 'rolled_back')));

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    const droppedFile = e.dataTransfer.files[0];
    validateAndReadFile(droppedFile);
  };

  const handleFileSelect = (e) => {
    const selectedFile = e.target.files[0];
    validateAndReadFile(selectedFile);
  };

  const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

  const validateAndReadFile = (file) => {
    if (!file) return;
    if (file.type !== 'text/csv' && !file.name.endsWith('.csv')) {
      setError('Please upload a valid CSV file.');
      return;
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      setError(
        `File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum size is 10 MB.`
      );
      return;
    }

    setFile(file);
    setError(null);
    parseCSV(file);
  };

  /**
   * Run validation + preview assembly on an already-parsed CSV payload.
   * Called from both parseCSV (for happy-path imports) and from the
   * ColumnMapper confirm handler (after we've rewritten headers).
   */
  const buildPreview = ({ data, headers, smartMetadata }) => {
    const { mappings } = smartMetadata;
    const normalizeHeader = (h) => mappings[h] || h.toLowerCase().trim();

    const validationErrors = [];
    const requiredForType = REQUIRED_HEADERS[importType] || [];

    data.forEach((row, index) => {
      const newRow = {};
      const rowErrors = [];
      const errorFields = [];

      Object.keys(row).forEach((key) => {
        newRow[normalizeHeader(key)] = row[key];
      });

      requiredForType.forEach((field) => {
        if (!newRow[field]) {
          rowErrors.push(`Missing ${field.replace(/_/g, ' ')}`);
          errorFields.push(field);
        }
      });

      if (rowErrors.length > 0) {
        validationErrors.push({ row: index + 2, data: newRow, errors: rowErrors, errorFields });
      }
    });

    setPreviewData({
      headers,
      rows: data.slice(0, 5),
      totalRows: data.length,
      fullData: data,
      validationErrors,
      smartMetadata,
    });
  };

  const parseCSV = (fileToParse, { isRemapped = false } = {}) => {
    Papa.parse(fileToParse, {
      header: true,
      skipEmptyLines: true,
      complete: async (results) => {
        const { data, meta } = results;
        if (!data || data.length === 0) {
          setError('CSV file appears to be empty or invalid.');
          return;
        }

        const headers = meta.fields || [];

        // Phase 3: Smart Header Mapping with Performance Gating
        const { mappings, confidence, rationales, timing, isFallback } = matchHeaders(
          headers,
          telemetryLogs
        );
        const smartMetadata = { mappings, confidence, rationales, timing, isFallback };

        // Snapshot the first-ever parse for this upload so "Adjust
        // mapping" can reopen the mapper against the truly-raw data
        // instead of the rewritten canonical CSV (Gemini review on
        // #186).
        if (!isRemapped) {
          setOriginalParse({
            file: fileToParse,
            headers,
            data,
            mappings,
          });
        }

        const normalizeHeader = (h) => mappings[h] || h.toLowerCase().trim();
        const requiredForType = REQUIRED_HEADERS[importType] || [];
        const normalizedFileHeaders = headers.map(normalizeHeader);
        const missingHeaders = requiredForType.filter(
          (req) => !normalizedFileHeaders.includes(req)
        );

        if (missingHeaders.length > 0) {
          // Instead of hard-erroring, hand off to the ColumnMapper so the
          // user can pick source columns (and optionally combine first/last
          // into full_name for GotSport-style exports).
          setMappingStage({
            rawHeaders: headers,
            rawData: data,
            sampleRows: data.slice(0, 3),
            autoMatches: mappings,
            smartMetadata,
            missingHeaders,
          });
          return;
        }

        buildPreview({ data, headers, smartMetadata });
      },
      error: (err) => {
        setError(`Error parsing CSV: ${err.message}`);
      },
    });
  };

  /**
   * Called when the user confirms their column mapping. Apply the mapping
   * to every row, build a new File object with canonical headers, then
   * re-enter the normal parse/preview path so downstream startImport() sees
   * a clean CSV without needing any mapping awareness itself.
   */
  const handleMappingConfirm = (mapping) => {
    const stage = mappingStage;
    if (!stage) return;

    const mappedRows = stage.rawData.map((row) => applyMapping(row, mapping));

    // Canonical header set = all explicitly mapped fields + any original
    // raw headers that (a) weren't used directly as a mapped key AND
    // (b) wouldn't be aliased to a mapped key by the downstream alias
    // map. Without the second check, a raw header like "Coach Name"
    // (alias → full_name) stays in the rewritten CSV alongside our
    // explicit full_name column, and the downstream normalize step
    // overwrites the user's mapping with the aliased raw value (Codex
    // review on #186).
    const mappedKeys = new Set(Object.keys(mapping));
    const aliasOf = (h) => HEADER_ALIASES[h.toLowerCase().trim()] ?? h.toLowerCase().trim();
    const canonicalHeaders = [
      ...mappedKeys,
      ...stage.rawHeaders.filter((h) => !mappedKeys.has(h) && !mappedKeys.has(aliasOf(h))),
    ];

    const csv = serializeCanonicalCsv(mappedRows, canonicalHeaders);
    const rewritten = new File(
      ['﻿', csv],
      file?.name?.replace(/\.csv$/i, '.mapped.csv') || 'mapped.csv',
      { type: 'text/csv' }
    );

    setMappingStage(null);
    setFile(rewritten);
    setError(null);
    // Pass isRemapped so the rewritten CSV doesn't overwrite our
    // originalParse snapshot — "Adjust mapping" needs that original.
    parseCSV(rewritten, { isRemapped: true });
  };

  const handleMappingCancel = () => {
    setMappingStage(null);
    setFile(null);
    setPreviewData(null);
    setOriginalParse(null);
    setError(null);
  };

  const handleStartImport = async () => {
    if (file) {
      // Phase 3: Telemetry Write-back
      if (previewData?.smartMetadata && !previewData.smartMetadata.isFallback) {
        try {
          const {
            data: { user },
          } = await supabase.auth.getUser();
          if (user && currentOrganization?.id) {
            await supabase.rpc('log_telemetry_event', {
              p_org_id: currentOrganization.id,
              p_event_name: 'import.suggestions_applied',
              p_payload: {
                session_id: crypto.randomUUID?.() || 'unknown',
                import_type: importType,
                file_name: file.name,
                match_count: Object.keys(previewData.smartMetadata.mappings).length,
                avg_confidence:
                  Object.values(previewData.smartMetadata.confidence).reduce((a, b) => a + b, 0) /
                  Object.keys(previewData.smartMetadata.confidence).length,
                latency_ms: previewData.smartMetadata.timing,
                match_rationale: previewData.smartMetadata.rationales,
              },
            });
          }
        } catch (err) {
          logger.error('Failed to log telemetry write-back:', err);
        }
      }

      startImport(file, importType);
    }
  };

  const handleValidateOnlyImport = async () => {
    if (file) {
      await startImport(file, importType, { deferApply: true });
    }
  };

  const getImportedCount = (type) => {
    switch (type) {
      case 'players':
        return importedPlayers?.totalRows || 0;
      case 'coaches':
        return importedCoaches?.totalRows || 0;
      case 'fields':
        return importedFields?.totalRows || 0;
      default:
        return 0;
    }
  };

  const previewHeaders = React.useMemo(() => {
    if (!previewData?.headers) return [];
    if (importType !== 'field_availability') return previewData.headers.slice(0, 5);

    const normalizedHeaderMap = new Map(
      previewData.headers.map((header) => {
        const canonical =
          previewData.smartMetadata?.mappings?.[header] || header.toLowerCase().trim();
        return [canonical, header];
      })
    );

    return FIELD_AVAILABILITY_PREVIEW_FIELDS.filter((field) => normalizedHeaderMap.has(field)).map(
      (field) => normalizedHeaderMap.get(field)
    );
  }, [previewData, importType]);

  const showFieldAvailabilityMissingSlotCopy =
    importType === 'field_availability' &&
    previewData?.headers &&
    ['day', 'start', 'end'].some(
      (field) =>
        !previewData.headers
          .map(
            (header) => previewData.smartMetadata?.mappings?.[header] || header.toLowerCase().trim()
          )
          .includes(field)
    );

  if (isImporting || isComplete || isReadyToApply) {
    return (
      <section className="glass-panel p-4 sm:p-8 rounded-xl border border-border-subtle relative overflow-visible mb-10 max-w-full min-w-0">
        <div
          className={`absolute inset-0 bg-gradient-to-br ${theme.gradientFrom} ${theme.gradientTo} pointer-events-none opacity-50`}
        />

        <div className="relative z-10 flex flex-col items-center justify-center text-center py-8">
          {isComplete || isReadyToApply ? (
            <div className="mb-6 w-20 h-20 rounded-full bg-green-500/20 flex items-center justify-center animate-fadeIn">
              <CheckCircle className="w-10 h-10 text-green-400" />
            </div>
          ) : (
            <div className="mb-6 w-20 h-20 rounded-full bg-blue-500/20 flex items-center justify-center animate-pulse">
              <UploadCloud className="w-10 h-10 text-blue-400" />
            </div>
          )}

          <h2 className="text-3xl font-display font-bold text-text-primary mb-2">
            {isComplete
              ? importStatus === 'completed_with_warnings'
                ? 'Import Applied with Warnings'
                : 'Import Applied'
              : isReadyToApply
                ? 'Import Ready to Apply'
                : 'Importing Data...'}
          </h2>

          <div className="w-full max-w-lg mb-8">
            <ProgressBar
              progress={progress}
              label={isReadyToApply ? 'Validated' : isComplete ? 'Applied' : 'Processing...'}
            />
          </div>

          {error && (
            <div
              data-testid="import-error-banner"
              className="bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-2 rounded-lg text-sm mb-6 animate-slideUp flex items-center gap-2"
            >
              <AlertCircle size={16} />
              {error}
            </div>
          )}

          {/*
            **The import log, on screen.**

            `completeImport` has always told the operator to "check the import
            log" when a job finishes with warnings, and until this there was no
            import log to check: `ImportContext` accumulated `importLogs` and no
            component read them. So a server-side row refusal -- an availability
            row naming a field the organisation does not have -- produced
            "Import Applied with Warnings", a count of zero profiles, and no
            statement anywhere on screen of why. A refusal nobody can read is
            the same silence as a refusal nobody records.

            Rendered whenever there are lines, which is any run that got past
            parsing, and always on the screen the operator lands on.
          */}
          {importLogs.length > 0 && (
            <section
              aria-labelledby="import-log-heading"
              data-testid="import-log"
              className="w-full max-w-lg mb-8 text-left"
            >
              <h3 id="import-log-heading" className="text-sm font-semibold text-text-primary mb-2">
                Import log
              </h3>
              <ol className="max-h-48 overflow-y-auto rounded-lg border border-border bg-bg-sunken divide-y divide-border-soft">
                {importLogs.map((entry, index) => (
                  <li
                    key={`${index}-${entry.message}`}
                    className="px-3 py-2 text-xs text-text-secondary"
                  >
                    {entry.message}
                  </li>
                ))}
              </ol>
            </section>
          )}

          {isReadyToApply ? (
            <div className="flex flex-wrap justify-center gap-4 w-full max-w-full">
              <Tooltip
                content={`Apply the validated ${workflowImportType === 'fields' ? 'field' : workflowImportType === 'field_availability' ? 'field availability' : 'coach'} import.`}
                className="w-full sm:w-auto"
              >
                <Button
                  variant="primary"
                  size="lg"
                  className="w-full sm:w-auto"
                  onClick={async () => {
                    try {
                      setError(null);
                      await applyDeferredImport(workflowImportType);
                    } catch (err) {
                      setError(err.message || `${workflowImportType} import apply failed.`);
                    }
                  }}
                >
                  Apply{' '}
                  {workflowImportType === 'fields'
                    ? 'Field Import'
                    : workflowImportType === 'field_availability'
                      ? 'Field Availability Import'
                      : 'Coach Import'}
                </Button>
              </Tooltip>
              <Tooltip content="Cancel this validated import." className="w-full sm:w-auto">
                <Button
                  variant="secondary"
                  size="lg"
                  className="w-full sm:w-auto"
                  onClick={async () => {
                    try {
                      setError(null);
                      await cancelDeferredImport(workflowImportType);
                      setFile(null);
                      setPreviewData(null);
                      setOriginalParse(null);
                    } catch (err) {
                      setError(err.message || `${workflowImportType} import cancellation failed.`);
                    }
                  }}
                >
                  Cancel Deferred Import
                </Button>
              </Tooltip>
            </div>
          ) : isComplete ? (
            <div className="flex flex-wrap justify-center gap-4 w-full max-w-full">
              {canRollbackImport && (
                <Tooltip
                  content={`Roll back this ${workflowImportType === 'fields' ? 'field' : workflowImportType === 'field_availability' ? 'field availability' : 'coach'} import.`}
                  className="w-full sm:w-auto"
                >
                  <Button
                    variant="danger"
                    size="lg"
                    className="w-full sm:w-auto"
                    onClick={async () => {
                      try {
                        setError(null);
                        await rollbackImport(workflowImportType);
                      } catch (err) {
                        setError(err.message || `${workflowImportType} import rollback failed.`);
                      }
                    }}
                  >
                    Roll Back{' '}
                    {workflowImportType === 'fields'
                      ? 'Field Import'
                      : workflowImportType === 'field_availability'
                        ? 'Field Availability Import'
                        : 'Coach Import'}
                  </Button>
                </Tooltip>
              )}
              <Tooltip content="Reset and choose another CSV." className="w-full sm:w-auto">
                <Button
                  variant="secondary"
                  size="lg"
                  className="w-full sm:w-auto"
                  onClick={() => {
                    resetImport('all');
                    setFile(null);
                    setPreviewData(null);
                    setOriginalParse(null);
                  }}
                >
                  Upload Another File
                </Button>
              </Tooltip>
              <Tooltip content="Continue to the next workflow step." className="w-full sm:w-auto">
                <Button
                  variant="primary"
                  size="lg"
                  className="w-full sm:w-auto"
                  onClick={() => {
                    if (onImport && previewData) {
                      onImport(previewData, importType);
                    }
                    resetImport('all');
                    setFile(null);
                    setPreviewData(null);
                    setOriginalParse(null);
                  }}
                >
                  Continue
                </Button>
              </Tooltip>
            </div>
          ) : (
            <div className="flex items-center gap-3 bg-bg-surface px-4 py-2 rounded-lg border border-border-subtle max-w-full">
              <label
                htmlFor={notifyCheckboxId}
                className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer select-none rounded-sm focus-within:outline-none focus-within:ring-2 focus-within:ring-blue-400/80 focus-within:ring-offset-2 focus-within:ring-offset-bg-surface"
              >
                <div
                  aria-hidden="true"
                  className={`w-2 h-2 rounded-full ${notifyOnComplete ? 'bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.8)]' : 'bg-text-muted/20'}`}
                />
                <input
                  id={notifyCheckboxId}
                  type="checkbox"
                  className="sr-only"
                  checked={notifyOnComplete}
                  onChange={(e) => setNotifyOnComplete(e.target.checked)}
                />
                Email me when complete
              </label>
            </div>
          )}
        </div>
      </section>
    );
  }

  return (
    <section
      data-testid="import-panel"
      className="glass-panel p-4 sm:p-6 rounded-xl border border-border-subtle relative overflow-visible mb-10 max-w-full min-w-0"
    >
      <div
        className={`absolute inset-0 bg-gradient-to-br ${theme.gradientFrom} ${theme.gradientTo} pointer-events-none`}
      />

      <div className="relative z-10 max-w-full min-w-0">
        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-4 mb-6 min-w-0">
          <div className="min-w-0">
            <h2 className="text-2xl font-bold text-text-primary mb-2 flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${theme.dotColor} ${theme.shadowColor}`} />
              Data Ingestion
            </h2>
            <p className="text-text-secondary max-w-prose leading-relaxed">
              Import GotSport registration data to populate teams and players.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Tooltip
              content={notifyOnComplete ? 'Disable notifications.' : 'Notify when complete.'}
            >
              <button
                type="button"
                aria-pressed={notifyOnComplete}
                aria-label={
                  notifyOnComplete
                    ? 'Disable import completion email notifications'
                    : 'Notify when import completes'
                }
                className={`p-2 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/80 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface ${notifyOnComplete ? 'bg-blue-500/20 text-blue-400' : 'bg-bg-surface text-text-muted hover:text-text-primary'}`}
                onClick={() => setNotifyOnComplete(!notifyOnComplete)}
              >
                <Bell size={20} aria-hidden="true" />
              </button>
            </Tooltip>
          </div>
        </div>

        <div
          data-testid="import-type-selector"
          className="grid grid-cols-1 sm:grid-cols-4 gap-4 mb-8"
        >
          {IMPORT_TYPES.map((type) => (
            <Tooltip key={type} content={IMPORT_TYPE_TOOLTIPS[type]} className="w-full">
              <button
                type="button"
                aria-pressed={importType === type}
                onClick={() => {
                  setImportType(type);
                  setFile(null);
                  setPreviewData(null);
                  setError(null);
                  setMappingStage(null);
                  setOriginalParse(null);
                }}
                className={`
                                 w-full min-w-0 p-4 rounded-xl border transition-all duration-200 text-left relative overflow-hidden group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/80 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface
                                 ${
                                   importType === type
                                     ? 'bg-blue-500/10 border-blue-500/50 shadow-[0_0_20px_rgba(56,189,248,0.1)]'
                                     : 'bg-bg-surface border-border-subtle hover:bg-bg-surface-hover hover:border-border-highlight'
                                 }
                             `}
              >
                <div className="relative z-10">
                  <div className="flex justify-between items-center gap-2 mb-1 min-w-0">
                    <span
                      className={`font-semibold capitalize truncate ${importType === type ? 'text-blue-400' : 'text-text-primary'}`}
                    >
                      {type}
                    </span>
                    {getImportedCount(type) > 0 && (
                      <span className="shrink-0 text-xs bg-green-500/20 text-green-400 px-2 py-0.5 rounded-full flex items-center gap-1">
                        <CheckCircle size={10} />
                        {getImportedCount(type)}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-text-muted">
                    {type === 'players' && 'Upload player registration data'}
                    {type === 'coaches' && 'Upload coach assignments'}
                    {type === 'fields' && 'Upload field configurations'}
                    {type === 'field_availability' &&
                      'Upload seasonal availability metadata (not schedule slots)'}
                  </p>
                </div>
              </button>
            </Tooltip>
          ))}
        </div>

        {/* Template download + defer-field hint */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6 p-3 bg-bg-surface/50 border border-border-subtle rounded-lg">
          <div className="text-xs text-text-secondary flex items-start gap-2 min-w-0">
            <Info size={14} className="shrink-0 mt-0.5 text-blue-400" />
            <span>
              {importType === 'fields' ? (
                <>
                  No fields yet?{' '}
                  <span className="text-text-primary">
                    You can skip this step and add them later
                  </span>{' '}
                  at <span className="font-mono text-brand-400">/fields</span> — useful if your
                  permits aren&apos;t finalized.
                </>
              ) : importType === 'field_availability' ? (
                <>
                  Seasonal availability metadata — not finalized schedule slots. No explicit
                  day/time slots were provided; schedule slots were not created.
                </>
              ) : (
                <>
                  Not sure about the format? Download a template with the expected columns and an
                  example row.
                </>
              )}
            </span>
          </div>
          <Tooltip content={`Download a ${importType} CSV template.`} className="w-full sm:w-auto">
            <button
              type="button"
              onClick={() => downloadTemplate(importType)}
              className="flex w-full sm:w-auto items-center justify-center gap-2 px-3 py-1.5 rounded-lg border border-border-subtle bg-bg-surface hover:bg-bg-surface-hover text-text-primary text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/80 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface"
            >
              <Download size={14} aria-hidden="true" />
              Download {importType} template
            </button>
          </Tooltip>
        </div>

        {mappingStage ? (
          <ColumnMapper
            importType={importType}
            rawHeaders={mappingStage.rawHeaders}
            sampleRows={mappingStage.sampleRows}
            autoMatches={mappingStage.autoMatches}
            onConfirm={handleMappingConfirm}
            onCancel={handleMappingCancel}
          />
        ) : !previewData ? (
          <div
            className={`border-2 border-dashed rounded-xl p-6 sm:p-12 text-center transition-all duration-300 max-w-full min-w-0 ${
              isDragging
                ? 'border-blue-400 bg-blue-500/10 scale-[1.02]'
                : 'border-border-subtle hover:border-border-highlight bg-bg-surface hover:bg-bg-surface-hover'
            }`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <div className="flex flex-col items-center gap-6 animate-fadeIn">
              <div
                className={`p-6 rounded-full transition-colors duration-300 ${isDragging ? 'bg-blue-500/20' : 'bg-bg-surface'}`}
              >
                <UploadCloud
                  className={`w-12 h-12 transition-colors duration-300 ${isDragging ? 'text-blue-400' : 'text-text-muted'}`}
                />
              </div>
              <div>
                <p className="text-xl font-medium text-text-primary mb-2">
                  Drag and drop your CSV file here
                </p>
                <p className="text-sm text-text-secondary">
                  or{' '}
                  <label
                    htmlFor={fileInputId}
                    className="text-blue-400 hover:text-blue-300 cursor-pointer font-semibold hover:underline transition-colors rounded-sm focus-within:outline-none focus-within:ring-2 focus-within:ring-blue-400/80 focus-within:ring-offset-2 focus-within:ring-offset-bg-surface"
                  >
                    browse files
                    <input
                      id={fileInputId}
                      type="file"
                      className="sr-only"
                      accept=".csv"
                      onChange={handleFileSelect}
                    />
                  </label>
                </p>
              </div>
              {error && (
                <div
                  data-testid="import-error-banner"
                  className="bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-2 rounded-lg text-sm mt-2 animate-slideUp flex items-center gap-2"
                >
                  <AlertCircle size={16} />
                  {error}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div
            data-testid="import-preview-card"
            className="bg-bg-surface border border-border-subtle rounded-lg overflow-visible animate-fadeIn max-w-full min-w-0"
          >
            <div
              data-testid="import-preview-header"
              className="p-4 border-b border-border-subtle flex flex-col xl:flex-row xl:justify-between xl:items-center gap-4 bg-bg-surface min-w-0"
            >
              <div
                data-testid="import-preview-file-summary"
                className="flex items-start gap-3 min-w-0"
              >
                <div className="p-2 bg-blue-500/20 rounded-lg shrink-0">
                  <FileText className="text-blue-400" size={20} />
                </div>
                <div className="min-w-0 flex-1">
                  <h3
                    className="text-lg font-semibold text-text-primary truncate"
                    title={file.name}
                  >
                    {file.name}
                  </h3>
                  <p className="text-sm text-text-secondary flex flex-wrap items-center gap-2 min-w-0">
                    {previewData.totalRows} rows detected
                    {previewData.smartMetadata && !previewData.smartMetadata.isFallback && (
                      <span className="text-[10px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded border border-blue-500/30 inline-flex items-center gap-1">
                        <BrainCircuit size={10} />
                        Smart Mapping Active ({previewData.smartMetadata.timing.toFixed(1)}ms)
                      </span>
                    )}
                  </p>
                </div>
              </div>
              <div className="w-full xl:w-auto xl:text-right">
                {importType === 'field_availability' && (
                  <>
                    <div className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                      This import stores seasonal field availability metadata. It does not create
                      practice or game slots.
                    </div>
                    <p className="mb-2 text-xs text-text-secondary">
                      Required fields:{' '}
                      {Object.values(REQUIRED_FIELD_LABELS.field_availability).join(', ')}
                    </p>
                    {showFieldAvailabilityMissingSlotCopy && (
                      <p className="mb-2 text-xs text-text-secondary">
                        No explicit day/time slots were provided; schedule slots were not created.
                      </p>
                    )}
                  </>
                )}
              </div>
              <div
                data-testid="import-preview-actions"
                className="flex flex-wrap gap-3 w-full xl:w-auto"
              >
                {originalParse && (
                  <Tooltip content="Review or edit column mapping." className="w-full sm:w-auto">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full sm:w-auto"
                      onClick={() => {
                        // Re-open the mapper against the ORIGINAL raw parse,
                        // not against previewData — previewData may be the
                        // post-confirmation rewritten CSV with canonical
                        // headers, which would present the user with
                        // canonical names as "raw" and prevent reverting to
                        // real source columns (Gemini review on #186).
                        setMappingStage({
                          rawHeaders: originalParse.headers,
                          rawData: originalParse.data,
                          sampleRows: originalParse.data.slice(0, 3),
                          autoMatches: originalParse.mappings,
                          smartMetadata: previewData.smartMetadata,
                          missingHeaders: [],
                        });
                        setPreviewData(null);
                      }}
                    >
                      <SlidersHorizontal size={14} className="mr-1" />
                      Adjust mapping
                    </Button>
                  </Tooltip>
                )}
                {importType !== 'players' && (
                  <Tooltip
                    content="Validate without applying records."
                    className="w-full sm:w-auto"
                  >
                    <Button
                      variant="secondary"
                      size="sm"
                      className="w-full sm:w-auto"
                      onClick={handleValidateOnlyImport}
                    >
                      Validate Only
                    </Button>
                  </Tooltip>
                )}
                <Tooltip content="Clear this file and choose another." className="w-full sm:w-auto">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full sm:w-auto"
                    onClick={() => {
                      setFile(null);
                      setPreviewData(null);
                      setOriginalParse(null);
                    }}
                  >
                    Cancel
                  </Button>
                </Tooltip>
                <Tooltip content="Validate and import this CSV." className="w-full sm:w-auto">
                  <Button
                    variant="primary"
                    size="sm"
                    className="w-full sm:w-auto"
                    onClick={handleStartImport}
                  >
                    Start Import
                  </Button>
                </Tooltip>
              </div>
            </div>
            <div
              data-testid="import-preview-table-wrapper"
              className="overflow-x-auto max-w-full pt-12 -mt-12"
            >
              <table className="min-w-max w-full text-left text-sm text-text-secondary">
                <thead className="bg-bg-surface text-xs uppercase font-semibold text-text-muted border-b border-border-subtle">
                  <tr>
                    {previewHeaders.map((header, i) => {
                      const confidence = previewData.smartMetadata?.confidence[header] || 0;
                      const rationale = previewData.smartMetadata?.rationales[header] || '';

                      return (
                        <th key={i} className="px-4 py-4 min-w-[150px]">
                          <div className="flex flex-col gap-1.5">
                            <span className="text-text-primary truncate" title={header}>
                              {header}
                            </span>
                            {confidence > 0 && (
                              <SmartBadge score={confidence} rationale={rationale} />
                            )}
                          </div>
                        </th>
                      );
                    })}
                    {importType !== 'field_availability' && previewData.headers.length > 5 && (
                      <th className="px-4 py-4 w-10">...</th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {previewData.rows.map((row, i) => {
                    const rowError = previewData.validationErrors?.find((ve) => ve.row === i + 2);
                    return (
                      <tr key={i} className="hover:bg-bg-surface-hover transition-colors">
                        {previewHeaders.map((header, j) => {
                          const mapped =
                            previewData.smartMetadata?.mappings[header] ||
                            header.toLowerCase().trim();
                          const isCellError = rowError?.errorFields?.includes(mapped);

                          return (
                            <td
                              key={j}
                              className={`px-4 py-3 whitespace-nowrap ${isCellError ? 'bg-status-error-bg text-status-error font-bold cell-error' : ''}`}
                            >
                              {row[header] || <span className="opacity-20">—</span>}
                            </td>
                          );
                        })}
                        {importType !== 'field_availability' && previewData.headers.length > 5 && (
                          <td className="px-4 py-3">...</td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="p-2 text-center text-xs text-text-muted bg-bg-surface border-t border-border-subtle">
              Showing first 5 rows preview
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
