import React, { useState, useEffect } from 'react';
import { Button } from './ui/index.js';
import WorkspaceSwitcher from './WorkspaceSwitcher.js';

type NavigablePage =
  | 'dashboard'
  | 'mcp-list'
  | 'configurations'
  | 'sources'
  | 'connections'
  | 'users'
  | 'metrics'
  | 'settings'
  | 'knowledge'
  | 'tenants';

interface SidebarUser {
  email?: string;
  role?: string;
}

interface SidebarProps {
  currentPage: string;
  onNavigate: (page: NavigablePage) => void;
  user?: SidebarUser;
  onLogout?: () => void;
}

interface NavItem {
  page: NavigablePage;
  label: string;
  // activeWhen covers additional page names that should highlight this item
  activeWhen?: string[];
  icon: React.ReactNode;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

// Heroicons-style outline SVGs (24×24, stroke-width=1.5, stroke=currentColor)
const IconHome = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
    strokeWidth={1.5}
    stroke="currentColor"
    className="w-4 h-4"
    aria-hidden="true"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="m2.25 12 8.954-8.955a1.126 1.126 0 0 1 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25"
    />
  </svg>
);

const IconServerStack = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
    strokeWidth={1.5}
    stroke="currentColor"
    className="w-4 h-4"
    aria-hidden="true"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M5.25 14.25h13.5m-13.5 0a3 3 0 0 1-3-3m3 3a3 3 0 1 0 0 6h13.5a3 3 0 1 0 0-6m-16.5-3a3 3 0 0 1 3-3h13.5a3 3 0 0 1 3 3m-19.5 0a3 3 0 0 0 3 3m16.5-3a3 3 0 0 1-3 3m0 0h.008v.008H18v-.008Zm-13.5 0h.008v.008H4.5v-.008Zm13.5-6h.008v.008H18v-.008Zm-13.5 0h.008v.008H4.5v-.008Z"
    />
  </svg>
);

const IconRectangleStack = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
    strokeWidth={1.5}
    stroke="currentColor"
    className="w-4 h-4"
    aria-hidden="true"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M6 6.878V6a2.25 2.25 0 0 1 2.25-2.25h7.5A2.25 2.25 0 0 1 18 6v.878m-12 0c.235-.083.487-.128.75-.128h10.5c.263 0 .515.045.75.128m-12 0A2.25 2.25 0 0 0 4.5 9v.878m13.5-3A2.25 2.25 0 0 1 19.5 9v.878m0 0a2.246 2.246 0 0 0-.75-.128H5.25c-.263 0-.515.045-.75.128m15 0A2.25 2.25 0 0 1 21 12v6a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 18v-6c0-.98.626-1.813 1.5-2.122"
    />
  </svg>
);

const IconCircleStack = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
    strokeWidth={1.5}
    stroke="currentColor"
    className="w-4 h-4"
    aria-hidden="true"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125"
    />
  </svg>
);

const IconUsers = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
    strokeWidth={1.5}
    stroke="currentColor"
    className="w-4 h-4"
    aria-hidden="true"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z"
    />
  </svg>
);

const IconChartBar = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
    strokeWidth={1.5}
    stroke="currentColor"
    className="w-4 h-4"
    aria-hidden="true"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z"
    />
  </svg>
);

// Building icon — workspaces / tenants
const IconBuildingOffice = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
    strokeWidth={1.5}
    stroke="currentColor"
    className="w-4 h-4"
    aria-hidden="true"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M3.75 21h16.5M4.5 3h15M5.25 3v18m13.5-18v18M9 6.75h1.5m-1.5 3h1.5m-1.5 3h1.5m3-6H15m-1.5 3H15m-1.5 3H15M9 21v-3.375c0-.621.504-1.125 1.125-1.125h3.75c.621 0 1.125.504 1.125 1.125V21"
    />
  </svg>
);

