// "AI instructions" profile field: editing, frontend size limit, save, FR/EN.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, act } from '@testing-library/react';
import AiInstructionsEditor, { AI_INSTRUCTIONS_MAX_LENGTH } from '../AiInstructionsEditor.js';
import { render } from '../../pages/__tests__/testUtils.js';
import en from '../../i18n/messages/en.json' with { type: 'json' };
import fr from '../../i18n/messages/fr.json' with { type: 'json' };

function mockFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async () =>
      ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      }) as unknown as Response,
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function textarea(): HTMLTextAreaElement {
  return document.getElementById('ai-instructions-input') as HTMLTextAreaElement;
}

describe('AiInstructionsEditor', () => {
  beforeEach(() => {
    localStorage.setItem('calame-locale', 'en');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.removeItem('calame-locale');
  });

  it('shows the stored value and an empty field for a legacy profile', () => {
    const { unmount } = render(
      <AiInstructionsEditor profileName="docs" value="Read 00-LISEZ-MOI.md" onSaved={vi.fn()} />,
    );
    expect(textarea().value).toBe('Read 00-LISEZ-MOI.md');
    unmount();
    render(<AiInstructionsEditor profileName="docs" value={undefined} onSaved={vi.fn()} />);
    expect(textarea().value).toBe('');
    expect(screen.getByText(`0 / ${AI_INSTRUCTIONS_MAX_LENGTH} characters`)).toBeTruthy();
  });

  it('saves through the profile PATCH route and reports the stored value', async () => {
    const fetchMock = mockFetch(200, {
      success: true,
      profile: { aiInstructions: 'Read 00-LISEZ-MOI.md first.' },
    });
    const onSaved = vi.fn();
    render(<AiInstructionsEditor profileName="team docs" value={undefined} onSaved={onSaved} />);

    fireEvent.change(textarea(), { target: { value: '  Read 00-LISEZ-MOI.md first.  ' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/profiles/team%20docs/ai-instructions');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({
      aiInstructions: '  Read 00-LISEZ-MOI.md first.  ',
    });
    expect(onSaved).toHaveBeenCalledWith('Read 00-LISEZ-MOI.md first.');
    expect(screen.getByText('Instructions saved.')).toBeTruthy();
  });

  it('clearing the field saves an empty value (stored as absent)', async () => {
    mockFetch(200, { success: true, profile: {} });
    const onSaved = vi.fn();
    render(<AiInstructionsEditor profileName="docs" value="Old rule" onSaved={onSaved} />);

    fireEvent.change(textarea(), { target: { value: '   ' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }));
    });
    expect(onSaved).toHaveBeenCalledWith(undefined);
  });

  it('refuses over-limit text with an explicit error, without truncating or calling the API', () => {
    const fetchMock = mockFetch(200, { success: true, profile: {} });
    const onSaved = vi.fn();
    render(<AiInstructionsEditor profileName="docs" value={undefined} onSaved={onSaved} />);

    const tooLong = 'x'.repeat(AI_INSTRUCTIONS_MAX_LENGTH + 1);
    fireEvent.change(textarea(), { target: { value: tooLong } });

    // Not truncated: the full text stays in the field.
    expect(textarea().value).toHaveLength(AI_INSTRUCTIONS_MAX_LENGTH + 1);
    expect(textarea().getAttribute('maxlength')).toBeNull();
    expect(textarea().getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toBe(
      'AI instructions are limited to 4000 characters (4001 entered). Shorten them: nothing was saved.',
    );
    const save = screen.getByRole('button', { name: 'Save instructions' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('accepts exactly the limit', async () => {
    const atLimit = 'y'.repeat(AI_INSTRUCTIONS_MAX_LENGTH);
    const fetchMock = mockFetch(200, { success: true, profile: { aiInstructions: atLimit } });
    render(<AiInstructionsEditor profileName="docs" value={undefined} onSaved={vi.fn()} />);
    fireEvent.change(textarea(), { target: { value: atLimit } });
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a backend refusal without reporting a save', async () => {
    mockFetch(400, { success: false, code: 'ai_instructions_too_long' });
    const onSaved = vi.fn();
    render(<AiInstructionsEditor profileName="docs" value={undefined} onSaved={onSaved} />);
    fireEvent.change(textarea(), { target: { value: 'Some rule' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }));
    });
    expect(screen.getByRole('alert').textContent).toMatch(/limited to 4000 characters/);
    expect(onSaved).not.toHaveBeenCalled();
    expect(textarea().value).toBe('Some rule');
  });

  it('shows a generic error on other failures (e.g. 403)', async () => {
    mockFetch(403, { success: false });
    const onSaved = vi.fn();
    render(<AiInstructionsEditor profileName="docs" value={undefined} onSaved={onSaved} />);
    fireEvent.change(textarea(), { target: { value: 'Some rule' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }));
    });
    expect(screen.getByRole('alert').textContent).toBe(
      'Failed to save the AI instructions. Nothing was changed.',
    );
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('renders the French labels and error', () => {
    localStorage.setItem('calame-locale', 'fr');
    render(<AiInstructionsEditor profileName="docs" value={undefined} onSaved={vi.fn()} />);
    expect(screen.getByLabelText("Consignes pour l'IA")).toBe(textarea());
    fireEvent.change(textarea(), {
      target: { value: 'z'.repeat(AI_INSTRUCTIONS_MAX_LENGTH + 5) },
    });
    expect(screen.getByRole('alert').textContent).toBe(
      "Les consignes sont limitées à 4000 caractères (4005 saisis). Raccourcissez-les : rien n'a été enregistré.",
    );
    expect(screen.getByRole('button', { name: 'Enregistrer les consignes' })).toBeTruthy();
  });

  it('has the same AI-instructions keys in FR and EN', () => {
    const keys = (o: object, prefix = ''): string[] =>
      Object.entries(o).flatMap(([k, v]) =>
        v && typeof v === 'object' ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
      );
    expect(keys(fr.mcpDetail.aiInstructions).sort()).toEqual(
      keys(en.mcpDetail.aiInstructions).sort(),
    );
    expect(fr.mcpDetail.aiInstructions.label).toBe("Consignes pour l'IA");
    expect(en.mcpDetail.aiInstructions.label).toBe('AI instructions');
    expect(fr.mcpList.preview.aiInstructionsHeading).toBe("Consignes pour l'IA");
    expect(en.mcpList.preview.aiInstructionsHeading).toBe('AI instructions');
  });
});
