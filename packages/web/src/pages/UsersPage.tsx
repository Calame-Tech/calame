// Users page (Phase 3 #14). Two tabs: the user management panel (moved
// verbatim from App.tsx) and the read-only access matrix (users × servers).

import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslations } from 'use-intl/react';
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
  const t = useTranslations('users');
  const tCommon = useTranslations('common');
  const [tab, setTab] = useState<UsersTab>('users');

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumb={[
          { label: tCommon('dashboard'), onClick: () => setView({ page: 'dashboard' }) },
          { label: t('page.breadcrumbUsers') },
        ]}
        title={t('page.title')}
        description={t('page.description')}
        actions={
          <SegmentedControl<UsersTab>
            ariaLabel={t('page.viewAriaLabel')}
            options={[
              { value: 'users', label: t('page.tabUsers') },
              {
                value: 'matrix',
                label: t('page.tabMatrix'),
                description: t('page.tabMatrixDescription'),
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
