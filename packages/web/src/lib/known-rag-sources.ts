/**
 * Last known knowledge-base list (tester feedback #02).
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
  get(): T[] | undefined;
  set(list: T[]): void;
}

const lists = new Map<string, unknown[]>();

/** The cache of the knowledge-base list for an account (admin email, '' when auth is off) in a workspace. */
export function knownRagSourcesCache<T>(account: string, tenant: string): KnownListCache<T> {
  const key = JSON.stringify([account, tenant]);
  return {
    get: () => lists.get(key) as T[] | undefined,
    set: (list) => {
      lists.set(key, [...list]);
    },
  };
}

/** Discards every known list — called when the admin session ends. */
export function clearKnownRagSources(): void {
  lists.clear();
}
