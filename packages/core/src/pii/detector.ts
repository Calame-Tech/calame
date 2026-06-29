import type { PiiCategory, PiiDetection } from './types.js';

// ---------------------------------------------------------------------------
// Column-name patterns → PII category
// ---------------------------------------------------------------------------

const COLUMN_NAME_PATTERNS: { pattern: RegExp; category: PiiCategory }[] = [
  // Email
  { pattern: /^e?-?_?mail/i, category: 'email' },
  { pattern: /email/i, category: 'email' },
  { pattern: /courriel/i, category: 'email' },

  // Phone
  { pattern: /^(phone|tel|mobile|fax|cellphone|telephone|numero.?tel)/i, category: 'phone' },
  { pattern: /phone/i, category: 'phone' },

  // Name — match "Name" alone, plus first/last/full/surname variants
  { pattern: /^name$/i, category: 'name' },
  {
    pattern: /^(first.?name|last.?name|full.?name|display.?name|user.?name|username)/i,
    category: 'name',
  },
  {
    pattern: /^(prenom|nom$|nom_|surname|given.?name|family.?name|middle.?name)/i,
    category: 'name',
  },

  // Address — including French/typo variants like "addresse", "adresse"
  {
    pattern: /^(addr|address|addresse|adresse|street|city|zip|postal|code.?postal|rue|ville)/i,
    category: 'address',
  },
  {
    pattern: /^(country|pays|region|state|province|street.?number|house.?number)/i,
    category: 'address',
  },
  { pattern: /(address|adresse|addresse)/i, category: 'address' },

  // Credit card
  { pattern: /^(cc|card|credit.?card|carte|card.?number|numero.?carte)/i, category: 'credit_card' },

  // Password / secrets
  {
    pattern: /^(pass|password|pwd|hash|secret|token|api.?key|private.?key)/i,
    category: 'password',
  },

  // IP address
  { pattern: /^(ip|ip.?addr|remote.?addr|ip.?address)/i, category: 'ip_address' },

  // SSN
  { pattern: /^(ssn|social.?security|nir|num.?secu|national.?id)/i, category: 'ssn' },
];

// ---------------------------------------------------------------------------
// Data-sample patterns → PII category
// ---------------------------------------------------------------------------

const DATA_PATTERNS: { pattern: RegExp; category: PiiCategory }[] = [
  { pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, category: 'email' },
  { pattern: /^\+?[\d\s\-()]{7,15}$/, category: 'phone' },
  { pattern: /^\d{13,19}$/, category: 'credit_card' },
  { pattern: /^\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}$/, category: 'credit_card' },
  { pattern: /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, category: 'ip_address' },
  { pattern: /^\d{3}-?\d{2}-?\d{4}$/, category: 'ssn' },
];

/**
 * Detect if sample data looks like it's already encrypted/Base64 encoded.
 * Values like "AuopQr4lNTLWpjhtYU3gfw==" suggest the data is encrypted at rest.
 */
const BASE64_ENCRYPTED_PATTERN = /^[A-Za-z0-9+/]{16,}={0,2}$/;

function looksEncrypted(sampleValues: string[]): boolean {
  if (sampleValues.length === 0) return false;
  const matchCount = sampleValues.filter((v) => BASE64_ENCRYPTED_PATTERN.test(v)).length;
  return matchCount / sampleValues.length >= 0.5;
}

// Minimum ratio of matching samples required to flag a column via data
const DATA_MATCH_THRESHOLD = 0.3;

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

function detectByColumnName(columnName: string): PiiCategory | null {
  for (const { pattern, category } of COLUMN_NAME_PATTERNS) {
    if (pattern.test(columnName)) {
      return category;
    }
  }
  return null;
}

function detectByDataSample(sampleValues: string[]): PiiCategory | null {
  if (sampleValues.length === 0) return null;

  for (const { pattern, category } of DATA_PATTERNS) {
    const matchCount = sampleValues.filter((v) => pattern.test(v)).length;
    if (matchCount / sampleValues.length >= DATA_MATCH_THRESHOLD) {
      return category;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect PII for a single column by name and optional data samples.
 * Returns null if no PII is detected.
 */
export function detectColumnPii(columnName: string, sampleValues?: string[]): PiiDetection | null {
  const nameCategory = detectByColumnName(columnName);
  const dataCategory = sampleValues ? detectByDataSample(sampleValues) : null;

  // Check if data appears to be encrypted/Base64 encoded
  if (sampleValues && looksEncrypted(sampleValues)) {
    return {
      category: nameCategory ?? 'encrypted',
      confidence: 'high',
      matchedBy: nameCategory ? 'both' : 'data_sample',
    };
  }

  if (nameCategory && dataCategory) {
    return {
      category: nameCategory,
      confidence: 'high',
      matchedBy: 'both',
    };
  }

  if (nameCategory) {
    return {
      category: nameCategory,
      confidence: 'medium',
      matchedBy: 'column_name',
    };
  }

  if (dataCategory) {
    return {
      category: dataCategory,
      confidence: 'medium',
      matchedBy: 'data_sample',
    };
  }

  return null;
}

/**
 * Detect PII across all columns of a table.
 * Returns a map of column name → PiiDetection (only columns with detected PII).
 */
export function detectTablePii(
  columns: { name: string; samples?: string[] }[],
): Record<string, PiiDetection> {
  const detections: Record<string, PiiDetection> = {};

  for (const col of columns) {
    const detection = detectColumnPii(col.name, col.samples);
    if (detection) {
      detections[col.name] = detection;
    }
  }

  return detections;
}