const IconCog = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
    strokeWidth={1.5}
    stroke="currentColor"
    className="w-4 h-4"
    aria-hidden="true"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z"
    />
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
  </svg>
);

// Chevron right — indicates the currently active nav item
const IconChevronRight = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
    strokeWidth={2}
    stroke="currentColor"
    className="w-4 h-4 ml-auto text-gray-500"
    aria-hidden="true"
  >
    <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
  </svg>
);

// Logout icon (arrow right out of a rectangle)
const IconLogout = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
    strokeWidth={1.5}
    stroke="currentColor"
    className="w-4 h-4"
    aria-hidden="true"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3 0 3-3m0 0-3-3m3 3H9"
    />
  </svg>
);

const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Workspace',
    items: [
      { page: 'dashboard', label: 'Dashboard', icon: IconHome },
      {
        page: 'mcp-list',
        label: 'MCP Servers',
        activeWhen: ['mcp-detail'],
        icon: IconServerStack,
      },
      {
        page: 'configurations',
        label: 'Data Profiles',
        activeWhen: ['config-detail'],
        icon: IconRectangleStack,
      },
      {
        page: 'sources',
        label: 'Sources',
        // Highlight this entry when on the legacy 'connections' or 'knowledge' pages too
        activeWhen: ['connections', 'knowledge'],
        icon: IconCircleStack,
      },
    ],
  },
  {
    label: 'Admin',
    items: [
      { page: 'users', label: 'Users', icon: IconUsers },
      { page: 'tenants', label: 'Workspaces', icon: IconBuildingOffice },
      { page: 'metrics', label: 'Metrics', icon: IconChartBar },
      { page: 'settings', label: 'Settings', icon: IconCog },
    ],
  },
];

