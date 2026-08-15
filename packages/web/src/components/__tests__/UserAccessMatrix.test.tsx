// UserAccessMatrix tests — the audit matrix (users × MCP servers) and the
// pure access-derivation helper.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import UserAccessMatrix, { describeAccess } from '../UserAccessMatrix.js';
import { makeProfile, flushEffects } from '../../pages/__tests__/testUtils.js';
import type { UserEntry, UserProfileAccess } from '../../types/schema.js';

function makeUser(overrides: Partial<UserEntry> = {}): UserEntry {
  return {
    id: 'u1',
    name: 'Alice',
    email: 'alice@example.com',
    role: 'user',
    status: 'active',
    profiles: [],
    createdAt: new Date().toISOString(),
    lastActiveAt: null,
    disabledAt: null,
    disabledReason: null,
    onboardingCode: null,
    onboardingExpiresAt: null,
    ...overrides,
  };
}

function stubUsersFetch(users: UserEntry[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, users }),
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('describeAccess', () => {
  it('derives R+W when all tools are allowed (null)', () => {
    const access: UserProfileAccess = {
      profileName: 'default',
      allowedTables: null,
      allowedTools: null,
      accessMode: 'both',
    };
    const d = describeAccess(access);
    expect(d.label).toBe('R+W');
    expect(d.restricted).toBe(false);
    expect(d.title).toContain('write allowed');
  });

  it('derives R with a restriction marker for a scoped grant', () => {
    const access: UserProfileAccess = {
      profileName: 'default',
      allowedTables: ['orders', 'invoices'],
      allowedTools: ['query', 'describe'],
      accessMode: 'mcp',
    };
    const d = describeAccess(access);
    expect(d.label).toBe('R');
    expect(d.restricted).toBe(true);
    expect(d.title).toContain('restricted to 2 tables');
  });

  it('derives R+W when write is explicitly listed', () => {
    const access: UserProfileAccess = {
      profileName: 'default',
      allowedTables: null,
      allowedTools: ['query', 'write'],
      accessMode: 'chat',
    };
    expect(describeAccess(access).label).toBe('R+W');
  });
});

describe('UserAccessMatrix', () => {
  it('renders one row per user with access badges and empty cells', async () => {
    stubUsersFetch([
      makeUser({
        id: 'u1',
        name: 'Alice',
        profiles: [
          { profileName: 'default', allowedTables: null, allowedTools: null, accessMode: 'both' },
        ],
      }),
      makeUser({
        id: 'u2',
        name: 'Bob',
        email: 'bob@example.com',
        profiles: [
          {
            profileName: 'default',
            allowedTables: ['orders'],
            allowedTools: ['query'],
            accessMode: 'mcp',
          },
        ],
      }),
    ]);
    render(
      <UserAccessMatrix
        profiles={[makeProfile(), makeProfile({ name: 'analytics', label: 'Analytics' })]}
      />,
    );
    await flushEffects();

    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('Bob')).toBeTruthy();
    // Server columns
    expect(screen.getByText('Default')).toBeTruthy();
    expect(screen.getByText('Analytics')).toBeTruthy();
    // Alice: full access → R+W; Bob: query-only + table scope → R
    expect(screen.getByText('R+W')).toBeTruthy();
    expect(screen.getByText('R')).toBeTruthy();
    // Neither user has access to the second server → two empty cells
    expect(screen.getAllByLabelText('No access')).toHaveLength(2);
    // Bob's grant is table-restricted
    expect(screen.getByLabelText('Table-restricted')).toBeTruthy();
  });

  it('shows an empty state when there are no users', async () => {
    stubUsersFetch([]);
    render(<UserAccessMatrix profiles={[makeProfile()]} />);
    await flushEffects();
    expect(screen.getByText('No users yet')).toBeTruthy();
  });

  it('shows an empty state when there are no servers', async () => {
    stubUsersFetch([makeUser()]);
    render(<UserAccessMatrix profiles={[]} />);
    await flushEffects();
    expect(screen.getByText('No MCP servers')).toBeTruthy();
  });
});
