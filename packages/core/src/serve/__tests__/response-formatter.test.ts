import { describe, it, expect } from 'vitest';
import {
  snakeCaseToLabel,
  friendlyType,
  buildLabelMap,
  buildReverseLabelMap,
  formatResponseRows,
} from '../response-formatter.js';

// ---------------------------------------------------------------------------
// snakeCaseToLabel
// ---------------------------------------------------------------------------

describe('snakeCaseToLabel', () => {
  it('converts a simple snake_case identifier', () => {
    expect(snakeCaseToLabel('user_accounts')).toBe('User Accounts');
  });

  it('converts a single underscore between words', () => {
    expect(snakeCaseToLabel('created_at')).toBe('Created At');
  });

  it('converts a multi-part snake_case identifier', () => {
    expect(snakeCaseToLabel('billing_invoices')).toBe('Billing Invoices');
  });

  it('converts camelCase to Title Case', () => {
    expect(snakeCaseToLabel('firstName')).toBe('First Name');
  });

  it('converts PascalCase to Title Case', () => {
    expect(snakeCaseToLabel('UserProfile')).toBe('User Profile');
  });

  it('handles a single lowercase word', () => {
    expect(snakeCaseToLabel('id')).toBe('Id');
  });

  it('handles a single uppercase word', () => {
    expect(snakeCaseToLabel('ID')).toBe('Id');
  });

  it('handles consecutive uppercase letters followed by lowercase (e.g. userID)', () => {
    // "userID" -> "user" + "ID" -> "User Id"
    const result = snakeCaseToLabel('userID');
    // The camelCase splitter separates "user" and "ID"
    expect(result).toBe('User Id');
  });

  it('handles numbers in the name', () => {
    expect(snakeCaseToLabel('plan_v2')).toBe('Plan V2');
  });

  it('handles multiple consecutive underscores gracefully', () => {
    // Empty segments between underscores are filtered out
    const result = snakeCaseToLabel('a__b');
    expect(result).toBe('A B');
  });

  it('returns the same word when no separators exist', () => {
    expect(snakeCaseToLabel('email')).toBe('Email');
  });

  it('handles empty string', () => {
    expect(snakeCaseToLabel('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// friendlyType
// ---------------------------------------------------------------------------

describe('friendlyType', () => {
  it.each([
    ['integer', 'Nombre'],
    ['int', 'Nombre'],
    ['int2', 'Nombre'],
    ['int4', 'Nombre'],
    ['int8', 'Nombre'],
    ['smallint', 'Nombre'],
    ['bigint', 'Nombre'],
    ['serial', 'Nombre'],
    ['smallserial', 'Nombre'],
    ['bigserial', 'Nombre'],
    ['numeric', 'Nombre'],
    ['decimal', 'Nombre'],
    ['real', 'Nombre'],
    ['float4', 'Nombre'],
    ['float8', 'Nombre'],
    ['double precision', 'Nombre'],
    ['money', 'Nombre'],
    ['oid', 'Nombre'],
  ])('maps numeric SQL type %s to "Nombre"', (sqlType, expected) => {
    expect(friendlyType(sqlType)).toBe(expected);
  });

  it.each([
    ['boolean', 'Oui/Non'],
    ['bool', 'Oui/Non'],
  ])('maps boolean SQL type %s to "Oui/Non"', (sqlType, expected) => {
    expect(friendlyType(sqlType)).toBe(expected);
  });

  it.each([
    ['timestamp', 'Date'],
    ['timestamp with time zone', 'Date'],
    ['timestamp without time zone', 'Date'],
    ['timestamptz', 'Date'],
    ['date', 'Date'],
    ['time', 'Date'],
    ['time with time zone', 'Date'],
    ['time without time zone', 'Date'],
    ['timetz', 'Date'],
    ['interval', 'Date'],
  ])('maps date/time SQL type %s to "Date"', (sqlType, expected) => {
    expect(friendlyType(sqlType)).toBe(expected);
  });

  it.each([
    ['json', 'Donnees'],
    ['jsonb', 'Donnees'],
  ])('maps JSON SQL type %s to "Donnees"', (sqlType, expected) => {
    expect(friendlyType(sqlType)).toBe(expected);
  });

  it.each([
    ['text', 'Texte'],
    ['varchar', 'Texte'],
    ['character varying', 'Texte'],
    ['char', 'Texte'],
    ['uuid', 'Texte'],
    ['inet', 'Texte'],
    ['cidr', 'Texte'],
    ['unknown_type', 'Texte'],
  ])('defaults SQL type %s to "Texte"', (sqlType, expected) => {
    expect(friendlyType(sqlType)).toBe(expected);
  });

  it('is case-insensitive', () => {
    expect(friendlyType('INTEGER')).toBe('Nombre');
    expect(friendlyType('Boolean')).toBe('Oui/Non');
    expect(friendlyType('TIMESTAMP')).toBe('Date');
  });

  it('trims whitespace before matching', () => {
    expect(friendlyType('  integer  ')).toBe('Nombre');
  });
});

// ---------------------------------------------------------------------------
// buildLabelMap
// ---------------------------------------------------------------------------

describe('buildLabelMap', () => {
  it('auto-generates labels from column names when no custom label is provided', () => {
    const map = buildLabelMap([
      { name: 'user_id' },
      { name: 'created_at' },
      { name: 'email' },
    ]);
    expect(map).toEqual({
      user_id: 'User Id',
      created_at: 'Created At',
      email: 'Email',
    });
  });

  it('uses the custom label when provided', () => {
    const map = buildLabelMap([
      { name: 'user_id', label: 'Identifiant' },
      { name: 'email' },
    ]);
    expect(map).toEqual({
      user_id: 'Identifiant',
      email: 'Email',
    });
  });

  it('mixes custom and auto-generated labels', () => {
    const map = buildLabelMap([
      { name: 'first_name', label: 'Prenom' },
      { name: 'last_name' },
      { name: 'age', label: 'Age' },
    ]);
    expect(map).toEqual({
      first_name: 'Prenom',
      last_name: 'Last Name',
      age: 'Age',
    });
  });

  it('returns an empty object for an empty column array', () => {
    expect(buildLabelMap([])).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// buildReverseLabelMap
// ---------------------------------------------------------------------------

describe('buildReverseLabelMap', () => {
  it('builds the inverse map from a label map', () => {
    const labelMap = { user_id: 'User Id', email: 'Email', created_at: 'Created At' };
    const reverse = buildReverseLabelMap(labelMap);
    expect(reverse).toEqual({
      'User Id': 'user_id',
      'Email': 'email',
      'Created At': 'created_at',
    });
  });

  it('round-trips correctly through both maps', () => {
    const cols = [
      { name: 'billing_address' },
      { name: 'phone_number', label: 'Telephone' },
      { name: 'zip_code' },
    ];
    const labelMap = buildLabelMap(cols);
    const reverse = buildReverseLabelMap(labelMap);

    for (const col of cols) {
      const label = labelMap[col.name];
      expect(reverse[label]).toBe(col.name);
    }
  });

  it('returns an empty object for an empty label map', () => {
    expect(buildReverseLabelMap({})).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// formatResponseRows
// ---------------------------------------------------------------------------

describe('formatResponseRows', () => {
  const labelMap = {
    user_id: 'User Id',
    first_name: 'First Name',
    created_at: 'Created At',
  };

  it('returns rows as-is in raw mode (no allocation)', () => {
    const rows = [{ user_id: 1, first_name: 'Alice' }];
    const result = formatResponseRows(rows, labelMap, 'raw');
    // Should be the exact same reference
    expect(result).toBe(rows);
  });

  it('keeps snake_case keys unchanged in friendly mode (no Title Case renaming)', () => {
    // Keys must stay snake_case in all modes so LLM chaining works:
    // a column name read from a query result can be used verbatim as a filter key.
    const rows = [
      { user_id: 1, first_name: 'Alice', created_at: '2024-01-01' },
      { user_id: 2, first_name: 'Bob', created_at: '2024-01-02' },
    ];
    const result = formatResponseRows(rows, labelMap, 'friendly');
    expect(result).toEqual([
      { user_id: 1, first_name: 'Alice', created_at: '2024-01-01' },
      { user_id: 2, first_name: 'Bob', created_at: '2024-01-02' },
    ]);
  });

  it('keeps all keys (including unknown) unchanged in friendly mode', () => {
    const rows = [{ user_id: 1, unknown_col: 'x' }];
    const result = formatResponseRows(rows, labelMap, 'friendly');
    expect(result[0]).toHaveProperty('user_id', 1);
    expect(result[0]).toHaveProperty('unknown_col', 'x');
  });

  it('returns empty array unchanged in both modes', () => {
    expect(formatResponseRows([], labelMap, 'friendly')).toEqual([]);
    expect(formatResponseRows([], labelMap, 'raw')).toEqual([]);
  });

  it('does not mutate the original rows', () => {
    const rows = [{ user_id: 1, first_name: 'Alice' }];
    const copy = JSON.stringify(rows);
    formatResponseRows(rows, labelMap, 'friendly');
    expect(JSON.stringify(rows)).toBe(copy);
  });

  it('handles nested object values without modifying them', () => {
    const rows = [{ user_id: 1, first_name: { nested: true } }];
    const result = formatResponseRows(rows, labelMap, 'friendly');
    expect(result[0]['first_name']).toEqual({ nested: true });
  });

  it('handles null and undefined values without throwing', () => {
    const rows = [{ user_id: null, first_name: undefined }];
    const result = formatResponseRows(rows, labelMap, 'friendly');
    expect(result[0]['user_id']).toBeNull();
    expect(result[0]['first_name']).toBeUndefined();
  });
});
