// Introspection
export { introspectDatabase } from './introspect/postgres.js';
export type {
  DatabaseSchema,
  TableInfo,
  ColumnInfo,
  Relation,
  TableToolOptions,
} from './introspect/types.js';

// Serve (dynamic runtime engine)
export { registerDynamicTools, computeDistinctValues, snakeCaseToLabel, friendlyType, buildLabelMap, buildReverseLabelMap, formatResponseRows } from './serve/index.js';
export type { ComputeDistinctValuesOptions } from './serve/index.js';
export type {
  ServeConfig,
  ServeProfile,
  ServeConfiguration,
  AuditLogEntry,
  PendingWriteQuery,
  NamedConnection,
  DataScopeRule,
  UserIdentity,
  ResolvedScopeFilter,
} from './serve/types.js';
export { resolveUserScope, getTableScopeStatus } from './serve/scope-resolver.js';
export type { TableScopeStatus } from './serve/scope-resolver.js';
export { createScopeGuard, ScopeBlockedError } from './serve/scoped-executor.js';
export type { ScopeGuard } from './serve/scoped-executor.js';

// PII detection & masking
export type {
  PiiCategory,
  MaskingMode,
  PiiDetection,
  ColumnMasking,
  GlobalMaskingRule,
} from './pii/types.js';
export { detectColumnPii, detectTablePii } from './pii/detector.js';

// Sources — abstract adapter system
export * from './sources/index.js';
