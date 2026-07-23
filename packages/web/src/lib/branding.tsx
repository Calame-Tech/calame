import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from 'react';
import { apiFetch } from './api.js';

/** Default Calame logo served from the web public dir. */
export const DEFAULT_LOGO_SRC = '/logo.png';

/** Base font choices offered in the branding settings UI. */
export const BASE_FONT_OPTIONS = [
  "'IBM Plex Sans', system-ui, sans-serif",
  "'Inter', system-ui, sans-serif",
  "'Roboto', system-ui, sans-serif",
  "'Georgia', serif",
  'system-ui, sans-serif',
] as const;

export interface Branding {
  /** Custom logo as a base64 data URL, or null when using the default. */
  logo: string | null;
  /** Custom favicon as a base64 data URL, or null. */
  favicon: string | null;
  /** Accent color as a hex string (e.g. `#5c7cfa`), or null for the default. */
  accentColor: string | null;
  /** CSS font-family value (name + optional fallbacks), or null for the default. */
  fontFamily: string | null;
  updatedAt: string | null;
}

const EMPTY_BRANDING: Branding = {
  logo: null,
  favicon: null,
  accentColor: null,
  fontFamily: null,
  updatedAt: null,
};

const BrandingContext = createContext<Branding>(EMPTY_BRANDING);

/** The `os` color scale's shade keys, used both as CSS custom property suffixes
 * and as the palette derived from a single accent hex. */
const OS_SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;

/** Target lightness (0-1) per shade, applied to the accent color's hue/saturation
 * to produce a full monochromatic scale — mirrors the spread of the default
 * `os` palette in tailwind.config.ts without hardcoding its exact values. */
const SHADE_LIGHTNESS: Record<(typeof OS_SHADES)[number], number> = {
  50: 0.96,
  100: 0.9,
  200: 0.8,
  300: 0.7,
  400: 0.6,
  500: 0.5,
  600: 0.44,
  700: 0.38,
  800: 0.32,
  900: 0.27,
  950: 0.18,
};

function hexToRgb(hex: string): [number, number, number] | null {
  const normalized = hex.replace('#', '');
  const full =
    normalized.length === 3
      ? normalized
          .split('')
          .map((c) => c + c)
          .join('')
      : normalized;
  if (full.length !== 6) return null;
  const num = Number.parseInt(full, 16);
  if (Number.isNaN(num)) return null;
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  switch (max) {
    case rn:
      h = (gn - bn) / d + (gn < bn ? 6 : 0);
      break;
    case gn:
      h = (bn - rn) / d + 2;
      break;
    default:
      h = (rn - gn) / d + 4;
  }
  return [h * 60, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const hue2rgb = (p: number, q: number, t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hn = h / 360;
  return [
    Math.round(hue2rgb(p, q, hn + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, hn) * 255),
    Math.round(hue2rgb(p, q, hn - 1 / 3) * 255),
  ];
}

/** Derive the full `os-{50..950}` palette from a single accent hex, keeping the
 * input's hue/saturation and varying only lightness. Returns each shade as a
 * space-separated "r g b" triplet, ready for a Tailwind `rgb(var(...) / <alpha-value>)`
 * custom property. Returns null if `hex` isn't a valid color. */
export function deriveOsPalette(hex: string): Record<(typeof OS_SHADES)[number], string> | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const [h, s] = rgbToHsl(...rgb);
  const palette = {} as Record<(typeof OS_SHADES)[number], string>;
  for (const shade of OS_SHADES) {
    const [r, g, b] = hslToRgb(h, s, SHADE_LIGHTNESS[shade]);
    palette[shade] = `${r} ${g} ${b}`;
  }
  return palette;
}

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
          accentColor: data.accentColor ?? null,
          fontFamily: data.fontFamily ?? null,
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

  // Drive the `--color-os-*` custom properties app-wide from the accent color.
  // Falls back to the defaults declared in index.css when unset/invalid.
  useEffect(() => {
    const root = document.documentElement;
    const palette = branding.accentColor ? deriveOsPalette(branding.accentColor) : null;
    for (const shade of OS_SHADES) {
      const prop = `--color-os-${shade}`;
      if (palette) root.style.setProperty(prop, palette[shade]);
      else root.style.removeProperty(prop);
    }
  }, [branding.accentColor]);

  // Drive the `--font-sans` custom property app-wide from the configured font.
  useEffect(() => {
    const root = document.documentElement;
    if (branding.fontFamily) root.style.setProperty('--font-sans', branding.fontFamily);
    else root.style.removeProperty('--font-sans');
  }, [branding.fontFamily]);

  return <BrandingContext.Provider value={branding}>{children}</BrandingContext.Provider>;
}
