import { useState, useRef, useCallback } from 'react';

export interface UsageInfo {
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
}

export interface ChatStreamOptions {
  url?: string; // default: '/api/chat/stream'
  headers?: Record<string, string>;
}

export function useChatStream(opts?: ChatStreamOptions) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [currentText, setCurrentText] = useState('');
  const [toolStatus, setToolStatus] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(
    async (
      body: Record<string, unknown>,
      onDelta?: (text: string) => void,
      onDone?: (finalText: string, usage: UsageInfo | null) => void,
    ) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setIsStreaming(true);
      setCurrentText('');
      setToolStatus(null);
      setUsage(null);
      setError(null);

      try {
        const res = await fetch(opts?.url ?? '/api/chat/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(opts?.headers ?? {}) },
          credentials: 'include',
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({ message: 'Request failed' }));
          throw new Error((data as { message?: string }).message ?? `HTTP ${res.status}`);
        }

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let accumulated = '';
        let finalUsage: UsageInfo | null = null;

        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split('\n\n');
          buffer = blocks.pop() ?? '';

          for (const block of blocks) {
            if (!block.trim()) continue;
            let eventType = '';
            let dataStr = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('event: ')) eventType = line.slice(7).trim();
              if (line.startsWith('data: ')) dataStr = line.slice(6).trim();
            }
            if (!dataStr) continue;
            let payload: Record<string, unknown>;
            try {
              payload = JSON.parse(dataStr) as Record<string, unknown>;
            } catch {
              continue;
            }

            if (eventType === 'text_delta') {
              const delta = (payload['delta'] as string) ?? '';
              accumulated += delta;
              setCurrentText(accumulated);
              onDelta?.(accumulated);
            } else if (eventType === 'tool_call') {
              setToolStatus(`Querying data (${payload['name'] as string})…`);
            } else if (eventType === 'tool_result') {
              setToolStatus(null);
            } else if (eventType === 'usage') {
              finalUsage = {
                input: payload['input'] as number,
                output: payload['output'] as number,
                cacheRead: payload['cacheRead'] as number | undefined,
                cacheCreation: payload['cacheCreation'] as number | undefined,
              };
              setUsage(finalUsage);
            } else if (eventType === 'done') {
              const finalText = (payload['finalText'] as string) || accumulated;
              setCurrentText(finalText);
              onDone?.(finalText, finalUsage);
            } else if (eventType === 'error') {
              throw new Error((payload['message'] as string) ?? 'Stream error');
            }
          }
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') return;
        const msg = err instanceof Error ? err.message : 'Unknown error';
        setError(msg);
        onDone?.('', null);
      } finally {
        setIsStreaming(false);
        setToolStatus(null);
      }
    },
    [opts?.url, opts?.headers],
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
    setIsStreaming(false);
    setToolStatus(null);
  }, []);

  return { isStreaming, currentText, toolStatus, usage, error, send, abort };
}
