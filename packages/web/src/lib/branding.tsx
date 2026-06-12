import { createContext, useContext, useEffect, useState, useCallback, useRef, type ReactNode } from 'react';
import { apiFetch } from './api.js';

/** Default Calame logo served from the web public dir. */
export const DEFAULT_LOGO_SRC = '/logo.png';

export interface Branding {
  /** Custom logo as a base64 data URL, or null when using the default. */
  logo: string | null;
  /** Custom favicon as a base64 data URL, or null. */
  favicon: string | null;
  updatedAt: string | null;
}

const EMPTY_BRANDING: Branding = {
  logo: null,
  favicon: null,
  updatedAt: null,
};

const BrandingContext = createContext<Branding>(EMPTY_BRANDING);

/** Returns true when any custom branding has been configured. */
export function useBranding(): Branding {
  return useContext(BrandingContext);
}

export function BrandingProvider({ children }: { children: ReactNode }) {
  const [branding, setBranding] = useState<Branding>(EMPTY_BRANDING);

  const loadBranding = useCallback(async () => {
    try {
      const res = await apiFetch('/api/branding');
      if (res.ok) {
        const data = await res.json();
        setBranding({
          logo: data.logo ?? null,
          favicon: data.favicon ?? null,
          updatedAt: data.updatedAt ?? null,
        });
      }
    } catch {
      // Use defaults — no branding configured.
    }
  }, []);

  useEffect(() => {
    loadBranding();
  }, [loadBranding]);

  // Apply the custom favicon to the document <head>. The original href (set in
  // index.html) is captured once so clearing the custom favicon restores it
  // rather than pointing at a hardcoded — possibly missing — path.
  const defaultFaviconRef = useRef<string | null>(null);
  useEffect(() => {
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    if (defaultFaviconRef.current === null) {
      defaultFaviconRef.current = link.getAttribute('href') ?? DEFAULT_LOGO_SRC;
    }
    link.href = branding.favicon ?? defaultFaviconRef.current;
  }, [branding.favicon]);

  // Re-fetch on focus (after returning from login/settings)
  useEffect(() => {
    const handler = () => loadBranding();
    window.addEventListener('focus', handler);
    return () => window.removeEventListener('focus', handler);
  }, [loadBranding]);

  return (
    <BrandingContext.Provider value={branding}>
      {children}
    </BrandingContext.Provider>
  );
}
