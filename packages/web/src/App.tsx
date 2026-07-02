import { useState } from 'react';
import Sidebar from './components/Sidebar.js';
import LoginPage from './components/LoginPage.js';
import SetupPage from './components/SetupPage.js';
import OnboardingWizard from './components/OnboardingWizard.js';
import UserDashboard from './components/UserDashboard.js';
import WelcomePage from './components/WelcomePage.js';
import ChatEntryPage from './components/ChatEntryPage.js';
import ProfilePreview from './components/ProfilePreview.js';
import { Redirect, useNavigation, resolveLocationRoutes } from './router/index.js';
import type { View } from './router/index.js';
import { useSession } from './context/SessionContext.js';
import { useAppData } from './hooks/useAppData.js';
import {
  DashboardPage,
  SourcesPage,
  ConnectionsPage,
  ConfigurationsPage,
  ConfigurationDetailPage,
  McpListPage,
  McpDetailPage,
  SettingsPage,
  UsersPage,
  MetricsPage,
  TenantsPage,
  KnowledgePage,
} from './pages/index.js';

export default function App() {
  // Session / auth state — owned by SessionProvider (context/SessionContext).
  const {
    authChecked,
    authenticated,
    authRequired,
    needsSetup,
    showOnboarding,
    userAuthenticated,
    currentUser,
    setAuthenticated,
    setAuthRequired,
    setNeedsSetup,
    setShowOnboarding,
    setUserAuthenticated,
    bumpDataVersion,
    logout,
  } = useSession();

  // Special, URL-driven pages (no admin auth needed). Resolved once from the
  // current pathname — see router/locationRoutes.ts.
  const { welcomeMatch, chatMatch, isAccountPage, isUserLoginPage, isUserPage } =
    resolveLocationRoutes();

  // View-based navigation (state owned by the router module).
  const { view, setView } = useNavigation();

  // Shared admin data (connections, configurations, profiles, serve status,
  // audit activity, PII/masking) — owned by hooks/useAppData.
  const {
    connections,
    setConnections,
    connectionSchemas,
    configurations,
    setConfigurations,
    profiles,
    setProfiles,
    activeProfileIndex,
    setActiveProfileIndex,
    activeProfile,
    serveStatus,
    fetchServeStatus,
    recentActivity,
    piiDetections,
    scanning,
    globalMaskingRules,
    selectedTables,
    configWithProfileOptions,
    allProfileNames,
    totalMcpCount,
    activeMcpCount,
    hasActiveMcp,
    totalConnCount,
    connectedCount,
    hasConnections,
    handlePiiOverride,
    handleScanPii,
    handleGlobalMaskingRulesChange,
    handleSchemaLoaded,
    handleProfileCreate,
    handleProfileDelete,
    handleConfigurationSave,
    handleConfigurationDelete,
  } = useAppData(isUserPage);

  // Profile preview modal state
  const [previewProfile, setPreviewProfile] = useState<string | null>(null);

  // --- Auth gates (must be after all hooks) ---
  if (welcomeMatch) {
    return <WelcomePage code={welcomeMatch[1]} />;
  }

  // /chat/:profileName — public-facing chat entry page (handles its own auth)
  if (chatMatch) {
    return <ChatEntryPage profileName={decodeURIComponent(chatMatch[1])} />;
  }

  if (!authChecked) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  // /account — user dashboard (redirect to /login if not authenticated)
  if (isAccountPage) {
    if (userAuthenticated) {
      return (
        <UserDashboard
          onLogout={() => {
            setUserAuthenticated(false);
            window.location.href = '/login';
          }}
        />
      );
    }
    // Not authenticated — redirect to unified login
    return <Redirect to="/login" />;
  }

  // First-run setup
  if (needsSetup) {
    return (
      <SetupPage
        onSetupComplete={() => {
          setNeedsSetup(false);
          setAuthenticated(true);
          setAuthRequired(true);
          setShowOnboarding(true);
        }}
      />
    );
  }

  // Onboarding wizard — shown on empty dashboard or after first account creation
  if (showOnboarding) {
    const dismissOnboarding = () => {
      localStorage.setItem('calame_onboarding_dismissed', '1');
      setShowOnboarding(false);
      bumpDataVersion();
    };
    return <OnboardingWizard onComplete={dismissOnboarding} onSkip={dismissOnboarding} />;
  }

  // /login or unauthenticated admin — unified login page
  if (isUserLoginPage || (authRequired && !authenticated)) {
    // If already authenticated, redirect to the right dashboard
    if (authenticated) {
      return <Redirect to="/" />;
    }
    if (userAuthenticated) {
      return <Redirect to="/account" />;
    }
    return (
      <LoginPage
        onAdminLogin={() => {
          setAuthenticated(true);
          window.location.href = '/';
        }}
        onUserLogin={() => {
          setUserAuthenticated(true);
          window.location.href = '/account';
        }}
      />
    );
  }

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-gray-950 text-gray-100">
      {/* Left sidebar navigation */}
      <Sidebar
        currentPage={view.page}
        onNavigate={(page) => setView({ page } as View)}
        user={currentUser ?? undefined}
        onLogout={logout}
      />

      {/* Main content column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Page content */}
        <main
          className="flex-1 p-6 md:p-8 pt-16 md:pt-8 animate-fade-in-up overflow-x-hidden"
          key={`${view.page}-${activeProfile.name}`}
        >
          <div className="max-w-7xl mx-auto w-full">
            {view.page === 'dashboard' && (
              <DashboardPage
                setView={setView}
                profiles={profiles}
                configurations={configurations}
                connections={connections}
                connectionSchemas={connectionSchemas}
                serveStatus={serveStatus}
                recentActivity={recentActivity}
                activeMcpCount={activeMcpCount}
                totalMcpCount={totalMcpCount}
                hasActiveMcp={hasActiveMcp}
                connectedCount={connectedCount}
                totalConnCount={totalConnCount}
                hasConnections={hasConnections}
              />
            )}

            {/* Unified Sources page */}
            {view.page === 'sources' && (
              <SourcesPage
                view={view}
                setView={setView}
                connections={connections}
                setConnections={setConnections}
                handleSchemaLoaded={handleSchemaLoaded}
              />
            )}

            {/* Legacy alias: 'connections' → sources/databases tab */}
            {view.page === 'connections' && (
              <ConnectionsPage
                view={view}
                setView={setView}
                connections={connections}
                setConnections={setConnections}
                handleSchemaLoaded={handleSchemaLoaded}
              />
            )}

            {view.page === 'configurations' && (
              <ConfigurationsPage
                setView={setView}
                configurations={configurations}
                setConfigurations={setConfigurations}
                handleConfigurationSave={handleConfigurationSave}
                handleConfigurationDelete={handleConfigurationDelete}
              />
            )}

            {view.page === 'config-detail' && (
              <ConfigurationDetailPage
                view={view}
                setView={setView}
                configurations={configurations}
                connections={connections}
                connectionSchemas={connectionSchemas}
                piiDetections={piiDetections}
                scanning={scanning}
                globalMaskingRules={globalMaskingRules}
                handleScanPii={handleScanPii}
                handleConfigurationSave={handleConfigurationSave}
                handleConfigurationDelete={handleConfigurationDelete}
                handleSchemaLoaded={handleSchemaLoaded}
                handlePiiOverride={handlePiiOverride}
                handleGlobalMaskingRulesChange={handleGlobalMaskingRulesChange}
              />
            )}

            {view.page === 'mcp-list' && (
              <McpListPage
                setView={setView}
                configWithProfileOptions={configWithProfileOptions}
                selectedTables={selectedTables}
                profiles={profiles}
                serveStatus={serveStatus}
                fetchServeStatus={fetchServeStatus}
                handleProfileCreate={handleProfileCreate}
                handleProfileDelete={handleProfileDelete}
                setPreviewProfile={setPreviewProfile}
              />
            )}

            {view.page === 'mcp-detail' && (
              <McpDetailPage
                view={view}
                setView={setView}
                profiles={profiles}
                setProfiles={setProfiles}
                serveStatus={serveStatus}
                configWithProfileOptions={configWithProfileOptions}
                configurations={configurations}
                setConfigurations={setConfigurations}
                activeProfileIndex={activeProfileIndex}
                setActiveProfileIndex={setActiveProfileIndex}
                handleProfileDelete={handleProfileDelete}
                handleConfigurationSave={handleConfigurationSave}
              />
            )}

            {view.page === 'settings' && (
              <SettingsPage
                allProfileNames={Array.from(allProfileNames)}
                onNavigateDashboard={() => setView({ page: 'dashboard' })}
                initialTab={view.initialTab}
                backTo={(() => {
                  const bt = view.backTo;
                  if (bt?.page === 'mcp-detail') {
                    return {
                      label:
                        profiles.find((p) => p.name === bt.profileName)?.label ?? bt.profileName,
                      view: bt,
                    };
                  }
                  return undefined;
                })()}
                onNavigate={(v) => setView(v)}
              />
            )}

            {view.page === 'users' && (
              <UsersPage view={view} setView={setView} profiles={profiles} />
            )}

            {view.page === 'metrics' && <MetricsPage setView={setView} />}

            {view.page === 'tenants' && <TenantsPage setView={setView} />}

            {/* Legacy alias: 'knowledge' → sources/knowledge tab */}
            {view.page === 'knowledge' && (
              <KnowledgePage
                setView={setView}
                connections={connections}
                setConnections={setConnections}
                handleSchemaLoaded={handleSchemaLoaded}
              />
            )}
          </div>
        </main>

        {/* Profile preview modal */}
        {previewProfile && (
          <ProfilePreview profileName={previewProfile} onClose={() => setPreviewProfile(null)} />
        )}
      </div>
    </div>
  );
}
