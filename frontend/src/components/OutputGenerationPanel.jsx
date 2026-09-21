import React, { useState } from 'react';
import { generateScheduleExports } from '@squadlogic/core/outputGeneration.js';
import { uploadScheduleExport } from '@squadlogic/core/storageSupabase.js';
import {
  baselineDriftSummary,
  baselineParitySoundness,
} from '@squadlogic/core/publication/index.js';
import { IS_MOCK_MODE } from '../config.js';
import { logger } from '../lib/logger.js';
import {
  teamsWithCoachSourceDisagreement,
  teamsWithUncorroboratedCoachIdentity,
} from '@squadlogic/core/people/coachList.js';
import { teamCoachFields, teamCoaches } from '../utils/teamCoaches.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import {
  naivePublicationStamp,
  usePublicationBaselines,
} from '../hooks/usePublicationBaselines.js';

/**
 * The publish path, and the question it makes answerable (GAP-29).
 *
 * Uploading the master CSV to Storage is the moment this app sends a schedule
 * out, and until now nothing recorded what went. `handleUpload` therefore
 * records a **publication baseline** alongside the upload: the same
 * `master.rows` the CSV was rendered from, frozen through
 * `makePublicationSnapshot()` and stored by `admin_publish_schedule_baseline()`.
 * No adapter stands between the two -- `generateScheduleExports()` builds its
 * rows from `SCHEDULE_EXPORT_COLUMNS` and `makePublicationSnapshot()` defaults
 * its `columns` to the same frozen constant.
 *
 * The reader is the section below it: pick a stored baseline, and
 * `checkBaselineParity()` says whether the working schedule is still what that
 * version said. A store nothing reads would be the defect this whole phase
 * keeps finding, with a table underneath it.
 *
 * **A failed baseline never reports as a successful publish, and never fails
 * the upload it follows.** The files really did go out; saying otherwise would
 * send an operator to re-upload. So the message carries both outcomes and the
 * status goes to `error` when the baseline did not land, because a publication
 * nobody recorded is exactly the state incident 1 could not recover from.
 */

const MOCK_UPLOAD = IS_MOCK_MODE;
const DAY_INDEX = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

function getAssignmentTeamId(assignment) {
  return assignment?.teamId ?? assignment?.team_id ?? assignment?.teams?.id ?? null;
}

function getAssignmentSlotId(assignment) {
  return (
    assignment?.slotId ??
    assignment?.slot_id ??
    assignment?.practiceSlotId ??
    assignment?.practice_slot_id ??
    assignment?.practiceSlots?.id ??
    assignment?.practice_slots?.id ??
    null
  );
}

function normalizeTeamForExport(team) {
  const id = team?.id ?? team?.teamId ?? team?.team_id;
  if (!id) return null;

  const division =
    team.division ??
    team.divisionName ??
    team.division_id ??
    team.divisionId ??
    team.divisions?.name ??
    '';

  return {
    id,
    name: team.name ?? team.teamName ?? id,
    division,
    // 8.2: the row's coach fields under one spelling, **both sources intact**,
    // so `generateScheduleExports()` reconciles them and its `coachFindings`
    // carry any disagreement. Reconciling here and passing the settled list
    // left the core one source to read, and the message below could never
    // fire — the export said "generated successfully" for a team whose two
    // sources named different people in slot 1.
    ...teamCoachFields(team),
  };
}

