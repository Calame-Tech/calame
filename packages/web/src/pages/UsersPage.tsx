// Users page (Phase 3 #14). Two tabs: the user management panel (moved
// verbatim from App.tsx) and the read-only access matrix (users × servers).

import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { PageHeader, SegmentedControl } from '../components/ui/index.js';
import UserManagement from '../components/UserManagement.js';
import UserAccessMatrix from '../components/UserAccessMatrix.js';
import type { Profile } from '../types/schema.js';
import type { View } from '../router/index.js';

interface UsersPageProps {
  view: Extract<View, { page: 'users' }>;
  setView: Dispatch<SetStateAction<View>>;
  profiles: Profile[];
}

type UsersTab = 'users' | 'matrix';

export default function UsersPage({ view, setView, profiles }: UsersPageProps) {
  const [tab, setTab] = useState<UsersTab>('users');

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumb={[
          { label: 'Dashboard', onClick: () => setView({ page: 'dashboard' }) },
          { label: 'Users' },
        ]}
        title="Users & Access"
        description="Manage administrator accounts and end-user access to your MCP servers."
        actions={
          <SegmentedControl<UsersTab>
            ariaLabel="Users view"
            options={[
              { value: 'users', label: 'Users' },
              {
                value: 'matrix',
                label: 'Access matrix',
                description: 'Audit which users can reach which MCP servers',
              },
            ]}
            value={tab}
            onChange={setTab}
          />
        }
      />
      {tab === 'users' ? (
        <UserManagement profiles={profiles} initialSelectedUserId={view.selectedUserId} />
      ) : (
        <UserAccessMatrix profiles={profiles} />
      )}
    </div>
  );
}
