// Access matrix — audit view of who can reach which MCP server. Rows are
// users, columns are servers (profiles), cells are letter badges (R / R+W —
// never color-only) with a `*` marker when the grant is table-restricted.
// Scannability first: mono tabular styling, sticky first column, horizontal
// scroll contained inside the card.

import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl/react';
import { apiFetch } from '../lib/api.js';
import { EmptyState } from './ui/index.js';
import type { Profile, UserEntry, UserProfileAccess } from '../types/schema.js';

interface UserAccessMatrixProps {
  profiles: Profile[];
}

interface CellInfo {
  label: string;
  restricted: boolean;
  title: string;
  classes: string;
}

/** Translator shape accepted by {@link describeAccess} — matches the subset of
 * `useTranslations('users')` scoped to `accessMatrix` that it needs. Defaults
 * to the plain English fallback below so the function stays callable (and
 * unit-testable) outside of an I18nProvider. */
type AccessMatrixTranslator = (
  key: string,
  values?: Record<string, string | number | Date>,
) => string;

const MODE_LABEL_FALLBACK: Record<string, string> = { mcp: 'MCP', chat: 'Chat', both: 'MCP+Chat' };

const englishAccessMatrixFallback: AccessMatrixTranslator = (key, values) => {
  if (key.startsWith('modeLabel.')) {
    return MODE_LABEL_FALLBACK[key.slice('modeLabel.'.length)] ?? key;
  }
  switch (key) {
    case 'modeAccess':
      return `${values?.mode} access`;
    case 'writeAllowed':
      return 'write allowed';
    case 'readOnly':
      return 'read-only';
    case 'restrictedToTables': {
      const count = values?.count as number;
      return `restricted to ${count} table${count !== 1 ? 's' : ''}`;
    }
    case 'allTables':
      return 'all tables';
    default:
      return key;
  }
};

/** Derives the badge for one (user, server) grant. */
export function describeAccess(
  access: UserProfileAccess,
  t: AccessMatrixTranslator = englishAccessMatrixFallback,
): Omit<CellInfo, 'classes'> {
  // allowedTools === null means "all tools the profile exposes" — write
  // included if the profile has it; an explicit list must name `write`.
  const write = access.allowedTools === null || access.allowedTools.includes('write');
  const restricted = access.allowedTables !== null;
  const parts = [
    t('modeAccess', { mode: t(`modeLabel.${access.accessMode}`) }),
    write ? t('writeAllowed') : t('readOnly'),
    restricted
      ? t('restrictedToTables', { count: access.allowedTables!.length })
      : t('allTables'),
  ];
  return {
    label: write ? 'R+W' : 'R',
    restricted,
    title: parts.join(' · '),
  };
}

function cellInfo(access: UserProfileAccess, t: AccessMatrixTranslator): CellInfo {
  const base = describeAccess(access, t);
  return {
    ...base,
    classes:
      base.label === 'R+W'
        ? 'bg-amber-400/10 text-amber-300 ring-1 ring-amber-400/20'
        : 'bg-os-500/10 text-os-300 ring-1 ring-os-500/20',
  };
}

export default function UserAccessMatrix({ profiles }: UserAccessMatrixProps) {
  const t = useTranslations('users');
  const tAccessMatrix: AccessMatrixTranslator = (key, values) =>
    t(`accessMatrix.${key}`, values);
  const [users, setUsers] = useState<UserEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/users', { credentials: 'include' });
        const data = await res.json();
        if (!cancelled && data.success && Array.isArray(data.users)) {
          setUsers(data.users as UserEntry[]);
        }
      } catch {
        // Endpoint unavailable — the empty state covers it.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="card-primary p-4">
      <h2 className="text-sm font-semibold text-gray-100">{t('accessMatrix.heading')}</h2>
      <p className="font-mono-plex text-[11px] text-gray-500 mb-3">{t('accessMatrix.legend')}</p>

      {loading ? (
        <p className="text-sm text-gray-500 py-6 text-center">{t('accessMatrix.loading')}</p>
      ) : profiles.length === 0 ? (
        <EmptyState
          title={t('accessMatrix.emptyNoServers.title')}
          description={t('accessMatrix.emptyNoServers.description')}
        />
      ) : users.length === 0 ? (
        <EmptyState
          title={t('accessMatrix.emptyNoUsers.title')}
          description={t('accessMatrix.emptyNoUsers.description')}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 bg-gray-900 text-left font-mono-plex text-[10px] uppercase tracking-widest text-gray-600 font-semibold px-3 py-1.5 border-b border-white/5">
                  {t('accessMatrix.colUser')}
                </th>
                {profiles.map((p) => (
                  <th
                    key={p.name}
                    className="text-left font-mono-plex text-[10px] uppercase tracking-widest text-gray-600 font-semibold px-3 py-1.5 border-b border-white/5 whitespace-nowrap"
                  >
                    {p.label || p.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="group hover:bg-white/[0.025]">
                  <td className="sticky left-0 z-10 bg-gray-900 group-hover:bg-gray-800 px-3 py-2 border-b border-white/[0.035] whitespace-nowrap transition-colors duration-150">
                    <div className="text-gray-200">{u.name || u.email}</div>
                    {u.name && (
                      <div className="font-mono-plex text-[11px] text-gray-500">{u.email}</div>
                    )}
                  </td>
                  {profiles.map((p) => {
                    const access = u.profiles.find((pp) => pp.profileName === p.name);
                    if (!access) {
                      return (
                        <td
                          key={p.name}
                          className="px-3 py-2 border-b border-white/[0.035]"
                          title={t('accessMatrix.noAccessTooltip', {
                            user: u.name || u.email,
                            server: p.label || p.name,
                          })}
                        >
                          <span className="text-gray-700" aria-label={t('accessMatrix.ariaNoAccess')}>
                            &mdash;
                          </span>
                        </td>
                      );
                    }
                    const cell = cellInfo(access, tAccessMatrix);
                    return (
                      <td
                        key={p.name}
                        className="px-3 py-2 border-b border-white/[0.035]"
                        title={cell.title}
                      >
                        <span
                          className={`inline-flex items-center gap-0.5 font-mono-plex text-[10px] font-semibold tracking-wider px-2 py-0.5 rounded-full ${cell.classes}`}
                        >
                          {cell.label}
                          {cell.restricted && (
                            <span aria-label={t('accessMatrix.ariaTableRestricted')}>*</span>
                          )}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
