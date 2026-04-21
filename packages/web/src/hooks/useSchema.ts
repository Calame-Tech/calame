import { useState, useCallback } from 'react';
import type { DatabaseSchema } from '../types/schema.js';

interface UseSchemaResult {
  schema: DatabaseSchema | null;
  status: 'idle' | 'loading' | 'success' | 'error';
  message: string;
  tableCount: number | null;
  connect: (connectionString: string, databaseType?: string) => Promise<DatabaseSchema | null>;
}

export function useSchema(): UseSchemaResult {
  const [schema, setSchema] = useState<DatabaseSchema | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [tableCount, setTableCount] = useState<number | null>(null);

  const connect = useCallback(async (connectionString: string, databaseType?: string): Promise<DatabaseSchema | null> => {
    setStatus('loading');
    setTableCount(null);
    setMessage('');

    try {
      const res = await fetch('/api/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionString, databaseType }),
      });
      const data = await res.json();

      if (!data.success) {
        setStatus('error');
        setMessage(data.message || 'Connection failed');
        return null;
      }

      setMessage('Connection successful! Fetching schema...');

      const schemaRes = await fetch('/api/schema');
      const schemaRaw = await schemaRes.json();
      const schemaData: DatabaseSchema = schemaRaw.schema ?? schemaRaw;
      const count = data.tableCount ?? schemaData.tables.length;

      setSchema(schemaData);
      setTableCount(count);
      setStatus('success');
      setMessage('Connection successful!');

      return schemaData;
    } catch {
      setStatus('error');
      setMessage('Failed to reach the server');
      return null;
    }
  }, []);

  return { schema, status, message, tableCount, connect };
}