/** Derive initials from an email address or display name */
function getInitials(email?: string): string {
  if (!email) return 'A';
  // If it looks like an email, use first letter of local part + first letter of domain
  const atIndex = email.indexOf('@');
  if (atIndex > 0) {
    return email.slice(0, 1).toUpperCase();
  }
  // Otherwise treat as display name: take up to two words
  const parts = email.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export default function Sidebar({ currentPage, onNavigate, user, onLogout }: SidebarProps) {
  const [isOpen, setIsOpen] = useState(false);

  // Lock body scroll when the mobile drawer is open
  useEffect(() => {
    document.body.style.overflow = isOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  const handleNavigate = (page: NavigablePage) => {
    onNavigate(page);
    setIsOpen(false);
  };

  const displayEmail = user?.email ?? 'Admin';
  const displayRole = user?.role ?? 'Administrator';
  const initials = getInitials(user?.email);

  return (
    <>
      {/* Burger button — mobile only, floats over page content */}
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-label="Toggle navigation menu"
        aria-expanded={isOpen}
        className="fixed top-4 left-4 z-50 md:hidden p-2 rounded-lg bg-gray-900/80 backdrop-blur-sm border border-gray-800/80 text-gray-300 hover:text-gray-100 focus:outline-none focus:ring-2 focus:ring-orange-500"
      >
        {isOpen ? (
          // Close (X) icon
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
            className="w-6 h-6"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
          </svg>
        ) : (
          // Burger (3 lines) icon
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
            className="w-6 h-6"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
            />
          </svg>
        )}
      </button>

      {/* Backdrop — mobile only, shown when drawer is open */}
      {isOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm md:hidden"
          onClick={() => setIsOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Navigation drawer */}
      <nav
        aria-label="Main navigation"
        className={[
          // Base styles shared by mobile and desktop
          'bg-gray-950/60 backdrop-blur-xl flex flex-col overflow-y-auto',
          // Mobile: fixed slide-in drawer from the left
          'fixed inset-y-0 left-0 z-40 w-64',
          'transform transition-transform duration-300 ease-in-out',
          isOpen ? 'translate-x-0' : '-translate-x-full',
          // Desktop: sticky sidebar pinned to viewport height so the user footer stays visible on long pages
          'md:sticky md:top-0 md:h-screen md:translate-x-0 md:w-56 md:shrink-0 md:z-auto',
          'md:border-r md:border-white/5',
        ].join(' ')}
      >
        {/* Branding block */}
        <div className="flex flex-col px-3 py-4 hairline-b shrink-0">
          <div className="flex items-center gap-2.5">
            <img src="/logo.png" alt="Calame" className="h-8 w-8 object-contain" />
            <div>
              <p className="text-base font-bold tracking-tight text-gray-100 leading-tight">
                Calame
              </p>
              <p className="font-mono-plex text-[10px] uppercase tracking-widest text-gray-500 leading-tight">
                MCP proxy
              </p>
            </div>
          </div>

          {/* Workspace switcher — always visible, subtle when on 'default'.
              We pass `onManageWorkspaces` so the dropdown surfaces a link to
              the tenant CRUD page; the Sidebar already knows how to navigate. */}
          <WorkspaceSwitcher className="mt-3" onManageWorkspaces={() => onNavigate('tenants')} />
        </div>

        {/* Navigation sections — flex-1 so user footer is pushed to the bottom */}
        <div className="flex-1 flex flex-col mt-3 overflow-y-auto">
          {NAV_SECTIONS.map((section, sectionIndex) => (
            <div
              key={section.label}
              className={['flex flex-col w-full', sectionIndex > 0 ? 'mt-4' : ''].join(' ')}
            >
              {/* Section label — eyebrow style */}
              <p className="px-3 py-1.5 font-mono-plex text-[10px] uppercase tracking-[0.25em] text-gray-500 select-none">
                {section.label}
              </p>

              <ul className="flex flex-col w-full px-2" role="list">
                {section.items.map(({ page, label, activeWhen, icon }) => {
                  const isActive =
                    currentPage === page || (activeWhen?.includes(currentPage) ?? false);

                  return (
                    <li key={page} className="w-full flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => handleNavigate(page)}
                        aria-current={isActive ? 'page' : undefined}
                        className={[
                          // Base layout & typography
                          'w-full flex items-center gap-2.5 px-2.5 py-2 text-sm transition-colors rounded-lg',
                          'whitespace-nowrap',
                          // Active vs inactive appearance
                          isActive
                            ? 'bg-os-500/15 text-os-300 ring-1 ring-os-500/30'
                            : 'text-gray-400 hover:bg-white/5 hover:text-gray-200',
                        ].join(' ')}
                      >
                        {/* Icon: accent color when active, muted gray otherwise */}
                        <span className={isActive ? 'text-os-400' : 'text-gray-500'}>{icon}</span>
                        <span>{label}</span>
                        {/* Chevron indicates the active item */}
                        {isActive && IconChevronRight}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>

        {/* User footer — only rendered when logout is available or user info exists */}
        {(onLogout !== undefined || user !== undefined) && (
          <div className="mt-auto hairline px-2.5 py-2.5 shrink-0">
            <div className="flex items-center gap-2.5 min-w-0">
              {/* Avatar with initials */}
              <div
                className="flex-shrink-0 w-8 h-8 rounded-full bg-os-500 text-white flex items-center justify-center text-xs font-semibold select-none"
                aria-hidden="true"
              >
                {initials}
              </div>

              {/* User info */}
              <div className="flex-1 min-w-0">
                <p className="text-xs text-gray-200 truncate" title={displayEmail}>
                  {displayEmail}
                </p>
                <p className="font-mono-plex text-[10px] text-gray-500">{displayRole}</p>
              </div>

              {/* Logout button */}
              {onLogout !== undefined && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onLogout}
                  aria-label="Log out"
                  className="flex-shrink-0 p-1 text-gray-400 hover:text-gray-100"
                  title="Log out"
                >
                  {IconLogout}
                </Button>
              )}
            </div>
          </div>
        )}
      </nav>
    </>
  );
}
