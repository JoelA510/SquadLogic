import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import PropTypes from 'prop-types';
import { PRACTICE_CHANGES_UNREAD_TEXT, useTeamPortal } from '../hooks/useTeamPortal.js';
import { Calendar, MapPin, Clock, RefreshCw, Shield, Target, UserRoundCheck } from 'lucide-react';
import LoadingScreen from '../components/LoadingScreen.jsx';
import Button from '../components/ui/Button.jsx';
import Modal from '../components/ui/Modal.jsx';
import Tabs from '../components/ui/Tabs.jsx';
import Badge from '../components/ui/Badge.jsx';
import Avatar from '../components/ui/Avatar.jsx';
import InlineField from '../components/ui/InlineField.jsx';
import { usePermission } from '../hooks/usePermission.js';
import { useScorableGames } from '../hooks/useScorableGames.js';
import { useFeatures } from '../hooks/useFeatures.js';
import { FEATURE_FLAGS } from '../constants/featureFlags.js';
import { divisionDisplayName } from '../utils/divisions.js';
import { supabase } from '../lib/supabaseClient.js';
import { logger } from '../lib/logger.js';

/** `practice_slots.day_of_week` in words, for the "Moved from" line. */
const WEEKDAY_NAMES = Object.freeze({
  sun: 'Sunday',
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
});

/** A wall date as "Monday, November 2", read at local midnight (never UTC). */
const longDate = (date) =>
  new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

/** "Moved from <weekday> <time>, <ground>" (plan §10 Q3). */
function movedFromLine(movedFrom) {
  const day = String(movedFrom?.dayOfWeek ?? '').toLowerCase();
  const weekday = WEEKDAY_NAMES[day] ?? 'another day';
  const time = movedFrom?.startTime
    ? String(movedFrom.startTime).substring(0, 5)
    : 'an unknown time';
  return `Moved from ${weekday} ${time}, ${movedFrom?.location ?? 'Venue - Field'}`;
}

/**
 * Team record — the old Team Portal absorbed into the Lightning-class
 * record layout: hero (name, division, roster size, calendar subscribe)
 * + tabs Schedule, Roster, Staff, Balance. The portal's calendar feed is
 * reused, not forked. Availability marking (RSVP) and team chat were removed
 * (20261022030000; plan docs/changes/2026-10-22-admin-focus.md, R2): families
 * reach the league through its registration platform, not here.
 */
