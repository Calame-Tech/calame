import { useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { View } from './view.js';
import { parseHash, serializeView } from './urlSync.js';

/** Return shape of {@link useNavigation}. */
export interface Navigation {
  /** The current in-app view. */
  view: View;
  /** Replace the current view (the navigation state setter). */
  setView: Dispatch<SetStateAction<View>>;
}

/**
 * Owns the in-app navigation state, synced with `window.location.hash` so
 * deep links, the browser Back/Forward buttons, and manual refresh all work
 * for the admin views. Extracted from `App.tsx` (Phase 3 #13); URL sync
 * added on top without changing the public `{ view, setView }` shape.
 *
 * Admin views are hash-routed (`#/mcp/foo`) — this never touches
 * `window.location.pathname`, which is reserved for the special
 * `/welcome/:code`, `/chat/:name`, `/login` and `/account` pages (see
 * `router/locationRoutes.ts`).
 */
export function useNavigation(initial: View = { page: 'dashboard' }): Navigation {
  const [view, setView] = useState<View>(() => {
    const hash = window.location.hash;
    return hash ? parseHash(hash) : initial;
  });

  // Latest view, readable from the hashchange listener below without
  // re-registering it (and without closing over a stale value) every time
  // the view changes.
  const viewRef = useRef(view);
  viewRef.current = view;

  // Push the current view into the URL hash whenever it changes. Skipped
  // when the serialized hash is unchanged (e.g. only the ephemeral `backTo`
  // field differs) so we don't pile up duplicate history entries.
  useEffect(() => {
    const nextHash = `#${serializeView(view)}`;
    if (window.location.hash !== nextHash) {
      window.location.hash = serializeView(view);
    }
  }, [view]);

  // React to Back/Forward navigation, manual address-bar edits, and links —
  // anything that changes location.hash other than our own effect above.
  useEffect(() => {
    function onHashChange(): void {
      const currentHash = window.location.hash;
      // Anti-loop guard: if the hash already matches what the view we hold
      // would serialize to, this event was caused by our own write (or is a
      // no-op change) — nothing new to apply.
      if (currentHash === `#${serializeView(viewRef.current)}`) return;
      setView(parseHash(currentHash));
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return { view, setView };
}
