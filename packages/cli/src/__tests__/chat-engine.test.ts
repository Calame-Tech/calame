import { describe, it, expect } from 'vitest';
import { getDefaultSystemPrompt, createCalcTool } from '../chat-engine.js';

describe('getDefaultSystemPrompt', () => {
  it('should return base prompt without friendly addendum when mode is raw', () => {
    const prompt = getDefaultSystemPrompt('raw');
    expect(prompt).not.toContain('ABSOLUTE RULE');
    expect(prompt).not.toContain('NEVER mention technical');
    expect(prompt).toContain('You are a versatile AI assistant');
  });

  it('should include friendly addendum when mode is friendly', () => {
    const prompt = getDefaultSystemPrompt('friendly');
    expect(prompt).toContain('ABSOLUTE RULE');
    expect(prompt).toContain('NEVER mention technical');
    expect(prompt).toContain('You are a versatile AI assistant');
  });

  it('should default to friendly mode when no argument is passed', () => {
    const prompt = getDefaultSystemPrompt();
    expect(prompt).toContain('ABSOLUTE RULE');
  });

  it('should default to friendly mode when undefined is passed', () => {
    const prompt = getDefaultSystemPrompt(undefined);
    expect(prompt).toContain('ABSOLUTE RULE');
  });

  it('friendly prompt should contain specific formatting rules', () => {
    const prompt = getDefaultSystemPrompt('friendly');
    expect(prompt).toContain('natural language');
    expect(prompt).toContain('field: value');
  });

  it('raw prompt should contain standard formatting instructions', () => {
    const prompt = getDefaultSystemPrompt('raw');
    expect(prompt).toContain('Use tables for tabular data');
    expect(prompt).toContain('bullet points');
  });

  it('default system prompt contains the arithmetic critical section', () => {
    const prompt = getDefaultSystemPrompt('raw');
    expect(prompt).toContain('## CRITICAL: arithmetic');
  });
});

describe('createCalcTool', () => {
  it('tool name is calc and description mentions arithmetic', () => {
    const tool = createCalcTool();
    expect(tool.name).toBe('calc');
    expect(tool.description.toLowerCase()).toContain('arithmetic');
  });

  it('sum of [1, 2, 3, 4] equals 10', async () => {
    const tool = createCalcTool();
    const raw = await tool.handler({ op: 'sum', values: [1, 2, 3, 4] });
    expect(JSON.parse(raw)).toEqual({ result: 10 });
  });

  it('avg of [2, 4, 6] equals 4', async () => {
    const tool = createCalcTool();
    const raw = await tool.handler({ op: 'avg', values: [2, 4, 6] });
    expect(JSON.parse(raw)).toEqual({ result: 4 });
  });

  it('min of [-1, 5, 0] equals -1', async () => {
    const tool = createCalcTool();
    const raw = await tool.handler({ op: 'min', values: [-1, 5, 0] });
    expect(JSON.parse(raw)).toEqual({ result: -1 });
  });

  it('max of [-1, 5, 0] equals 5', async () => {
    const tool = createCalcTool();
    const raw = await tool.handler({ op: 'max', values: [-1, 5, 0] });
    expect(JSON.parse(raw)).toEqual({ result: 5 });
  });

  it('count of [1, 2, 3] equals 3', async () => {
    const tool = createCalcTool();
    const raw = await tool.handler({ op: 'count', values: [1, 2, 3] });
    expect(JSON.parse(raw)).toEqual({ result: 3 });
  });

  it('product of [2, 3, 4] equals 24', async () => {
    const tool = createCalcTool();
    const raw = await tool.handler({ op: 'product', values: [2, 3, 4] });
    expect(JSON.parse(raw)).toEqual({ result: 24 });
  });

  it('avg on empty array throws', async () => {
    const tool = createCalcTool();
    await expect(tool.handler({ op: 'avg', values: [] })).rejects.toThrow();
  });

  it('min on empty array throws', async () => {
    const tool = createCalcTool();
    await expect(tool.handler({ op: 'min', values: [] })).rejects.toThrow();
  });

  it('max on empty array throws', async () => {
    const tool = createCalcTool();
    await expect(tool.handler({ op: 'max', values: [] })).rejects.toThrow();
  });

  it('sum of floats [0.1, 0.2] is close to 0.3', async () => {
    const tool = createCalcTool();
    const raw = await tool.handler({ op: 'sum', values: [0.1, 0.2] });
    const { result } = JSON.parse(raw) as { result: number };
    expect(result).toBeCloseTo(0.3);
  });
});