export default function TeamRecordPage() {
  const { teamId } = useParams();
  const { loading, error, team, roster, rosterUnavailable, events, practiceChangesUnread } =
    useTeamPortal(teamId);
  const { can, PERMISSIONS } = usePermission();
  const { isEnabled, genderModel } = useFeatures();

  const [tab, setTab] = useState('schedule');
  const [calendarModalOpen, setCalendarModalOpen] = useState(false);
  // Who may regenerate the calendar link: an admin or the team's current
  // coach (rotate_calendar_token, 20261021020000). Asked only once the dialog
  // is open.
  const { coachesTeam } = useScorableGames({ enabled: calendarModalOpen });
  const [staff, setStaff] = useState(/** @type {any[] | null} */ (null));
  const [staffError, setStaffError] = useState(false);

  // Staff tab: every current coach, through the server-side read
  // (20261021010000), which admits admins and the team's current coaches (no
  // guardian since 20261024010000) and returns names and roles, with no
  // contact details (20261025010000); an admin finds a coach's sign-in email
  // on the Coaches page.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!team?.id) return;
      // Clear the previous team's staff while this team's loads.
      setStaff(null);
      setStaffError(false);
      const { data, error: staffReadError } = await supabase.rpc('get_team_staff', {
        p_team_id: team.id,
      });
      if (cancelled) return;
      if (staffReadError) {
        logger.warn('[TeamRecordPage] team staff not loaded', {
          teamId: team.id,
          code: staffReadError.code,
          message: staffReadError.message,
        });
        setStaffError(true);
        setStaff([]);
        return;
      }
      setStaffError(false);
      setStaff(data || []);
    })();
    return () => {
      cancelled = true;
    };
  }, [team?.id]);

  if (loading) return <LoadingScreen />;
  if (error) return <div className="p-8 text-status-error glass-panel">Error: {error}</div>;

  const isAdminish = can(PERMISSIONS.MANAGE_ALL_TEAMS);
  const divisionLabel = team?.division?.name
    ? divisionDisplayName(team.division.name, genderModel)
    : null;
  const ratingOn = isEnabled(FEATURE_FLAGS.PLAYER_RATING);
  const yearsOn = isEnabled(FEATURE_FLAGS.YEARS_PLAYED);

  const boys = roster.filter((p) => p.gender === 'm').length;
  const girls = roster.filter((p) => p.gender === 'f').length;
  const avgYears = roster.length
    ? roster.reduce((sum, p) => sum + (p.years_played || 0), 0) / roster.length
    : 0;
  const avgRating = roster.length
    ? roster.reduce((sum, p) => sum + (p.rating || 0), 0) / roster.length
    : 0;
  const volunteers = roster.filter((p) => p.willing_to_coach).length;

  const tabs = [
    { id: 'schedule', label: 'Schedule' },
    { id: 'roster', label: `Roster (${roster.length})` },
    { id: 'staff', label: 'Staff' },
    // Balance reads gender, years played and rating, which the roster read
    // returns to admins and staff only.
    ...(isAdminish ? [{ id: 'balance', label: 'Balance' }] : []),
  ];

  return (
    <div className="animate-fadeIn">
      <div
        className="page-head"
        style={{ paddingBottom: 0, background: 'transparent', border: 'none' }}
      >
        <div
          className="record-hero"
          style={{ border: 'none', padding: '8px 0 0', background: 'transparent' }}
        >
          <span
            className="record-avatar"
            style={{ background: 'var(--primary)' }}
            aria-hidden="true"
          >
            <Shield size={26} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 className="page-title text-3xl font-display font-bold text-text-primary tracking-tight">
              {team?.name || 'Loading Team...'}
            </h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
              {divisionLabel && <Badge tone="info">{divisionLabel}</Badge>}
              <span className="muted" style={{ fontSize: 13 }}>
                {team?.division?.season?.season_label} {team?.division?.season?.season_year}
              </span>
              <span className="muted">·</span>
              <span className="muted" style={{ fontSize: 13 }}>
                {roster.length} players
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {isAdminish && (
              <Button
                variant="secondary"
                size="sm"
                icon={Target}
                onClick={() => (window.location.href = '/teams/builder')}
              >
                Team Builder
              </Button>
            )}
            <button
              type="button"
              onClick={() => setCalendarModalOpen(true)}
              className="relative z-20 bg-bg-surface px-4 py-2 rounded-lg border border-border-subtle flex items-center gap-2 hover:bg-bg-surface-hover transition-colors"
            >
              <Calendar size={18} className="text-color-primary" aria-hidden="true" />
              <span className="font-semibold">Subscribe to Calendar</span>
            </button>
          </div>
        </div>
        <Tabs tabs={tabs} activeTab={tab} onChange={setTab} label="Team record sections" />
      </div>

      <div style={{ padding: '20px 0 40px' }}>
        {tab === 'schedule' && (
          <div className="space-y-6">
            <h2 className="text-2xl font-display font-bold flex items-center gap-2">
              <Calendar className="text-color-primary" />
              Team Schedule
            </h2>

            {practiceChangesUnread && (
              // Q5: the practices below are the bare series; say so, never silently.
              <div
                role="alert"
                data-testid="practice-changes-unread"
                className="bg-status-warning-bg text-text-primary border border-status-warning rounded-xl p-4 text-sm"
              >
                {PRACTICE_CHANGES_UNREAD_TEXT}
              </div>
            )}

            <div className="space-y-4">
              {events.length === 0 ? (
                <div className="glass-panel p-8 text-center text-text-muted">
                  No upcoming events scheduled.
                </div>
              ) : (
                events.map((event, idx) => (
                  <div
                    key={`${event.type}-${event.id}-${event.date}-${event.reasonCode ?? ''}-${event.exceptionId ?? ''}`}
                    className="glass-panel p-5 animate-slideUp"
                    style={{ animationDelay: `${idx * 0.05}s` }}
                  >
                    <div className="flex flex-col md:flex-row justify-between gap-4">
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                              event.type === 'game'
                                ? 'bg-status-success-bg text-status-success'
                                : 'bg-brand-glow text-color-primary'
                            }`}
                          >
                            {event.type}
                          </span>
                          <h3 className="font-bold text-lg">{event.description}</h3>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-y-1 gap-x-4 text-sm text-text-secondary">
                          <div className="flex items-center gap-1.5">
                            <Calendar size={14} />
                            {event.timeTbd
                              ? event.date
                                ? `Time TBD on ${longDate(event.date)}: ${event.reason}`
                                : `Date and time TBD: ${event.reason}`
                              : longDate(event.date)}
                          </div>
                          <div className="flex items-center gap-1.5">
                            <Clock size={14} />
                            {event.timeTbd
                              ? 'TIME TBD'
                              : `${event.startTime?.substring(0, 5)} - ${event.endTime?.substring(0, 5)}`}
                          </div>
                          <div className="flex items-center gap-1.5 md:col-span-2">
                            <MapPin size={14} />
                            {event.location ?? 'Location TBD'}
                          </div>
                          {event.timingNotes?.map((note) => (
                            // The feed's placed-event note: an ambiguous fall-back hour.
                            <p key={note} className="md:col-span-2 text-text-secondary">
                              Note: {note}.
                            </p>
                          ))}
                          {event.kind === 'relocated' && (
                            // Q3: one line naming what the move replaces.
                            <p className="md:col-span-2 text-text-secondary">
                              {movedFromLine(event.movedFrom)}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {tab === 'roster' && (
          <div className="glass-panel p-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {roster.map((player) => {
                const playerName = `${player.first_name} ${player.last_name}`;

                return (
                  <div
                    key={player.id}
                    className="bg-bg-surface p-4 rounded-lg border border-border-subtle flex justify-between items-center"
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <Avatar name={playerName} size="sm" />
                      <div>
                        <div className="font-bold text-text-primary">
                          {isAdminish ? (
                            <Link className="linklike" to={`/players/${player.id}`}>
                              {playerName}
                            </Link>
                          ) : (
                            playerName
                          )}
                        </div>
                        <div className="text-sm text-text-secondary">
                          {player.jersey_number != null ? `#${player.jersey_number} · ` : ''}
                          Player
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
              {roster.length === 0 && (
                <div className="col-span-full text-center text-text-muted py-8">
                  {rosterUnavailable === 'refused'
                    ? "The roster is shown to the team's coaches and league admins."
                    : rosterUnavailable === 'failed'
                      ? 'The roster could not be loaded. Try again shortly.'
                      : 'No players assigned yet.'}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'staff' && (
          <div className="card" style={{ maxWidth: 720 }}>
            <div className="card-head">
              <UserRoundCheck size={17} aria-hidden="true" />
              <h3>Coaching staff</h3>
            </div>
            <div className="card-body">
              {staff === null ? (
                <span className="muted">Loading staff…</span>
              ) : staffError ? (
                <span className="muted">The coaching staff could not be loaded.</span>
              ) : staff.length === 0 ? (
                <span className="muted">No coach assigned.</span>
              ) : (
                staff.map((member, index) => (
                  <div key={`${member.coach_id}-${member.role}-${index}`}>
                    {index > 0 && <div className="divider" />}
                    <div className="rf-grid">
                      <InlineField
                        label={member.role === 'lead' ? 'Head coach' : 'Assistant coach'}
                        value={member.full_name}
                        editable={false}
                        render={() => (
                          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <Avatar name={member.full_name || '?'} size="sm" />
                            {member.full_name}
                          </span>
                        )}
                      />
                      {member.status != null && (
                        <InlineField
                          label="Status"
                          value={member.status}
                          editable={false}
                          render={(v) => (
                            <Badge tone={v === 'active' ? 'success' : 'warning'} dot>
                              {v}
                            </Badge>
                          )}
                        />
                      )}
                    </div>
                  </div>
                ))
              )}
              {isAdminish && (
                <>
                  <div className="divider" />
                  <div style={{ fontSize: 13 }} className="secondary">
                    {volunteers} player(s) on this roster have a family member willing to coach.
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {tab === 'balance' && isAdminish && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 860 }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))',
                gap: 12,
              }}
            >
              <div className="metric-tile">
                <div className="mt-val tnum">{roster.length}</div>
                <div className="mt-label">Roster size</div>
              </div>
              {ratingOn && (
                <div className="metric-tile">
                  <div className="mt-val tnum">{avgRating.toFixed(1)}</div>
                  <div className="mt-label">Avg rating</div>
                </div>
              )}
              {yearsOn && (
                <div className="metric-tile">
                  <div className="mt-val tnum">{avgYears.toFixed(1)}</div>
                  <div className="mt-label">Avg years played</div>
                </div>
              )}
              <div className="metric-tile">
                <div className="mt-val tnum">
                  {boys}
                  <span className="muted" style={{ fontSize: 14 }}>
                    /
                  </span>
                  {girls}
                </div>
                <div className="mt-label">Boys / Girls</div>
              </div>
            </div>
            {isAdminish && (
              <div className="card">
                <div
                  className="card-body"
                  style={{ display: 'flex', alignItems: 'center', gap: 12 }}
                >
                  <Target size={20} style={{ color: 'var(--primary)' }} aria-hidden="true" />
                  <div style={{ flex: 1 }}>
                    <b>Re-balance this division</b>{' '}
                    <span className="muted">
                      — move players across teams honoring buddy requests, coach parents, and{' '}
                      {ratingOn ? 'ratings' : yearsOn ? 'years played' : 'roster size'}.
                    </span>
                  </div>
                  <Link to="/teams/builder">
                    <Button variant="primary">Open Team Builder</Button>
                  </Link>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {calendarModalOpen && (
        <CalendarModal
          team={team}
          canRotate={coachesTeam(team?.id)}
          onClose={() => setCalendarModalOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * Phase 2.3 (H-2): Calendar modal with token rotation support.
 *
 * The token is read from `team_calendar_tokens` (20261021020000), which admins
 * and the team's current coaches can read (no guardian since 20261024010000);
 * anyone else gets no row and is told so. `canRotate` (an admin or the team's current coach)
 * offers Regenerate; the server refuses everyone else regardless.
 */
export function CalendarModal({ team, canRotate = false, onClose }) {
  const [calendarToken, setCalendarToken] = useState('');
  const [tokenState, setTokenState] = useState(
    /** @type {'loading' | 'ready' | 'none' | 'failed'} */ ('loading')
  );
  const [isRotating, setIsRotating] = useState(false);
  const [rotateMessage, setRotateMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!team?.id) {
        setTokenState('none');
        return;
      }
      setTokenState('loading');
      const { data, error } = await supabase
        .from('team_calendar_tokens')
        .select('token')
        .eq('team_id', team.id)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        logger.warn('[CalendarModal] calendar token not read', {
          teamId: team.id,
          code: error.code,
          message: error.message,
        });
        setTokenState('failed');
        return;
      }
      setCalendarToken(data?.token ?? '');
      setTokenState(data?.token ? 'ready' : 'none');
    })();
    return () => {
      cancelled = true;
    };
  }, [team?.id]);

  const calendarUrl = calendarToken
    ? `webcal://${window.location.host}/functions/v1/calendar-feed?token=${calendarToken}`
    : '';

  const handleRotateToken = async () => {
    if (!team?.id) return;
    setIsRotating(true);
    setRotateMessage('');
    try {
      const { data, error } = await supabase.rpc('rotate_calendar_token', {
        p_team_id: team.id,
      });
      if (error) throw error;
      if ((data?.status === 'success' || data?.status === 'ok') && data?.calendar_token) {
        setCalendarToken(data.calendar_token);
        setTokenState('ready');
        setRotateMessage('New link generated. Update your calendar subscription.');
      } else {
        setRotateMessage(data?.message || 'Failed to regenerate link.');
      }
    } catch (err) {
      setRotateMessage('Error: ' + (err.message || 'Could not regenerate link.'));
    } finally {
      setIsRotating(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Calendar Subscription">
      <>
        <label
          htmlFor="team-calendar-subscription-link"
          className="block text-sm text-text-secondary mb-4"
        >
          Copy this link to your calendar app:
        </label>
        <input
          id="team-calendar-subscription-link"
          type="text"
          readOnly
          value={calendarUrl}
          placeholder="Regenerate a link before subscribing."
          className="w-full bg-bg-surface border border-border-subtle rounded-lg p-3 text-text-primary mb-4 text-sm"
        />
        {tokenState === 'none' && (
          <p className="text-sm text-status-warning-text mb-3">
            {canRotate
              ? 'No calendar link is currently available. Regenerate the link before sharing it.'
              : "The calendar link is shared with the team's coaches and league admins."}
          </p>
        )}
        {tokenState === 'failed' && (
          <p className="text-sm text-status-warning-text mb-3" role="alert">
            The calendar link could not be loaded. Try again shortly.
          </p>
        )}
        {rotateMessage && (
          <p className="text-sm text-status-warning-text mb-3" aria-live="polite">
            {rotateMessage}
          </p>
        )}
        <div className="flex justify-between items-center">
          {canRotate ? (
            <button
              type="button"
              onClick={handleRotateToken}
              // Not while the stored token is still being read: a read landing
              // after a rotation would put the old, now invalid token back.
              disabled={isRotating || tokenState === 'loading'}
              className="flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
              title="Generate a new calendar link (invalidates the old one)"
            >
              <RefreshCw
                size={14}
                className={isRotating ? 'animate-spin' : ''}
                aria-hidden="true"
              />
              Regenerate Link
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-3">
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
            <Button
              variant="primary"
              disabled={!calendarToken}
              onClick={() => {
                if (calendarUrl) navigator.clipboard?.writeText(calendarUrl).catch(() => {});
              }}
            >
              Copy Link
            </Button>
          </div>
        </div>
      </>
    </Modal>
  );
}

CalendarModal.propTypes = {
  team: PropTypes.shape({
    id: PropTypes.string,
  }),
  canRotate: PropTypes.bool,
  onClose: PropTypes.func.isRequired,
};
