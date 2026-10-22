// ProfilePreview shows the profile's AI instructions as plain text.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import ProfilePreview from '../ProfilePreview.js';
import { render, flushEffects } from '../../pages/__tests__/testUtils.js';

function mockPreview(preview: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ success: true, preview }),
        }) as unknown as Response,
    ),
  );
}

describe('ProfilePreview — AI instructions', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.removeItem('calame-locale');
  });

  it('displays the instructions verbatim, without interpreting HTML', async () => {
    localStorage.setItem('calame-locale', 'en');
    const text = '# Rules\nRead 00-LISEZ-MOI.md first.\n<img src=x onerror="alert(1)"><b>bold</b>';
    mockPreview({ profileName: 'docs', tables: [], aiInstructions: text });
    render(<ProfilePreview profileName="docs" onClose={vi.fn()} />);
    await flushEffects();

    const section = screen.getByTestId('preview-ai-instructions');
    expect(section.textContent).toContain('AI instructions');
    expect(section.querySelector('pre')?.textContent).toBe(text);
    expect(section.querySelector('img')).toBeNull();
    expect(section.querySelector('b')).toBeNull();
  });

  it('uses the French heading', async () => {
    localStorage.setItem('calame-locale', 'fr');
    mockPreview({ profileName: 'docs', tables: [], aiInstructions: 'Lis le guide.' });
    render(<ProfilePreview profileName="docs" onClose={vi.fn()} />);
    await flushEffects();
    expect(screen.getByText("Consignes pour l'IA")).toBeTruthy();
  });

  it('shows nothing for a profile without instructions', async () => {
    mockPreview({ profileName: 'docs', tables: [] });
    render(<ProfilePreview profileName="docs" onClose={vi.fn()} />);
    await flushEffects();
    expect(screen.queryByTestId('preview-ai-instructions')).toBeNull();
  });
});
