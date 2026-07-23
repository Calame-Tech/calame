/**
 * Truncates `text` to at most `max` characters, appending an ellipsis (…)
 * when truncation occurs. The total returned length never exceeds `max`.
 */
export function truncate(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}