function getDateFromRange(range) {
  const match = String(range ?? '').match(/\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? '2026-01-01';
}

function getDateForDay(baseDate, day) {
  const date = new Date(`${baseDate}T00:00:00Z`);
  const dayIndex = DAY_INDEX[String(day ?? '').toLowerCase()];
  if (Number.isNaN(date.getTime()) || dayIndex == null) {
    return baseDate;
  }

  const delta = (dayIndex - date.getUTCDay() + 7) % 7;
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function normalizeTime(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  const [hours = '00', minutes = '00', seconds = '00'] = trimmed.split(':');
  return `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}:${seconds.padStart(2, '0')}`;
}

function normalizePracticeForExport(assignment) {
  const teamId = getAssignmentTeamId(assignment);
  const slot = assignment?.practiceSlots ?? assignment?.practice_slots ?? {};
  const startTime = normalizeTime(
    assignment?.startTime ?? assignment?.start_time ?? slot.startTime ?? slot.start_time
  );
  const endTime = normalizeTime(
    assignment?.endTime ?? assignment?.end_time ?? slot.endTime ?? slot.end_time
  );
  const range = assignment?.effectiveDateRange ?? assignment?.effective_date_range;
  const day =
    assignment?.dayOfWeek ?? assignment?.day_of_week ?? slot.dayOfWeek ?? slot.day_of_week;
  const date = getDateForDay(getDateFromRange(range), day);

  if (!teamId || (!assignment?.start && !startTime) || (!assignment?.end && !endTime)) {
    return null;
  }

  return {
    teamId,
    start: assignment.start ?? `${date}T${startTime}`,
    end: assignment.end ?? `${date}T${endTime}`,
    fieldId:
      assignment.fieldId ??
      assignment.field_id ??
      slot.fieldId ??
      slot.field_id ??
      slot.fields?.id ??
      slot.fields?.name ??
      '',
    slotId: getAssignmentSlotId(assignment) ?? '',
    notes: assignment.notes ?? '',
  };
}

function normalizeGameForExport(assignment) {
  if (!assignment?.start || !assignment?.end) return null;

  return {
    homeTeamId: assignment.homeTeamId ?? assignment.home_team_id,
    awayTeamId: assignment.awayTeamId ?? assignment.away_team_id,
    start: assignment.start,
    end: assignment.end,
    fieldId: assignment.fieldId ?? assignment.field_id ?? '',
    slotId: assignment.slotId ?? assignment.slot_id ?? '',
    notes: assignment.notes ?? '',
  };
}

function buildExportPayload({ teams, teamSummary, practiceAssignments, gameAssignments }) {
  const teamDirectory = new Map();
  const addTeam = (team) => {
    const normalized = normalizeTeamForExport(team);
    if (normalized) teamDirectory.set(normalized.id, normalized);
  };

  (Array.isArray(teams) ? teams : []).forEach(addTeam);
  (Array.isArray(teamSummary?.teams) ? teamSummary.teams : []).forEach(addTeam);
  (Array.isArray(practiceAssignments) ? practiceAssignments : []).forEach((assignment) => {
    const teamId = getAssignmentTeamId(assignment);
    if (!teamDirectory.has(teamId)) {
      addTeam({ ...assignment.teams, id: teamId });
    }
  });

  const exportTeams = Array.from(teamDirectory.values());
  const exportTeamIds = new Set(exportTeams.map((team) => String(team.id)));
  const exportPractices = (Array.isArray(practiceAssignments) ? practiceAssignments : [])
    .map(normalizePracticeForExport)
    .filter((assignment) => assignment && exportTeamIds.has(String(assignment.teamId)));
  const exportGames = (Array.isArray(gameAssignments) ? gameAssignments : [])
    .map(normalizeGameForExport)
    .filter(
      (assignment) =>
        assignment &&
        exportTeamIds.has(String(assignment.homeTeamId)) &&
        exportTeamIds.has(String(assignment.awayTeamId))
    );

  return { teams: exportTeams, practiceAssignments: exportPractices, gameAssignments: exportGames };
}

/**
 * A baseline parity result, rendered for an operator.
 *
 * **All four buckets, and the read's own findings.** Showing only "differing"
 * would hide a fixture that has vanished, which is the half of incident 1 that
 * actually hurt; showing only the parity findings would hide a
 * `SNAPSHOT_DIGEST_MISMATCH`, which means the stored ground truth itself is
 * not what was published and no number below it can be trusted.
 *
 * **Additions are reported as news, not as drift** -- `baselineDriftSummary()`
 * is the one reading of that, and this component does not invent a second one.
 *
 * @param {{ report: { baseline: any, snapshot: any, readFindings: any[], parity: any } }} props
 */
function ParityReport({ report }) {
  const { baseline, parity, readFindings } = report;
  const drift = baselineDriftSummary(parity);
  const all = [...readFindings, ...parity.findings];
  const blocking = all.filter((finding) => finding.severity === 'blocking');
  // **`compromise` is rendered too, and that is a review finding rather than
  // taste.** `PARITY_FIELD_UNCOMPARED` is the statement of what the numbers
  // are silent about and `PARITY_KEY_AMBIGUOUS` says rows were paired by
  // input order because the key did not identify them. Both are `compromise`,
  // both change how the counts above should be read, and dropping them put
  // the narrowing back in the silence `baseline.js` exists to break.
  const qualified = all.filter((finding) => finding.severity === 'compromise');
  // **The verdict is gated on the findings, not only on the buckets.** A run
  // whose `Start` cells nobody could read puts every row in `matched` with
  // `startMinutes` absent, so `drifted` is false and the panel printed, in
  // green, that the schedule still matches — having compared no kickoff at
  // all.
  //
  // `baselineParitySoundness()` rather than "any blocking finding", and the
  // difference matters: `PARITY_ROW_DIFFERS` and `PARITY_ROW_REMOVED` are
  // blocking **because they are the answer**, so gating on severity made the
  // panel refuse to state the result it exists to state. The soundness list
  // is the codes that mean the comparison itself cannot be read, and it lives
  // in the core beside those codes rather than in this component.
  const soundness = baselineParitySoundness(parity, readFindings);
  const unsound = !soundness.sound;

  return (
    <div
      className="bg-bg-surface rounded-lg p-4 border border-border-subtle"
      data-testid="parity-report"
    >
      <h4 className="text-sm font-medium text-text-primary mb-2">
        {`Baseline v${baseline.baselineVersion} — ${baseline.label}`}
      </h4>
      <p
        className={
          unsound
            ? 'text-sm text-red-400 mb-2'
            : drift.drifted
              ? 'text-sm text-amber-400 mb-2'
              : 'text-sm text-emerald-400 mb-2'
        }
        data-testid="parity-verdict"
      >
        {unsound
          ? `This comparison cannot be read as a verdict (${soundness.reasons.join(', ')}); the counts below are arithmetic over something that did not compare cleanly.`
          : drift.drifted
            ? `The working schedule has moved since this was published: ${drift.differing} row(s) changed, ${drift.removed} row(s) gone.`
            : 'The working schedule still matches what was published.'}
      </p>
      <dl className="text-xs text-text-muted font-mono grid grid-cols-2 gap-x-6 gap-y-1 max-w-sm">
        <dt>Matched</dt>
        <dd data-testid="parity-matched">{drift.matched}</dd>
        <dt>Differing</dt>
        <dd data-testid="parity-differing">{drift.differing}</dd>
        <dt>Removed since publication</dt>
        <dd data-testid="parity-removed">{drift.removed}</dd>
        <dt>Added since publication</dt>
        <dd data-testid="parity-added">{drift.added}</dd>
      </dl>

      {parity.buckets.differing.length > 0 && (
        <div className="mt-3">
          <h5 className="text-xs font-medium text-text-secondary mb-1">What changed</h5>
          <ul className="text-xs text-text-muted space-y-1">
            {/* The key carries the row id, not just the parity key: a
                parity key that does not identify a row is exactly the
                `PARITY_KEY_AMBIGUOUS` case, and there `pair.key` repeats. */}
            {parity.buckets.differing.map((pair) => (
              <li key={pair.currentRow.rowId} data-testid="parity-differing-row">
                {`${pair.label} — ${pair.changedFields.join(', ')}`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {parity.buckets.removed.length > 0 && (
        <div className="mt-3">
          <h5 className="text-xs font-medium text-text-secondary mb-1">
            Published and no longer in the schedule
          </h5>
          <ul className="text-xs text-text-muted space-y-1">
            {parity.buckets.removed.map((orphan) => (
              <li key={orphan.row.rowId} data-testid="parity-removed-row">
                {orphan.label}
              </li>
            ))}
          </ul>
        </div>
      )}

      {blocking.length > 0 && (
        <div className="mt-3">
          <h5 className="text-xs font-medium text-red-400 mb-1">Blocking findings</h5>
          <ul className="text-xs text-red-400 space-y-1">
            {blocking.map((finding, index) => (
              <li key={`${finding.code}-${index}`} data-testid="parity-blocking">
                {`${finding.code}: ${finding.message}`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {qualified.length > 0 && (
        <div className="mt-3">
          <h5 className="text-xs font-medium text-amber-400 mb-1">What these numbers do not say</h5>
          <ul className="text-xs text-amber-400 space-y-1">
            {qualified.map((finding, index) => (
              <li key={`${finding.code}-${index}`} data-testid="parity-qualified">
                {`${finding.code}: ${finding.message}`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function OutputGenerationPanel({
  teams = [],
  teamSummary = null,
  practiceAssignments = [],
  gameAssignments = [],
  supabaseClient,
}) {
  const [generated, setGenerated] = useState(null);
  const [emails, setEmails] = useState(null);
  const [status, setStatus] = useState('idle');
  const [message, setMessage] = useState('');
  const { user } = useAuth() || {};
  const {
    baselines,
    loading: baselinesLoading,
    error: baselinesError,
    publishBaseline,
    compareWithBaseline,
  } = usePublicationBaselines();
  const [selectedBaselineId, setSelectedBaselineId] = useState('');
  const [parityReport, setParityReport] = useState(null);
  const [parityError, setParityError] = useState(null);
  const [parityBusy, setParityBusy] = useState(false);

  const generateEmails = () => {
    const sourceTeams =
      Array.isArray(teams) && teams.length > 0
        ? teams
        : Array.isArray(teamSummary?.teams)
          ? teamSummary.teams
          : [];

    // 8.2: one draft per coach, not one per team. The old shape addressed
    // `headCoach` and every co-coach got nothing — the same truncation the
    // export carried, in the artifact that actually reaches a person.
    //
    // A coach with no address on file still gets no draft, and that is
    // **counted and reported** rather than absorbed: most team rows the app
    // holds carry one email, so a silent "42 drafts" would look exactly like a
    // run that reached everybody.
    // Keyed by coach, not by coach-team pair: one assistant with no address who
    // coaches three teams is one person, and reporting "3 coaches" would be the
    // same unit confusion the count exists to end.
    const coachesWithoutDraft = new Set();
    const drafts = sourceTeams.flatMap((team) => {
      const teamPractices = practiceAssignments.filter((p) =>
        [p.teamId, p.team_id].some((teamId) => String(teamId) === String(team.id))
      );
      const scheduleStr =
        teamPractices.length > 0
          ? teamPractices
              .map((p) => `${p.day} at ${p.slotId.split('_').pop().slice(0, 5)} on ${p.fieldId}`)
              .join(' and ')
          : 'TBD';

      const coaches = teamCoaches(team);
      // Everybody a draft cannot reach, whether the row lacks their address or
      // their name. Counting only the named ones left a team whose rows carry
      // ids and no names reporting "0 drafts" with nobody named as skipped.
      for (const coach of coaches) {
        if (!coach.displayName || !coach.email) coachesWithoutDraft.add(coach.personId);
      }
      return coaches
        .filter((coach) => coach.displayName && coach.email)
        .map((coach) => ({
          teamId: team.id,
          coachName: coach.displayName,
          coachEmail: coach.email,
          subject: `Welcome to the season, Coach ${coach.displayName}!`,
          body: `Hi Coach ${coach.displayName},\n\nThank you for volunteering to coach ${team.name} in the ${team.division || team.divisionName} division this season! Your roster has been finalized.\n\nYour assigned practice schedule is:\n${scheduleStr}\n\nPlease let us know if you have any questions.\n\nBest,\nLeague Admin`,
        }));
    });

    setEmails(drafts);
    setMessage(
      coachesWithoutDraft.size === 0
        ? `Generated ${drafts.length} email drafts, one per coach.`
        : `Generated ${drafts.length} email drafts, one per coach. ${coachesWithoutDraft.size} coach(es) have no name or address on file and were not written to.`
    );
  };

  const handleGenerate = () => {
    setStatus('generating');
    setMessage('Generating CSVs...');

    setTimeout(() => {
      try {
        const exportPayload = buildExportPayload({
          teams,
          teamSummary,
          practiceAssignments,
          gameAssignments,
        });
        const exports = generateScheduleExports({
          teams: exportPayload.teams,
          practiceAssignments: exportPayload.practiceAssignments,
          gameAssignments: exportPayload.gameAssignments,
        });
        setGenerated(exports);
        // **A parity report describes one row set.** Leaving the previous
        // verdict on screen after a regenerate means a green "still matches"
        // describing a schedule that no longer exists.
        setParityReport(null);
        setParityError(null);
        setStatus('idle');
        // The reconciliation's findings are surfaced, not discarded. A
        // `COACH_ORDER_SOURCE_DISAGREES` is two sources contradicting each
        // other about a team's coach order; producing that and dropping it here
        // would make the export look clean for a team nobody has reconciled —
        // the "declared is not enforced" shape, in the artifact this change
        // exists to fix.
        //
        // Filtered on the codes that mean disagreement, **not on severity**:
        // `COACH_SLOT_UNDECLARED` is also `compromise` and fires for the
        // ordinary app row, so a severity filter told the operator that sources
        // disagreed about teams where only one source was ever read.
        //
        // `COACH_IDENTITY_UNCORROBORATED` is the other silence refused: a coach
        // no row carries an id for is exported but cannot be clash-checked, and
        // the operator is told so rather than shown a clean sheet.
        const teamsWithDisagreement = teamsWithCoachSourceDisagreement(exports.coachFindings);
        const teamsUncorroborated = teamsWithUncorroboratedCoachIdentity(exports.coachFindings);
        setMessage(
          [
            'CSVs generated successfully.',
            teamsWithDisagreement.length === 0
              ? null
              : `${teamsWithDisagreement.length} team(s) have sources that disagree about their coaches; every coach is exported and none is treated as the primary.`,
            teamsUncorroborated.length === 0
              ? null
              : `${teamsUncorroborated.length} team(s) have a coach with no id on file; they are exported, but no clash check can cover them until a row carries their id.`,
          ]
            .filter(Boolean)
            .join(' ')
        );
      } catch (err) {
        logger.error('Generation error:', err);
        setStatus('error');
        setMessage(`Generation failed: ${err.message}`);
      }
    }, 0);
  };

  const handleUpload = async () => {
    if (!generated) return;
    if (!supabaseClient && !IS_MOCK_MODE) {
      setStatus('error');
      setMessage('Supabase client not available for upload.');
      return;
    }

    setStatus('uploading');
    setMessage('Uploading to Storage...');

    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const uploads = [];

      uploads.push(
        uploadFile(supabaseClient, `master-schedule-${timestamp}.csv`, generated.master.csv)
      );

      for (const teamExport of generated.perTeam) {
        uploads.push(
          uploadFile(supabaseClient, `teams/${teamExport.teamId}-${timestamp}.csv`, teamExport.csv)
        );
      }

      await Promise.all(uploads);

      // **Stage 3: the writer, on the path that actually publishes.** The
      // rows go in exactly as the CSV was rendered from them.
      let baselineNote;
      let baselineFailed = false;
      try {
        const recorded = await publishBaseline({
          snapshotId: `master-schedule-${timestamp}`,
          label: `Master schedule, ${generated.master.rows.length} rows`,
          channel: 'exports bucket',
          // The caller's clock, in local wall-clock parts. This package never
          // self-stamps: a snapshot that invents its own timestamp and actor
          // has two fields that read as an audit trail and are not one.
          publishedAt: naivePublicationStamp(new Date()),
          publishedBy: user?.id ? String(user.id) : 'unknown-actor',
          rows: generated.master.rows,
        });
        baselineNote = `Recorded as published baseline v${recorded.baseline_version}.`;
      } catch (baselineErr) {
        logger.error('Baseline error:', baselineErr);
        baselineFailed = true;
        baselineNote =
          `The files went out but NO published baseline was recorded: ` +
          `${baselineErr.message}. Nothing can later be checked against this publication.`;
      }

      setStatus(baselineFailed ? 'error' : 'success');
      setMessage(`Uploaded ${uploads.length} files to 'exports' bucket. ${baselineNote}`);
    } catch (err) {
      logger.error('Upload error:', err);
      setStatus('error');
      setMessage(`Upload failed: ${err.message}`);
    }
  };

  /**
   * **Stage 4: the reader.** "Is the working schedule still what version v
   * said?", answered from the store rather than from this process's memory.
   */
  const handleCheckParity = async () => {
    setParityBusy(true);
    setParityError(null);
    setParityReport(null);
    try {
      const report = await compareWithBaseline(selectedBaselineId, generated?.master?.rows ?? []);
      setParityReport(report);
    } catch (err) {
      logger.error('Parity error:', err);
      setParityError(err.message || 'The baseline comparison could not be run.');
    } finally {
      setParityBusy(false);
    }
  };

  const uploadFile = async (client, path, content) => {
    if (MOCK_UPLOAD) {
      logger.log(`[Mock Upload] ${path} (${content.length} bytes)`);
      return Promise.resolve({ path });
    }
    return uploadScheduleExport({
      supabaseClient: client,
      bucket: 'exports',
      path,
      file: content,
    });
  };

  const downloadCsv = (filename, content) => {
    const blob = new Blob([content], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="glass-panel p-6 rounded-xl border border-border-subtle relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-orange-500/5 to-red-500/5 pointer-events-none" />

      <div className="relative z-10">
        <h2 className="text-xl font-bold text-text-primary mb-4 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-orange-400 shadow-[0_0_10px_rgba(251,146,60,0.5)]" />
          Output Generation
        </h2>

        <div className="flex flex-col gap-4">
          <div className="flex gap-4">
            <button
              type="button"
              data-testid="generate-csvs-btn"
              onClick={handleGenerate}
              disabled={status === 'generating' || status === 'uploading'}
              className="relative z-20 bg-bg-surface hover:bg-bg-surface-hover text-text-primary px-4 py-2 rounded-lg transition-colors"
            >
              {status === 'generating' ? 'Generating...' : 'Generate CSVs'}
            </button>

            {generated && (
              <button
                type="button"
                onClick={handleUpload}
                disabled={status === 'uploading'}
                className="relative z-20 bg-orange-500 hover:bg-orange-400 text-white px-4 py-2 rounded-lg shadow-lg shadow-orange-500/20 transition-all"
              >
                {status === 'uploading' ? 'Uploading...' : 'Upload to Storage'}
              </button>
            )}
          </div>

          {generated && (
            <div className="bg-bg-surface rounded-lg p-4 border border-border-subtle mt-2">
              <div className="flex justify-between items-center mb-2">
                <h3 className="text-sm font-medium text-text-primary">Generated Files</h3>
                <button
                  type="button"
                  onClick={() => downloadCsv('master-schedule.csv', generated.master.csv)}
                  className="relative z-20 text-xs text-blue-400 hover:text-blue-300"
                >
                  Download Master CSV
                </button>
              </div>
              <div className="text-xs text-text-muted font-mono">
                <div>Master Schedule: {generated.master.rows.length} rows</div>
                <div>Team Schedules: {generated.perTeam.length} files</div>
              </div>
            </div>
          )}

          <section
            aria-labelledby="published-baselines-heading"
            className="pt-4 border-t border-border-subtle mt-4"
          >
            <h3
              id="published-baselines-heading"
              className="text-lg font-bold text-text-primary mb-2"
            >
              Published Baselines
            </h3>
            <p className="text-xs text-text-muted mb-4">
              Uploading to Storage records what went out. Compare a published baseline against the
              schedule you have now to see what has moved since.
            </p>

            {baselinesLoading ? (
              <p className="text-sm text-text-muted">Loading published baselines…</p>
            ) : baselinesError ? (
              /* **A read that failed is not an empty store.** The hook empties
                 the list on a read error, so without this the operator is told
                 "nothing has been published yet" when the truth is that we
                 could not find out — which is the false statement
                 `docs/sql/20260920000000_revert.sql` explicitly promises this
                 surface will not make. */
              <p className="text-sm text-red-400" data-testid="baselines-error">
                {`Published baselines could not be read, so this says nothing about whether any exist: ${baselinesError}`}
              </p>
            ) : baselines.length === 0 ? (
              <p className="text-sm text-text-muted" data-testid="no-baselines">
                Nothing has been published yet. Generate the CSVs and upload them to record the
                first baseline.
              </p>
            ) : (
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="baseline-select"
                    className="text-xs font-medium text-text-secondary"
                  >
                    Published baseline
                  </label>
                  <select
                    id="baseline-select"
                    data-testid="baseline-select"
                    value={selectedBaselineId}
                    onChange={(event) => {
                      setSelectedBaselineId(event.target.value);
                      // The report on screen is about the version that was
                      // selected when it ran, not this one.
                      setParityReport(null);
                      setParityError(null);
                    }}
                    className="relative z-20 bg-bg-surface text-text-primary border border-border-subtle rounded-lg px-3 py-2 text-sm"
                  >
                    <option value="">Choose a version…</option>
                    {baselines.map((baseline) => (
                      <option key={baseline.id} value={baseline.id}>
                        {`v${baseline.baselineVersion} — ${baseline.label} — published ${baseline.publishedAt} (${baseline.rowCount} rows)`}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  data-testid="check-parity-btn"
                  onClick={handleCheckParity}
                  disabled={parityBusy || !selectedBaselineId || !generated}
                  className="relative z-20 bg-bg-surface hover:bg-bg-surface-hover text-text-primary px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
                >
                  {parityBusy ? 'Checking…' : 'Check against current schedule'}
                </button>
                {!generated && (
                  <p className="text-xs text-text-muted">
                    Generate the CSVs first — there is no current schedule to compare against.
                  </p>
                )}
              </div>
            )}

            <div aria-live="polite" className="mt-4">
              {parityError && (
                <p className="text-sm text-red-400" data-testid="parity-error">
                  {parityError}
                </p>
              )}
              {parityReport && <ParityReport report={parityReport} />}
            </div>
          </section>

          <div className="pt-4 border-t border-border-subtle mt-4">
            <h3 className="text-lg font-bold text-text-primary mb-4">Coach Communications</h3>
            <button
              type="button"
              data-testid="generate-emails-btn"
              onClick={generateEmails}
              className="relative z-20 bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 border border-purple-500/30 px-4 py-2 rounded-lg transition-colors mb-4"
            >
              Generate Draft Welcome Emails
            </button>

            {emails && (
              <div className="space-y-4 max-h-96 overflow-y-auto pr-2">
                {emails.length === 0 ? (
                  <p className="text-sm text-text-muted">No coaches with emails found.</p>
                ) : (
                  emails.map((email, idx) => (
                    <div
                      key={idx}
                      className="bg-bg-surface border border-border-subtle rounded-lg p-4"
                    >
                      <div className="flex justify-between items-start mb-2">
                        <div>
                          <div className="text-sm font-bold text-text-primary">
                            To: {email.coachName} &lt;{email.coachEmail}&gt;
                          </div>
                          <div className="text-sm text-text-secondary">
                            Subject: {email.subject}
                          </div>
                        </div>
                        <a
                          href={`mailto:${email.coachEmail}?subject=${encodeURIComponent(email.subject)}&body=${encodeURIComponent(email.body)}`}
                          className="relative z-20 bg-blue-500/20 text-blue-400 px-3 py-1 text-xs rounded hover:bg-blue-500/30 transition-colors shrink-0"
                        >
                          Open in Mail App
                        </a>
                      </div>
                      <div className="bg-bg-app rounded p-3 text-xs text-text-secondary whitespace-pre-wrap font-mono border border-border-subtle">
                        {email.body}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          <div className="text-sm min-h-[20px]">
            {status === 'error' && <span className="text-red-400">{message}</span>}
            {status === 'success' && <span className="text-emerald-400">{message}</span>}
            {(status === 'generating' || status === 'uploading') && (
              <span className="text-orange-400 animate-pulse">{message}</span>
            )}
            {status === 'idle' && message && <span className="text-text-muted">{message}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
