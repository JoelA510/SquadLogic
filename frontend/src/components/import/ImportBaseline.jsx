import { useCallback, useEffect, useRef } from 'react';
import { useDashboardData } from '../../hooks/useDashboardData.js';
import {
  naivePublicationStamp,
  readBaselineBySnapshotId,
  usePublicationBaselines,
} from '../../hooks/usePublicationBaselines.js';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useOrganization } from '../../contexts/OrganizationContext.jsx';
import { supabase } from '../../lib/supabaseClient.js';
import {
  MASTER_EXPORT_SOURCES,
  describeSources,
  generateMasterExport,
  masterExportInputs,
  unreadableSources,
} from '../../utils/masterExport.js';

/**
 * Record a games import as the publication baseline, and find that baseline again after a roll back (PR 6b of the
 * schedule expansion, task G5, decision 15; `docs/changes/2026-11-03-schedule-expansion.md`, section 7).
 *
 * **The Exports page's baseline, made the Exports page's way.** The rows are `generateMasterExport`'s over the inputs
 * `useDashboardData()` gives (`masterExportInputs`, the same mapping the Exports page passes), read when this mounts:
 * after the apply, never the preview. They go in through `usePublicationBaselines().publishBaseline`, the one writer
 * the Exports page's upload uses, so the two baselines of one schedule are the same rows and the same digest.
 *
 * **One client.** `useDashboardData` and `usePublicationBaselines` read through the app's client
 * (`lib/supabaseClient.js`), so `generateMasterExport` is handed that client too, as the Exports page hands it the same
 * one: one baseline is never made from two clients' reads.
 *
 * **One baseline per import.** The snapshot id names the job, and `publication_baselines_snapshot_unique` refuses a
 * second one, so the baseline an import recorded can be asked after (`readBaselineBySnapshotId`): after a write whose
 * answer was lost, before a second attempt writes, and after a roll back.
 *
 * **It always ends.** Everything (the reads, the rows, the write, the check after a lost answer) is bounded by one
 * minute; whatever has not answered by then is said, and the panel offers to record again. A recording given up before
 * its write never writes afterwards.
 *
 * A lazy chunk of the import panel: nothing here loads until an import records or is rolled back. Each component draws
 * nothing and tells the panel what came of it; the panel says it.
 *
 * @module components/import/ImportBaseline
 */

/** @param {string} jobId */
const snapshotIdOf = (jobId) => `schedule-import-${jobId}`;

/** How long the whole recording may take before it is given up and said. */
const RECORD_WAIT_MS = 60000;

/** Where a person can see for themselves whether the baseline is there. */
const WHERE_TO_CHECK =
  '"Changes since publication" on the Exports page lists every baseline: one labelled "Schedule import" with this file\'s name is this import\'s. "Record the baseline again" checks first and records only if there is none.';

/** @param {number} version */
const recorded = (version) => ({
  status: /** @type {const} */ ('recorded'),
  message: `Recorded the schedule as it now stands as published baseline v${version}, for "Changes since publication" on the Exports page.`,
});

/** Known: nothing was recorded. @param {string} why */
const failed = (why) => ({
  status: /** @type {const} */ ('failed'),
  message: `The import is applied, but no publication baseline was recorded: ${why}. "Changes since publication" has nothing from this import to compare with until one is recorded.`,
});

/** Not known: the write may have been made. Never said as "none". @param {string} why */
const unknown = (why) => ({
  status: /** @type {const} */ ('unknown'),
  message: `The import is applied, but it is not known whether its publication baseline was recorded: ${why}. ${WHERE_TO_CHECK}`,
});

/** @param {any} err */
const words = (err) => String(err?.message ?? err);

/**
 * Reads the saved schedule as it now stands, makes the master export's rows and records them. Draws nothing.
 *
 * @param {{
 *   jobId: string,
 *   fileName?: string,
 *   checkFirst?: boolean,
 *   onDone: (outcome: { status: 'recorded' | 'failed' | 'unknown', message: string }) => void,
 * }} props - `checkFirst`: a second attempt; it asks for the import's baseline first and writes only if there is none
 */
