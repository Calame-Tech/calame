import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { View } from './view.js';

/** Return shape of {@link useNavigation}. */
export interface Navigation {
  /** The current in-app view. */
  view: View;
  /** Replace the current view (the navigation state setter). */
  setView: Dispatch<SetStateAction<View>>;
}

/**
 * Owns the in-app navigation state. A thin wrapper over `useState<View>` so the
 * navigation slot lives in the router module rather than inside `App`. Extracted
 * from `App.tsx` (Phase 3 #13).
 */
export function useNavigation(initial: View = { page: 'dashboard' }): Navigation {
  const [view, setView] = useState<View>(initial);
  return { view, setView };
}
