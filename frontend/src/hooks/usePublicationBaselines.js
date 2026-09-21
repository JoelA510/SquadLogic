import { useState, useEffect, useCallback } from 'react';
import {
  checkBaselineParity,
  makePublicationSnapshot,
  readPublicationSnapshot,
  serialisePublicationSnapshot,
} from '@squadlogic/core/publication/index.js';
import { supabase } from '../lib/supabaseClient.js';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { logger } from '../lib/logger.js';

/**
 * Published schedule baselines: the list, the write, and the one question they
 * exist to answer.
 *
 * **GAP-29 Stage 2/3/4 in one file's worth of wiring.**
 * `packages/core/src/publication/` could freeze a published artifact and
 * compare two row sets; what it had nowhere to put the frozen copy. It now
 * has `public.publication_baselines`
 * (`supabase/migrations/20260920000000_publication_baselines.sql`), and this
 * hook is the only thing in the app that touches it.
 *
 * **Reads the table directly, writes only through the RPC** — the shape
 * `useFieldClosures` established for `field_blackouts`, and for the same
 * reasons. `publication_baselines` has a SELECT policy for organisation
 * members and **no write policy at all**, so a direct insert is refused by
 * RLS. `admin_publish_schedule_baseline` is SECURITY DEFINER, gates on
 * `is_org_admin`, re-validates the document server-side rather than trusting
 * the Zod pass below, assigns the durable `baseline_version`, and audits
 * before and after.
 *
 * **The list deliberately does not carry the rows.** A season baseline is 679
 * rows of 13 columns, and a dropdown does not need them; `row_count` and
 * `digest` are stored beside the payload precisely so the list can be cheap.
 * {@link usePublicationBaselines} loads one baseline's payload only when
 * `compareWithBaseline` is asked for it.
 *
 * **Nothing here reads a clock for `publishedAt`.** The caller supplies it,
 * because `packages/core/src/publication/` refuses to self-stamp: a snapshot
 * that invents its own timestamp and actor carries two fields that read as an
 * audit trail and are not one. {@link naivePublicationStamp} exists so the
 * *component* has one obvious way to produce the stamp, and it is exported so
 * a test can see what it produces.
 */

/**
 * `YYYY-MM-DDTHH:MM:SS` in the browser's local wall clock, which is what
 * `PublicationStampSchema` takes.
 *
 * **Local parts, never `toISOString()`.** `toISOString()` renders UTC, so a
 * publication at 8pm on the 20th in New York would be stamped `21T00:00:00`
 * and an operator reading the list back would see a date they did not
 * publish on. The stamp carries no zone by design (GAP-30), so the one rule
 * is that every stamp in a report comes from one clock; this is that clock.
 *
 * @param {Date} at
 * @returns {string}
 */
export function naivePublicationStamp(at) {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
  );
}

/**
 * One `publication_baselines` list row, in the camelCase shape the UI reads.
 *
 * The payload columns (`export_columns`, `export_rows`) are **not** here: the
 * list query does not select them. One mapping, so the table's column names
 * appear once in the frontend.
 *
 * @param {Record<string, any>} row
 */
function toBaselineSummary(row) {
  return {
    id: String(row.id),
    baselineVersion: Number(row.baseline_version),
    snapshotId: String(row.snapshot_id),
    label: String(row.label),
    channel: String(row.channel),
    publishedAt: String(row.published_at),
    publishedBy: String(row.published_by),
    notes: row.notes ?? null,
    rowCount: Number(row.row_count),
    digest: String(row.digest),
    recordedAt: row.recorded_at ?? null,
  };
}

/** The columns the list needs. Never `export_rows`; see the header. */
const SUMMARY_COLUMNS =
  'id, baseline_version, snapshot_id, label, channel, published_at, published_by, notes, row_count, digest, recorded_at';