export function ImportBaselineRecorder({ jobId, fileName, checkFirst = false, onDone }) {
  const { team, practice, game, loading, errors } = useDashboardData();
  const { publishBaseline } = usePublicationBaselines();
  const { user } = useAuth() || {};
  const { currentOrganization, currentSeasonSetting } = useOrganization() || {};
  const organizationId = currentOrganization?.id ?? null;
  // One outcome per recording, whichever comes first: the work, or the minute running out.
  const settled = useRef(false);
  const started = useRef(false);
  // From the moment the write is sent, its outcome is not known until it answers.
  const writing = useRef(false);
  const finish = useCallback(
    (outcome) => {
      if (settled.current) return;
      settled.current = true;
      onDone(outcome);
    },
    [onDone]
  );
  // Every read the Exports page waits for, finished (a read still in flight is not "none").
  const waiting = MASTER_EXPORT_SOURCES.some((source) => Boolean(loading[source]));

  useEffect(() => {
    const timer = setTimeout(() => {
      finish(
        writing.current
          ? unknown('the recording sent its baseline and no answer came within a minute')
          : failed(
              'the saved schedule was still being read or made into rows after a minute (nothing was written)'
            )
      );
    }, RECORD_WAIT_MS);
    return () => clearTimeout(timer);
  }, [finish]);

  useEffect(() => {
    if (started.current || waiting) return;
    started.current = true;
    const snapshotId = snapshotIdOf(jobId);
    const record = async () => {
      if (checkFirst) {
        try {
          const there = await readBaselineBySnapshotId(organizationId, snapshotId);
          if (there) return recorded(there.baselineVersion);
        } catch {
          // A check that cannot be made is not "none", and is no reason to stop either: the write that follows is
          // refused by the snapshot id's unique key if the baseline is there, and that refusal is checked again below.
        }
      }
      // As the Exports page blocks its files on a read that failed: rows made without it could leave games out.
      const unread = unreadableSources(errors, null, MASTER_EXPORT_SOURCES);
      if (unread.length > 0) {
        return failed(
          `${describeSources(unread)} could not be read (${unread.map((source) => errors[source]).join('; ')}), so rows made now could leave games out`
        );
      }
      const made = await generateMasterExport(supabase, {
        organizationId,
        seasonSettingsId: currentSeasonSetting?.id ?? null,
        seasonCompleted: currentSeasonSetting?.status === 'completed',
        ...masterExportInputs({ team, practice, game }),
      });
      if (made.status === 'tbd-failed') {
        return failed(
          `the list of practices and games not scheduled yet could not be brought up to date and read (${words(made.error)})`
        );
      }
      if (made.status === 'directory-failed') {
        return failed(`the season's teams could not be read (${made.table}: ${made.message})`);
      }
      if (made.status !== 'generated') {
        return failed('the saved schedule holds nothing the master export can write');
      }
      // Given up while the rows were made: nothing is written after the screen said nothing was.
      if (settled.current) return null;
      const rows = made.exports.master.rows;
      writing.current = true;
      try {
        const written = await publishBaseline({
          snapshotId,
          label: `Schedule import${fileName ? ` "${fileName}"` : ''}, ${rows.length} rows`,
          channel: 'schedule import',
          // The caller's clock, as the Exports page stamps its own (`naivePublicationStamp`).
          publishedAt: naivePublicationStamp(new Date()),
          publishedBy: user?.id ? String(user.id) : 'unknown-actor',
          rows,
        });
        return recorded(written.baseline_version);
      } catch (err) {
        // A refusal and a lost answer look alike here: the write may have been made. The baseline is asked after.
        let there;
        try {
          there = await readBaselineBySnapshotId(organizationId, snapshotId);
        } catch (checkErr) {
          return unknown(
            `the recording got no clear answer (${words(err)}) and the check for its baseline failed (${words(checkErr)})`
          );
        }
        return there ? recorded(there.baselineVersion) : failed(words(err));
      }
    };
    record().then(
      (outcome) => {
        if (outcome) finish(outcome);
      },
      (err) => finish(writing.current ? unknown(words(err)) : failed(words(err)))
    );
  }, [
    waiting,
    errors,
    organizationId,
    currentSeasonSetting?.id,
    currentSeasonSetting?.status,
    team,
    practice,
    game,
    publishBaseline,
    jobId,
    fileName,
    checkFirst,
    user?.id,
    finish,
  ]);

  return null;
}

/**
 * Finds the baseline an import recorded, read when this mounts (after its roll back): that one row, by its snapshot
 * id. Draws nothing.
 *
 * @param {{
 *   jobId: string,
 *   onResult: (found: { status: 'found', version: number } | { status: 'none' } | { status: 'unchecked', message: string }) => void,
 * }} props
 */
export function ImportBaselineLookup({ jobId, onResult }) {
  const { currentOrganization } = useOrganization() || {};
  const organizationId = currentOrganization?.id ?? null;
  useEffect(() => {
    let current = true;
    readBaselineBySnapshotId(organizationId, snapshotIdOf(jobId)).then(
      (found) => {
        if (current) {
          onResult(
            found ? { status: 'found', version: found.baselineVersion } : { status: 'none' }
          );
        }
      },
      (err) => {
        if (current) onResult({ status: 'unchecked', message: words(err) });
      }
    );
    return () => {
      current = false;
    };
  }, [organizationId, jobId, onResult]);
  return null;
}
