// Narrow window: the floating menu button must never cover a page title, even
// when the page is shown again with a preserved scroll position. An opaque
// sticky bar reserves the button's place at the top of the viewport.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import Sidebar from '../Sidebar.js';
import { I18nProvider } from '../../i18n/I18nProvider.js';

describe('Sidebar — collapsed navigation menu bar', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reserves an opaque sticky bar at least as tall as the floating menu button', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    );
    render(<Sidebar currentPage="dashboard" onNavigate={() => {}} />, { wrapper: I18nProvider });

    const bar = screen.getByTestId('mobile-menu-bar');
    const button = screen.getByRole('button', { name: 'Toggle navigation menu' });
    const barClasses = bar.className.split(' ');
    const buttonClasses = button.className.split(' ');

    // Sticks to the top whatever the scroll position, hidden on wide windows.
    expect(barClasses).toEqual(expect.arrayContaining(['sticky', 'top-0', 'md:hidden']));
    // Opaque, so scrolled content never shows through under the button.
    expect(barClasses).toContain('bg-gray-950');
    // h-16 (64px) covers the button: top-4 (16px) + p-2 + 24px icon = 56px.
    expect(barClasses).toContain('h-16');
    expect(buttonClasses).toEqual(expect.arrayContaining(['fixed', 'top-4', 'p-2']));
    // The button stays above the bar (and above the open drawer).
    expect(buttonClasses).toContain('z-50');
    expect(barClasses).toContain('z-20');
  });
});
