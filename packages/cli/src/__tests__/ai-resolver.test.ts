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
});
