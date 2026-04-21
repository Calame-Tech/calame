import { describe, it, expect } from 'vitest';
import { LlmRouter } from '../llm-router.js';
import type { ClassifierResult } from '../llm-router.js';

function makeRouter(threshold = 0.8): LlmRouter {
  return new LlmRouter({
    classifierProvider: 'anthropic',
    classifierModel: 'claude-haiku-20240307',
    classifierApiKey: 'test-key',
    injectionThreshold: threshold,
  });
}

describe('LlmRouter constructor', () => {
  it('creates an instance without throwing', () => {
    const router = makeRouter();
    expect(router).toBeInstanceOf(LlmRouter);
  });

  it('creates an instance with a custom threshold', () => {
    const router = makeRouter(0.5);
    expect(router).toBeInstanceOf(LlmRouter);
  });

  it('creates an instance with an openrouter provider', () => {
    const router = new LlmRouter({
      classifierProvider: 'openrouter',
      classifierModel: 'mistral/mistral-7b-instruct',
      classifierApiKey: 'or-key',
      injectionThreshold: 0.8,
    });
    expect(router).toBeInstanceOf(LlmRouter);
  });

  it('creates an instance with a custom endpoint', () => {
    const router = new LlmRouter({
      classifierProvider: 'custom',
      classifierModel: 'llama3',
      classifierApiKey: '',
      classifierEndpoint: 'http://localhost:11434/v1',
      injectionThreshold: 0.9,
    });
    expect(router).toBeInstanceOf(LlmRouter);
  });
});

describe('LlmRouter.shouldBlock', () => {
  it('returns true for injection_attempt above threshold', () => {
    const router = makeRouter(0.8);
    const result: ClassifierResult = {
      intent: 'injection_attempt',
      confidence: 0.95,
      reasoning: 'UNION SELECT detected',
    };
    expect(router.shouldBlock(result)).toBe(true);
  });

  it('returns true for injection_attempt exactly at threshold', () => {
    const router = makeRouter(0.8);
    const result: ClassifierResult = {
      intent: 'injection_attempt',
      confidence: 0.8,
      reasoning: 'Boundary case',
    };
    expect(router.shouldBlock(result)).toBe(true);
  });

  it('returns false for injection_attempt below threshold', () => {
    const router = makeRouter(0.8);
    const result: ClassifierResult = {
      intent: 'injection_attempt',
      confidence: 0.79,
      reasoning: 'Low confidence',
    };
    expect(router.shouldBlock(result)).toBe(false);
  });

  it('returns false for query intent above threshold', () => {
    const router = makeRouter(0.8);
    const result: ClassifierResult = {
      intent: 'query',
      confidence: 0.99,
      reasoning: 'Normal query',
    };
    expect(router.shouldBlock(result)).toBe(false);
  });

  it('returns false for describe intent', () => {
    const router = makeRouter(0.8);
    const result: ClassifierResult = {
      intent: 'describe',
      confidence: 0.95,
      reasoning: 'Schema exploration',
    };
    expect(router.shouldBlock(result)).toBe(false);
  });

  it('returns false for aggregate intent', () => {
    const router = makeRouter(0.8);
    const result: ClassifierResult = {
      intent: 'aggregate',
      confidence: 0.9,
      reasoning: 'Count request',
    };
    expect(router.shouldBlock(result)).toBe(false);
  });

  it('returns false for off_topic intent', () => {
    const router = makeRouter(0.8);
    const result: ClassifierResult = {
      intent: 'off_topic',
      confidence: 1.0,
      reasoning: 'Unrelated question',
    };
    expect(router.shouldBlock(result)).toBe(false);
  });

  it('returns false for write intent above threshold', () => {
    const router = makeRouter(0.8);
    const result: ClassifierResult = {
      intent: 'write',
      confidence: 0.99,
      reasoning: 'Insert request',
    };
    expect(router.shouldBlock(result)).toBe(false);
  });

  it('uses custom threshold correctly', () => {
    const router = makeRouter(0.5);
    const resultAbove: ClassifierResult = {
      intent: 'injection_attempt',
      confidence: 0.6,
      reasoning: 'Suspicious',
    };
    const resultBelow: ClassifierResult = {
      intent: 'injection_attempt',
      confidence: 0.49,
      reasoning: 'Low confidence',
    };
    expect(router.shouldBlock(resultAbove)).toBe(true);
    expect(router.shouldBlock(resultBelow)).toBe(false);
  });
});

describe('LlmRouter.getBlockMessage', () => {
  it('returns a non-empty string', () => {
    const router = makeRouter();
    const result: ClassifierResult = {
      intent: 'injection_attempt',
      confidence: 0.95,
      reasoning: 'DROP TABLE detected',
    };
    const message = router.getBlockMessage(result);
    expect(typeof message).toBe('string');
    expect(message.length).toBeGreaterThan(0);
  });

  it('includes the confidence percentage', () => {
    const router = makeRouter();
    const result: ClassifierResult = {
      intent: 'injection_attempt',
      confidence: 0.95,
      reasoning: 'Injection pattern',
    };
    const message = router.getBlockMessage(result);
    expect(message).toContain('95%');
  });

  it('includes the reasoning in the message', () => {
    const router = makeRouter();
    const result: ClassifierResult = {
      intent: 'injection_attempt',
      confidence: 0.9,
      reasoning: 'UNION SELECT pattern found',
    };
    const message = router.getBlockMessage(result);
    expect(message).toContain('UNION SELECT pattern found');
  });

  it('mentions how to get help (rephrase)', () => {
    const router = makeRouter();
    const result: ClassifierResult = {
      intent: 'injection_attempt',
      confidence: 0.85,
      reasoning: 'Suspicious input',
    };
    const message = router.getBlockMessage(result);
    expect(message.toLowerCase()).toContain('rephrase');
  });
});
