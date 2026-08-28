// Settings page (Phase 3 #14). The SettingsPage component, its tab model and
// the lazy OidcSettings import were moved verbatim from App.tsx.

import { useState, lazy, Suspense } from 'react';
import { useTranslations } from 'use-intl/react';
import { Card, PageHeader } from '../components/ui/index.js';
import AiSettings from '../components/AiSettings.js';
import SmtpSettings from '../components/SmtpSettings.js';
import BrandingSettings from '../components/BrandingSettings.js';
import NotificationSettings from '../components/NotificationSettings.js';
import LanguageSettings from '../components/LanguageSettings.js';
import type { View } from '../router/index.js';

/**
 * Lazy-loaded SSO components from the ee package. Deferred so the main Apache
 * bundle never statically imports the BUSL chunk — the SSO module is only
 * fetched at runtime when the relevant UI section is rendered.
 */
const OidcSettings = lazy(() =>
  import('@calame-ee/sso/web')
    .then((m) => ({ default: m.OidcSettings }))
    .catch(() => ({
      default: function OidcSettingsUnavailable() {
        const t = useTranslations('settings.sso');
        return <div className="p-6 text-sm text-gray-400 text-center">{t('unavailable')}</div>;
      },
    })),
);

// ---------------------------------------------------------------------------
// SettingsPage — tabbed layout wrapping AiSettings / SmtpSettings / OidcSettings
// ---------------------------------------------------------------------------

type SettingsTab = 'ai' | 'email' | 'sso' | 'branding' | 'notifications' | 'language';

const SETTINGS_TAB_IDS: SettingsTab[] = [
  'ai',
  'email',
  'sso',
  'branding',
  'notifications',
  'language',
];

interface SettingsPageProps {
  allProfileNames: string[];
  onNavigateDashboard: () => void;
  initialTab?: SettingsTab;
  /** Optional intermediate breadcrumb crumb — used when the page is opened from an MCP detail. */
  backTo?: { label: string; view: View };
  onNavigate?: (view: View) => void;
}

export default function SettingsPage({
  allProfileNames,
  onNavigateDashboard,
  initialTab,
  backTo,
  onNavigate,
}: SettingsPageProps) {
  const t = useTranslations('settings');
  const tCommon = useTranslations('common');
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab ?? 'ai');

  const breadcrumb: { label: string; onClick?: () => void }[] = [
    { label: tCommon('dashboard'), onClick: onNavigateDashboard },
  ];
  if (backTo && onNavigate) {
    breadcrumb.push({ label: backTo.label, onClick: () => onNavigate(backTo.view) });
  }
  breadcrumb.push({ label: t('title') });

  const loadingFallback = <div className="p-6 text-sm text-gray-500 italic">{tCommon('loading')}</div>;

  return (
    <div className="space-y-4">
      <PageHeader breadcrumb={breadcrumb} title={t('title')} description={t('description')} />

      {/* Mobile: horizontal scrollable tab bar */}
      <div className="flex gap-1 overflow-x-auto md:hidden border-b border-gray-800/60 pb-0">
        {SETTINGS_TAB_IDS.map((tab) => {
          const isActive = activeTab === tab;
          return (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              aria-current={isActive ? 'page' : undefined}
              className={[
                'flex-shrink-0 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap',
                isActive
                  ? 'border-os-400 text-gray-100'
                  : 'border-transparent text-gray-400 hover:text-gray-200 hover:border-gray-600',
              ].join(' ')}
            >
              {t(`tabs.${tab}.label`)}
            </button>
          );
        })}
      </div>

      {/* Desktop: sidebar nav + content */}
      <div className="hidden md:grid md:grid-cols-[220px_1fr] md:gap-4">
        {/* Left tab nav */}
        <nav aria-label={t('navAriaLabel')} className="flex flex-col gap-1">
          {SETTINGS_TAB_IDS.map((tab) => {
            const isActive = activeTab === tab;
            return (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                aria-current={isActive ? 'page' : undefined}
                className={[
                  'relative flex flex-col items-start w-full px-3 py-2.5 rounded-lg text-sm text-left transition-colors focus:outline-none focus:ring-2 focus:ring-os-400',
                  isActive
                    ? 'bg-gray-800/70 text-gray-100'
                    : 'text-gray-400 hover:bg-gray-800/40 hover:text-gray-200',
                ].join(' ')}
              >
                {/* Blue left indicator for active tab */}
                {isActive && (
                  <span
                    aria-hidden="true"
                    className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-os-400"
                  />
                )}
                <span className={isActive ? 'pl-2' : undefined}>{t(`tabs.${tab}.label`)}</span>
                <span
                  className={[
                    'text-xs mt-0.5 hidden md:block',
                    isActive ? 'text-gray-400 pl-2' : 'text-gray-500',
                  ].join(' ')}
                >
                  {t(`tabs.${tab}.description`)}
                </span>
              </button>
            );
          })}
        </nav>

        {/* Right content pane — desktop only */}
        <Card padded={true} key={activeTab} className="animate-fade-in-up">
          {activeTab === 'ai' && <AiSettings />}
          {activeTab === 'email' && <SmtpSettings />}
          {activeTab === 'sso' && (
            <Suspense fallback={loadingFallback}>
              <OidcSettings availableProfiles={[...allProfileNames]} />
            </Suspense>
          )}
          {activeTab === 'branding' && <BrandingSettings />}
          {activeTab === 'notifications' && <NotificationSettings />}
          {activeTab === 'language' && <LanguageSettings />}
        </Card>
      </div>

      {/* Mobile content pane */}
      <Card padded={true} key={`mobile-${activeTab}`} className="animate-fade-in-up md:hidden">
        {activeTab === 'ai' && <AiSettings />}
        {activeTab === 'email' && <SmtpSettings />}
        {activeTab === 'sso' && (
          <Suspense fallback={loadingFallback}>
            <OidcSettings availableProfiles={[...allProfileNames]} />
          </Suspense>
        )}
        {activeTab === 'branding' && <BrandingSettings />}
        {activeTab === 'notifications' && <NotificationSettings />}
        {activeTab === 'language' && <LanguageSettings />}
      </Card>
    </div>
  );
}
