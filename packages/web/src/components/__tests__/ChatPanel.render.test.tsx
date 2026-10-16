/**
 * ChatPanel — the conversational (LLM) test of an MCP server.
 *
 * Covers the tester feedback "Using Anthropic, then an error with no reason":
 * the panel must name the provider really configured, never default to
 * "Anthropic", refuse to call the chat without a chat provider, and show the
 * server's error message instead of a generic "could not reach the server".
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ChatPanel from '../ChatPanel.js';
import { I18nProvider } from '../../i18n/I18nProvider.js';

const localEmbeddings = {
  name: 'local',
  label: 'Local embeddings',
  provider: 'local',
  configured: true,
  capabilities: ['embeddings'],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installFetch(settings: unknown[], chatResponse: () => Response) {
  const mock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/ai-settings') return Promise.resolve(json({ success: true, settings }));
    if (url.startsWith('/api/chat-profile/'))
      return Promise.resolve(json({ success: true, profile: { name: 'demo' } }));
    if (url === '/api/chat/stream') return Promise.resolve(chatResponse());
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function renderPanel() {
  render(<ChatPanel selectedTables={{}} activeProfiles={['demo']} />, { wrapper: I18nProvider });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ChatPanel (conversational LLM test)', () => {
  it('explains it uses an LLM, unlike the MCP test that needs no AI', async () => {
    installFetch([localEmbeddings], () => json({}));
    renderPanel();
    expect(await screen.findByText(/sends your question to the AI provider/)).toBeTruthy();
    expect(screen.getByText(/without any AI, use “Test MCP”/)).toBeTruthy();
  });

  it('with only the local embedding model: says what to configure and where, and never calls the chat', async () => {
    const fetchMock = installFetch([localEmbeddings], () => json({}));
    renderPanel();

    expect(await screen.findByText(/No AI provider for chat is configured/)).toBeTruthy();
    // Named like the real setting; plain text when no navigation is wired.
    expect(screen.getByText('Settings → AI Provider').tagName).toBe('SPAN');
    expect(screen.queryByText(/Anthropic \(/)).toBeNull();
    expect(screen.queryByText('Using')).toBeNull();

    const input = screen.getByPlaceholderText(
      'Configure AI in Settings first',
    ) as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    expect(fetchMock.mock.calls.some((c) => String(c[0]) === '/api/chat/stream')).toBe(false);
  });

  it('without a provider: links straight to the "AI Provider" setting', async () => {
    installFetch([localEmbeddings], () => json({}));
    const onOpenAiSettings = vi.fn();
    render(
      <ChatPanel
        selectedTables={{}}
        activeProfiles={['demo']}
        onOpenAiSettings={onOpenAiSettings}
      />,
      { wrapper: I18nProvider },
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Settings → AI Provider' }));
    expect(onOpenAiSettings).toHaveBeenCalledTimes(1);
  });

  it('shows the provider actually configured, not a default "Anthropic"', async () => {
    installFetch(
      [
        localEmbeddings,
        {
          name: 'or',
          label: 'My router',
          provider: 'openrouter',
          configured: true,
          model: 'mistral-small',
        },
      ],
      () => json({}),
    );
    renderPanel();

    expect(await screen.findByText('My router (OpenRouter / mistral-small)')).toBeTruthy();
    expect(screen.queryByText(/Anthropic/)).toBeNull();
  });

  it('shows the error returned by the server instead of a generic message', async () => {
    const serverMessage =
      'AI setting "Claude" (Anthropic) has no API key. Go to Settings → AI Provider, edit "Claude" and enter its API key.';
    const fetchMock = installFetch(
      [{ name: 'claude', label: 'Claude', provider: 'anthropic', configured: true }],
      () => json({ success: false, message: serverMessage }, 503),
    );
    renderPanel();

    const input = await screen.findByPlaceholderText(/Ask/);
    fireEvent.change(input, { target: { value: 'How many orders?' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(screen.getByText(`Error: ${serverMessage}`)).toBeTruthy());
    expect(screen.queryByText(/could not reach the server/)).toBeNull();
    expect(fetchMock.mock.calls.some((c) => String(c[0]) === '/api/chat/stream')).toBe(true);
  });

  it('shows an error raised mid-stream by the AI provider', async () => {
    installFetch(
      [{ name: 'claude', label: 'Claude', provider: 'anthropic', configured: true }],
      () =>
        new Response('event: error\ndata: {"message":"401 invalid x-api-key"}\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
    );
    renderPanel();

    const input = await screen.findByPlaceholderText(/Ask/);
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(screen.getByText('Error: 401 invalid x-api-key')).toBeTruthy());
  });
});
