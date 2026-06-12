import { describe, it, expect, vi, beforeEach } from 'vitest';
import { settingSupports } from '../ai-config.js';
import type { AiSetting, AiCapability } from '../ai-config.js';

// ---------------------------------------------------------------------------
// Mock better-sqlite3 so tests pass without native bindings.
// We simulate an in-memory store of AI settings rows.
// ---------------------------------------------------------------------------

type Row = {
  name: string;
  label: string;
  provider: string;
  api_key: string;
  model: string | null;
  base_url: string | null;
  capabilities: string | null;
  embedding_model: string | null;
  embedding_dimensions: number | null;
  rerank_model: string | null;
  created_at: string;
};

let store: Map<string, Row>;

function makeStmt(type: 'list' | 'get' | 'insert' | 'update' | 'delete') {
  return {
    all: vi.fn(() => Array.from(store.values())),
    get: vi.fn((name: string) => store.get(name)),
    run: vi.fn((...args: unknown[]) => {
      if (type === 'insert') {
        const [
          name,
          label,
          provider,
          api_key,
          model,
          base_url,
          capabilities,
          embedding_model,
          embedding_dimensions,
          rerank_model,
        ] = args as [
          string,
          string,
          string,
          string,
          string | null,
          string | null,
          string | null,
          string | null,
          number | null,
          string | null,
        ];
        store.set(name, {
          name,
          label,
          provider,
          api_key,
          model,
          base_url,
          capabilities,
          embedding_model,
          embedding_dimensions,
          rerank_model,
          created_at: new Date().toISOString(),
        });
      } else if (type === 'update') {
        const [
          label,
          provider,
          api_key,
          model,
          base_url,
          capabilities,
          embedding_model,
          embedding_dimensions,
          rerank_model,
          name,
        ] = args as [
          string,
          string,
          string,
          string | null,
          string | null,
          string | null,
          string | null,
          number | null,
          string | null,
          string,
        ];
        const existing = store.get(name);
        if (existing) {
          store.set(name, {
            ...existing,
            label,
            provider,
            api_key,
            model,
            base_url,
            capabilities,
            embedding_model,
            embedding_dimensions,
            rerank_model,
          });
        }
      } else if (type === 'delete') {
        store.delete(args[0] as string);
      }
    }),
  };
}

vi.mock('better-sqlite3', () => {
  const Database = vi.fn(() => ({
    pragma: vi.fn(),
    exec: vi.fn(),
    prepare: vi.fn((sql: string) => {
      if (sql.includes('INSERT INTO ai_settings')) return makeStmt('insert');
      if (sql.includes('UPDATE ai_settings')) return makeStmt('update');
      if (sql.includes('DELETE FROM ai_settings')) return makeStmt('delete');
      if (sql.includes('WHERE name = ?')) {
        return {
          get: vi.fn((name: string) => store.get(name)),
          run: vi.fn(),
        };
      }
      // SELECT * FROM ai_settings (list)
      return {
        all: vi.fn(() => Array.from(store.values())),
        get: vi.fn(),
        run: vi.fn(),
      };
    }),
    close: vi.fn(),
  }));
  return { default: Database };
});

vi.mock('../migration.js', () => ({ runMigrations: vi.fn() }));

// Import AFTER mocks are set up
const { AiSettingsManager } = await import('../ai-config.js');
const { CalameDatabase } = await import('../database.js');

function makeManager(): InstanceType<typeof AiSettingsManager> {
  const db = new CalameDatabase('/fake/path');
  return new AiSettingsManager(db);
}

const BASE: AiSetting = {
  name: 'ollama',
  label: 'Ollama Local',
  provider: 'custom',
  apiKey: '',
  baseUrl: 'http://localhost:11434/v1',
  model: 'llama3',
};

