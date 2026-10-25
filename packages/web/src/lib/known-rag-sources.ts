import { useMemo } from 'react';
import { getCurrentTenant } from './api.js';

/**
 * Last known knowledge-base list (tester feedback #02).
 *
 * Also the single source of truth shared by the Sources page and the
 * data-configuration knowledge tab (tester feedback #12): both views read and
 * refresh this same list instead of each keeping its own copy.
 *
 * The KnowledgeBaseManager kept its list in component state only, so every
 * remount (leaving and re-entering Sources, app restart after an update)
 * started from an empty list behind a "loading" line — during a resync the
 * knowledge bases seemed to vanish until the server answered. The last
 * authoritative list is kept here, in memory, for the lifetime of the app
 * window: the manager shows it with a "syncing" notice and replaces it with
 * the server answer (even an empty one) as soon as it arrives.
 *
 * Lists are keyed by account and workspace (tenant) and wiped entirely when
 * the admin session ends (see SessionProvider), so nothing from one account
 * is ever shown to another.
 */

/** Cache handed to the EE KnowledgeBaseManager (`sourcesCache` prop). */
export interface KnownListCache<T> {
  /** Account + workspace the list belongs to — key views on it so a switch remounts them. */
  readonly scope: string;
  get(): T[] | undefined;
  set(list: T[]): void;
}

const lists = new Map<string, unknown[]>();

/** The cache of the knowledge-base list for an account (admin email, '' when auth is off) in a workspace. */
export function knownRagSourcesCache<T>(account: string, tenant: string): KnownListCache<T> {
  const key = JSON.stringify([account, tenant]);
  return {
    scope: key,
    get: () => lists.get(key) as T[] | undefined,
    set: (list) => {
      lists.set(key, [...list]);
    },
  };
}

/** The known list of the signed-in account in the current workspace. */
export function useKnownRagSourcesCache<T>(account: string): KnownListCache<T> {
  const tenant = getCurrentTenant();
  return useMemo(() => knownRagSourcesCache<T>(account, tenant), [account, tenant]);
}

/** Discards every known list — called when the admin session ends. */
export function clearKnownRagSources(): void {
  lists.clear();
}