export function usePublicationBaselines() {
  const [baselines, setBaselines] = useState(/** @type {any[]} */ ([]));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(/** @type {string|null} */ (null));
  const { currentOrganization } = useOrganization();

  const refresh = useCallback(async () => {
    if (!currentOrganization?.id) {
      setBaselines([]);
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const { data, error: readError } = await supabase
        .from('publication_baselines')
        .select(SUMMARY_COLUMNS)
        .eq('organization_id', currentOrganization.id)
        .order('baseline_version', { ascending: false });
      if (readError) throw readError;
      setBaselines((data || []).map(toBaselineSummary));
    } catch (err) {
      logger.error('Error fetching publication baselines:', err);
      setError(err.message || 'Published baselines could not be loaded.');
      setBaselines([]);
    } finally {
      setLoading(false);
    }
  }, [currentOrganization?.id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /**
   * Record what was just published, as a durable baseline.
   *
   * The rows go in **exactly as `generateScheduleExports()` produced them**.
   * `makePublicationSnapshot()` defaults its `columns` to
   * `SCHEDULE_EXPORT_COLUMNS`, which is the same frozen constant the export
   * builds its rows from, so there is no adapter between the two and none is
   * wanted: an adapter here would be a second export vocabulary, which
   * `publication/index.js` names as a thing this package must not grow.
   *
   * @param {Object} input
   * @param {string} input.snapshotId - the caller's own label; unique per org
   * @param {string} input.label
   * @param {string} input.channel - where it went
   * @param {string} input.publishedAt - a naive stamp, from the caller's clock
   * @param {string} input.publishedBy - an actor identifier
   * @param {ReadonlyArray<Record<string, string>>} input.rows
   * @param {string|null} [input.notes]
   */
  const publishBaseline = useCallback(
    async (input) => {
      if (!currentOrganization?.id) throw new Error('No active organization');

      // Zod, through the package's own constructor and seam. A document this
      // seam cannot read back is not a document, and finding that out here is
      // the difference between a failing call and a corrupt row.
      const { snapshot } = makePublicationSnapshot({
        snapshotId: input.snapshotId,
        label: input.label,
        channel: input.channel,
        publishedAt: input.publishedAt,
        publishedBy: input.publishedBy,
        rows: input.rows,
        notes: input.notes ?? null,
      });
      const document = serialisePublicationSnapshot(snapshot);

      const { data, error: rpcError } = await supabase.rpc('admin_publish_schedule_baseline', {
        p_organization_id: currentOrganization.id,
        p_document: document,
      });
      if (rpcError) throw rpcError;
      // **A payload we cannot read is an error, not a success.**
      // `useFieldClosures` learned this on the delete path, where a falsy
      // result for an unreadable response made a refusal render as success.
      if (!data || typeof data !== 'object' || !data.id) {
        throw new Error('admin_publish_schedule_baseline returned no readable result');
      }
      await refresh();
      return data;
    },
    [currentOrganization?.id, refresh]
  );

  /**
   * Load one stored baseline and ask whether the working schedule still
   * matches it.
   *
   * **The read goes back through `readPublicationSnapshot()`**, which re-runs
   * every construction check and re-computes the digest against the rows that
   * actually arrived. There is no fast path that trusts a row because this
   * hook wrote it: a store with its own opinions about jsonb, or a row edited
   * out of band, comes back as `SNAPSHOT_DIGEST_MISMATCH` at blocking rather
   * than as a clean comparison against corrupted ground truth.
   *
   * The result carries the read's own findings alongside the parity run's, so
   * a digest mismatch is visible to the surface rather than being swallowed by
   * a comparison that then looks fine.
   *
   * @param {string} baselineId - a `publication_baselines.id`
   * @param {ReadonlyArray<Record<string, string>>} currentRows - `master.rows`
   * @returns {Promise<{ baseline: any, snapshot: any, readFindings: any[], parity: any }>}
   */
  const compareWithBaseline = useCallback(
    async (baselineId, currentRows) => {
      if (!currentOrganization?.id) throw new Error('No active organization');
      if (!baselineId) throw new Error('Choose a published baseline to compare against');
      if (!Array.isArray(currentRows) || currentRows.length === 0) {
        throw new Error('Generate the CSVs first: there is no current schedule to compare');
      }

      const { data, error: readError } = await supabase
        .from('publication_baselines')
        .select('*')
        .eq('organization_id', currentOrganization.id)
        .eq('id', baselineId)
        .maybeSingle();
      if (readError) throw readError;
      if (!data) throw new Error('That baseline is no longer readable in this organization');

      // The table's column names, turned back into the document shape the seam
      // validates. `durability` and `rowCount` are deliberately absent from the
      // document (see `PublicationSnapshotDocumentSchema`), so they are not
      // reconstructed here either.
      const { snapshot, findings } = readPublicationSnapshot({
        version: Number(data.document_version),
        snapshotId: String(data.snapshot_id),
        label: String(data.label),
        channel: String(data.channel),
        publishedAt: String(data.published_at),
        publishedBy: String(data.published_by),
        notes: data.notes ?? null,
        columns: data.export_columns,
        rows: data.export_rows,
        digest: String(data.digest),
      });

      return {
        baseline: toBaselineSummary(data),
        snapshot,
        readFindings: findings,
        parity: checkBaselineParity({
          snapshot,
          currentRows,
          currentLabel: 'the working schedule',
          subject: `published baseline v${data.baseline_version} against the working schedule`,
        }),
      };
    },
    [currentOrganization?.id]
  );

  return { baselines, loading, error, refresh, publishBaseline, compareWithBaseline };
}
