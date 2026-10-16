import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppState } from '../state.js';
import { CalameDatabase } from '../database.js';
import { AiSettingsManager } from '../ai-config.js';
import { resolveAiSetting } from '../ai-resolver.js';

// ---------------------------------------------------------------------------
// resolveAiSetting must never return an embeddings-only setting for chat —
// the fallback path used to be `listSettings()[0]` with no capability filter
// at all. That was already a latent bug (an embeddings-only openrouter
// setting sitting first would break chat), but became a GUARANTEED failure
// once the `local` provider was introduced: it's embeddings-only by
// construction (see ai-config.ts's validateCapabilities) and is designed to
// sort first in the built-in-settings seed. These tests lock in the fix.
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: CalameDatabase;
let state: AppState;
let manager: AiSettingsManager;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calame-ai-resolver-test-'));
  db = new CalameDatabase(tmpDir);
  manager = new AiSettingsManager(db);
  state = new AppState();
  state.db = db;
  state.aiSettingsManager = manager;
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createChatSetting(name: string): void {
  manager.createSetting({
    name,
    label: name,
    provider: 'anthropic',
    apiKey: 'sk-test',
    capabilities: ['chat'],
  });
}

describe('resolveAiSetting', () => {
  // Note: a real CalameDatabase runs migrations on construction (see
  // beforeEach above), and migration v17 (Phase 6) unconditionally seeds the
  // built-in "local" setting — embeddings-only by construction — so every
  // test in this file already has exactly the embeddings-only fixture these
  // tests are about, with NO need to create one by hand (and doing so would
  // now collide with it: "local" already exists).

  it('returns 503 when the only chat-relevant setting is the built-in embeddings-only "local" one', () => {
    const result = resolveAiSetting(state, undefined);
    expect(result).toEqual({
      ok: false,
      status: 503,
      message: 'AI chat is not configured. Go to AI Settings to set up a provider.',
    });
  });

  it('skips the built-in embeddings-only "local" setting in the unfiltered fallback and picks a chat-capable one', () => {
    createChatSetting('my-chat-setting');

    const result = resolveAiSetting(state, undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.setting.name).toBe('my-chat-setting');
      expect(result.setting.provider).not.toBe('local');
    }
  });

  it('returns 400 (not a crash) when a requestedName explicitly points at the embeddings-only "local" setting', () => {
    const result = resolveAiSetting(state, undefined, 'local');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.message).toContain('does not support chat');
    }
  });

  it('skips the built-in "local" setting in a profile allowlist and falls through to the global fallback', () => {
    createChatSetting('fallback-chat');
    state.serveProfiles = {
      demo: { name: 'demo', label: 'Demo', aiSettingNames: ['local'] },
    };

    const result = resolveAiSetting(state, 'demo');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.setting.name).toBe('fallback-chat');
    }
  });

  it('still resolves a normal chat-capable requestedName setting', () => {
    createChatSetting('my-chat-setting');
    const result = resolveAiSetting(state, undefined, 'my-chat-setting');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.setting.name).toBe('my-chat-setting');
    }
  });

  // Tester feedback (point 13): a chat-capable setting without its API key
  // used to be picked anyway, and the provider call then failed with an
  // opaque authentication error. It must be refused up front, saying what to
  // fill in and where — and a setting that has its key must be preferred.
  describe('missing credentials', () => {
    function createKeylessSetting(name: string, provider: 'anthropic' | 'custom'): void {
      manager.createSetting({ name, label: name, provider, apiKey: '', capabilities: ['chat'] });
    }

    it('returns 503 naming the setting, the provider and the missing API key', () => {
      createKeylessSetting('Claude', 'anthropic');
      const result = resolveAiSetting(state, undefined);
      expect(result).toEqual({
        ok: false,
        status: 503,
        message:
          'AI setting "Claude" (Anthropic) has no API key. Go to Settings → AI Provider, edit "Claude" and enter its API key.',
      });
    });

    it('asks for the base URL of a custom endpoint', () => {
      createKeylessSetting('ollama', 'custom');
      const result = resolveAiSetting(state, undefined, 'ollama');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(503);
        expect(result.message).toContain('(custom endpoint) has no base URL');
      }
    });

    it('prefers a setting with its key over an earlier keyless one', () => {
      createKeylessSetting('a-keyless', 'anthropic');
      createChatSetting('b-with-key');
      expect(resolveAiSetting(state, undefined)).toMatchObject({
        ok: true,
        setting: { name: 'b-with-key' },
      });

      state.serveProfiles = {
        demo: { name: 'demo', label: 'Demo', aiSettingNames: ['a-keyless', 'b-with-key'] },
      };
      expect(resolveAiSetting(state, 'demo')).toMatchObject({
        ok: true,
        setting: { name: 'b-with-key' },
      });
    });

    it('never leaks the API key of another setting in the message', () => {
      createKeylessSetting('Claude', 'anthropic');
      const result = resolveAiSetting(state, undefined, 'Claude');
      expect(JSON.stringify(result)).not.toContain('sk-');
    });
  });
});
