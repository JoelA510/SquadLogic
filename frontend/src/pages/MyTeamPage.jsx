import React from 'react';
import { Navigate } from 'react-router-dom';
import LoadingScreen from '../components/LoadingScreen.jsx';
import { useMyCoachedTeams } from '../hooks/useMyCoachedTeams.js';

/**
 * "My Team" in the coach's nav (plan docs/changes/2026-10-22-admin-focus.md,
 * R6). It pointed at `/teams`, the admin's league view a coach may not open,
 * so it bounced to the home with "Unauthorized access". Now: a coach of one
 * team goes to that team's page; a coach of none or of several (or one whose
 * teams could not be read) goes to their home, which lists them, or says
 * why it cannot.
 */
export default function MyTeamPage() {
  const { teams, loaded, error } = useMyCoachedTeams();
  if (!loaded) return <LoadingScreen message="Finding your team..." />;
  if (!error && teams.length === 1) return <Navigate to={`/team/${teams[0].id}`} replace />;
  return <Navigate to="/" replace />;
}
