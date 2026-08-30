import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslations } from 'use-intl/react';
import { apiFetch } from '../lib/api.js';
import type { UserEntry, AccessMode, Profile } from '../types/schema.js';
import HelpTip from './HelpTip.js';
import { useLocale } from '../i18n/I18nProvider.js';

interface UserManagementProps {
  profiles: Profile[];
  initialSelectedUserId?: string;
}

/** Status badge with color coding */
function StatusBadge({ status }: { status: string }) {
  const t = useTranslations('userManagement');
  const statusTooltip: Record<string, string> = {
    active: t('statusTooltip.active'),
    disabled: t('statusTooltip.disabled'),
    invited: t('statusTooltip.invited'),
  };
  const colors: Record<string, string> = {
    active: 'bg-green-900/50 text-green-300 border-green-700',
    disabled: 'bg-red-900/50 text-red-300 border-red-700',
    invited: 'bg-yellow-900/50 text-yellow-300 border-yellow-700',
  };
  return (
    <span
      title={statusTooltip[status] ?? t('statusTooltip.fallback', { status })}
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${colors[status] ?? 'bg-gray-700 text-gray-300 border-gray-600'}`}
    >
      {status}
    </span>
  );
}

/** Inline editor for custom attributes (key-value pairs) with save to API */
function CustomAttributesEditor({
  userId,
  initialAttrs,
  onSaved,
}: {
  userId: string;
  initialAttrs: Record<string, string> | null;
  onSaved: () => void;
}) {
  const t = useTranslations('userManagement');
  const tCommon = useTranslations('common');
  const [attrs, setAttrs] = useState<Array<{ key: string; value: string }>>(
    initialAttrs ? Object.entries(initialAttrs).map(([key, value]) => ({ key, value })) : [],
  );
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Resync attrs when the displayed user changes (userId/initialAttrs come from a new user selection)
  const prevUserIdRef = useRef(userId);
  useEffect(() => {
    if (prevUserIdRef.current !== userId) {
      prevUserIdRef.current = userId;
      setAttrs(
        initialAttrs ? Object.entries(initialAttrs).map(([key, value]) => ({ key, value })) : [],
      );
      setDirty(false);
    }
  }, [userId, initialAttrs]);

  const updateAttr = (index: number, field: 'key' | 'value', val: string) => {
    const updated = [...attrs];
    updated[index] = { ...updated[index], [field]: val };
    setAttrs(updated);
    setDirty(true);
  };

  const addAttr = () => {
    setAttrs([...attrs, { key: '', value: '' }]);
    setDirty(true);
  };

  const removeAttr = (index: number) => {
    setAttrs(attrs.filter((_, i) => i !== index));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const customAttributes =
        attrs.length > 0
          ? Object.fromEntries(attrs.filter((a) => a.key).map((a) => [a.key, a.value]))
          : null;
      await apiFetch(`/api/users/${userId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ customAttributes }),
      });
      setDirty(false);
      onSaved();
    } catch {
      /* ignore */
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm text-gray-400">{t('customAttributes.title')}</span>
        <div className="flex items-center gap-2">
          {dirty && (
            <button
              onClick={save}
              disabled={saving}
              className="text-xs px-2 py-0.5 bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-40 transition-colors"
            >
              {saving ? t('customAttributes.saving') : tCommon('save')}
            </button>
          )}
          <button onClick={addAttr} className="text-xs text-blue-400 hover:text-blue-300">
            {t('customAttributes.add')}
          </button>
        </div>
      </div>
      {attrs.length > 0 ? (
        <div className="space-y-1.5">
          {attrs.map((attr, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <input
                type="text"
                value={attr.key}
                onChange={(e) => updateAttr(i, 'key', e.target.value)}
                placeholder={t('customAttributes.keyPlaceholder')}
                className="flex-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 font-mono"
              />
              <span className="text-gray-600">=</span>
              <input
                type="text"
                value={attr.value}
                onChange={(e) => updateAttr(i, 'value', e.target.value)}
                placeholder={t('customAttributes.valuePlaceholder')}
                className="flex-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 font-mono"
              />
              <button
                onClick={() => removeAttr(i)}
                className="text-gray-500 hover:text-red-400 text-xs"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-gray-500">{t('customAttributes.empty')}</p>
      )}
    </div>
  );
}

/** Inline detail panel for a user — allows editing profiles */
function UserDetailPanel({
  user: initialUser,
  profiles: availableProfiles,
  onClose,
  onUpdate,
  formatDate,
}: {
  user: UserEntry;
  profiles: Profile[];
  onClose: () => void;
  onUpdate: () => void;
  formatDate: (d: string | null) => string;
}) {
  const t = useTranslations('userManagement');
  const tCommon = useTranslations('common');
  const [user, setUser] = useState(initialUser);
  const [addingProfile, setAddingProfile] = useState(false);
  const [newProfileName, setNewProfileName] = useState('');
  const [newAccessMode, setNewAccessMode] = useState<AccessMode>('both');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  // Keep in sync when parent changes the selected user
  useEffect(() => {
    setUser(initialUser);
  }, [initialUser]);

  // Re-fetch user data from API to get fresh state
  const refreshUser = async () => {
    try {
      const res = await apiFetch(`/api/users/${user.id}`, { credentials: 'include' });
      const data = await res.json();
      if (data.success) setUser(data.user);
    } catch {
      /* ignore */
    }
    onUpdate();
  };

  const profilesNotAdded = availableProfiles.filter(
    (p) => !user.profiles.some((up) => up.profileName === p.name),
  );

  const handleAddProfile = async () => {
    if (!newProfileName) return;
    setError('');
    try {
      const res = await apiFetch(`/api/users/${user.id}/profiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ profileName: newProfileName, accessMode: newAccessMode }),
      });
      const data = await res.json();
      if (data.success) {
        setAddingProfile(false);
        setNewProfileName('');
        await refreshUser();
      } else {
        setError(data.message);
      }
    } catch {
      setError(t('errors.addProfileFailed'));
    }
  };

  const handleRemoveProfile = async (profileName: string) => {
    if (user.profiles.length <= 1) {
      setError(t('errors.cannotRemoveLastProfile'));
      return;
    }
    try {
      const res = await apiFetch(`/api/users/${user.id}/profiles/${profileName}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await res.json();
      if (data.success) await refreshUser();
      else setError(data.message);
    } catch {
      setError(t('errors.removeProfileFailed'));
    }
  };

  const onboardingLink = user.onboardingCode
    ? `${window.location.origin}/welcome/${user.onboardingCode}`
    : null;
  const onboardingExpired = user.onboardingExpiresAt
    ? new Date(user.onboardingExpiresAt) < new Date()
    : true;

  return (
    <div className="card-primary p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="heading-md">{user.name}</h3>
        <button onClick={onClose} className="text-gray-400 hover:text-white">
          ×
        </button>
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded p-2 text-red-300 text-xs">
          {error}
          <button onClick={() => setError('')} className="ml-2 text-red-400">
            ×
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <span className="text-gray-500">{t('detail.email')}</span>{' '}
          <span className="text-gray-300">{user.email}</span>
        </div>
        <div>
          <span className="text-gray-500">{t('detail.role')}</span>{' '}
          <span className="text-gray-300">{user.role}</span>
        </div>
        <div>
          <span className="text-gray-500">{t('detail.status')}</span>{' '}
          <StatusBadge status={user.status} />
        </div>
        <div>
          <span className="text-gray-500">{t('detail.created')}</span>{' '}
          <span className="text-gray-300">{formatDate(user.createdAt)}</span>
        </div>
        {user.disabledReason && (
          <div className="col-span-2">
            <span className="text-gray-500">{t('detail.disabledReason')}</span>{' '}
            <span className="text-red-300">{user.disabledReason}</span>
          </div>
        )}
      </div>

      {/* Custom Attributes editor */}
      <CustomAttributesEditor
        userId={user.id}
        initialAttrs={user.customAttributes ?? null}
        onSaved={refreshUser}
      />

      {/* Invitation link */}
      {onboardingLink && !onboardingExpired && (
        <div className="bg-blue-900/20 border border-blue-800 rounded-lg p-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-blue-300 text-sm font-medium">
              {t('detail.invitationLink.title')}
            </span>
            <span className="text-xs text-gray-500">
              {t('detail.invitationLink.expires', { date: formatDate(user.onboardingExpiresAt) })}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-gray-900 px-2 py-1 rounded text-blue-300 text-xs font-mono break-all">
              {onboardingLink}
            </code>
            <button
              onClick={() => {
                navigator.clipboard.writeText(onboardingLink);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              className={`px-2 py-1 ${copied ? 'bg-green-700 text-green-200' : 'bg-gray-700 hover:bg-gray-600 text-white'} text-xs rounded flex-shrink-0 transition-colors`}
            >
              {copied ? t('actions.copied') : t('actions.copy')}
            </button>
          </div>
        </div>
      )}
      {onboardingLink && onboardingExpired && (
        <div className="text-xs text-gray-600">{t('detail.invitationLink.expired')}</div>
      )}
      {!onboardingLink && user.status === 'active' && (
        <div className="text-xs text-green-600">{t('detail.accountActivated')}</div>
      )}

      {/* Profiles — editable */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-gray-400">{t('mcpAccess.title')}</span>
          {profilesNotAdded.length > 0 && !addingProfile && (
            <button
              onClick={() => setAddingProfile(true)}
              title={t('mcpAccess.addTooltip')}
              className="text-xs text-blue-400 hover:text-blue-300"
            >
              {t('mcpAccess.addButton')}
            </button>
          )}
        </div>

        <div className="space-y-1">
          {user.profiles.map((p) => (
            <div
              key={p.profileName}
              className="flex items-center justify-between bg-gray-700/50 rounded px-3 py-1.5"
            >
              <div className="flex items-center gap-2">
                <span className="text-os-400 font-medium text-sm">{p.profileName}</span>
                <span className="text-xs text-gray-500">({p.accessMode})</span>
                {p.allowedTables && (
                  <span className="text-xs text-gray-600">
                    {t('mcpAccess.tables', { tables: p.allowedTables.join(', ') })}
                  </span>
                )}
              </div>
              <button
                onClick={() => handleRemoveProfile(p.profileName)}
                title={t('mcpAccess.revokeTooltip')}
                className="text-red-400 hover:text-red-300 text-xs px-1"
              >
                ×
              </button>
            </div>
          ))}
        </div>

        {/* Add profile inline */}
        {addingProfile && (
          <div className="flex items-center gap-2 mt-2">
            <select
              value={newProfileName}
              onChange={(e) => setNewProfileName(e.target.value)}
              className="flex-1 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-sm"
            >
              <option value="">{t('mcpAccess.selectPlaceholder')}</option>
              {profilesNotAdded.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.label || p.name}
                </option>
              ))}
            </select>
            <select
              value={newAccessMode}
              onChange={(e) => setNewAccessMode(e.target.value as AccessMode)}
              className="px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-sm"
            >
              <option value="both">{t('accessMode.both')}</option>
              <option value="mcp">{t('accessMode.mcp')}</option>
              <option value="chat">{t('accessMode.chat')}</option>
            </select>
            <button
              onClick={handleAddProfile}
              className="px-2 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded"
            >
              {t('mcpAccess.addSubmit')}
            </button>
            <button
              onClick={() => setAddingProfile(false)}
              className="text-gray-400 hover:text-white text-xs"
            >
              {tCommon('cancel')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function UserManagement({ profiles, initialSelectedUserId }: UserManagementProps) {
  const t = useTranslations('userManagement');
  const tCommon = useTranslations('common');
  const { locale } = useLocale();
  const [users, setUsers] = useState<UserEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [selectedUser, setSelectedUser] = useState<UserEntry | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [onboardingCode, setOnboardingCode] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [filterProfile, setFilterProfile] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');

  // Create form state
  const [formName, setFormName] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formRole, setFormRole] = useState<'admin' | 'user'>('user');
  const [formProfiles, setFormProfiles] = useState<
    Array<{ profileName: string; accessMode: AccessMode }>
  >([]);
  const [formRateLimitRpm, setFormRateLimitRpm] = useState<number>(0);
  const [sendInvitation, setSendInvitation] = useState(false);
  const [formCustomAttrs, setFormCustomAttrs] = useState<Array<{ key: string; value: string }>>([]);

  const fetchUsers = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filterStatus) params.set('status', filterStatus);
      if (filterProfile) params.set('profileName', filterProfile);
      if (searchQuery) params.set('search', searchQuery);

      const res = await apiFetch(`/api/users?${params}`, { credentials: 'include' });
      const data = await res.json();
      if (data.success) {
        setUsers(data.users);
      }
    } catch {
      setError(t('errors.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [filterStatus, filterProfile, searchQuery, t]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  // Pre-select user when navigating from MCP detail
  useEffect(() => {
    if (initialSelectedUserId && users.length > 0 && !selectedUser) {
      const found = users.find((u) => u.id === initialSelectedUserId);
      if (found) setSelectedUser(found);
    }
  }, [initialSelectedUserId, users, selectedUser]);

  const addProfileToForm = () => {
    setFormProfiles([...formProfiles, { profileName: '', accessMode: 'both' }]);
  };

  const removeProfileFromForm = (index: number) => {
    setFormProfiles(formProfiles.filter((_, i) => i !== index));
  };

  const updateFormProfile = (index: number, field: string, value: string) => {
    const updated = [...formProfiles];
    (updated[index] as Record<string, string>)[field] = value;
    setFormProfiles(updated);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (formProfiles.length === 0 || formProfiles.some((p) => !p.profileName)) {
      setError(t('errors.profileRequired'));
      return;
    }

    try {
      const res = await apiFetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: formName,
          email: formEmail,
          role: formRole,
          rateLimitRpm: formRateLimitRpm > 0 ? formRateLimitRpm : undefined,
          sendInvitation,
          profiles: formProfiles.map((p) => ({
            profileName: p.profileName,
            accessMode: p.accessMode,
            allowedTables: null,
            allowedTools: null,
          })),
          customAttributes:
            formCustomAttrs.length > 0
              ? Object.fromEntries(
                  formCustomAttrs.filter((a) => a.key).map((a) => [a.key, a.value]),
                )
              : undefined,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setNewToken(data.plaintextToken);
        setOnboardingCode(data.onboardingCode);
        setShowCreateForm(false);
        setFormName('');
        setFormEmail('');
        setFormRole('user');
        setFormProfiles([]);
        setFormRateLimitRpm(0);
        setSendInvitation(false);
        setFormCustomAttrs([]);
        fetchUsers();
      } else {
        setError(data.message);
      }
    } catch {
      setError(t('errors.createFailed'));
    }
  };

  const handleDisable = async (userId: string) => {
    const reason = prompt(t('prompts.disableReason'));
    try {
      const res = await apiFetch(`/api/users/${userId}/disable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ reason: reason || undefined }),
      });
      const data = await res.json();
      if (data.success) fetchUsers();
      else setError(data.message);
    } catch {
      setError(t('errors.disableFailed'));
    }
  };

  const handleEnable = async (userId: string) => {
    try {
      const res = await apiFetch(`/api/users/${userId}/enable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      const data = await res.json();
      if (data.success) {
        setNewToken(data.plaintextToken);
        fetchUsers();
      } else {
        setError(data.message);
      }
    } catch {
      setError(t('errors.enableFailed'));
    }
  };

  const handleRegenerateToken = async (userId: string) => {
    if (!confirm(t('confirmations.regenerateToken'))) return;
    try {
      const res = await apiFetch(`/api/users/${userId}/regenerate-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      const data = await res.json();
      if (data.success) {
        setNewToken(data.plaintextToken);
      } else {
        setError(data.message);
      }
    } catch {
      setError(t('errors.regenerateTokenFailed'));
    }
  };

  const handleDelete = async (userId: string) => {
    if (!confirm(t('confirmations.deleteUser'))) return;
    try {
      const res = await apiFetch(`/api/users/${userId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await res.json();
      if (data.success) {
        setSelectedUser(null);
        fetchUsers();
      } else {
        setError(data.message);
      }
    } catch {
      setError(t('errors.deleteFailed'));
    }
  };

  const handleResendInvitation = async (userId: string) => {
    try {
      const res = await apiFetch(`/api/users/${userId}/resend-invitation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.message || t('errors.resendInvitationFailed'));
      }
    } catch {
      setError(t('errors.resendInvitationFailed'));
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

  // Import state
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');
  const [importProfile, setImportProfile] = useState('');
  const [importResult, setImportResult] = useState<{
    created: number;
    updated: number;
    errors: Array<{ index: number; email?: string; reason: string }>;
  } | null>(null);
  const [importing, setImporting] = useState(false);

  const handleImport = async () => {
    setError('');
    setImportResult(null);
    setImporting(true);
    try {
      let parsed: unknown[];
      try {
        parsed = JSON.parse(importText);
      } catch {
        // Try CSV parsing: first line = headers, rest = data
        const lines = importText.trim().split('\n').filter(Boolean);
        if (lines.length < 2) {
          setError(t('import.invalidFormat'));
          setImporting(false);
          return;
        }
        const headers = lines[0].split(',').map((h) => h.trim());
        parsed = lines.slice(1).map((line) => {
          const values = line.split(',').map((v) => v.trim());
          const obj: Record<string, unknown> = {};
          headers.forEach((h, i) => {
            obj[h] = values[i] ?? '';
          });
          // Auto-detect customAttributes: any column not email/name becomes a custom attribute
          const customAttributes: Record<string, string> = {};
          for (const [k, v] of Object.entries(obj)) {
            if (k !== 'email' && k !== 'name' && typeof v === 'string' && v) {
              customAttributes[k] = v;
            }
          }
          if (Object.keys(customAttributes).length > 0) obj.customAttributes = customAttributes;
          return obj;
        });
      }
      if (!Array.isArray(parsed)) {
        setError(t('import.invalidArray'));
        setImporting(false);
        return;
      }

      const res = await apiFetch('/api/users/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ users: parsed, profileName: importProfile || undefined }),
      });
      const data = await res.json();
      if (data.success) {
        setImportResult(data);
        fetchUsers();
      } else {
        setError(data.message);
      }
    } catch {
      setError(t('import.failed'));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="heading-md">{t('title')}</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              setShowImport(!showImport);
              setImportResult(null);
            }}
            className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded-md transition-colors"
          >
            {showImport ? t('import.toggleCancel') : t('import.toggleOpen')}
          </button>
          <button
            onClick={() => {
              setShowCreateForm(!showCreateForm);
              if (!showCreateForm && formProfiles.length === 0) addProfileToForm();
            }}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-md transition-colors"
          >
            {showCreateForm ? tCommon('cancel') : t('actions.newUser')}
          </button>
        </div>
      </div>

      {/* Token display modal */}
      {newToken && (
        <div className="bg-green-900/30 border border-green-700 rounded-lg p-4">
          <h3 className="text-green-300 font-medium mb-2">{t('tokenModal.title')}</h3>
          <p className="text-gray-400 text-sm mb-2">{t('tokenModal.description')}</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-gray-800 px-3 py-2 rounded text-green-300 text-sm font-mono break-all">
              {newToken}
            </code>
            <button
              onClick={() => {
                navigator.clipboard.writeText(newToken);
              }}
              className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded transition-colors"
            >
              {t('actions.copy')}
            </button>
          </div>
          {onboardingCode && (
            <div className="mt-3">
              <p className="text-gray-400 text-sm mb-1">{t('tokenModal.onboardingLink')}</p>
              <code className="block bg-gray-800 px-3 py-2 rounded text-blue-300 text-sm font-mono break-all">
                {window.location.origin}/welcome/{onboardingCode}
              </code>
            </div>
          )}
          <button
            onClick={() => {
              setNewToken(null);
              setOnboardingCode(null);
            }}
            className="mt-3 text-sm text-gray-400 hover:text-white transition-colors"
          >
            {t('actions.dismiss')}
          </button>
        </div>
      )}

      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-lg p-3 text-red-300 text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 text-red-400 hover:text-red-200">
            ×
          </button>
        </div>
      )}

      {/* Import form */}
      {showImport && (
        <div className="card-primary p-4 space-y-3">
          <h3 className="eyebrow">{t('import.heading')}</h3>
          <p className="text-xs text-gray-500">{t('import.description')}</p>
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-400">{t('import.defaultProfileLabel')}</label>
            <select
              value={importProfile}
              onChange={(e) => setImportProfile(e.target.value)}
              className="bg-gray-900 border border-gray-600 rounded px-2 py-1 text-sm text-gray-200"
            >
              <option value="">{t('import.noneOption')}</option>
              {profiles.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.label || p.name}
                </option>
              ))}
            </select>
          </div>
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder={
              'email,name,client_id\ndupont@gmail.com,Dupont,CLT-00042\nmartin@yahoo.fr,Martin,CLT-00043'
            }
            rows={8}
            className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm text-gray-200 font-mono"
          />
          <div className="flex items-center gap-3">
            <button
              onClick={handleImport}
              disabled={importing || !importText.trim()}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-md disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {importing ? t('import.submitting') : t('import.toggleOpen')}
            </button>
            {importResult && (
              <span className="text-sm text-gray-300">
                <span className="text-green-400">
                  {t('import.result.created', { count: importResult.created })}
                </span>
                ,{' '}
                <span className="text-blue-400">
                  {t('import.result.updated', { count: importResult.updated })}
                </span>
                {importResult.errors.length > 0 && (
                  <span className="text-red-400">
                    , {t('import.result.errorsCount', { count: importResult.errors.length })}
                  </span>
                )}
              </span>
            )}
          </div>
          {importResult?.errors && importResult.errors.length > 0 && (
            <div className="text-xs text-red-400 max-h-32 overflow-auto space-y-1">
              {importResult.errors.map((err, i) => (
                <div key={i}>
                  {t('import.result.errorLine', { line: err.index + 1 })}
                  {err.email ? ` (${err.email})` : ''}: {err.reason}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Create form */}
      {showCreateForm && (
        <form onSubmit={handleCreate} className="card-primary p-4 space-y-3">
          <h3 className="heading-md">{t('createForm.title')}</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-gray-400 mb-1" htmlFor="form-name">
                {t('createForm.nameLabel')} <span className="text-red-400">*</span>
              </label>
              <input
                id="form-name"
                type="text"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                className="w-full px-3 py-1.5 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500/50"
                required
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1" htmlFor="form-email">
                {t('createForm.emailLabel')} <span className="text-red-400">*</span>
              </label>
              <input
                id="form-email"
                type="email"
                value={formEmail}
                onChange={(e) => setFormEmail(e.target.value)}
                className="w-full px-3 py-1.5 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500/50"
                required
              />
            </div>
            <div>
              <label
                className="flex items-center gap-1 text-sm text-gray-400 mb-1"
                htmlFor="form-role"
              >
                {t('createForm.roleLabel')}
                <HelpTip
                  content={t('createForm.roleHelp')}
                  position="top"
                  maxWidth={300}
                  size="xs"
                />
              </label>
              <select
                id="form-role"
                value={formRole}
                onChange={(e) => setFormRole(e.target.value as 'admin' | 'user')}
                className="w-full px-3 py-1.5 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500/50"
              >
                <option value="user">{t('createForm.roleUser')}</option>
                <option value="admin">{t('createForm.roleAdmin')}</option>
              </select>
            </div>
            <div>
              <label
                className="flex items-center gap-1 text-sm text-gray-400 mb-1"
                htmlFor="form-rate-limit"
              >
                {t('createForm.rateLimitLabel')}
                <HelpTip
                  content={t('createForm.rateLimitHelp')}
                  position="top"
                  maxWidth={280}
                  size="xs"
                />
              </label>
              <input
                id="form-rate-limit"
                type="number"
                min={0}
                value={formRateLimitRpm}
                onChange={(e) =>
                  setFormRateLimitRpm(Math.max(0, parseInt(e.target.value, 10) || 0))
                }
                className="w-full px-3 py-1.5 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500/50"
              />
            </div>
          </div>

          {/* Profile accesses */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm text-gray-400">{t('mcpAccess.title')}</label>
              <button
                type="button"
                onClick={addProfileToForm}
                className="text-xs text-blue-400 hover:text-blue-300"
              >
                {t('createForm.addProfile')}
              </button>
            </div>
            {formProfiles.map((fp, i) => (
              <div key={i} className="flex items-center gap-2 mb-2">
                <select
                  value={fp.profileName}
                  onChange={(e) => updateFormProfile(i, 'profileName', e.target.value)}
                  className="flex-1 px-3 py-1.5 bg-gray-700 border border-gray-600 rounded text-white text-sm"
                  required
                >
                  <option value="">{t('createForm.selectProfilePlaceholder')}</option>
                  {profiles.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.label || p.name}
                    </option>
                  ))}
                </select>
                <select
                  value={fp.accessMode}
                  onChange={(e) => updateFormProfile(i, 'accessMode', e.target.value)}
                  title={t('createForm.accessModeTooltip')}
                  className="px-3 py-1.5 bg-gray-700 border border-gray-600 rounded text-white text-sm"
                >
                  <option value="both">{t('accessMode.both')}</option>
                  <option value="mcp">{t('accessMode.mcp')}</option>
                  <option value="chat">{t('accessMode.chat')}</option>
                </select>
                {formProfiles.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeProfileFromForm(i)}
                    className="text-red-400 hover:text-red-300 text-sm px-2"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* Custom Attributes (for data scoping) */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm text-gray-400">{t('customAttributes.title')}</label>
              <button
                type="button"
                onClick={() => setFormCustomAttrs([...formCustomAttrs, { key: '', value: '' }])}
                className="text-xs text-blue-400 hover:text-blue-300"
              >
                {t('createForm.addAttribute')}
              </button>
            </div>
            {formCustomAttrs.length > 0 && (
              <div className="space-y-2">
                {formCustomAttrs.map((attr, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      type="text"
                      value={attr.key}
                      onChange={(e) => {
                        const updated = [...formCustomAttrs];
                        updated[i] = { ...updated[i], key: e.target.value };
                        setFormCustomAttrs(updated);
                      }}
                      placeholder={t('createForm.attrKeyPlaceholder')}
                      className="flex-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-sm text-gray-200"
                    />
                    <input
                      type="text"
                      value={attr.value}
                      onChange={(e) => {
                        const updated = [...formCustomAttrs];
                        updated[i] = { ...updated[i], value: e.target.value };
                        setFormCustomAttrs(updated);
                      }}
                      placeholder={t('createForm.attrValuePlaceholder')}
                      className="flex-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-sm text-gray-200"
                    />
                    <button
                      type="button"
                      onClick={() => setFormCustomAttrs(formCustomAttrs.filter((_, j) => j !== i))}
                      className="text-gray-500 hover:text-red-400 transition-colors"
                    >
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M6 18L18 6M6 6l12 12"
                        />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}
            {formCustomAttrs.length === 0 && (
              <p className="text-xs text-gray-500">{t('createForm.noAttributesHint')}</p>
            )}
          </div>

          {/* Send invitation email */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={sendInvitation}
              onChange={(e) => setSendInvitation(e.target.checked)}
              className="rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-blue-500/30 focus:ring-offset-0"
            />
            <span className="flex items-center gap-1 text-sm text-gray-300">
              {t('createForm.sendInvitationLabel')}
              <HelpTip content={t('createForm.sendInvitationHelp')} position="right" size="xs" />
            </span>
          </label>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowCreateForm(false)}
              className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded transition-colors"
            >
              {tCommon('cancel')}
            </button>
            <button
              type="submit"
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded transition-colors"
            >
              {t('createForm.title')}
            </button>
          </div>
        </form>
      )}

      {/* Filters */}
      <div className="flex gap-3 items-center">
        <input
          type="text"
          placeholder={t('filters.searchPlaceholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="flex-1 px-3 py-1.5 bg-gray-800 border border-gray-700 rounded text-white text-sm placeholder-gray-500"
        />
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded text-white text-sm"
        >
          <option value="">{t('filters.allStatuses')}</option>
          <option value="active">{t('filters.statusActive')}</option>
          <option value="disabled">{t('filters.statusDisabled')}</option>
          <option value="invited">{t('filters.statusInvited')}</option>
        </select>
        <select
          value={filterProfile}
          onChange={(e) => setFilterProfile(e.target.value)}
          className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded text-white text-sm"
        >
          <option value="">{t('filters.allProfiles')}</option>
          {profiles.map((p) => (
            <option key={p.name} value={p.name}>
              {p.label || p.name}
            </option>
          ))}
        </select>
      </div>

      {/* User table */}
      {loading ? (
        <div className="text-gray-400 text-center py-8">{t('table.loading')}</div>
      ) : users.length === 0 ? (
        <div className="text-gray-500 text-center py-8">{t('table.empty')}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-gray-400 border-b border-white/5">
              <tr>
                <th className="px-3 py-2">{t('table.colName')}</th>
                <th className="px-3 py-2">{t('table.colEmail')}</th>
                <th className="px-3 py-2">{t('table.colMcpServers')}</th>
                <th className="px-3 py-2">{t('table.colStatus')}</th>
                <th className="px-3 py-2">{t('table.colLastActive')}</th>
                <th className="px-3 py-2">{t('table.colActions')}</th>
              </tr>
            </thead>
            <tbody className="text-gray-300">
              {users.map((user) => (
                <tr
                  key={user.id}
                  className="border-b border-white/5 hover:bg-gray-800/40 cursor-pointer"
                  onClick={() => setSelectedUser(user)}
                >
                  <td className="px-3 py-2 font-medium text-white">{user.name}</td>
                  <td className="px-3 py-2">{user.email}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {user.profiles.map((p) => (
                        <span
                          key={p.profileName}
                          title={t('table.profileTooltip', {
                            name: p.profileName,
                            mode:
                              p.accessMode === 'both'
                                ? t('accessMode.both')
                                : p.accessMode === 'mcp'
                                  ? t('accessMode.mcp')
                                  : t('accessMode.chat'),
                          })}
                          className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-os-700/20 text-os-400 border border-os-600/30"
                        >
                          {p.profileName}
                          <span className="ml-1 text-gray-500">({p.accessMode})</span>
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={user.status} />
                  </td>
                  <td className="px-3 py-2 text-gray-500">{formatDate(user.lastActiveAt)}</td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                      {user.status === 'active' ? (
                        <button
                          onClick={() => handleDisable(user.id)}
                          title={t('actions.disableTooltip')}
                          className="px-2 py-1 bg-red-900/50 hover:bg-red-900 text-red-300 text-xs rounded transition-colors"
                        >
                          {t('actions.disable')}
                        </button>
                      ) : user.status === 'disabled' ? (
                        <button
                          onClick={() => handleEnable(user.id)}
                          title={t('actions.enableTooltip')}
                          className="px-2 py-1 bg-green-900/50 hover:bg-green-900 text-green-300 text-xs rounded transition-colors"
                        >
                          {t('actions.enable')}
                        </button>
                      ) : null}
                      {user.status === 'invited' && (
                        <button
                          onClick={() => handleResendInvitation(user.id)}
                          title={t('actions.resendTooltip')}
                          className="text-xs text-os-400 hover:text-os-300 px-2 py-1 transition-colors"
                        >
                          {t('actions.resend')}
                        </button>
                      )}
                      <button
                        onClick={() => handleRegenerateToken(user.id)}
                        title={t('actions.regenerateTooltip')}
                        className="px-2 py-1 bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs rounded transition-colors"
                      >
                        {t('actions.regenerate')}
                      </button>
                      <button
                        onClick={() => handleDelete(user.id)}
                        title={t('actions.deleteTooltip')}
                        className="px-2 py-1 bg-gray-700 hover:bg-red-900 text-gray-300 hover:text-red-300 text-xs rounded transition-colors"
                      >
                        {t('actions.delete')}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* User detail panel with inline profile editing */}
      {selectedUser && (
        <UserDetailPanel
          user={selectedUser}
          profiles={profiles}
          onClose={() => setSelectedUser(null)}
          onUpdate={fetchUsers}
          formatDate={formatDate}
        />
      )}
    </div>
  );
}
