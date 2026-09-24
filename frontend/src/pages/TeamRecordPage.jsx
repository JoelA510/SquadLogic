import React, { useState, useRef, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import PropTypes from 'prop-types';
import { useTeamPortal } from '../hooks/useTeamPortal.js';
import {
  Calendar,
  MessageSquare,
  Send,
  Check,
  X,
  Minus,
  MapPin,
  Clock,
  RefreshCw,
  Shield,
  Target,
  UserRoundCheck,
} from 'lucide-react';
import LoadingScreen from '../components/LoadingScreen.jsx';
import Button from '../components/ui/Button.jsx';
import Tabs from '../components/ui/Tabs.jsx';
import Badge from '../components/ui/Badge.jsx';
import Avatar from '../components/ui/Avatar.jsx';
import InlineField from '../components/ui/InlineField.jsx';
import { usePermission } from '../hooks/usePermission.js';
import { useFeatures } from '../hooks/useFeatures.js';
import { FEATURE_FLAGS } from '../constants/featureFlags.js';
import { divisionDisplayName } from '../utils/divisions.js';
import { supabase } from '../lib/supabaseClient.js';

/**
 * Team record — the old Team Portal absorbed into the Lightning-class
 * record layout: hero (name, division, roster size, calendar subscribe)
 * + tabs Schedule (events, RSVPs, team chat), Roster, Staff, Balance.
 * All portal capabilities (calendar feed, RSVP, messages, medical status)
 * are reused, not forked.
 */
export default function TeamRecordPage() {
  const { teamId } = useParams();
  const {
    loading,
    error,
    team,
    roster,
    events,
    rsvps,
    messages,
    myPlayers,
    updateRsvp,
    sendMessage,
  } = useTeamPortal(teamId);
  const { can, PERMISSIONS } = usePermission();
  const { isEnabled, genderModel } = useFeatures();

  const [tab, setTab] = useState('schedule');
  const [chatInput, setChatInput] = useState('');
  const [calendarModalOpen, setCalendarModalOpen] = useState(false);
  const [coach, setCoach] = useState(null);
  const chatEndRef = useRef(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Staff tab: resolve the head coach row when the team carries one.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!team?.coach_id) {
        setCoach(null);
        return;
      }
      try {
        const { data } = await supabase.from('coaches').select('*').eq('id', team.coach_id);
        if (!cancelled) setCoach((data || [])[0] || null);
      } catch {
        /* staff card is optional */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [team?.coach_id]);

  if (loading) return <LoadingScreen />;
  if (error) return <div className="p-8 text-status-error glass-panel">Error: {error}</div>;

  const handleSendMessage = (e) => {
    e.preventDefault();
    const message = chatInput.trim();
    if (!message) return;
    sendMessage(message);
    setChatInput('');
  };

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
    { id: 'balance', label: 'Balance' },
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
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2 space-y-6">
              <h2 className="text-2xl font-display font-bold flex items-center gap-2">
                <Calendar className="text-color-primary" />
                Team Schedule
              </h2>

              <div className="space-y-4">
                {events.length === 0 ? (
                  <div className="glass-panel p-8 text-center text-text-muted">
                    No upcoming events scheduled.
                  </div>
                ) : (
                  events.map((event, idx) => (
                    <div
                      key={`${event.type}-${event.id}-${event.date}`}
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
                                ? `Date and time TBD: ${event.reason}`
                                : new Date(event.date + 'T00:00:00').toLocaleDateString(undefined, {
                                    weekday: 'long',
                                    month: 'long',
                                    day: 'numeric',
                                  })}
                            </div>
                            <div className="flex items-center gap-1.5">
                              <Clock size={14} />
                              {event.timeTbd
                                ? 'TIME TBD'
                                : `${event.startTime?.substring(0, 5)} - ${event.endTime?.substring(0, 5)}`}
                            </div>
                            <div className="flex items-center gap-1.5 md:col-span-2">
                              <MapPin size={14} />
                              {event.location}
                            </div>
                          </div>
                        </div>

                        <div className="flex flex-col gap-3 min-w-[200px]">
                          {myPlayers.length > 0 && !event.timeTbd ? (
                            <div className="space-y-3">
                              <p className="text-xs font-bold text-text-muted uppercase tracking-widest">
                                Your RSVPs
                              </p>
                              {myPlayers.map((player) => {
                                const rsvp = rsvps.find(
                                  (r) =>
                                    r.player_id === player.id &&
                                    r.reference_id === event.id &&
                                    r.occurrence_date === event.date
                                );

                                return (
                                  <div
                                    key={player.id}
                                    className="flex flex-col gap-1.5 p-2 rounded bg-bg-surface/30 border border-border-subtle"
                                  >
                                    <span className="text-xs font-semibold text-text-primary px-1">
                                      {player.first_name} {player.last_name}
                                    </span>
                                    <div className="flex gap-2">
                                      <RsvpButton
                                        active={rsvp?.status === 'attending'}
                                        type="attending"
                                        onClick={() =>
                                          updateRsvp(
                                            player.id,
                                            event.id,
                                            event.type,
                                            event.date,
                                            'attending'
                                          )
                                        }
                                      />
                                      <RsvpButton
                                        active={rsvp?.status === 'declined'}
                                        type="declined"
                                        onClick={() =>
                                          updateRsvp(
                                            player.id,
                                            event.id,
                                            event.type,
                                            event.date,
                                            'declined'
                                          )
                                        }
                                      />
                                      <RsvpButton
                                        active={rsvp?.status === 'maybe'}
                                        type="maybe"
                                        onClick={() =>
                                          updateRsvp(
                                            player.id,
                                            event.id,
                                            event.type,
                                            event.date,
                                            'maybe'
                                          )
                                        }
                                      />
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          ) : (
                            <div className="h-full flex items-center justify-end">
                              <span className="text-xs text-text-muted">
                                {event.timeTbd
                                  ? 'RSVP opens once a date is set'
                                  : 'Viewing as Guest/Coach'}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="lg:col-span-1 flex flex-col h-[700px]">
              <h2 className="text-2xl font-display font-bold flex items-center gap-2 mb-6">
                <MessageSquare className="text-color-primary" />
                Team Chat
              </h2>

              <div className="glass-panel p-0 flex flex-col flex-grow overflow-hidden">
                <div className="flex-grow overflow-y-auto p-4 space-y-4">
                  {messages.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-text-muted text-sm italic">
                      No messages yet. Say hello!
                    </div>
                  ) : (
                    messages.map((msg) => (
                      <div key={msg.id} className="flex flex-col gap-1">
                        <div className="flex justify-between items-baseline">
                          <span className="text-xs font-bold text-color-primary">
                            {msg.author?.full_name}
                          </span>
                          <span className="text-[10px] text-text-muted">
                            {new Date(msg.created_at).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </span>
                        </div>
                        <div className="bg-bg-surface p-3 rounded-lg rounded-tl-none border border-border-subtle text-sm">
                          {msg.content}
                        </div>
                      </div>
                    ))
                  )}
                  <div ref={chatEndRef} />
                </div>

                <form
                  onSubmit={handleSendMessage}
                  className="p-4 bg-bg-surface/50 border-t border-border-subtle flex gap-2"
                >
                  <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder="Type a message..."
                    className="glass-input flex-grow text-sm"
                  />
                  <button
                    type="submit"
                    aria-label="Send team message"
                    className="relative z-20 glass-button p-2 flex items-center justify-center"
                  >
                    <Send size={18} />
                  </button>
                </form>
              </div>
            </div>
          </div>
        )}

        {tab === 'roster' && (
          <div className="glass-panel p-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {roster.map((player) => {
                const isMedicalCleared = player.medical_cleared === true;
                const canViewMedicalClearance = player.medical_clearance_visible === true;
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
                    {canViewMedicalClearance && (
                      <div
                        className={`text-xs font-bold px-2 py-1 rounded-full ${
                          isMedicalCleared
                            ? 'bg-status-success-bg text-status-success'
                            : 'bg-status-warning-bg text-status-warning'
                        }`}
                      >
                        Medical Clearance: {isMedicalCleared ? 'Yes' : 'Pending'}
                      </div>
                    )}
                  </div>
                );
              })}
              {roster.length === 0 && (
                <div className="col-span-full text-center text-text-muted py-8">
                  No players assigned yet.
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
              {coach ? (
                <div className="rf-grid">
                  <InlineField
                    label="Head coach"
                    value={coach.full_name}
                    editable={false}
                    render={() => (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Avatar name={coach.full_name || '?'} size="sm" />
                        {coach.full_name}
                      </span>
                    )}
                  />
                  <InlineField label="Email" value={coach.email} editable={false} />
                  <InlineField label="Phone" value={coach.phone} editable={false} />
                  <InlineField
                    label="Status"
                    value={coach.status}
                    editable={false}
                    render={(v) => (
                      <Badge tone={v === 'active' ? 'success' : 'warning'} dot>
                        {v}
                      </Badge>
                    )}
                  />
                </div>
              ) : (
                <span className="muted">No coach assigned.</span>
              )}
              <div className="divider" />
              <div style={{ fontSize: 13 }} className="secondary">
                {volunteers} guardian(s) on this roster volunteered to coach.
              </div>
            </div>
          </div>
        )}

        {tab === 'balance' && (
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
        <CalendarModal team={team} onClose={() => setCalendarModalOpen(false)} />
      )}
    </div>
  );
}

/**
 * Phase 2.3 (H-2): Calendar modal with token rotation support.
 * Coaches/admins can regenerate the calendar link if it's been compromised or expired.
 */
export function CalendarModal({ team, onClose }) {
  const [calendarToken, setCalendarToken] = useState(team?.calendar_token ?? '');
  const [isRotating, setIsRotating] = useState(false);
  const [rotateMessage, setRotateMessage] = useState('');

  useEffect(() => {
    setCalendarToken(team?.calendar_token ?? '');
  }, [team?.calendar_token]);

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-bg-app border border-border-subtle rounded-xl p-6 w-full max-w-md shadow-md">
        <h3 className="text-xl font-bold text-text-primary mb-4">Calendar Subscription</h3>
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
        {!calendarToken && (
          <p className="text-sm text-status-warning mb-3">
            No calendar link is currently available. Regenerate the link before sharing it.
          </p>
        )}
        {rotateMessage && (
          <p className="text-sm text-status-warning mb-3" aria-live="polite">
            {rotateMessage}
          </p>
        )}
        <div className="flex justify-between items-center">
          <button
            type="button"
            onClick={handleRotateToken}
            disabled={isRotating}
            className="flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
            title="Generate a new calendar link (invalidates the old one)"
          >
            <RefreshCw size={14} className={isRotating ? 'animate-spin' : ''} aria-hidden="true" />
            Regenerate Link
          </button>
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
      </div>
    </div>
  );
}

CalendarModal.propTypes = {
  team: PropTypes.shape({
    id: PropTypes.string,
    calendar_token: PropTypes.string,
  }),
  onClose: PropTypes.func.isRequired,
};

function RsvpButton({ active, type, onClick }) {
  const configs = {
    attending: {
      icon: Check,
      color: 'text-status-success',
      bg: 'bg-status-success-bg',
      label: 'Going',
    },
    declined: { icon: X, color: 'text-status-error', bg: 'bg-status-error-bg', label: 'Not Going' },
    maybe: {
      icon: Minus,
      color: 'text-status-warning',
      bg: 'bg-status-warning-bg',
      label: 'Maybe',
    },
  };

  const config = configs[type];
  const Icon = config.icon;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`relative z-20 flex-1 flex flex-col items-center gap-1 p-2 rounded transition-all duration-200 ${
        active
          ? `${config.bg} ${config.color} border-current scale-105`
          : 'bg-bg-surface/20 text-text-muted border-transparent grayscale hover:grayscale-0 hover:bg-bg-surface/40'
      } border`}
      title={config.label}
    >
      <Icon size={16} aria-hidden="true" />
      <span className="text-[9px] font-bold uppercase">{config.label}</span>
    </button>
  );
}

RsvpButton.propTypes = {
  active: PropTypes.bool.isRequired,
  type: PropTypes.oneOf(['attending', 'declined', 'maybe']).isRequired,
  onClick: PropTypes.func.isRequired,
};
