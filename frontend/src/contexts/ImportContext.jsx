import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
} from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { z } from 'zod';
import { logger } from '../lib/logger.js';
import { REFRESH_TOPICS, emitRefresh } from '../lib/refreshBus.js';
import { withTimeout } from '../lib/withTimeout.js';
import { useOrganization } from './OrganizationContext.jsx';
import { matchHeaders, SYSTEM_COLUMNS } from '../utils/telemetryUtils.js';
import {
  canonicalizeForUpload,
  isSensitiveHeader,
  makeDedupeHeaderTransformer,
} from '../utils/gotsportCanonicalizer.js';
import {
  REQUIRED_HEADERS,
  findMissingRequiredHeaders,
  describeHeaderParse,
} from '../utils/importHeaders.js';
import {
  buildCoachLeadPayload,
  getExternalRegistrationId,
  hasCoachLeadIntent,
} from '../utils/coachLeads.js';

const MAX_ROWS = 10000;
const MAX_COLS = 1200;
const PLAYER_LOOKUP_CHUNK_SIZE = 500;
const canDeferImport = (type) =>
  type === 'coaches' || type === 'fields' || type === 'field_availability';

const ImportContext = createContext({
  isImporting: false,
  progress: 0,
  importStatus: 'idle',
  importLogs: [],
  notifyOnComplete: false,
  setNotifyOnComplete: (_val) => {},
  startImport: async (_file, _type, _options) => {},
  applyDeferredImport: async (_type) => {},
  cancelDeferredImport: async (_type) => {},
  resetImport: async (_type) => {},
  importedData: null,
  setImportedData: (_data) => {},
  importedPlayers: null,
  setImportedPlayers: (_data) => {},
  importedCoaches: null,
  setImportedCoaches: (_data) => {},
  importedFields: null,
  setImportedFields: (_data) => {},
  importedFieldAvailability: null,
  setImportedFieldAvailability: (_data) => {},
  rollbackImport: async (_type) => {},
  telemetryLogs: [],
  organizationSchemas: {},
  activeJobId: null,
  activeJob: null,
});

export function useImport() {
  return useContext(ImportContext);
}

// Static Utility: Mask Sensitive Data out of component scope to ensure stability
const maskDataInternal = (importPayload, entitySchema) => {
  if (!importPayload || !importPayload.data || !entitySchema) return importPayload;

  // Check if any schema fields are marked as sensitive
  const hasSensitiveFields = Object.values(entitySchema).some((field) => field.isSensitive);
  if (!hasSensitiveFields) return importPayload;

  const maskedRows = importPayload.data.map((row) => {
    if (!row.custom_attributes) return row;
    const newAttrs = { ...row.custom_attributes };
    let masked = false;
    for (const [key] of Object.entries(newAttrs)) {
      // Schema definition tells us if it's sensitive
      if (entitySchema[key]?.isSensitive) {
        newAttrs[key] = '***';
        masked = true;
      }
    }
    return masked ? { ...row, custom_attributes: newAttrs } : row;
  });
  return { ...importPayload, data: maskedRows };
};

const chunkValues = (values, chunkSize) => {
  const chunks = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
};

const persistCoachLeadSummary = async ({ importJobId, summary, statusOverride = null, addLog }) => {
  const { error } = await supabase.rpc('set_import_job_coach_lead_summary', {
    p_import_job_id: importJobId,
    p_summary: summary,
    p_status: statusOverride,
  });

  if (error) {
    addLog(`Warning: Could not persist coach lead summary: ${error.message}`);
  }
};

const fetchCoachLeadPlayers = async ({ organizationId, candidateRows }) => {
  const externalIds = Array.from(
    new Set(candidateRows.map(getExternalRegistrationId).filter(Boolean))
  );
  const players = [];

  for (const externalIdChunk of chunkValues(externalIds, PLAYER_LOOKUP_CHUNK_SIZE)) {
    const { data: matchedPlayers, error } = await supabase
      .from('players')
      .select('id, external_registration_id, division_id')
      .eq('organization_id', organizationId)
      .in('external_registration_id', externalIdChunk);

    if (error) {
      throw new Error(error.message || 'Could not resolve imported players');
    }
    players.push(...(matchedPlayers || []));
  }

  return players;
};

const captureCoachLeadsForImport = async ({
  importJobId,
  organizationId,
  normalizedData,
  addLog,
}) => {
  const candidateRows = normalizedData.filter(hasCoachLeadIntent);
  if (candidateRows.length === 0) return null;

  try {
    const { data: divisions, error: divisionsError } = await supabase
      .from('divisions')
      .select('id, name')
      .eq('organization_id', organizationId);

    if (divisionsError) {
      throw new Error(divisionsError.message || 'Could not resolve divisions');
    }

    const players = await fetchCoachLeadPlayers({ organizationId, candidateRows });
    const coachLeadPayload = buildCoachLeadPayload(normalizedData, {
      organizationId,
      divisions: divisions || [],
      players,
    });

    if (coachLeadPayload.length === 0) {
      const summary = {
        status: 'skipped',
        candidate_rows: candidateRows.length,
        leads_submitted: 0,
        message:
          'Coach volunteer rows were present, but no guardian or parent name and email could be resolved.',
      };
      addLog(
        `Warning: ${candidateRows.length} coach volunteer row(s) could not create leads because adult contact fields were missing.`
      );
      await persistCoachLeadSummary({
        importJobId,
        summary,
        statusOverride: 'completed_with_warnings',
        addLog,
      });
      return summary;
    }

    const { data: coachLeadResult, error: coachLeadError } = await supabase.rpc(
      'upsert_coach_leads',
      { p_leads: coachLeadPayload }
    );

    if (coachLeadError) {
      throw new Error(coachLeadError.message || 'Coach lead capture failed');
    }

    const summary = {
      status: 'completed',
      candidate_rows: candidateRows.length,
      leads_submitted: coachLeadPayload.length,
      leads_created: coachLeadResult?.leads_created ?? 0,
      programs_linked: coachLeadResult?.programs_linked ?? 0,
      skipped_existing: coachLeadResult?.skipped_existing ?? 0,
    };
    addLog(
      `Coach leads captured: ${summary.leads_created} new, ${summary.programs_linked} program links.`
    );
    await persistCoachLeadSummary({ importJobId, summary, addLog });
    return summary;
  } catch (err) {
    const summary = {
      status: 'failed',
      candidate_rows: candidateRows.length,
      leads_submitted: 0,
      message: err.message,
    };
    addLog(`Coach leads were NOT saved (players still imported): ${err.message}`);
    await persistCoachLeadSummary({
      importJobId,
      summary,
      statusOverride: 'completed_with_warnings',
      addLog,
    });
    return summary;
  }
};

