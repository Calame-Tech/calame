// HelpTip — the "?" help used by the MCP view and the knowledge-base source
// form. Covers the collapsible behaviour (click / Enter / Space / Escape) and
// the accessible wiring (localized name, aria-expanded, aria-describedby).

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render as rtlRender, screen, fireEvent, act } from '@testing-library/react';
import type { ReactElement } from 'react';
import HelpTip from '../HelpTip.js';
import { I18nProvider } from '../../i18n/I18nProvider.js';

function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: I18nProvider });
}

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe('HelpTip', () => {
  it('is a focusable, collapsed button with a generic localized name by default', () => {
    render(<HelpTip content="Secondary explanation" />);
    const tip = screen.getByRole('button', { name: 'Help' });
    expect(tip).toHaveAttribute('tabindex', '0');
    expect(tip).toHaveAttribute('aria-expanded', 'false');
    expect(tip).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('names the field it explains when a label is given', () => {
    render(<HelpTip content="x" label="Include globs" />);
    expect(screen.getByRole('button', { name: 'Help: Include globs' })).toBeInTheDocument();
  });

  it('follows the active locale for its accessible name', () => {
    localStorage.setItem('calame-locale', 'fr');
    render(<HelpTip content="x" label="Inclure les fichiers cachés" />);
    expect(
      screen.getByRole('button', { name: 'Aide : Inclure les fichiers cachés' }),
    ).toBeInTheDocument();
  });

  it('unfolds and folds on click, describing itself with the tooltip while open', () => {
    render(<HelpTip content="Secondary explanation" label="Field" />);
    const tip = screen.getByRole('button', { name: 'Help: Field' });

    fireEvent.click(tip);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('Secondary explanation');
    expect(tip).toHaveAttribute('aria-expanded', 'true');
    expect(tip.getAttribute('aria-describedby')).toBe(tooltip.id);
    expect(tip).toHaveAccessibleDescription('Secondary explanation');

    fireEvent.click(tip);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(tip).toHaveAttribute('aria-expanded', 'false');
  });

  it('pins a tooltip already opened by hover instead of closing it on click', () => {
    vi.useFakeTimers();
    render(<HelpTip content="Secondary explanation" label="Field" />);
    const tip = screen.getByRole('button', { name: 'Help: Field' });

    fireEvent.mouseEnter(tip);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    // Click while hover-open: stays open, and survives leaving the icon.
    fireEvent.click(tip);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.mouseLeave(tip);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    // A second click folds it back.
    fireEvent.click(tip);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('still closes on mouse leave when it was only hovered', () => {
    vi.useFakeTimers();
    render(<HelpTip content="Secondary explanation" />);
    const tip = screen.getByRole('button', { name: 'Help' });

    fireEvent.mouseEnter(tip);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    fireEvent.mouseLeave(tip);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('is operable from the keyboard: Enter and Space toggle, Escape closes', () => {
    render(<HelpTip content="Secondary explanation" />);
    const tip = screen.getByRole('button', { name: 'Help' });

    fireEvent.keyDown(tip, { key: 'Enter' });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.keyDown(tip, { key: 'Enter' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    fireEvent.keyDown(tip, { key: ' ' });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.keyDown(tip, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(tip).toHaveAttribute('aria-expanded', 'false');
  });

  it('does not toggle the control of a surrounding <label> when clicked', () => {
    render(
      <label>
        <input type="checkbox" aria-label="Option" />
        Option
        <HelpTip content="x" />
      </label>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Help' }));
    expect(screen.getByRole('checkbox', { name: 'Option' })).not.toBeChecked();
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });
});
