import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/**/*.{ts,tsx}',
    // EE packages whose React components are consumed via direct TS source
    // (their `./web` export points at `src/web/index.ts`, not a compiled bundle).
    // Tailwind needs to scan them so utility classes are not purged.
    '../../ee/sso/src/web/**/*.{ts,tsx}',
    '../../ee/rag-core/src/web/**/*.{ts,tsx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Each shade reads a `--color-os-{shade}` custom property ("r g b"),
        // defaulted in index.css and overridden app-wide by BrandingProvider
        // when an admin sets a custom accent color. <alpha-value> keeps
        // opacity modifiers (e.g. `bg-os-500/20`) working.
        os: {
          50: 'rgb(var(--color-os-50) / <alpha-value>)',
          100: 'rgb(var(--color-os-100) / <alpha-value>)',
          200: 'rgb(var(--color-os-200) / <alpha-value>)',
          300: 'rgb(var(--color-os-300) / <alpha-value>)',
          400: 'rgb(var(--color-os-400) / <alpha-value>)',
          500: 'rgb(var(--color-os-500) / <alpha-value>)',
          600: 'rgb(var(--color-os-600) / <alpha-value>)',
          700: 'rgb(var(--color-os-700) / <alpha-value>)',
          800: 'rgb(var(--color-os-800) / <alpha-value>)',
          900: 'rgb(var(--color-os-900) / <alpha-value>)',
          950: 'rgb(var(--color-os-950) / <alpha-value>)',
        },
      },
      animation: {
        'fade-in': 'fadeIn 200ms ease-out',
        'fade-in-up': 'fadeInUp 300ms ease-out',
        'slide-in-right': 'slideInRight 250ms ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        fadeInUp: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideInRight: {
          '0%': { opacity: '0', transform: 'translateX(-8px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
      },
    },
  },
  plugins: [],
};

export default config;
