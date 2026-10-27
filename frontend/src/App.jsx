import { Suspense, lazy } from 'react';
import './App.css';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';

// Auth
import { AuthProvider, useAuth } from './contexts/AuthContext.jsx';
import { ImportProvider } from './contexts/ImportContext.jsx';
import { ThemeProvider } from './contexts/ThemeContext.jsx';
import { OrganizationProvider, useOrganization } from './contexts/OrganizationContext.jsx';
import LoadingScreen from './components/LoadingScreen.jsx';
import OrganizationFetchError from './components/OrganizationFetchError.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { PERMISSIONS } from './constants/permissions.js';
import { FEATURE_FLAGS } from './constants/featureFlags.js';
import { FeatureGuard } from './components/ui/FeatureGuard.jsx';

// Layouts
import DashboardLayout from './layouts/DashboardLayout.jsx';

// Lazy load pages
const Login = lazy(() => import('./components/Login.jsx'));
const DashboardPage = lazy(() => import('./pages/DashboardPage.jsx'));
const ImportPage = lazy(() => import('./pages/ImportPage.jsx'));
const TeamAnalysisPage = lazy(() => import('./pages/TeamAnalysisPage.jsx'));
const CoachesPage = lazy(() => import('./pages/CoachesPage.jsx'));
const FieldManagementPage = lazy(() => import('./pages/FieldManagementPage.jsx'));
const PracticeSchedulingPage = lazy(() => import('./pages/PracticeSchedulingPage.jsx'));
const GameSchedulingPage = lazy(() => import('./pages/GameSchedulingPage.jsx'));
const SettingsPage = lazy(() => import('./pages/SettingsPage.jsx'));
const AccountSettingsPage = lazy(() => import('./pages/AccountSettingsPage.jsx'));
const TeamRecordPage = lazy(() => import('./pages/TeamRecordPage.jsx'));
const EnterpriseDashboard = lazy(() => import('./pages/EnterpriseDashboard.jsx'));
const LeagueStandings = lazy(() => import('./pages/LeagueStandings.jsx'));
const SeasonSetupPage = lazy(() => import('./pages/SeasonSetupPage.jsx'));
const WorkflowPage = lazy(() => import('./pages/WorkflowPage.jsx'));
const ResetPassword = lazy(() => import('./pages/ResetPassword.jsx'));
const AuditLogPage = lazy(() => import('./pages/AuditLogPage.jsx'));
const AnalyticalDashboard = lazy(() => import('./pages/AnalyticalDashboard.jsx'));
const OrganizationCreation = lazy(() => import('./pages/OrganizationCreation.jsx'));
const InvitePage = lazy(() => import('./pages/InvitePage.jsx'));
const PlayersPage = lazy(() => import('./pages/PlayersPage.jsx'));
const TeamBuilderPage = lazy(() => import('./pages/TeamBuilderPage.jsx'));
const BlackoutsPage = lazy(() => import('./pages/BlackoutsPage.jsx'));
const ScoresPage = lazy(() => import('./pages/ScoresPage.jsx'));
const ExportsPage = lazy(() => import('./pages/ExportsPage.jsx'));
const MembersPage = lazy(() => import('./pages/MembersPage.jsx'));
const FeaturesSetupPage = lazy(() => import('./pages/FeaturesSetupPage.jsx'));
const PlayerRecordPage = lazy(() => import('./pages/PlayerRecordPage.jsx'));
const CoachPreferencesPage = lazy(() => import('./pages/CoachPreferencesPage.jsx'));
const PracticeLightingPage = lazy(() => import('./pages/PracticeLightingPage.jsx'));
const HeatForecastPage = lazy(() => import('./pages/HeatForecastPage.jsx'));
const MyTeamPage = lazy(() => import('./pages/MyTeamPage.jsx'));
const PermitsPage = lazy(() => import('./pages/PermitsPage.jsx'));
const DemoStartPage = lazy(() => import('./pages/DemoStartPage.jsx'));
const DemoEndedPage = lazy(() => import('./pages/DemoEndedPage.jsx'));
import DemoTimer from './components/auth/DemoTimer.jsx';
import OfflineGuard from './components/OfflineGuard.jsx';
import ToastHost from './components/ui/ToastHost.jsx';

