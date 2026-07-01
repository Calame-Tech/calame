import { useEffect } from 'react';

/**
 * Navigate to another URL via a useEffect so the redirect is a post-mount side
 * effect rather than an impure render. Returns null so the current route renders
 * nothing while the browser transitions away. Extracted from `App.tsx`
 * (Phase 3 #13).
 */
export function Redirect({ to }: { to: string }): null {
  useEffect(() => {
    window.location.href = to;
  }, [to]);
  return null;
}