const materializeBuddyPairsForImport = async ({ importJobId, addLog }) => {
  try {
    const { data: buddyPairResult, error: buddyPairError } = await supabase.rpc(
      'materialize_import_buddy_pairs',
      { p_import_job_id: importJobId }
    );

    if (buddyPairError) {
      throw new Error(buddyPairError.message || 'Buddy pair materialization failed');
    }

    addLog(
      `Buddy pairs materialized: ${buddyPairResult?.materialized_pairs ?? 0} pair(s), ${buddyPairResult?.inserted_relationships ?? 0} relationship rows.`
    );
    if (buddyPairResult?.status === 'completed_with_warnings') {
      addLog('Warning: Some buddy requests could not be matched reciprocally.');
    }
    return buddyPairResult;
  } catch (err) {
    const summary = {
      status: 'failed',
      message: err.message,
    };
    addLog(`Buddy pairs were NOT saved (players still imported): ${err.message}`);
    return summary;
  }
};

export function ImportProvider({ children }) {
  const { currentOrganization, orgMember } = useOrganization();
  const [isImporting, setIsImporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [importStatus, setImportStatus] = useState(() => {
    return localStorage.getItem('importStatus') || 'idle';
  }); // idle, importing, ready_to_apply, completed, completed_with_warnings, error
  const [importLogs, setImportLogs] = useState([]);
  const [notifyOnComplete, setNotifyOnComplete] = useState(false);
  const [telemetryLogs, setTelemetryLogs] = useState([]);

  // Multi-type state
  const [importedPlayers, setImportedPlayers] = useState(null);
  const [importedCoaches, setImportedCoaches] = useState(null);
  const [importedFields, setImportedFields] = useState(null);
  const [importedFieldAvailability, setImportedFieldAvailability] = useState(null);
  const [importedData, setImportedData] = useState(null); // Legacy/General
  const [organizationSchemas, setOrganizationSchemas] = useState({
    player: {},
    coach: {},
    field: {},
  }); // { player: {}, coach: {}, team: {} }
  const [activeJobId, setActiveJobId] = useState(null);
  const [activeJob, setActiveJob] = useState(null);

  // Refs for Realtime callbacks to avoid stale closures
  const activeJobRef = useRef(activeJob);
  const activeJobIdRef = useRef(activeJobId);

  useEffect(() => {
    activeJobRef.current = activeJob;
    activeJobIdRef.current = activeJobId;
  }, [activeJob, activeJobId]);

  const setImportDataForType = useCallback((type, data) => {
    if (type === 'players') setImportedPlayers(data);
    if (type === 'coaches') setImportedCoaches(data);
    if (type === 'fields') setImportedFields(data);
    if (type === 'field_availability') setImportedFieldAvailability(data);
    setImportedData(data);
  }, []);

  const hydrateReadyImportJob = useCallback(
    async (job) => {
      const { buildDeferredImportDataFromJob } = await import('../utils/importDeferredActions.js');
      const deferredImportData = buildDeferredImportDataFromJob(job);
      setActiveJobId(job.id);
      setActiveJob((prev) => ({ ...(prev || {}), ...job }));
      setIsImporting(false);
      setImportStatus('ready_to_apply');
      setProgress(job.progress_percent || 100);
      localStorage.setItem('importStatus', 'ready_to_apply');
      if (deferredImportData) {
        setImportDataForType(deferredImportData.persistence.ready.import_type, deferredImportData);
      }
    },
    [setImportDataForType]
  );

  // Throttled Progress Update Helper
  const lastUpdateRef = useRef(0);
  const updateJobProgress = useCallback(
    async (jobId, progressPercent, processedRows = null) => {
      const now = Date.now();
      // Governance: Throttled to 100ms max frequency
      if (now - lastUpdateRef.current < 100 && progressPercent < 100) return;

      lastUpdateRef.current = now;
      setProgress(progressPercent);

      const { persistImportJobProgress } = await import('../utils/importJobLifecycleActions.js');
      const updatedJob = await persistImportJobProgress({
        supabase,
        importJobId: jobId,
        progressPercent,
        processedRows: Number.isFinite(processedRows) ? processedRows : null,
      });
      setActiveJob((prev) => (prev?.id === jobId ? { ...prev, ...updatedJob } : prev));

      // Broadcast Realtime Channel
      const channel = supabase.channel(`import-progress-${currentOrganization?.id}`);
      channel.send({
        type: 'broadcast',
        event: 'import.progress_update',
        payload: { jobId, progress: progressPercent, status: 'processing' },
      });
    },
    [currentOrganization?.id]
  );

  // 1. Fetch Organization-Scoped Telemetry & Custom Schemas (Lazy Cache)
  useEffect(() => {
    const loadOrgData = async () => {
      if (!currentOrganization?.id) return;

      try {
        logger.log('[ImportContext] Fetching org data for:', currentOrganization.id);

        // Fetch Telemetry
        const { data: telData, error: telError } = await supabase
          .from('telemetry_log')
          .select('*')
          .eq('org_id', currentOrganization.id)
          .order('created_at', { ascending: false });

        if (telError) throw telError;
        setTelemetryLogs(telData || []);

        // Fetch Custom Schemas
        const { data: schemaData, error: schemaError } = await supabase
          .from('organization_schemas')
          .select('entity_type, schema_definition')
          .eq('organization_id', currentOrganization.id);

        if (schemaError) throw schemaError;

        const schemaMap = { player: {}, coach: {}, field: {} };
        schemaData?.forEach((s) => {
          schemaMap[s.entity_type] = s.schema_definition;
        });
        setOrganizationSchemas(schemaMap);
      } catch (err) {
        logger.error('Failed to fetch org data:', err);
      }
    };

    loadOrgData();
  }, [currentOrganization?.id]);

  const addLog = useCallback((message) => {
    setImportLogs((prev) => [...prev, { timestamp: new Date(), message }]);
  }, []);

  // 2. Load initial state & Setup Realtime Subscriptions
  useEffect(() => {
    const loadFromSupabase = async () => {
      try {
        let readyImportType = null;
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user || !currentOrganization?.id) return;

        logger.log('[ImportContext] Loading imports for user:', user.id);

        const role = orgMember?.role;
        const roleKnown = Boolean(role);
        const canManageImports = role === 'admin' || role === 'tenant_admin';

        if (canManageImports) {
          const { data: staleCleanup, error: staleCleanupError } = await supabase.rpc(
            'fail_stale_import_jobs',
            {
              p_organization_id: currentOrganization.id,
            }
          );
          if (staleCleanupError) {
            logger.warn('[ImportContext] Failed to clean stale import jobs:', staleCleanupError);
          } else if (staleCleanup?.failed_jobs > 0) {
            addLog(
              `${staleCleanup.failed_jobs} stale import job${staleCleanup.failed_jobs === 1 ? '' : 's'} failed so the import can be retried.`
            );
          }
        }

        if (roleKnown && canManageImports) {
          // Check for active/recent jobs for re-hydration
          const { data: activeJobs } = await supabase
            .from('import_jobs')
            .select('*')
            .eq('organization_id', currentOrganization.id)
            .in('status', ['processing', 'importing', 'ready_to_apply'])
            .order('created_at', { ascending: false })
            .limit(1);

          if (activeJobs && activeJobs.length > 0) {
            const job = activeJobs[0];
            if (job.status === 'ready_to_apply') {
              await hydrateReadyImportJob(job);
              readyImportType = job.warning_summary?.deferred_apply?.import_type;
            } else {
              setActiveJobId(job.id);
              setActiveJob(job);
              setProgress(job.progress_percent || 0);
              setIsImporting(true);
              setImportStatus('importing');
            }
          }
        }

        const { data, error } = await supabase
          .from('imports')
          .select('*')
          .eq('user_id', user.id)
          .eq('organization_id', currentOrganization.id)
          .order('created_at', { ascending: false });

        if (error) throw error;

        if (data && !readyImportType) {
          const latestPlayers = data.find((i) => i.import_type === 'players');
          const latestCoaches = data.find((i) => i.import_type === 'coaches');
          const latestFields = data.find((i) => i.import_type === 'fields');
          const latestFieldAvailability = data.find((i) => i.import_type === 'field_availability');

          if (latestPlayers) setImportedPlayers(latestPlayers.data);
          if (latestCoaches) setImportedCoaches(latestCoaches.data);
          if (latestFields) setImportedFields(latestFields.data);
          if (latestFieldAvailability) setImportedFieldAvailability(latestFieldAvailability.data);
          if (latestPlayers) setImportedData(latestPlayers.data);
        }
      } catch (e) {
        logger.error('Failed to load imports from Supabase:', e);
      }
    };

    loadFromSupabase();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
        loadFromSupabase();
      }
    });

    let channel = null;
    if (currentOrganization?.id) {
      channel = supabase
        .channel(`import-jobs-${currentOrganization.id}`)
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'import_jobs' },
          (payload) => {
            const newJob = payload.new;
            // Governance: Type safety and existence check
            if (newJob && typeof newJob === 'object' && 'status' in newJob && 'id' in newJob) {
              const job = newJob;

              if (job.status === 'processing' || job.status === 'importing') {
                // Throttled UI update logic for active job
                if (activeJobIdRef.current === job.id) {
                  setActiveJob((prev) => ({ ...prev, ...job }));
                  if (job.progress_percent !== undefined) {
                    setProgress(job.progress_percent);
                  }
                }
              } else if (['completed', 'failed', 'completed_with_warnings'].includes(job.status)) {
                if (activeJobIdRef.current === job.id || !activeJobIdRef.current) {
                  setIsImporting(false);
                  setImportStatus(job.status);
                  setActiveJob((prev) => ({ ...(prev || {}), ...job }));
                }
              }
            }
          }
        )
        .subscribe();
    }

    return () => {
      subscription?.unsubscribe();
      if (channel) supabase.removeChannel(channel);
    };
  }, [addLog, currentOrganization?.id, hydrateReadyImportJob, orgMember?.role]);

  const completeImport = useCallback(
    (type, _previewData, status = 'completed') => {
      setIsImporting(false);
      setImportStatus(status);
      localStorage.setItem('importStatus', status);
      addLog(
        status === 'completed_with_warnings'
          ? `Import for ${type} applied with warnings — check the import log; some related data may not have been saved.`
          : `Import for ${type} applied successfully.`
      );

      if (notifyOnComplete) {
        logger.log('Sending email notification...');
        addLog('Email notification sent.');
      }
    },
    [addLog, notifyOnComplete]
  );

  const startImport = useCallback(
    async (file, type = 'players', options = {}) => {
      const deferApply = options.deferApply === true && canDeferImport(type);
      setIsImporting(true);
      setImportStatus('importing');
      setProgress(0);
      setImportLogs([]);
      addLog(
        deferApply
          ? `Starting validation for ${type} from ${file.name}...`
          : `Starting import for ${type} from ${file.name}...`
      );

      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user || !currentOrganization?.id)
          throw new Error('Unauthenticated or no organization');

        const [{ default: Papa }, { createImportJob, failImportJob, persistImportJobProgress }] =
          await Promise.all([import('papaparse'), import('../utils/importJobLifecycleActions.js')]);
        const job = await createImportJob({
          supabase,
          organizationId: currentOrganization.id,
          type,
          fileName: file.name,
        });
        setActiveJobId(job.id);
        setActiveJob(job);

        addLog('Parsing CSV data...');
        Papa.parse(file, {
          header: true,
          skipEmptyLines: true,
          // Disambiguate GotSport's repeated headers (e.g. "Playing Up" appears
          // once per coached player) so duplicate columns never collide.
          transformHeader: makeDedupeHeaderTransformer(),
          complete: async (results) => {
            const { meta } = results;
            // For player/coach imports, strip sensitive registration columns
            // (medical, insurance, financial/payment, identity documents,
            // waivers, non-teaming demographics) BEFORE upload so they never
            // leave the browser. Kept columns retain their original headers, so
            // downstream header recognition is unchanged.
            const isPrivacyFiltered = type === 'players' || type === 'coaches';
            const data = isPrivacyFiltered
              ? canonicalizeForUpload(type, results.data)
              : results.data;
            if (isPrivacyFiltered && Array.isArray(meta.fields)) {
              meta.fields = meta.fields.filter((h) => !isSensitiveHeader(h));
            }

            // Guard an unreadable header row (empty file, wrong delimiter, or
            // encoding/quoting damage) before any meta.fields access below.
            if (!Array.isArray(meta.fields) || meta.fields.length === 0) {
              await failImportJob({
                supabase,
                importJobId: job.id,
                stage: 'header_validation',
                message:
                  'No columns were detected in the file. It may be empty, not comma-delimited, or mis-encoded — re-save as CSV (UTF-8, comma-delimited) and try again.',
                errorSummary: describeHeaderParse({
                  fields: meta.fields,
                  meta,
                  parseErrors: results.errors,
                }),
              });
              setImportStatus('error');
              setIsImporting(false);
              addLog('Import failed: no columns were detected in the file.');
              return;
            }

            // Check hard limits for DoS mitigation
            if (meta.fields.length > MAX_COLS) {
              await failImportJob({
                supabase,
                importJobId: job.id,
                stage: 'parse_limit',
                message: `Payload exceeds column limit of ${MAX_COLS}`,
                errorSummary: { limit: 'columns', max_columns: MAX_COLS },
              });
              setImportStatus('error');
              setIsImporting(false);
              addLog('Validation Error: Payload exceeds column limit of ' + MAX_COLS);
              return;
            }
            if (data.length > MAX_ROWS) {
              await failImportJob({
                supabase,
                importJobId: job.id,
                stage: 'parse_limit',
                message: `Payload exceeds row limit of ${MAX_ROWS}`,
                errorSummary: { limit: 'rows', max_rows: MAX_ROWS },
              });
              setImportStatus('error');
              setIsImporting(false);
              addLog('Validation Error: Payload exceeds row limit of ' + MAX_ROWS);
              return;
            }

            // Update total rows
            const countedJob = await persistImportJobProgress({
              supabase,
              importJobId: job.id,
              totalRows: data.length,
            });
            setActiveJob((prev) => ({ ...(prev || {}), ...countedJob }));

            // Phase 5: Dynamic Ingestion Logic
            const entityType =
              type === 'players' ? 'player' : type === 'coaches' ? 'coach' : 'field';
            const customSchema = organizationSchemas[entityType] || {};

            const { mappings, isFallback, timing, needsConfirmation } = matchHeaders(
              meta.fields,
              telemetryLogs,
              customSchema
            );

            const efficiency = isFallback ? 85.0 : 99.2;
            const efficiencyMetadata = {
              efficiency,
              latency: timing,
              needs_confirmation: needsConfirmation,
            };

            if (isFallback) {
              addLog(
                `Performance Warning: Smart Ingestion timed out (${timing.toFixed(2)}ms). Using static fallback.`
              );
            } else {
              addLog(`Smart Ingestion active. Match calculated in ${timing.toFixed(2)}ms.`);
              if (needsConfirmation.length > 0) {
                addLog(`Warning: ${needsConfirmation.length} fields require manual confirmation.`);
              }
            }

            // Persist metrics for Enterprise Overlay
            const efficiencyJob = await persistImportJobProgress({
              supabase,
              importJobId: job.id,
              efficiencyMetadata,
            });

            setActiveJob((prev) => ({ ...(prev || {}), ...efficiencyJob }));

            // Phase 5 Vibe Audit: Detect if a key must go into JSONB vs root table
            const _shouldGoToCustomAttributes = (mappedKey) => {
              // If it's a known custom field, yes.
              if (organizationSchemas[entityType]?.[mappedKey]) return true;
              // If it's NOT a system column, yes (Fluid Schemas rule).
              if (!SYSTEM_COLUMNS.has(mappedKey)) return true;
              return false;
            };

            const normalizedData = [];
            const validationErrors = [];

            const requiredForType = REQUIRED_HEADERS[type] || [];
            const missingHeaders = findMissingRequiredHeaders(meta.fields, type, mappings);
            if (missingHeaders.length > 0) {
              const headerDiagnostics = describeHeaderParse({
                fields: meta.fields,
                meta,
                parseErrors: results.errors,
              });
              const collapsedHint =
                (meta?.fields?.length ?? 0) <= 1
                  ? ` The file did not split into columns (detected ${meta?.fields?.length ?? 0}). It may be tab-delimited or have encoding/quoting issues — re-save as CSV (UTF-8, comma-delimited) and try again.`
                  : '';
              await failImportJob({
                supabase,
                importJobId: job.id,
                stage: 'header_validation',
                message: `Missing required columns: ${missingHeaders.join(', ')}.${collapsedHint}`,
                errorSummary: { missing_columns: missingHeaders, ...headerDiagnostics },
              });
              setImportStatus('error');
              setIsImporting(false);
              addLog(
                `Import failed: Missing required columns: ${missingHeaders.join(', ')}.${collapsedHint}`
              );
              return;
            }

            // Create Zod Schema dynamically for the base requirement
            const schemaShape = {};
            requiredForType.forEach((req) => {
              schemaShape[req] = z.string().min(1, `Missing ${req}`);
            });
            const _rowSchema = z.object(schemaShape).passthrough();

            const CHUNK_SIZE = 5000;
            let currentIndex = 0;

            const processChunk = async () => {
              const endIndex = Math.min(currentIndex + CHUNK_SIZE, data.length);
              const chunkRows = data.slice(currentIndex, endIndex);

              addLog(
                `Validating batch ${Math.floor(currentIndex / CHUNK_SIZE) + 1} (${chunkRows.length} rows)...`
              );

              try {
                // 60s timeout guards against the Edge Function hanging silently
                // (e.g. after a successful CORS preflight when the POST never
                // fires). Without this the UI stalls forever on "Importing
                // Data..." with no diagnostic.
                const { data: efResult, error: efError } = await withTimeout(
                  supabase.functions.invoke('import-validation', {
                    body: {
                      import_type: type,
                      organization_id: currentOrganization.id,
                      rows: chunkRows,
                      file_name: file.name,
                      import_job_id: job.id,
                      row_offset: currentIndex,
                    },
                  }),
                  60000,
                  'Import validation'
                );

                if (efError || !efResult || efResult.status === 'error') {
                  throw new Error(efError?.message || efResult?.message || 'Validation failed');
                }

                // Add validated/sanitized rows
                normalizedData.push(...efResult.validated_data);

                // Add errors (adjusting row index since EF uses relative index)
                const adjustedErrors = efResult.validation_errors.map((err) => ({
                  ...err,
                  row: err.row + currentIndex, // EF offset was relative to chunk
                }));
                validationErrors.push(...adjustedErrors);

                // Update progress
                const currentProgress = Math.floor((endIndex / data.length) * 100);
                await updateJobProgress(job.id, currentProgress, endIndex);

                currentIndex = endIndex;
                if (currentIndex < data.length) {
                  setTimeout(processChunk, 100); // Small breath for UI
                } else {
                  await finalizeImport();
                }
              } catch (err) {
                logger.error('Edge Function validation failed:', err);
                addLog(`Server Validation Error: ${err.message}`);
                await failImportJob({
                  supabase,
                  importJobId: job.id,
                  stage: 'validation',
                  message: err.message,
                });
                setImportStatus('error');
                setIsImporting(false);
              }
            };

            const finalizeImport = async () => {
              addLog(
                `Validation complete. ${normalizedData.length} valid rows, ${validationErrors.length} errors.`
              );
              const finalStatus =
                validationErrors.length > 0 ? 'completed_with_warnings' : 'completed';
              let persistenceResult = null;
              let effectiveStatus = finalStatus;

              if (deferApply) {
                addLog(`Validation complete. ${type} import is ready for review.`);
                const { markDeferredImportReady } =
                  await import('../utils/importDeferredActions.js');
                const { importData, activeJob: readyJob } = await markDeferredImportReady({
                  supabase,
                  job,
                  type,
                  fileName: file.name,
                  totalRows: data.length,
                  normalizedData,
                  validationErrors,
                });

                setImportDataForType(type, importData);
                setProgress(100);
                setActiveJob(readyJob);
                setIsImporting(false);
                setImportStatus('ready_to_apply');
                localStorage.setItem('importStatus', 'ready_to_apply');
                addLog(
                  `${type === 'fields' ? 'Field' : type === 'field_availability' ? 'Field availability' : 'Coach'} import validated and waiting for apply.`
                );
                return;
              }

              if (type === 'players') {
                addLog('Applying validated players to the roster database...');
                const { data: finalizeResult, error: finalizeError } = await supabase.rpc(
                  'finalize_import_job',
                  {
                    p_import_job_id: job.id,
                    p_validation_errors: validationErrors,
                  }
                );

                if (finalizeError) {
                  throw new Error(finalizeError.message || 'Import finalization failed');
                }

                persistenceResult = finalizeResult;
                effectiveStatus = finalizeResult?.status || finalStatus;
                addLog(
                  `Roster database updated: ${finalizeResult?.inserted_players ?? 0} inserted, ${finalizeResult?.updated_players ?? 0} updated.`
                );
                // Imports change the roster size; nudge the nav count badges.
                emitRefresh(REFRESH_TOPICS.NAV_BADGES);

                const buddyPairSummary = await materializeBuddyPairsForImport({
                  importJobId: job.id,
                  addLog,
                });
                if (buddyPairSummary) {
                  persistenceResult = {
                    ...(persistenceResult || {}),
                    buddy_pairs: buddyPairSummary,
                  };
                  if (buddyPairSummary.status !== 'completed') {
                    effectiveStatus = 'completed_with_warnings';
                  }
                }

                const coachLeadSummary = await captureCoachLeadsForImport({
                  importJobId: job.id,
                  organizationId: currentOrganization.id,
                  normalizedData,
                  addLog,
                });
                if (coachLeadSummary) {
                  persistenceResult = {
                    ...(persistenceResult || {}),
                    coach_leads: coachLeadSummary,
                  };
                  if (coachLeadSummary.status !== 'completed') {
                    effectiveStatus = 'completed_with_warnings';
                  }
                }

                // Surface genuine sub-step failures distinctly from benign partial
                // warnings. Players are already persisted, so we keep the import
                // successful, but we must not let a swallowed RPC failure look like
                // a clean success — record what did NOT save so it can be retried.
                const incompleteSecondarySteps = [];
                if (buddyPairSummary?.status === 'failed')
                  incompleteSecondarySteps.push('buddy pairs');
                if (coachLeadSummary?.status === 'failed')
                  incompleteSecondarySteps.push('coach leads');
                if (incompleteSecondarySteps.length > 0) {
                  effectiveStatus = 'completed_with_warnings';
                  persistenceResult = {
                    ...(persistenceResult || {}),
                    incomplete_steps: incompleteSecondarySteps,
                  };
                  addLog(
                    `Players were imported, but these steps did NOT save and can be retried: ${incompleteSecondarySteps.join(', ')}.`
                  );
                }
              } else if (type === 'coaches') {
                addLog('Applying validated coaches to the coach database...');
                const { data: finalizeResult, error: finalizeError } = await supabase.rpc(
                  'finalize_coach_import_job',
                  {
                    p_import_job_id: job.id,
                    p_validation_errors: validationErrors,
                  }
                );

                if (finalizeError) {
                  throw new Error(finalizeError.message || 'Coach import finalization failed');
                }

                persistenceResult = finalizeResult;
                effectiveStatus = finalizeResult?.status || finalStatus;
                addLog(
                  `Coach database updated: ${finalizeResult?.inserted_coaches ?? 0} inserted, ${finalizeResult?.updated_coaches ?? 0} updated.`
                );
              } else if (type === 'fields') {
                addLog('Applying validated field slots to the facilities database...');
                const { data: finalizeResult, error: finalizeError } = await supabase.rpc(
                  'finalize_field_import_job',
                  {
                    p_import_job_id: job.id,
                    p_validation_errors: validationErrors,
                  }
                );

                if (finalizeError) {
                  throw new Error(finalizeError.message || 'Field import finalization failed');
                }

                persistenceResult = finalizeResult;
                effectiveStatus = finalizeResult?.status || finalStatus;
                addLog(
                  `Facilities database updated: ${finalizeResult?.inserted_fields ?? 0} fields, ${finalizeResult?.inserted_practice_slots ?? 0} practice slots, ${finalizeResult?.inserted_game_slots ?? 0} game slots inserted.`
                );
              } else if (type === 'field_availability') {
                addLog('Applying validated field availability metadata...');
                const { data: finalizeResult, error: finalizeError } = await supabase.rpc(
                  'finalize_field_availability_import_job',
                  {
                    p_import_job_id: job.id,
                    p_validation_errors: validationErrors,
                  }
                );

                if (finalizeError) {
                  throw new Error(
                    finalizeError.message || 'Field availability import finalization failed'
                  );
                }

                persistenceResult = finalizeResult;
                effectiveStatus = finalizeResult?.status || finalStatus;
                addLog(
                  `Field availability updated: ${finalizeResult?.inserted_profiles ?? 0} profiles, ${finalizeResult?.inserted_blackouts ?? 0} blackouts, ${finalizeResult?.inserted_requirements ?? 0} equipment requirements.`
                );
                addLog(
                  'No explicit day/time slots were provided; schedule slots were not created.'
                );
              }

              // **The same refusal reporting as the deferred path.** This arm
              // calls the identical finalize RPCs and printed only its insert
              // counts, so an operator importing a CSV whose venues do not
              // match any field saw "0 profiles" and "check the import log"
              // with nothing in the log to check.
              if (persistenceResult) {
                const { describeFinalizeOutcome } =
                  await import('../utils/importDeferredActions.js');
                describeFinalizeOutcome(persistenceResult, type).forEach(addLog);
              }

              const importData = {
                importJobId: job.id,
                fileName: file.name,
                totalRows: data.length,
                validRows: normalizedData.length,
                errorRows: validationErrors.length,
                timestamp: new Date(),
                data: normalizedData,
                validationErrors,
                persistence: {
                  durable:
                    type === 'players' ||
                    type === 'coaches' ||
                    type === 'fields' ||
                    type === 'field_availability',
                  result: persistenceResult,
                },
              };

              setImportDataForType(type, importData);

              completeImport(type, importData, effectiveStatus);
            };

            await processChunk();
          },
          error: (err) => {
            addLog(`Error parsing CSV: ${err.message}`);
            setImportStatus('error');
            setIsImporting(false);
          },
        });
      } catch (err) {
        logger.error('Import error:', err);
        addLog(`Import failed: ${err.message}`);
        setImportStatus('error');
        setIsImporting(false);
      }
    },
    [
      addLog,
      telemetryLogs,
      completeImport,
      currentOrganization?.id,
      updateJobProgress,
      organizationSchemas,
      setImportDataForType,
    ]
  );

  const applyDeferredImport = useCallback(
    async (type = 'coaches') => {
      const deferredState =
        type === 'coaches'
          ? importedCoaches
          : type === 'field_availability'
            ? importedFieldAvailability
            : importedFields;
      const deferredJobId = deferredState?.importJobId;
      if (!deferredJobId) {
        throw new Error('No validated import job is ready to apply');
      }

      setIsImporting(true);
      setImportStatus('importing');
      setProgress(100);
      addLog(`Applying ${type} import...`);

      try {
        const { finalizeDeferredImportJob } = await import('../utils/importDeferredActions.js');
        const finalizeResult = await finalizeDeferredImportJob({
          supabase,
          type,
          importJobId: deferredJobId,
          validationErrors: deferredState.validationErrors || [],
        });

        // Say which rows the server refused, and why. `completeImport` already
        // tells the operator to "check the import log" when a job finishes with
        // warnings, and for a server-side row refusal that log had nothing in
        // it to check: the reasons live on the staging rows and in the job's
        // warning_summary, neither of which this flow reads.
        const { describeFinalizeOutcome } = await import('../utils/importDeferredActions.js');
        describeFinalizeOutcome(finalizeResult, type).forEach(addLog);

        const appliedData = {
          ...deferredState,
          persistence: {
            ...(deferredState.persistence || {}),
            durable: true,
            deferred: true,
            result: finalizeResult,
          },
        };
        const effectiveStatus = finalizeResult?.status || 'completed';
        setImportDataForType(type, appliedData);
        setActiveJob((prev) => ({
          ...(prev || {}),
          id: deferredJobId,
          status: effectiveStatus,
          progress_percent: 100,
          completed_at: new Date().toISOString(),
        }));
        completeImport(type, appliedData, effectiveStatus);
        return finalizeResult;
      } catch (err) {
        logger.error('Import apply failed:', err);
        addLog(`Apply failed: ${err.message}`);
        setImportStatus('error');
        setIsImporting(false);
        throw err;
      }
    },
    [
      addLog,
      completeImport,
      importedCoaches,
      importedFieldAvailability,
      importedFields,
      setImportDataForType,
    ]
  );

  const cancelDeferredImport = useCallback(
    async (type = 'coaches') => {
      const deferredState =
        type === 'coaches'
          ? importedCoaches
          : type === 'field_availability'
            ? importedFieldAvailability
            : importedFields;
      const deferredJobId = deferredState?.importJobId;
      if (!deferredJobId) {
        throw new Error('No validated import job is ready to cancel');
      }

      setIsImporting(true);
      setImportStatus('importing');
      setProgress(100);
      addLog(`Canceling ${type} import...`);

      try {
        const { cancelDeferredImportJob } = await import('../utils/importDeferredActions.js');
        const cancelResult = await cancelDeferredImportJob({
          supabase,
          type,
          importJobId: deferredJobId,
        });

        setImportDataForType(type, null);
        setActiveJobId(null);
        setActiveJob(null);
        setIsImporting(false);
        setImportStatus('idle');
        setProgress(0);
        localStorage.removeItem('importStatus');
        addLog(`${type} import canceled before apply.`);
        return cancelResult;
      } catch (err) {
        logger.error('Import cancel failed:', err);
        addLog(`Cancel failed: ${err.message}`);
        setImportStatus('error');
        setIsImporting(false);
        throw err;
      }
    },
    [addLog, importedCoaches, importedFieldAvailability, importedFields, setImportDataForType]
  );

  const rollbackImport = useCallback(
    async (type = 'coaches') => {
      if (!['coaches', 'fields', 'field_availability'].includes(type)) {
        throw new Error(`Rollback is not available for ${type} imports yet`);
      }
      const rollbackState =
        type === 'coaches'
          ? importedCoaches
          : type === 'field_availability'
            ? importedFieldAvailability
            : importedFields;
      const rollbackJobId = rollbackState?.importJobId;
      if (!rollbackJobId) {
        throw new Error(`No completed ${type} import job is available to roll back`);
      }

      setIsImporting(true);
      setImportStatus('importing');
      addLog(`Rolling back ${type} import...`);

      try {
        const rpcName =
          type === 'coaches'
            ? 'rollback_coach_import_job'
            : type === 'field_availability'
              ? 'rollback_field_availability_import_job'
              : 'rollback_field_import_job';
        const { data: rollbackResult, error: rollbackError } = await supabase.rpc(rpcName, {
          p_import_job_id: rollbackJobId,
        });

        if (rollbackError) {
          throw new Error(rollbackError.message || `${type} import rollback failed`);
        }

        const rollbackData = {
          ...(rollbackState || {}),
          persistence: {
            ...(rollbackState?.persistence || {}),
            rollback: rollbackResult,
          },
        };
        const rollbackSucceeded = rollbackResult?.status === 'rolled_back';
        if (rollbackSucceeded) {
          if (type === 'coaches') setImportedCoaches(null);
          if (type === 'fields') setImportedFields(null);
          if (type === 'field_availability') setImportedFieldAvailability(null);
          setImportedData(null);
          setActiveJobId(null);
          setActiveJob(null);
        } else {
          if (type === 'coaches') setImportedCoaches(rollbackData);
          if (type === 'fields') setImportedFields(rollbackData);
          if (type === 'field_availability') setImportedFieldAvailability(rollbackData);
          setImportedData(rollbackData);
        }
        setIsImporting(false);
        const nextStatus = rollbackSucceeded ? 'idle' : 'completed_with_warnings';
        setImportStatus(nextStatus);
        if (nextStatus === 'idle') {
          localStorage.removeItem('importStatus');
        } else {
          localStorage.setItem('importStatus', nextStatus);
        }
        addLog(
          type === 'coaches'
            ? `Coach import rolled back: ${rollbackResult?.deleted_coaches ?? 0} deleted, ${rollbackResult?.restored_coaches ?? 0} restored.`
            : type === 'field_availability'
              ? `Field availability import rolled back: ${rollbackResult?.deleted_profiles ?? 0} profiles deleted.`
              : `Field import rolled back: ${rollbackResult?.deleted_fields ?? 0} fields, ${rollbackResult?.deleted_practice_slots ?? 0} practice slots, ${rollbackResult?.deleted_game_slots ?? 0} game slots deleted.`
        );
        return rollbackResult;
      } catch (err) {
        logger.error('Import rollback failed:', err);
        addLog(`Rollback failed: ${err.message}`);
        setImportStatus('error');
        setIsImporting(false);
        throw err;
      }
    },
    [addLog, importedCoaches, importedFieldAvailability, importedFields]
  );

  const resetImport = useCallback(async (type = 'all') => {
    if (type === 'all') {
      setIsImporting(false);
      setImportStatus('idle');
      localStorage.removeItem('importStatus');
      setImportLogs([]);
      setImportedData(null);
      setImportedPlayers(null);
      setImportedCoaches(null);
      setImportedFields(null);
      setImportedFieldAvailability(null);
      setActiveJobId(null);
      setActiveJob(null);
    } else {
      if (type === 'players') setImportedPlayers(null);
      if (type === 'coaches') setImportedCoaches(null);
      if (type === 'fields') setImportedFields(null);
      if (type === 'field_availability') setImportedFieldAvailability(null);
    }
  }, []);

  // Stabilized Memoized Data Views
  const maskedImportedPlayers = useMemo(
    () => maskDataInternal(importedPlayers, organizationSchemas?.player),
    [importedPlayers, organizationSchemas?.player]
  );
  const maskedImportedCoaches = useMemo(
    () => maskDataInternal(importedCoaches, organizationSchemas?.coach),
    [importedCoaches, organizationSchemas?.coach]
  );
  const maskedImportedFields = useMemo(
    () => maskDataInternal(importedFields, organizationSchemas?.field),
    [importedFields, organizationSchemas?.field]
  );
  // Keep field availability unmasked because it is infrastructure metadata
  // (season windows/capacity), not PII-bearing person records.
  const maskedImportedFieldAvailability = useMemo(
    () => importedFieldAvailability,
    [importedFieldAvailability]
  );
  const maskedImportedData = useMemo(
    () =>
      maskDataInternal(
        importedData,
        organizationSchemas?.player || organizationSchemas?.coach || organizationSchemas?.field
      ),
    [importedData, organizationSchemas]
  );

  // Stabilize State Setters
  const stableSetNotifyOnComplete = useCallback((val) => setNotifyOnComplete(val), []);
  const stableSetImportedData = useCallback((data) => setImportedData(data), []);
  const stableSetImportedPlayers = useCallback((data) => setImportedPlayers(data), []);
  const stableSetImportedCoaches = useCallback((data) => setImportedCoaches(data), []);
  const stableSetImportedFields = useCallback((data) => setImportedFields(data), []);
  const stableSetImportedFieldAvailability = useCallback(
    (data) => setImportedFieldAvailability(data),
    []
  );

  const value = useMemo(
    () => ({
      isImporting,
      progress,
      importStatus,
      importLogs,
      notifyOnComplete,
      setNotifyOnComplete: stableSetNotifyOnComplete,
      startImport,
      applyDeferredImport,
      cancelDeferredImport,
      resetImport,
      importedData: maskedImportedData,
      setImportedData: stableSetImportedData,
      importedPlayers: maskedImportedPlayers,
      setImportedPlayers: stableSetImportedPlayers,
      importedCoaches: maskedImportedCoaches,
      setImportedCoaches: stableSetImportedCoaches,
      importedFields: maskedImportedFields,
      setImportedFields: stableSetImportedFields,
      importedFieldAvailability: maskedImportedFieldAvailability,
      setImportedFieldAvailability: stableSetImportedFieldAvailability,
      rollbackImport,
      telemetryLogs,
      organizationSchemas,
      activeJobId,
      activeJob,
    }),
    [
      isImporting,
      progress,
      importStatus,
      importLogs,
      notifyOnComplete,
      stableSetNotifyOnComplete,
      startImport,
      applyDeferredImport,
      cancelDeferredImport,
      resetImport,
      maskedImportedData,
      stableSetImportedData,
      maskedImportedPlayers,
      stableSetImportedPlayers,
      maskedImportedCoaches,
      stableSetImportedCoaches,
      maskedImportedFields,
      stableSetImportedFields,
      maskedImportedFieldAvailability,
      stableSetImportedFieldAvailability,
      rollbackImport,
      telemetryLogs,
      organizationSchemas,
      activeJobId,
      activeJob,
    ]
  );

  return <ImportContext.Provider value={value}>{children}</ImportContext.Provider>;
}
