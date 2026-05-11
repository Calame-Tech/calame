import { useState, useEffect, useRef, useCallback } from 'react';
import {
  getCurrentTenant,
  setCurrentTenant,
  getTenantHistory,
  addTenantToHistory,
  TENANT_ID_REGEX,
} from '../lib/api.js';

interface WorkspaceSwitcherProps {
  className?: string;
  /**
   * Optional handler invoked when the admin clicks "Gérer les workspaces"
   * inside the dropdown. When supplied, a link to the tenant administration
   * page is rendered at the bottom of the menu. When omitted, the link is
   * hidden — useful for environments where the management page is not wired
   * (e.g. an embedded preview).
   */
  onManageWorkspaces?: () => void;
}

// Chevron down icon (inline SVG, no external dep)
const IconChevronDown = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
    strokeWidth={2}
    stroke="currentColor"
    className="w-3 h-3"
    aria-hidden="true"
  >
    <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
  </svg>
);

// Check icon
const IconCheck = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
    strokeWidth={2.5}
    stroke="currentColor"
    className="w-3 h-3 flex-shrink-0"
    aria-hidden="true"
  >
    <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
  </svg>
);

// Building/workspace icon
const IconBuildingOffice = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
    strokeWidth={1.5}
    stroke="currentColor"
    className="w-3.5 h-3.5 flex-shrink-0"
    aria-hidden="true"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M3.75 21h16.5M4.5 3h15M5.25 3v18m13.5-18v18M9 6.75h1.5m-1.5 3h1.5m-1.5 3h1.5m3-6H15m-1.5 3H15m-1.5 3H15M9 21v-3.375c0-.621.504-1.125 1.125-1.125h3.75c.621 0 1.125.504 1.125 1.125V21"
    />
  </svg>
);

/**
 * Workspace switcher — lets the admin select which tenant context to operate in.
 *
 * The current tenant is stored in localStorage and forwarded as X-Tenant-Id on
 * every API request via apiFetch (packages/web/src/lib/api.ts).
 *
 * Switching workspace reloads the page so all in-flight data is re-fetched from
 * the new tenant context. This is intentional: there is no "soft switch" because
 * the entire App state (connections, profiles, configurations) is tenant-scoped.
 */
