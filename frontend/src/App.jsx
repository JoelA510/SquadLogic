import { Suspense, lazy } from 'react';
import './App.css';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

// Auth
import { AuthProvider, useAuth } from './contexts/AuthContext.jsx';
import { ImportProvider } from './contexts/ImportContext.jsx';
import { ThemeProvider } from './contexts/ThemeContext.jsx';
import { OrganizationProvider } from './contexts/OrganizationContext.jsx';
import LoadingScreen from './components/LoadingScreen.jsx';

// Layouts
import DashboardLayout from './layouts/DashboardLayout.jsx';

// Lazy load pages
const Login = lazy(() => import('./components/Login.jsx'));
const DashboardPage = lazy(() => import('./pages/DashboardPage.jsx'));
const ImportPage = lazy(() => import('./pages/ImportPage.jsx'));
const TeamAnalysisPage = lazy(() => import('./pages/TeamAnalysisPage.jsx'));
const FieldManagementPage = lazy(() => import('./pages/FieldManagementPage.jsx'));
const PracticeSchedulingPage = lazy(() => import('./pages/PracticeSchedulingPage.jsx'));
const GameSchedulingPage = lazy(() => import('./pages/GameSchedulingPage.jsx'));
const SettingsPage = lazy(() => import('./pages/SettingsPage.jsx'));
const ThemeToggle = lazy(() => import('./components/ThemeToggle.jsx'));

function AppContent() {
  const { session, loading } = useAuth();

  if (loading) {
    return <LoadingScreen />;
  }

  if (!session) {
    return (
      <Suspense fallback={<LoadingScreen />}>
        <Login />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={<LoadingScreen />}>
      <Routes>
        <Route element={<DashboardLayout />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="/teams" element={<TeamAnalysisPage />} />
          <Route path="/fields" element={<FieldManagementPage />} />
          <Route path="/schedule/practice" element={<PracticeSchedulingPage />} />
          <Route path="/schedule/game" element={<GameSchedulingPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <ThemeToggle />
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
              <AppContent />
            </ThemeProvider>
          </ImportProvider>
        </OrganizationProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