describe('AiSettingsManager — capabilities', () => {
  beforeEach(() => {
    store = new Map();
  });

  it('creates a setting with capabilities chat+embeddings and embeddingModel', () => {
    const mgr = makeManager();
    mgr.createSetting({ ...BASE, capabilities: ['chat', 'embeddings'], embeddingModel: 'nomic-embed-text' });
    const saved = mgr.getSetting('ollama');
    expect(saved).not.toBeNull();
    expect(saved!.capabilities).toEqual(['chat', 'embeddings']);
    expect(saved!.embeddingModel).toBe('nomic-embed-text');
  });

  it('creates a setting with only embeddings capability and embeddingModel', () => {
    const mgr = makeManager();
    mgr.createSetting({ ...BASE, capabilities: ['embeddings'], embeddingModel: 'text-embedding-3-small' });
    const saved = mgr.getSetting('ollama');
    expect(saved!.capabilities).toEqual(['embeddings']);
    expect(saved!.embeddingModel).toBe('text-embedding-3-small');
  });

  it('throws when capabilities includes embeddings but embeddingModel is absent', () => {
    const mgr = makeManager();
    expect(() => {
      mgr.createSetting({ ...BASE, capabilities: ['embeddings'] });
    }).toThrow(/embeddingModel is required/);
  });

  it('throws when capabilities contains an unknown value', () => {
    const mgr = makeManager();
    expect(() => {
      // Force-cast to bypass TS; runtime must still reject it.
      mgr.createSetting({ ...BASE, capabilities: ['chat', 'unknown-cap'] as AiCapability[] });
    }).toThrow(/Unknown capability/);
  });

  it('returns capabilities: undefined for settings without the field (backward compat)', () => {
    // Simulate a legacy row (no capabilities or embedding_model stored).
    store.set('legacy', {
      name: 'legacy',
      label: 'Legacy',
      provider: 'anthropic',
      api_key: 'sk-test',
      model: null,
      base_url: null,
      capabilities: null,
      embedding_model: null,
      embedding_dimensions: null,
      rerank_model: null,
      created_at: new Date().toISOString(),
    });
    const mgr = makeManager();
    const setting = mgr.getSetting('legacy');
    expect(setting).not.toBeNull();
    expect(setting!.capabilities).toBeUndefined();
    expect(setting!.embeddingModel).toBeUndefined();
  });

  it('updates a setting to add capabilities and embeddingModel', () => {
    const mgr = makeManager();
    mgr.createSetting({ ...BASE });
    mgr.updateSetting('ollama', { capabilities: ['chat', 'embeddings'], embeddingModel: 'nomic-embed-text' });
    const updated = mgr.getSetting('ollama');
    expect(updated!.capabilities).toEqual(['chat', 'embeddings']);
    expect(updated!.embeddingModel).toBe('nomic-embed-text');
  });

  it('throws on updateSetting when embeddings capability lacks embeddingModel', () => {
    const mgr = makeManager();
    mgr.createSetting({ ...BASE });
    expect(() => {
      mgr.updateSetting('ollama', { capabilities: ['embeddings'] });
    }).toThrow(/embeddingModel is required/);
  });

  // -------------------------------------------------------------------------
  // Rerank capability (Phase 5 EE RAG Tranche 2)
  // -------------------------------------------------------------------------

  it('creates a setting with rerank capability and rerankModel', () => {
    const mgr = makeManager();
    mgr.createSetting({
      ...BASE,
      name: 'cohere',
      label: 'Cohere',
      capabilities: ['rerank'],
      rerankModel: 'rerank-multilingual-v3.0',
    });
    const saved = mgr.getSetting('cohere');
    expect(saved).not.toBeNull();
    expect(saved!.capabilities).toEqual(['rerank']);
    expect(saved!.rerankModel).toBe('rerank-multilingual-v3.0');
  });

  it('throws when capabilities includes rerank but rerankModel is absent', () => {
    const mgr = makeManager();
    expect(() => {
      mgr.createSetting({ ...BASE, capabilities: ['rerank'] });
    }).toThrow(/rerankModel is required/);
  });

  it('backward compat: capabilities=[chat, embeddings] still validates without rerankModel', () => {
    const mgr = makeManager();
    mgr.createSetting({
      ...BASE,
      capabilities: ['chat', 'embeddings'],
      embeddingModel: 'nomic-embed-text',
    });
    const saved = mgr.getSetting('ollama');
    expect(saved!.capabilities).toEqual(['chat', 'embeddings']);
    expect(saved!.rerankModel).toBeUndefined();
  });

  it('error message lists rerank among valid capabilities', () => {
    const mgr = makeManager();
    expect(() => {
      mgr.createSetting({ ...BASE, capabilities: ['nope'] as unknown as AiCapability[] });
    }).toThrow(/Valid values: chat, embeddings, rerank\./);
  });
});

describe('settingSupports', () => {
  const legacy: AiSetting = {
    name: 'legacy',
    label: 'Legacy',
    provider: 'anthropic',
    apiKey: 'sk-test',
    // capabilities intentionally absent
  };

  const chatOnly: AiSetting = { ...legacy, name: 'chat-only', capabilities: ['chat'] };

  const embeddingCapable: AiSetting = {
    ...legacy,
    name: 'embed',
    capabilities: ['chat', 'embeddings'],
    embeddingModel: 'nomic-embed-text',
  };

  it('returns true for chat on a legacy setting (no capabilities field)', () => {
    expect(settingSupports(legacy, 'chat')).toBe(true);
  });

  it('returns false for embeddings on a legacy setting', () => {
    expect(settingSupports(legacy, 'embeddings')).toBe(false);
  });

  it('returns true for chat on a chat-only setting', () => {
    expect(settingSupports(chatOnly, 'chat')).toBe(true);
  });

  it('returns false for embeddings on a chat-only setting', () => {
    expect(settingSupports(chatOnly, 'embeddings')).toBe(false);
  });

  it('returns true for both chat and embeddings on an embedding-capable setting', () => {
    expect(settingSupports(embeddingCapable, 'chat')).toBe(true);
    expect(settingSupports(embeddingCapable, 'embeddings')).toBe(true);
  });
});
