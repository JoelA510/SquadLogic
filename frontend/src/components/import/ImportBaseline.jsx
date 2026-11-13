import { useEffect, useRef } from 'react';
import { useDashboardData } from '../../hooks/useDashboardData.js';
import {
  naivePublicationStamp,
  usePublicationBaselines,
} from '../../hooks/usePublicationBaselines.js';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useOrganization } from '../../contexts/OrganizationContext.jsx';
import { generateMasterExport, masterExportInputs } from '../../utils/masterExport.js';

/**
 * Record a games import as the publication baseline, and find that baseline again after a roll back (PR 6b of the
 * schedule expansion, task G5, decision 15; `docs/changes/2026-11-03-schedule-expansion.md`, section 7).
 *
 * **The Exports page's baseline, made the Exports page's way.** The rows are `generateMasterExport`'s over the inputs
 * `useDashboardData()` gives (`masterExportInputs`, the same mapping the Exports page passes), read when this mounts:
 * after the apply, never the preview. They go in through `usePublicationBaselines().publishBaseline`, the one writer
 * the Exports page's upload uses, so the two baselines of one schedule are the same rows and the same digest.
 *
 * **One baseline per import.** The snapshot id names the job, and `publication_baselines_snapshot_unique` refuses a
 * second one, so a roll back can find the baseline its import recorded (`ImportBaselineLookup`).
 *
 * A lazy chunk of the import panel: nothing here loads until an import records or is rolled back. Each component draws
 * nothing and tells the panel what came of it; the panel says it.
 *
 * @module components/import/ImportBaseline
 */

/** @param {string} jobId */
const snapshotIdOf = (jobId) => `schedule-import-${jobId}`;

/** @param {string} why */
const failed = (why) => ({
  status: /** @type {const} */ ('failed'),
  message: `The import is applied, but no publication baseline was recorded: ${why}. "Changes since publication" has nothing from this import to compare with; uploading the files on the Exports page records a baseline.`,
});

/** How long the reads may take before the recording is given up and said (a team run still running keeps one open). */
const READ_WAIT_MS = 60000;

/** The source names `useDashboardData().errors` uses, in the words the Exports page uses for them. */
const SOURCE_WORDS = Object.freeze({ team: 'teams', practice: 'practices', game: 'games' });

/**
 * Reads the saved schedule as it now stands, makes the master export's rows and records them. Draws nothing.
 *
 * @param {{
 *   jobId: string,
 *   fileName?: string,
 *   client: any,
 *   onDone: (outcome: { status: 'recorded' | 'failed', message: string }) => void,
 * }} props
 */
export function ImportBaselineRecorder({ jobId, fileName, client, onDone }) {
  const { team, practice, game, loading, errors } = useDashboardData();
  const { publishBaseline } = usePublicationBaselines();
  const { user } = useAuth() || {};
  const { currentOrganization, currentSeasonSetting } = useOrganization() || {};
  const started = useRef(false);
  // Every read the Exports page waits for, finished (a read still in flight is not "none").
  const waiting = Boolean(loading.team || loading.practice || loading.game);

  // A read that never settles (a team run still running is polled, not finished) must not hold the result screen,
  // whose buttons wait for the recording: after a minute the recording is given up, and said.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (started.current) return;
      started.current = true;
      onDone(failed('the saved schedule was still being read after a minute'));
    }, READ_WAIT_MS);
    return () => clearTimeout(timer);
  }, [onDone]);

  useEffect(() => {
    if (started.current || waiting) return;
    started.current = true;
    const record = async () => {
      // As the Exports page blocks its files on a read that failed: rows made without it could leave games out.
      const unread = Object.entries(SOURCE_WORDS)
        .filter(([source]) => errors[source])
        .map(([source, word]) => `${word} (${errors[source]})`);
      if (unread.length > 0) {
        return failed(
          `the saved schedule could not be read: ${unread.join(', ')}, so rows made now could leave games out`
        );
      }
      const made = await generateMasterExport(client, {
        organizationId: currentOrganization?.id ?? null,
        seasonSettingsId: currentSeasonSetting?.id ?? null,
        seasonCompleted: currentSeasonSetting?.status === 'completed',
        ...masterExportInputs({ team, practice, game }),
      });
      if (made.status === 'tbd-failed') {
        return failed(
          `the list of practices and games not scheduled yet could not be brought up to date and read (${made.error?.message ?? made.error})`
        );
      }
      if (made.status === 'directory-failed') {
        return failed(`the season's teams could not be read (${made.table}: ${made.message})`);
      }
      if (made.status !== 'generated') {
        return failed('the saved schedule holds nothing the master export can write');
      }
      const rows = made.exports.master.rows;
      const recorded = await publishBaseline({
        snapshotId: snapshotIdOf(jobId),
        label: `Schedule import${fileName ? ` "${fileName}"` : ''}, ${rows.length} rows`,
        channel: 'schedule import',
        // The caller's clock, as the Exports page stamps its own (`naivePublicationStamp`).
        publishedAt: naivePublicationStamp(new Date()),
        publishedBy: user?.id ? String(user.id) : 'unknown-actor',
        rows,
      });
      return {
        status: /** @type {const} */ ('recorded'),
        message: `Recorded the schedule as it now stands as published baseline v${recorded.baseline_version}, for "Changes since publication" on the Exports page.`,
      };
    };
    record().then(onDone, (err) => onDone(failed(String(err?.message ?? err))));
  }, [
    waiting,
    errors,
    client,
    currentOrganization?.id,
    currentSeasonSetting?.id,
    currentSeasonSetting?.status,
    team,
    practice,
    game,
    publishBaseline,
    jobId,
    fileName,
    user?.id,
    onDone,
  ]);

  return null;
}

/**
 * Finds the baseline an import recorded, read when this mounts (after its roll back). Draws nothing.
 *
 * @param {{
 *   jobId: string,
 *   onResult: (found: { status: 'found', version: number } | { status: 'none' } | { status: 'unchecked', message: string }) => void,
 * }} props
 */
export function ImportBaselineLookup({ jobId, onResult }) {
  const { baselines, loading, error } = usePublicationBaselines();
  useEffect(() => {
    if (loading) return;
    if (error) {
      onResult({ status: 'unchecked', message: String(error) });
      return;
    }
    const found = baselines.find((baseline) => baseline.snapshotId === snapshotIdOf(jobId));
    onResult(found ? { status: 'found', version: found.baselineVersion } : { status: 'none' });
  }, [loading, error, baselines, jobId, onResult]);
  return null;
}
