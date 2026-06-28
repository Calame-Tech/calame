import { describe, it, expect, vi } from 'vitest';
import { executeWithAudit } from '../audit.js';
import type { ExecuteQuery } from '../../scoped-executor.js';
import type { AuditLogEntry } from '../../types.js';

const executeQuery: ExecuteQuery = async () => ({ rows: [], fields: [] });

function baseOpts(onAuditLog?: (e: Omit<AuditLogEntry, 'id' | 'timestamp'>) => void) {
  return { executeQuery, profileName: 'p', toolName: 'query', toolArgs: { table: 't' }, onAuditLog };
}

describe('executeWithAudit', () => {
  it('passes executeQuery to the body and returns its content on success', async () => {
    const log = vi.fn();
    let received: ExecuteQuery | undefined;
    const res = await executeWithAudit(baseOpts(log), async (exec) => {
      received = exec;
      return { content: [{ type: 'text', text: 'ok' }], resultSummary: '1 row', resultData: '[]' };
    });

    expect(received).toBe(executeQuery);
    expect(res).toEqual({ content: [{ type: 'text', text: 'ok' }], isError: undefined });
    expect(log).toHaveBeenCalledTimes(1);
    const entry = log.mock.calls[0][0];
    expect(entry).toMatchObject({
      profileName: 'p',
      toolName: 'query',
      toolArgs: { table: 't' },
      result: 'success',
      resultSummary: '1 row',
      resultData: '[]',
    });
    expect(typeof entry.durationMs).toBe('number');
  });

  it('converts a thrown DB error into a structured error response and logs it', async () => {
    const log = vi.fn();
    const res = await executeWithAudit(baseOpts(log), async () => {
      throw new Error('boom');
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe('Database error: boom');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatchObject({ result: 'error', resultSummary: 'boom' });
  });

  it('marks an isError result from the body as an error in the audit log', async () => {
    const log = vi.fn();
    const res = await executeWithAudit(baseOpts(log), async () => ({
      content: [{ type: 'text', text: 'nope' }],
      isError: true,
    }));

    expect(res.isError).toBe(true);
    expect(log.mock.calls[0][0].result).toBe('error');
  });

  it('works without an onAuditLog callback', async () => {
    const res = await executeWithAudit(baseOpts(), async () => ({
      content: [{ type: 'text', text: 'ok' }],
    }));
    expect(res).toEqual({ content: [{ type: 'text', text: 'ok' }], isError: undefined });
  });
});
