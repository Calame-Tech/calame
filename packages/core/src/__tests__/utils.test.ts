import { describe, it, expect } from 'vitest';
import { truncate } from '../utils.js';

describe('truncate', () => {
  it('returns the text unchanged when under the limit', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('returns the text unchanged when exactly at the limit', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('truncates and appends an ellipsis when over the limit', () => {
    const result = truncate('hello world', 5);
    expect(result).toBe('hell…');
    expect(result.length).toBe(5);
  });

  it('returns an empty string when max is 0', () => {
    expect(truncate('hello', 0)).toBe('');
  });

  it('returns an empty string for empty input', () => {
    expect(truncate('', 5)).toBe('');
    expect(truncate('', 0)).toBe('');
  });
});
