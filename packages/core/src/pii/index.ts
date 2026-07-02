export type {
  PiiCategory,
  MaskingMode,
  PiiDetection,
  ColumnMasking,
  GlobalMaskingRule,
} from './types.js';

export { detectColumnPii, detectTablePii } from './detector.js';
export { scanTextForPii, applyPiiMasking, DEFAULT_TEXT_PII_CATEGORIES } from './text-scanner.js';
export type { PiiSpan, TextMaskingMode } from './text-scanner.js';
