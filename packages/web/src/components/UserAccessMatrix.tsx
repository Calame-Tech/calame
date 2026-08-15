// Access matrix — audit view of who can reach which MCP server. Rows are
// users, columns are servers (profiles), cells are letter badges (R / R+W —
// never color-only) with a `*` marker when the grant is table-restricted.
// Scannability first: mono tabular styling, sticky first column, horizontal
// scroll contained inside the card.

import { useEffect, useState } from 'react';
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

/** Derives the badge for one (user, server) grant. */
export function describeAccess(access: UserProfileAccess): Omit<CellInfo, 'classes'> {
  // allowedTools === null means "all tools the profile exposes" — write
  // included if the profile has it; an explicit list must name `write`.
  const write = access.allowedTools === null || access.allowedTools.includes('write');
  const restricted = access.allowedTables !== null;
  const parts = [
    `${access.accessMode} access`,
    write ? 'write allowed' : 'read-only',
    restricted
      ? `restricted to ${access.allowedTables!.length} table${access.allowedTables!.length !== 1 ? 's' : ''}`
      : 'all tables',
  ];
  return {
    label: write ? 'R+W' : 'R',
    restricted,
    title: parts.join(' · '),
  };
}

function cellInfo(access: UserProfileAccess): CellInfo {
  const base = describeAccess(access);
  return {
    ...base,
    classes:
      base.label === 'R+W'
        ? 'bg-amber-400/10 text-amber-300 ring-1 ring-amber-400/20'
        : 'bg-os-500/10 text-os-300 ring-1 ring-os-500/20',
  };
}

export default function UserAccessMatrix({ profiles }: UserAccessMatrixProps) {
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
      <h2 className="text-sm font-semibold text-gray-100">Access matrix</h2>
      <p className="font-mono-plex text-[11px] text-gray-500 mb-3">
        users &times; MCP servers &middot; R = read &middot; R+W = write allowed &middot; * =
        table-restricted
      </p>

      {loading ? (
        <p className="text-sm text-gray-500 py-6 text-center">Loading users&hellip;</p>
      ) : profiles.length === 0 ? (
        <EmptyState
          title="No MCP servers"
          description="Create a server first — the matrix maps users to servers."
        />
      ) : users.length === 0 ? (
        <EmptyState
          title="No users yet"
          description="Grant a user access to an MCP server to populate the matrix."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 bg-gray-900 text-left font-mono-plex text-[10px] uppercase tracking-widest text-gray-600 font-semibold px-3 py-1.5 border-b border-white/5">
                  User
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
                          title={`${u.name || u.email} has no access to ${p.label || p.name}`}
                        >
                          <span className="text-gray-700" aria-label="No access">
                            &mdash;
                          </span>
                        </td>
                      );
                    }
                    const cell = cellInfo(access);
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
                          {cell.restricted && <span aria-label="Table-restricted">*</span>}
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
