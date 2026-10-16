import { describe, it, expect } from 'vitest';
import { findChatSetting } from '../ChatPanel.js';

describe('findChatSetting', () => {
  const local = {
    name: 'local',
    label: 'Local embeddings',
    provider: 'local',
    configured: true,
    capabilities: ['embeddings'],
  };

  it('ignores the built-in local embedding model (it cannot chat)', () => {
    expect(findChatSetting([local])).toBeUndefined();
  });

  it('returns the configured chat provider, including legacy settings', () => {
    const openrouter = {
      name: 'or',
      label: 'OpenRouter',
      provider: 'openrouter',
      configured: true,
    };
    expect(findChatSetting([local, openrouter])).toBe(openrouter);
    expect(
      findChatSetting([{ ...openrouter, configured: false, capabilities: ['chat'] }]),
    ).toBeUndefined();
  });
});
