// Router module (Phase 3 #13): the in-app navigation state machine extracted
// from the App god-component — the `View` model, the location-driven route
// detection, the `Redirect` primitive, and the navigation-state hook.

export type { View, Page } from './view.js';
export { resolveLocationRoutes } from './locationRoutes.js';
export type { LocationRoutes } from './locationRoutes.js';
export { Redirect } from './Redirect.js';
export { useNavigation } from './useNavigation.js';
export type { Navigation } from './useNavigation.js';
