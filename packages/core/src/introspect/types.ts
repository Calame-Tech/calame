export interface DatabaseSchema {
  tables: TableInfo[];
  relations: Relation[];
}

export interface TableInfo {
  name: string;
  schema: string;
  columns: ColumnInfo[];
  primaryKeys: string[];
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  piiDetection?: import('../pii/types.js').PiiDetection;
}

export interface Relation {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

export interface TableToolOptions {
  enabledTools: ('describe' | 'aggregate' | 'query' | 'write')[];
  maxLimit: number;
  filterableColumns: string[];
  groupableColumns: string[];
  columnMasking?: Record<string, import('../pii/types.js').ColumnMasking>;
}
