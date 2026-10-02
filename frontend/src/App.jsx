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
const RegistrationFlow = lazy(() => import('./pages/RegistrationFlow.jsx'));
const AdminComplianceDashboard = lazy(() => import('./pages/AdminComplianceDashboard.jsx'));
const RegistrationForms = lazy(() => import('./pages/RegistrationForms.jsx'));
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

  const hasNoOrgs = !orgLoading && organizations.length === 0;
  const shouldRedirectToOrgCreation =
    hasNoOrgs && !location.pathname.startsWith('/organizations/new') && location.pathname === '/';

  const isOnboarded = currentOrganization?.is_onboarded;
  const isTenantAdmin = permissions.includes(PERMISSIONS.MANAGE_GLOBAL_SETTINGS);

  return (
    <Suspense fallback={<LoadingScreen />}>
      <Routes>
        <Route path="/auth/reset-password" element={<ResetPassword />} />
        <Route path="/organizations/new" element={<OrganizationCreation />} />
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
          <Route path="/register/:formId" element={<RegistrationFlow />} />
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
                <ScoresPage />
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
              <ProtectedRoute requiredPermission={PERMISSIONS.REQUEST_PRACTICE_LIGHTING_OVERRIDE}>
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
            path="/admin/compliance"
            element={
              <ProtectedRoute requiredPermission={PERMISSIONS.MANAGE_ORGANIZATION}>
                <AdminComplianceDashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/forms"
            element={
              <ProtectedRoute requiredPermission={PERMISSIONS.MANAGE_ORGANIZATION}>
                <RegistrationForms />
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
          <Route path="/standings" element={<LeagueStandings />} />
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
