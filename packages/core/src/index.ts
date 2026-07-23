// Introspection — the schema TYPES are the shared contract; the actual
// per-dialect introspection lives behind `DatabaseConnector.introspect()` in
// `@calame/connectors` (postgresql / mysql / sqlite), which depends on these
// types. Keeping implementations there avoids a core ↔ connectors cycle.
export type {
  DatabaseSchema,
  TableInfo,
  ColumnInfo,
  Relation,
  TableToolOptions,
} from './introspect/types.js';

// Serve (dynamic runtime engine)
export {
  registerDynamicTools,
  registerCalcTool,
  computeDistinctValues,
  snakeCaseToLabel,
  friendlyType,
  buildLabelMap,
  buildReverseLabelMap,
  formatResponseRows,
} from './serve/index.js';
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
export {
  scanTextForPii,
  applyPiiMasking,
  DEFAULT_TEXT_PII_CATEGORIES,
} from './pii/text-scanner.js';
export type { PiiSpan, TextMaskingMode } from './pii/text-scanner.js';

// Sources — abstract adapter system
export * from './sources/index.js';

// Utils
export { truncate } from './utils.js';
