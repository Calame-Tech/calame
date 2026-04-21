export type PiiCategory =
  | 'email'
  | 'phone'
  | 'name'
  | 'address'
  | 'credit_card'
  | 'password'
  | 'ip_address'
  | 'ssn'
  | 'encrypted';

export type MaskingMode =
  | 'none'
  | 'exclude'
  | 'hash'
  | 'truncate'
  | 'replace'
  | 'aggregate_only';

export interface PiiDetection {
  category: PiiCategory;
  confidence: 'high' | 'medium' | 'low' | 'manual';
  matchedBy: 'column_name' | 'data_sample' | 'both' | 'manual';
}

export interface ColumnMasking {
  piiDetected?: PiiDetection;
  maskingMode: MaskingMode;
  truncateOptions?: {
    showFirst?: number;
    showLast?: number;
  };
  replaceValue?: string;
}

export interface GlobalMaskingRule {
  piiCategory: PiiCategory;
  defaultMode: MaskingMode;
  truncateOptions?: { showFirst?: number; showLast?: number };
  replaceValue?: string;
}
