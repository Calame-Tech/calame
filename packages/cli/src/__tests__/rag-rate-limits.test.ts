import { describe, it, expect, vi } from 'vitest';

import { parseRateLimitEnv } from '../rag-rate-limits.js';

describe('parseRateLimitEnv', () => {
  it('parses well-formed CALAME_RAG_RATE_LIMIT_<TYPE> entries', () => {
    const out = parseRateLimitEnv({
      CALAME_RAG_RATE_LIMIT_NOTION: '3:9',
      CALAME_RAG_RATE_LIMIT_COHERE: '1:5',
      CALAME_RAG_RATE_LIMIT_S3: '50:100',
      // Non-matching env var must be ignored.
      PATH: '/usr/bin',
      // Unrelated CALAME_RAG_* must be ignored too.
      CALAME_RAG_HYBRID_SEARCH: 'off',
    });
    expect(out).toEqual({
      notion: { capacity: 9, refillPerSec: 3 },
      cohere: { capacity: 5, refillPerSec: 1 },
      s3: { capacity: 100, refillPerSec: 50 },
    });
  });

  it('lowercases the type suffix so case is forgiving', () => {
    const out = parseRateLimitEnv({ CALAME_RAG_RATE_LIMIT_GDRIVE: '8:20' });
    expect(out.gdrive).toEqual({ capacity: 20, refillPerSec: 8 });
  });

  it('warns and skips when the value lacks a colon', () => {
    const logger = { warn: vi.fn() };
    const out = parseRateLimitEnv({ CALAME_RAG_RATE_LIMIT_NOTION: '3' }, logger);
    expect(out).toEqual({});
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![0]).toMatch(/refillPerSec.*:.*capacity/i);
  });

  it('warns and skips when refillPerSec is not a positive number', () => {
    const logger = { warn: vi.fn() };
    const out = parseRateLimitEnv(
      { CALAME_RAG_RATE_LIMIT_NOTION: 'abc:9', CALAME_RAG_RATE_LIMIT_S3: '-1:10' },
      logger,
    );
    expect(out).toEqual({});
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('warns and skips when capacity is not a positive number', () => {
    const logger = { warn: vi.fn() };
    const out = parseRateLimitEnv({ CALAME_RAG_RATE_LIMIT_NOTION: '3:0' }, logger);
    expect(out).toEqual({});
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![0]).toMatch(/capacity.*positive/i);
  });

  it('accepts unknown types but logs a note', () => {
    const logger = { warn: vi.fn() };
    const out = parseRateLimitEnv({ CALAME_RAG_RATE_LIMIT_DROPBOX: '5:20' }, logger);
    expect(out.dropbox).toEqual({ capacity: 20, refillPerSec: 5 });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![0]).toMatch(/unknown connector type/i);
  });

  it('returns an empty map when no env vars match', () => {
    expect(parseRateLimitEnv({})).toEqual({});
    expect(parseRateLimitEnv({ NODE_ENV: 'test' })).toEqual({});
  });

  it('ignores empty-string values without warning (treats as unset)', () => {
    const logger = { warn: vi.fn() };
    const out = parseRateLimitEnv({ CALAME_RAG_RATE_LIMIT_NOTION: '' }, logger);
    expect(out).toEqual({});
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
