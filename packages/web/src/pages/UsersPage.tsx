// Users page (Phase 3 #14). JSX moved verbatim from the
// `view.page === 'users'` branch of App.tsx.

import type { Dispatch, SetStateAction } from 'react';
import { PageHeader } from '../components/ui/index.js';
import UserManagement from '../components/UserManagement.js';
import type { Profile } from '../types/schema.js';
import type { View } from '../router/index.js';

interface UsersPageProps {
  view: Extract<View, { page: 'users' }>;
  setView: Dispatch<SetStateAction<View>>;
  profiles: Profile[];
}

export default function UsersPage({ view, setView, profiles }: UsersPageProps) {
  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumb={[
          { label: 'Dashboard', onClick: () => setView({ page: 'dashboard' }) },
          { label: 'Users' },
        ]}
        title="Users & Access"
        description="Manage administrator accounts and end-user access to your MCP profiles."
      />
      <UserManagement profiles={profiles} initialSelectedUserId={view.selectedUserId} />
    </div>
  );
}