export default function WorkspaceSwitcher({ className, onManageWorkspaces }: WorkspaceSwitcherProps) {
  const [tenant] = useState<string>(() => getCurrentTenant());
  const isNonDefault = tenant !== 'default';
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [newInput, setNewInput] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load tenant history from localStorage on mount.
  useEffect(() => {
    setHistory(getTenantHistory());
  }, []);

  // Close dropdown on Escape key or click-outside.
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [open]);

  // Focus the input when the dropdown opens.
  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  const handleSelect = useCallback((target: string) => {
    setCurrentTenant(target);
    if (target !== 'default') addTenantToHistory(target);
    // Full page reload: re-fetches all tenant-scoped data.
    window.location.reload();
  }, []);

  const handleCreate = () => {
    const trimmed = newInput.trim();
    if (!TENANT_ID_REGEX.test(trimmed)) {
      setInputError(
        'Format invalide — lettres, chiffres, tirets et underscores uniquement (1-64 car.).',
      );
      return;
    }
    setInputError(null);
    setNewInput('');
    handleSelect(trimmed);
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') handleCreate();
  };

  // All known tenants to display: 'default' is always first, then history sorted.
  const allTenants = ['default', ...history.filter((t) => t !== 'default')];

  const toggleLabel = isNonDefault ? tenant : 'default';

  return (
    <div ref={containerRef} className={['relative', className].filter(Boolean).join(' ')}>
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Workspace actuel : ${toggleLabel}. Cliquer pour changer.`}
        className={[
          'w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs transition-colors',
          'focus:outline-none focus:ring-2 focus:ring-os-500/60',
          // Non-default tenant gets a violet accent ring to alert the user.
          isNonDefault
            ? 'bg-violet-500/10 border border-violet-500/30 text-violet-300 hover:bg-violet-500/15'
            : 'bg-white/5 border border-white/10 text-gray-400 hover:bg-white/8 hover:text-gray-300',
        ].join(' ')}
      >
        <span
          className={isNonDefault ? 'text-violet-400' : 'text-gray-500'}
          aria-hidden="true"
        >
          {IconBuildingOffice}
        </span>

        <span className="flex-1 min-w-0 text-left">
          <span className="block truncate font-medium" title={toggleLabel}>
            {toggleLabel}
          </span>
        </span>

        <span
          className={[
            'transition-transform duration-150',
            open ? 'rotate-180' : '',
            isNonDefault ? 'text-violet-400' : 'text-gray-600',
          ].join(' ')}
        >
          {IconChevronDown}
        </span>
      </button>

      {/* Non-default indicator pill */}
      {isNonDefault && (
        <span
          className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-violet-500 border border-gray-950"
          aria-label="Workspace non-default actif"
          title={`Workspace "${tenant}" actif`}
        />
      )}

      {/* Dropdown */}
      {open && (
        <div
          role="dialog"
          aria-label="Sélecteur de workspace"
          className="absolute left-0 top-full mt-1.5 w-56 rounded-xl border border-white/10 bg-gray-900/95 backdrop-blur-xl shadow-xl shadow-black/40 z-50 overflow-hidden"
        >
          {/* Header */}
          <div className="px-3 py-2 border-b border-white/8">
            <p className="font-mono-plex text-[10px] uppercase tracking-widest text-gray-500 select-none">
              Workspace
            </p>
          </div>

          {/* Known workspace list */}
          <ul role="listbox" aria-label="Workspaces disponibles" className="py-1">
            {allTenants.map((t) => {
              const isActive = tenant === t;
              return (
                <li key={t} role="option" aria-selected={isActive}>
                  <button
                    type="button"
                    onClick={() => handleSelect(t)}
                    className={[
                      'w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors',
                      isActive
                        ? 'text-os-300 bg-os-500/10'
                        : 'text-gray-300 hover:bg-white/5 hover:text-gray-100',
                    ].join(' ')}
                  >
                    <span className="flex-1 text-left truncate font-medium">{t}</span>
                    {isActive && (
                      <span className="text-os-400">{IconCheck}</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>

          {/* Separator */}
          <div className="border-t border-white/8 mx-3" />

          {/* New workspace input */}
          <div className="px-3 py-2.5">
            <p className="font-mono-plex text-[10px] uppercase tracking-widest text-gray-600 mb-2 select-none">
              Nouveau workspace
            </p>
            <div className="flex gap-1.5">
              <input
                ref={inputRef}
                type="text"
                value={newInput}
                onChange={(e) => {
                  setNewInput(e.target.value);
                  setInputError(null);
                }}
                onKeyDown={handleInputKeyDown}
                placeholder="mon-workspace"
                maxLength={64}
                aria-label="Nom du nouveau workspace"
                aria-describedby={inputError ? 'ws-input-error' : undefined}
                className={[
                  'flex-1 min-w-0 bg-white/5 border rounded-lg px-2 py-1 text-xs text-gray-200',
                  'placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-os-500/60',
                  inputError ? 'border-red-500/60' : 'border-white/10',
                ].join(' ')}
              />
              <button
                type="button"
                onClick={handleCreate}
                disabled={!newInput.trim()}
                className="px-2.5 py-1 rounded-lg bg-os-500/20 text-os-300 text-xs font-medium hover:bg-os-500/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus:outline-none focus:ring-2 focus:ring-os-500/60"
              >
                OK
              </button>
            </div>
            {inputError && (
              <p id="ws-input-error" role="alert" className="mt-1.5 text-[10px] text-red-400 leading-tight">
                {inputError}
              </p>
            )}
          </div>

          {/* Manage workspaces — admin entry point for the tenant CRUD page */}
          {onManageWorkspaces && (
            <>
              <div className="border-t border-white/8 mx-3" />
              <div className="px-3 py-2">
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onManageWorkspaces();
                  }}
                  className="w-full text-left text-xs text-gray-400 hover:text-gray-100 focus:outline-none focus:text-gray-100"
                >
                  Gérer les workspaces &rarr;
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