function AppContent() {
  const { session, loading } = useAuth();
  // Router location, NOT window.location: AppContent must re-render when an
  // in-app <Navigate> fires (e.g. leaving /invite/:code), or these branches
  // keep rendering route sets that no longer match anything (blank screen).
  const location = useLocation();
  const {
    currentOrganization,
    permissions,
    organizations,
    loading: orgLoading,
    fetchError: orgFetchError,
    refetchOrgs,
  } = useOrganization();

  if (loading) {
    return <LoadingScreen />;
  }

  // /invite/:code is reachable regardless of session or org state. The page
  // itself handles each auth/org combination (unauthenticated → inline Login;
  // authenticated → redeem immediately).
  const isInvitePath = /^\/invite\/[^/]+\/?$/.test(location.pathname);
  if (isInvitePath) {
    return (
      <Suspense fallback={<LoadingScreen message="Validating invite..." />}>
        <Routes>
          <Route path="/invite/:code" element={<InvitePage />} />
        </Routes>
      </Suspense>
    );
  }

  // /demo/start and /demo/ended (plan docs/changes/2026-10-22-demo-mode.md, D4) are reachable
  // signed out, anonymous or signed in, and sit outside every redirect below: a visitor with no
  // account has no organization on the way in, which must not send them to /organizations/new.
  if (/^\/demo\/(start|ended)\/?$/.test(location.pathname)) {
    return (
      <Suspense fallback={<LoadingScreen />}>
        <Routes>
          <Route path="/demo/start" element={<DemoStartPage />} />
          <Route path="/demo/ended" element={<DemoEndedPage />} />
        </Routes>
      </Suspense>
    );
  }

  if (!session && location.pathname !== '/auth/reset-password') {
    return (
      <Suspense fallback={<LoadingScreen />}>
        <Login />
      </Suspense>
    );
  }

  // The initial organization fetch errored out (typical cause: stale RLS
  // policy returning 500, or network hiccup). Surface a diagnostic instead
  // of either (a) hanging on LoadingScreen forever or (b) pushing the user
  // back to OrganizationCreation as if they had no orgs.
  if (orgFetchError && !orgLoading) {
    return <OrganizationFetchError error={orgFetchError} onRetry={refetchOrgs} />;
  }

  // An anonymous session is a demo visitor's. It is never routed to /organizations/new (the server
  // refuses it a tenant): with no organization its demo is gone, and it goes to /demo/ended, where
  // "Start again" begins a new one.
  const isAnonymous = session?.user?.is_anonymous === true;
  const hasNoOrgs = !orgLoading && organizations.length === 0;
  if (isAnonymous && hasNoOrgs) {
    return <Navigate to="/demo/ended" replace />;
  }
  const shouldRedirectToOrgCreation =
    hasNoOrgs && !location.pathname.startsWith('/organizations/new') && location.pathname === '/';
  // The setup pages have no header; the demo's clock floats over them instead.
  const showFloatingDemoTimer = /^\/setup(\/|$)/.test(location.pathname);

  const isOnboarded = currentOrganization?.is_onboarded;
  const isTenantAdmin = permissions.includes(PERMISSIONS.MANAGE_GLOBAL_SETTINGS);

  return (
    <Suspense fallback={<LoadingScreen />}>
      {showFloatingDemoTimer && <DemoTimer floating />}
      <Routes>
        <Route path="/auth/reset-password" element={<ResetPassword />} />
        <Route
          path="/organizations/new"
          element={isAnonymous ? <Navigate to="/" replace /> : <OrganizationCreation />}
        />
        <Route
          path="/setup"
          element={
            <ProtectedRoute requiredPermission={PERMISSIONS.MANAGE_GLOBAL_SETTINGS}>
              <SeasonSetupPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/setup/features"
          element={
            <ProtectedRoute requiredPermission={PERMISSIONS.MANAGE_GLOBAL_SETTINGS}>
              <FeaturesSetupPage />
            </ProtectedRoute>
          }
        />
        <Route
          element={
            shouldRedirectToOrgCreation ? (
              <Navigate to="/organizations/new" replace />
            ) : !isOnboarded && isTenantAdmin ? (
              <Navigate to="/setup" replace />
            ) : (
              <DashboardLayout />
            )
          }
        >
          <Route path="/" element={<DashboardPage />} />
          <Route
            path="/workflow"
            element={
              <ProtectedRoute requiredPermission={PERMISSIONS.MANAGE_ORGANIZATION}>
                <WorkflowPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/import"
            element={
              <ProtectedRoute requiredPermission={PERMISSIONS.MANAGE_ORGANIZATION}>
                <ImportPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/teams"
            element={
              <ProtectedRoute requiredPermission={PERMISSIONS.VIEW_ALL_TEAMS}>
                <TeamAnalysisPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/players"
            element={
              <ProtectedRoute requiredPermission={PERMISSIONS.MANAGE_ORGANIZATION}>
                <PlayersPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/players/:playerId"
            element={
              <ProtectedRoute requiredPermission={PERMISSIONS.MANAGE_ORGANIZATION}>
                <PlayerRecordPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/teams/builder"
            element={
              <ProtectedRoute requiredPermission={PERMISSIONS.MANAGE_ALL_TEAMS}>
                <TeamBuilderPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/scheduling/blackouts"
            element={
              <ProtectedRoute requiredPermission={PERMISSIONS.MANAGE_ORGANIZATION}>
                <BlackoutsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/scores"
            element={
              <ProtectedRoute requiredPermission={PERMISSIONS.MANAGE_SCHEDULE}>
                {/* Score entry is off until the league turns it on (R6). */}
                <FeatureGuard
                  flag={FEATURE_FLAGS.SCORE_ENTRY}
                  fallback={<Navigate to="/" replace />}
                >
                  <ScoresPage />
                </FeatureGuard>
              </ProtectedRoute>
            }
          />
          <Route
            path="/exports"
            element={
              <ProtectedRoute requiredPermission={PERMISSIONS.MANAGE_ORGANIZATION}>
                <ExportsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/members"
            element={
              <ProtectedRoute requiredPermission={PERMISSIONS.MANAGE_ORGANIZATION}>
                <MembersPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/coaches"
            element={
              <ProtectedRoute requiredPermission={PERMISSIONS.MANAGE_ORGANIZATION}>
                <CoachesPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/coaches/practice-preferences"
            element={
              <ProtectedRoute requiredPermission={PERMISSIONS.REQUEST_PRACTICE_PREFERENCE}>
                <CoachPreferencesPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/schedule/practice-lighting"
            element={
              <ProtectedRoute requiredPermission={PERMISSIONS.DECIDE_PRACTICE_LIGHTING_OVERRIDE}>
                <PracticeLightingPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/schedule/heat"
            element={
              <ProtectedRoute requiredPermission={PERMISSIONS.MANAGE_ORGANIZATION}>
                <HeatForecastPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/fields"
            element={
              <ProtectedRoute requiredPermission={PERMISSIONS.MANAGE_ORGANIZATION}>
                <FieldManagementPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/audit-logs"
            element={
              <ProtectedRoute requiredPermission={PERMISSIONS.MANAGE_GLOBAL_SETTINGS}>
                <AuditLogPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/analytics"
            element={
              <ProtectedRoute requiredPermission={PERMISSIONS.MANAGE_ORGANIZATION}>
                <AnalyticalDashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/reports"
            element={
              <ProtectedRoute requiredPermission={PERMISSIONS.MANAGE_ORGANIZATION}>
                <EnterpriseDashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/schedule/practice"
            element={
              <ProtectedRoute requiredPermission={PERMISSIONS.VIEW_SCHEDULE}>
                <PracticeSchedulingPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/schedule/game"
            element={
              <ProtectedRoute requiredPermission={PERMISSIONS.VIEW_SCHEDULE}>
                <GameSchedulingPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/settings"
            element={
              <ProtectedRoute requiredPermission={PERMISSIONS.MANAGE_ORGANIZATION}>
                <SettingsPage />
              </ProtectedRoute>
            }
          />
          <Route path="/account" element={<AccountSettingsPage />} />
          <Route path="/team/:teamId" element={<TeamRecordPage />} />
          <Route
            path="/standings"
            element={
              <ProtectedRoute requiredPermission={PERMISSIONS.VIEW_SCHEDULE}>
                {/* An admin function the league turns on (R6). */}
                <FeatureGuard flag={FEATURE_FLAGS.STANDINGS} fallback={<Navigate to="/" replace />}>
                  <LeagueStandings />
                </FeatureGuard>
              </ProtectedRoute>
            }
          />
          <Route path="/my-team" element={<MyTeamPage />} />
          <Route
            path="/permits"
            element={
              <ProtectedRoute requiredPermission={PERMISSIONS.VIEW_FIELD_PERMITS}>
                <PermitsPage />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <OrganizationProvider>
          <ImportProvider>
            <ThemeProvider>
              <ToastHost>
                <ErrorBoundary>
                  <OfflineGuard>
                    <AppContent />
                  </OfflineGuard>
                </ErrorBoundary>
              </ToastHost>
            </ThemeProvider>
          </ImportProvider>
        </OrganizationProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
