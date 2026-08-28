import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'use-intl/react';
import { apiFetch } from '../lib/api.js';
import type { UserEntry, AccessMode } from '../types/schema.js';
import { useLocale } from '../i18n/I18nProvider.js';

interface McpUsersProps {
  profileName: string;
  onNavigateToUser?: (userId: string) => void;
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: 'bg-green-900/50 text-green-300 border-green-700',
    disabled: 'bg-red-900/50 text-red-300 border-red-700',
    invited: 'bg-yellow-900/50 text-yellow-300 border-yellow-700',
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${colors[status] ?? 'bg-gray-700 text-gray-300 border-gray-600'}`}
    >
      {status}
    </span>
  );
}

export default function McpUsers({ profileName, onNavigateToUser }: McpUsersProps) {
  const t = useTranslations('mcpList.users');
  const tCommon = useTranslations('common');
  const { locale } = useLocale();
  const [usersOnProfile, setUsersOnProfile] = useState<UserEntry[]>([]);
  const [allUsers, setAllUsers] = useState<UserEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [newToken, setNewToken] = useState<string | null>(null);

  // Quick-create form
  const [showQuickCreate, setShowQuickCreate] = useState(false);
  const [qcName, setQcName] = useState('');
  const [qcEmail, setQcEmail] = useState('');
  const [qcAccessMode, setQcAccessMode] = useState<AccessMode>('both');

  // Add existing user
  const [showAddExisting, setShowAddExisting] = useState(false);
  const [addAccessMode, setAddAccessMode] = useState<AccessMode>('both');

  const fetchUsers = useCallback(async () => {
    try {
      const [profileRes, allRes] = await Promise.all([
        apiFetch(`/api/users?profileName=${profileName}`, { credentials: 'include' }),
        apiFetch('/api/users', { credentials: 'include' }),
      ]);
      const profileData = await profileRes.json();
      const allData = await allRes.json();

      if (profileData.success) setUsersOnProfile(profileData.users);
      if (allData.success) setAllUsers(allData.users);
    } catch {
      setError(t('errors.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [profileName]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  // Users NOT on this profile (for the "add existing" dropdown)
  const usersNotOnProfile = allUsers.filter(
    (u) => !u.profiles.some((p) => p.profileName === profileName),
  );

  const handleRemoveFromProfile = async (userId: string) => {
    if (!confirm(t('confirmRemove'))) return;
    try {
      const res = await apiFetch(`/api/users/${userId}/profiles/${profileName}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await res.json();
      if (data.success) fetchUsers();
      else setError(data.message);
    } catch {
      setError(t('errors.removeFailed'));
    }
  };

  const handleAddExistingUser = async (userId: string) => {
    try {
      const res = await apiFetch(`/api/users/${userId}/profiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          profileName,
          accessMode: addAccessMode,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setShowAddExisting(false);
        fetchUsers();
      } else {
        setError(data.message);
      }
    } catch {
      setError(t('errors.addFailed'));
    }
  };

  const handleQuickCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const res = await apiFetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: qcName,
          email: qcEmail,
          role: 'user',
          profiles: [{ profileName, accessMode: qcAccessMode }],
        }),
      });
      const data = await res.json();
      if (data.success) {
        setNewToken(data.plaintextToken);
        setShowQuickCreate(false);
        setQcName('');
        setQcEmail('');
        setQcAccessMode('both');
        fetchUsers();
      } else {
        setError(data.message);
      }
    } catch {
      setError(t('errors.createFailed'));
    }
  };

  const formatDate = (date: string | null) => {
    if (!date) return '—';
    return new Date(date).toLocaleDateString(locale, {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="space-y-4">
      {/* Action buttons */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            setShowQuickCreate(!showQuickCreate);
            setShowAddExisting(false);
          }}
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded transition-colors"
        >
          {t('newUserButton')}
        </button>
        {usersNotOnProfile.length > 0 && (
          <button
            onClick={() => {
              setShowAddExisting(!showAddExisting);
              setShowQuickCreate(false);
            }}
            className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded transition-colors"
          >
            {t('addExistingButton')}
          </button>
        )}
      </div>

      {/* Token display */}
      {newToken && (
        <div className="bg-green-900/30 border border-green-700 rounded-lg p-3">
          <p className="text-green-300 text-sm font-medium mb-1">{t('tokenDisplay.heading')}</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-gray-800 px-3 py-1.5 rounded text-green-300 text-xs font-mono break-all">
              {newToken}
            </code>
            <button
              onClick={() => navigator.clipboard.writeText(newToken)}
              className="px-2 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs rounded"
            >
              {t('tokenDisplay.copy')}
            </button>
            <button
              onClick={() => setNewToken(null)}
              className="text-gray-500 hover:text-white text-xs"
            >
              {t('tokenDisplay.dismiss')}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-lg p-2 text-red-300 text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 text-red-400 hover:text-red-200">
            ×
          </button>
        </div>
      )}

      {/* Quick-create form */}
      {showQuickCreate && (
        <form onSubmit={handleQuickCreate} className="card-nested p-3 space-y-2">
          <h4 className="text-sm text-gray-200 font-medium">
            {t('quickCreate.heading', { profileName })}
          </h4>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder={t('quickCreate.namePlaceholder')}
              value={qcName}
              onChange={(e) => setQcName(e.target.value)}
              className="input-editorial flex-1 text-sm"
              required
            />
            <input
              type="email"
              placeholder={t('quickCreate.emailPlaceholder')}
              value={qcEmail}
              onChange={(e) => setQcEmail(e.target.value)}
              className="input-editorial flex-1 text-sm"
              required
            />
            <select
              value={qcAccessMode}
              onChange={(e) => setQcAccessMode(e.target.value as AccessMode)}
              className="input-editorial text-sm"
            >
              <option value="both">{t('accessMode.both')}</option>
              <option value="mcp">{t('accessMode.mcp')}</option>
              <option value="chat">{t('accessMode.chat')}</option>
            </select>
            <button
              type="submit"
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded"
            >
              {t('quickCreate.createButton')}
            </button>
            <button
              type="button"
              onClick={() => setShowQuickCreate(false)}
              className="px-2 py-1.5 text-gray-400 hover:text-white text-sm"
            >
              {tCommon('cancel')}
            </button>
          </div>
        </form>
      )}

      {/* Add existing user */}
      {showAddExisting && (
        <div className="card-nested p-3 space-y-2">
          <h4 className="text-sm text-gray-200 font-medium">
            {t('addExisting.heading', { profileName })}
          </h4>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs text-gray-400">{t('addExisting.accessModeLabel')}</span>
            <select
              value={addAccessMode}
              onChange={(e) => setAddAccessMode(e.target.value as AccessMode)}
              className="input-editorial text-xs"
            >
              <option value="both">{t('accessMode.both')}</option>
              <option value="mcp">{t('accessMode.mcp')}</option>
              <option value="chat">{t('accessMode.chat')}</option>
            </select>
          </div>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {usersNotOnProfile.map((u) => (
              <div
                key={u.id}
                className="flex items-center justify-between px-2 py-1.5 rounded hover:bg-gray-700"
              >
                <div>
                  <span className="text-sm text-white">{u.name}</span>
                  <span className="text-xs text-gray-500 ml-2">{u.email}</span>
                </div>
                <button
                  onClick={() => handleAddExistingUser(u.id)}
                  className="px-2 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded"
                >
                  {t('addExisting.addButton')}
                </button>
              </div>
            ))}
          </div>
          <button
            onClick={() => setShowAddExisting(false)}
            className="text-xs text-gray-400 hover:text-white"
          >
            {tCommon('cancel')}
          </button>
        </div>
      )}

      {/* Users list */}
      {loading ? (
        <div className="text-gray-500 text-sm text-center py-4">{t('loading')}</div>
      ) : usersOnProfile.length === 0 ? (
        <div className="text-gray-500 text-sm text-center py-4">{t('emptyState')}</div>
      ) : (
        <table className="w-full text-sm text-left">
          <thead className="text-gray-400 border-b border-white/5">
            <tr>
              <th className="px-3 py-2">{t('table.colName')}</th>
              <th className="px-3 py-2">{t('table.colEmail')}</th>
              <th className="px-3 py-2">{t('table.colAccess')}</th>
              <th className="px-3 py-2">{t('table.colStatus')}</th>
              <th className="px-3 py-2">{t('table.colLastActive')}</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="text-gray-300">
            {usersOnProfile.map((user) => {
              const pa = user.profiles.find((p) => p.profileName === profileName);
              return (
                <tr
                  key={user.id}
                  className="border-b border-white/5 hover:bg-gray-800/50 cursor-pointer"
                  onClick={() => onNavigateToUser?.(user.id)}
                >
                  <td className="px-3 py-2 font-medium text-white">{user.name}</td>
                  <td className="px-3 py-2">{user.email}</td>
                  <td className="px-3 py-2">
                    <span className="text-xs text-gray-400">{pa?.accessMode ?? '—'}</span>
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={user.status} />
                  </td>
                  <td className="px-3 py-2 text-gray-500">{formatDate(user.lastActiveAt)}</td>
                  <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={() => handleRemoveFromProfile(user.id)}
                      className="px-2 py-1 bg-red-900/50 hover:bg-red-900 text-red-300 text-xs rounded transition-colors"
                    >
                      {t('table.removeButton')}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
