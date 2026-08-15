// Detail chip for the Data Configurations graph (top-right panel). Shows the
// focused/pinned node's facts; for a pinned MCP server it additionally lists
// the users granted access (fetched lazily by ConfigGraphView and passed in).

import type { UserEntry } from '../types/schema.js';

export interface ChipRow {
  k: string;
  v: string;
  tone?: 'pii' | 'ok';
}

export interface ChipData {
  kind: string;
  title: string;
  rows: ChipRow[];
}

interface GraphDetailChipProps {
  chip?: ChipData;
  /** Shift down when the "Reset layout" button occupies the top-right slot. */
  offsetForReset: boolean;
  /** 'loading' while the fetch is in flight; undefined hides the section. */
  users?: UserEntry[] | 'loading';
  /** Profile name of the pinned server — used to pick each user's accessMode. */
  profileName?: string;
}

const MAX_USERS = 5;

export default function GraphDetailChip({
  chip,
  offsetForReset,
  users,
  profileName,
}: GraphDetailChipProps) {
  return (
    <aside
      aria-live="polite"
      className={`absolute ${offsetForReset ? 'top-14' : 'top-3'} right-3 w-[270px] card-primary rounded-xl p-4 transition-all duration-200 ${
        chip ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-2 pointer-events-none'
      } motion-reduce:transition-none`}
    >
      {chip && (
        <>
          <div className="font-mono-plex text-[10px] uppercase tracking-[0.2em] text-gray-600">
            {chip.kind}
          </div>
          <h2 className="font-display text-xl text-gray-100 mt-0.5 mb-2">{chip.title}</h2>
          {chip.rows.map((row) => (
            <div
              key={row.k}
              className="flex justify-between gap-3 py-1.5 border-t border-white/5 text-xs"
            >
              <span className="text-gray-500">{row.k}</span>
              <span
                className={`font-mono-plex text-right ${
                  row.tone === 'pii'
                    ? 'text-purple-400'
                    : row.tone === 'ok'
                      ? 'text-emerald-400'
                      : 'text-gray-300'
                }`}
              >
                {row.v}
              </span>
            </div>
          ))}

          {users !== undefined && (
            <div className="pt-1.5 border-t border-white/5 mt-1.5">
              <div className="font-mono-plex text-[10px] uppercase tracking-[0.2em] text-gray-600 mb-1">
                Users
              </div>
              {users === 'loading' ? (
                <p className="text-xs text-gray-600">Loading&hellip;</p>
              ) : users.length === 0 ? (
                <p className="text-xs text-gray-600 italic">No users granted</p>
              ) : (
                <>
                  {users.slice(0, MAX_USERS).map((u) => {
                    const accessMode =
                      u.profiles.find((p) => p.profileName === profileName)?.accessMode ?? 'both';
                    return (
                      <div
                        key={u.id}
                        className="flex items-center justify-between gap-2 py-0.5 text-xs"
                      >
                        <span className="text-gray-300 truncate">{u.name || u.email}</span>
                        <span className="font-mono-plex text-[9px] uppercase px-1.5 py-0.5 rounded bg-white/5 text-gray-400 flex-shrink-0">
                          {accessMode}
                        </span>
                      </div>
                    );
                  })}
                  {users.length > MAX_USERS && (
                    <p className="text-[11px] text-gray-600 mt-0.5">
                      +{users.length - MAX_USERS} more
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
    </aside>
  );
}
