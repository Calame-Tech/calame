/**
 * URL-path route detection for the special, non-`View` pages that are driven by
 * `window.location.pathname` rather than the in-app navigation state: the public
 * chat entry page, the magic-link welcome page, and the end-user `/login` and
 * `/account` pages. Extracted from `App.tsx` (Phase 3 #13) so the location
 * parsing is a pure, testable helper.
 */
export interface LocationRoutes {
  /** Match for `/welcome/:code` (hex code) — magic-link landing, or null. */
  welcomeMatch: RegExpMatchArray | null;
  /** Match for `/chat/:profileName` — public chat entry, or null. */
  chatMatch: RegExpMatchArray | null;
  /** True on the end-user `/account` dashboard. */
  isAccountPage: boolean;
  /** True on the unified `/login` page. */
  isUserLoginPage: boolean;
  /**
   * True when the current path is any non-admin page (login / account /
   * welcome / chat). Admin auth + data loading are skipped for these.
   */
  isUserPage: boolean;
}

/**
 * Resolve the location-driven routes from a pathname. Defaults to the live
 * `window.location.pathname`; an explicit value can be passed for testing.
 */
export function resolveLocationRoutes(pathname: string = window.location.pathname): LocationRoutes {
  const welcomeMatch = pathname.match(/^\/welcome\/([a-f0-9]+)$/);
  const chatMatch = pathname.match(/^\/chat\/(.+)/);
  const isAccountPage = pathname === '/account';
  const isUserLoginPage = pathname === '/login';
  const isUserPage = isUserLoginPage || isAccountPage || !!welcomeMatch || !!chatMatch;
  return { welcomeMatch, chatMatch, isAccountPage, isUserLoginPage, isUserPage };
}
