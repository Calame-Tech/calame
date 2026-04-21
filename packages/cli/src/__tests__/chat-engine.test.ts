import { describe, it, expect } from 'vitest';
import { getDefaultSystemPrompt } from '../chat-engine.js';

describe('getDefaultSystemPrompt', () => {
  it('should return base prompt without friendly addendum when mode is raw', () => {
    const prompt = getDefaultSystemPrompt('raw');
    expect(prompt).not.toContain('REGLE ABSOLUE');
    expect(prompt).not.toContain('Ne mentionne JAMAIS');
    expect(prompt).toContain('You are a versatile AI assistant');
  });

  it('should include friendly addendum when mode is friendly', () => {
    const prompt = getDefaultSystemPrompt('friendly');
    expect(prompt).toContain('REGLE ABSOLUE');
    expect(prompt).toContain('Ne mentionne JAMAIS');
    expect(prompt).toContain('You are a versatile AI assistant');
  });

  it('should default to friendly mode when no argument is passed', () => {
    const prompt = getDefaultSystemPrompt();
    expect(prompt).toContain('REGLE ABSOLUE');
  });

  it('should default to friendly mode when undefined is passed', () => {
    const prompt = getDefaultSystemPrompt(undefined);
    expect(prompt).toContain('REGLE ABSOLUE');
  });

  it('friendly prompt should contain specific formatting rules', () => {
    const prompt = getDefaultSystemPrompt('friendly');
    expect(prompt).toContain('langage naturel');
    expect(prompt).toContain('champ: valeur');
  });

  it('raw prompt should contain standard formatting instructions', () => {
    const prompt = getDefaultSystemPrompt('raw');
    expect(prompt).toContain('Use tables for tabular data');
    expect(prompt).toContain('bullet points');
  });
});
