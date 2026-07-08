// SchemaExplorer component tests (Lot D2) — smoke coverage for the new
// `tableOptions` prop that surfaces a compact R/W badge on selected tables.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import SchemaExplorer from '../SchemaExplorer.js';
import type { DatabaseSchema } from '../../types/schema.js';

const schema: DatabaseSchema = {
  tables: [
    {
      name: 'orders',
      schema: 'public',
      columns: [{ name: 'id', type: 'int', nullable: false, defaultValue: null }],
      primaryKeys: ['id'],
    },
    {
      name: 'customers',
      schema: 'public',
      columns: [{ name: 'id', type: 'int', nullable: false, defaultValue: null }],
      primaryKeys: ['id'],
    },
  ],
  relations: [],
};

describe('SchemaExplorer', () => {
  it('renders without tableOptions (no behavior change for existing callers)', () => {
    render(
      <SchemaExplorer
        schema={schema}
        selectedTables={{ orders: new Set(['id']) }}
        onSelectionChange={() => {}}
      />,
    );
    expect(screen.getByText('orders')).toBeTruthy();
    expect(screen.queryByText('W')).toBeNull();
    expect(screen.queryByText('R')).toBeNull();
  });

  it('shows an amber W badge on a selected table with the write tool enabled', () => {
    render(
      <SchemaExplorer
        schema={schema}
        selectedTables={{ orders: new Set(['id']) }}
        onSelectionChange={() => {}}
        tableOptions={{
          orders: {
            enabledTools: ['describe', 'query', 'write'],
            maxLimit: 100,
            filterableColumns: [],
            groupableColumns: [],
          },
        }}
      />,
    );
    expect(screen.getByText('W')).toBeTruthy();
  });

  it('shows a gray R badge on a selected table without the write tool', () => {
    render(
      <SchemaExplorer
        schema={schema}
        selectedTables={{ orders: new Set(['id']) }}
        onSelectionChange={() => {}}
        tableOptions={{
          orders: {
            enabledTools: ['describe', 'query'],
            maxLimit: 100,
            filterableColumns: [],
            groupableColumns: [],
          },
        }}
      />,
    );
    expect(screen.getByText('R')).toBeTruthy();
  });

  it('does not render a badge for tables with no column selected', () => {
    render(
      <SchemaExplorer
        schema={schema}
        selectedTables={{ orders: new Set(['id']) }}
        onSelectionChange={() => {}}
        tableOptions={{
          orders: {
            enabledTools: ['describe', 'query', 'write'],
            maxLimit: 100,
            filterableColumns: [],
            groupableColumns: [],
          },
        }}
      />,
    );
    // customers has no selection — no badge should render for it, and only
    // one W badge should exist (for orders).
    expect(screen.getAllByText('W')).toHaveLength(1);
  });
});
