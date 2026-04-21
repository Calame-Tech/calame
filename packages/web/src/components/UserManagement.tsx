import { useState, useEffect, useCallback, useRef } from 'react';
import type { UserEntry, AccessMode, Profile } from '../types/schema.js';
import HelpTip from './HelpTip.js';

interface UserManagementProps {
  profiles: Profile[];
  initialSelectedUserId?: string;
}

const STATUS_TOOLTIP: Record<string, string> = {
  active: 'Compte actif — l\'utilisateur peut se connecter et utiliser ses accès MCP.',
  disabled: 'Compte désactivé — l\'accès est révoqué. L\'utilisateur ne peut plus s\'authentifier.',
  invited: 'Invitation envoyée — le compte sera actif après que l\'utilisateur ait complété son inscription.',
};

/** Status badge with color coding */
function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: 'bg-green-900/50 text-green-300 border-green-700',
    disabled: 'bg-red-900/50 text-red-300 border-red-700',
    invited: 'bg-yellow-900/50 text-yellow-300 border-yellow-700',
  };
  return (
    <span
      title={STATUS_TOOLTIP[status] ?? `Statut : ${status}`}
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
      setAttrs(initialAttrs ? Object.entries(initialAttrs).map(([key, value]) => ({ key, value })) : []);
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
      const customAttributes = attrs.length > 0
        ? Object.fromEntries(attrs.filter((a) => a.key).map((a) => [a.key, a.value]))
        : null;
      await fetch(`/api/users/${userId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ customAttributes }),
      });
      setDirty(false);
      onSaved();
    } catch { /* ignore */ } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm text-gray-400">Custom Attributes</span>
        <div className="flex items-center gap-2">
          {dirty && (
            <button
              onClick={save}
              disabled={saving}
              className="text-xs px-2 py-0.5 bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-40 transition-colors"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          )}
          <button onClick={addAttr} className="text-xs text-blue-400 hover:text-blue-300">
            + Add
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
                placeholder="Key"
                className="flex-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 font-mono"
              />
              <span className="text-gray-600">=</span>
              <input
                type="text"
                value={attr.value}
                onChange={(e) => updateAttr(i, 'value', e.target.value)}
                placeholder="Value"
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
        <p className="text-xs text-gray-500">No custom attributes.</p>
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
      const res = await fetch(`/api/users/${user.id}`, { credentials: 'include' });
      const data = await res.json();
      if (data.success) setUser(data.user);
    } catch { /* ignore */ }
    onUpdate();
  };

  const profilesNotAdded = availableProfiles.filter(
    (p) => !user.profiles.some((up) => up.profileName === p.name),
  );

  const handleAddProfile = async () => {
    if (!newProfileName) return;
    setError('');
    try {
      const res = await fetch(`/api/users/${user.id}/profiles`, {
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
      setError('Failed to add profile.');
    }
  };

  const handleRemoveProfile = async (profileName: string) => {
    if (user.profiles.length <= 1) {
      setError('Cannot remove the last profile. Delete the user instead.');
      return;
    }
    try {
      const res = await fetch(`/api/users/${user.id}/profiles/${profileName}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await res.json();
      if (data.success) await refreshUser();
      else setError(data.message);
    } catch {
      setError('Failed to remove profile.');
    }
  };

  const onboardingLink = user.onboardingCode
    ? `${window.location.origin}/welcome/${user.onboardingCode}`
    : null;
  const onboardingExpired = user.onboardingExpiresAt
    ? new Date(user.onboardingExpiresAt) < new Date()
    : true;

  return (
    <div className="bg-gray-800 rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-white font-medium">{user.name}</h3>
        <button onClick={onClose} className="text-gray-400 hover:text-white">×</button>
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded p-2 text-red-300 text-xs">
          {error}
          <button onClick={() => setError('')} className="ml-2 text-red-400">×</button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <span className="text-gray-500">Email:</span>{' '}
          <span className="text-gray-300">{user.email}</span>
        </div>
        <div>
          <span className="text-gray-500">Role:</span>{' '}
          <span className="text-gray-300">{user.role}</span>
        </div>
        <div>
          <span className="text-gray-500">Status:</span>{' '}
          <StatusBadge status={user.status} />
        </div>
        <div>
          <span className="text-gray-500">Created:</span>{' '}
          <span className="text-gray-300">{formatDate(user.createdAt)}</span>
        </div>
        {user.disabledReason && (
          <div className="col-span-2">
            <span className="text-gray-500">Disabled reason:</span>{' '}
            <span className="text-red-300">{user.disabledReason}</span>
          </div>
        )}
      </div>

      {/* Custom Attributes editor */}
      <CustomAttributesEditor userId={user.id} initialAttrs={user.customAttributes ?? null} onSaved={refreshUser} />

      {/* Invitation link */}
      {onboardingLink && !onboardingExpired && (
        <div className="bg-blue-900/20 border border-blue-800 rounded-lg p-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-blue-300 text-sm font-medium">Invitation Link</span>
            <span className="text-xs text-gray-500">
              Expires {formatDate(user.onboardingExpiresAt)}
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
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>
      )}
      {onboardingLink && onboardingExpired && (
        <div className="text-xs text-gray-600">Invitation link expired.</div>
      )}
      {!onboardingLink && user.status === 'active' && (
        <div className="text-xs text-green-600">Account activated.</div>
      )}

      {/* Profiles — editable */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-gray-400">MCP Server Access</span>
          {profilesNotAdded.length > 0 && !addingProfile && (
            <button
              onClick={() => setAddingProfile(true)}
              title="Accorder à cet utilisateur l'accès à un serveur MCP supplémentaire."
              className="text-xs text-blue-400 hover:text-blue-300"
            >
              + Add MCP
            </button>
          )}
        </div>

        <div className="space-y-1">
          {user.profiles.map((p) => (
            <div key={p.profileName} className="flex items-center justify-between bg-gray-700/50 rounded px-3 py-1.5">
              <div className="flex items-center gap-2">
                <span className="text-os-400 font-medium text-sm">{p.profileName}</span>
                <span className="text-xs text-gray-500">({p.accessMode})</span>
                {p.allowedTables && (
                  <span className="text-xs text-gray-600">tables: {p.allowedTables.join(', ')}</span>
                )}
              </div>
              <button
                onClick={() => handleRemoveProfile(p.profileName)}
                title="Révoquer l'accès à ce serveur MCP pour cet utilisateur."
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
              <option value="">Select MCP...</option>
              {profilesNotAdded.map((p) => (
                <option key={p.name} value={p.name}>{p.label || p.name}</option>
              ))}
            </select>
            <select
              value={newAccessMode}
              onChange={(e) => setNewAccessMode(e.target.value as AccessMode)}
              className="px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-sm"
            >
              <option value="both">MCP + Chat</option>
              <option value="mcp">MCP only</option>
              <option value="chat">Chat only</option>
            </select>
            <button
              onClick={handleAddProfile}
              className="px-2 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded"
            >
              Add
            </button>
            <button
              onClick={() => setAddingProfile(false)}
              className="text-gray-400 hover:text-white text-xs"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function UserManagement({ profiles, initialSelectedUserId }: UserManagementProps) {
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
  const [formProfiles, setFormProfiles] = useState<Array<{ profileName: string; accessMode: AccessMode }>>([]);
  const [formRateLimitRpm, setFormRateLimitRpm] = useState<number>(0);
  const [sendInvitation, setSendInvitation] = useState(false);
  const [formCustomAttrs, setFormCustomAttrs] = useState<Array<{ key: string; value: string }>>([]);

  const fetchUsers = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filterStatus) params.set('status', filterStatus);
      if (filterProfile) params.set('profileName', filterProfile);
      if (searchQuery) params.set('search', searchQuery);

      const res = await fetch(`/api/users?${params}`, { credentials: 'include' });
      const data = await res.json();
      if (data.success) {
        setUsers(data.users);
      }
    } catch {
      setError('Failed to load users.');
    } finally {
      setLoading(false);
    }
  }, [filterStatus, filterProfile, searchQuery]);

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
      setError('At least one profile with a name is required.');
      return;
    }

    try {
      const res = await fetch('/api/users', {
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
          customAttributes: formCustomAttrs.length > 0
            ? Object.fromEntries(formCustomAttrs.filter((a) => a.key).map((a) => [a.key, a.value]))
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
      setError('Failed to create user.');
    }
  };

  const handleDisable = async (userId: string) => {
    const reason = prompt('Reason for disabling (optional):');
    try {
      const res = await fetch(`/api/users/${userId}/disable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ reason: reason || undefined }),
      });
      const data = await res.json();
      if (data.success) fetchUsers();
      else setError(data.message);
    } catch {
      setError('Failed to disable user.');
    }
  };

  const handleEnable = async (userId: string) => {
    try {
      const res = await fetch(`/api/users/${userId}/enable`, {
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
      setError('Failed to enable user.');
    }
  };

  const handleRegenerateToken = async (userId: string) => {
    if (!confirm('Regenerate token? The old token will stop working immediately.')) return;
    try {
      const res = await fetch(`/api/users/${userId}/regenerate-token`, {
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
      setError('Failed to regenerate token.');
    }
  };

  const handleDelete = async (userId: string) => {
    if (!confirm('Permanently delete this user? This action cannot be undone.')) return;
    try {
      const res = await fetch(`/api/users/${userId}`, {
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
      setError('Failed to delete user.');
    }
  };

  const handleResendInvitation = async (userId: string) => {
    try {
      const res = await fetch(`/api/users/${userId}/resend-invitation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.message || 'Failed to resend invitation.');
      }
    } catch {
      setError('Failed to resend invitation.');
    }
  };

  const formatDate = (date: string | null) => {
    if (!date) return '—';
    return new Date(date).toLocaleDateString('fr-FR', {
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
  const [importResult, setImportResult] = useState<{ created: number; updated: number; errors: Array<{ index: number; email?: string; reason: string }> } | null>(null);
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
        if (lines.length < 2) { setError('Invalid format. Use JSON array or CSV with headers.'); setImporting(false); return; }
        const headers = lines[0].split(',').map((h) => h.trim());
        parsed = lines.slice(1).map((line) => {
          const values = line.split(',').map((v) => v.trim());
          const obj: Record<string, unknown> = {};
          headers.forEach((h, i) => { obj[h] = values[i] ?? ''; });
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
      if (!Array.isArray(parsed)) { setError('Expected a JSON array of user objects.'); setImporting(false); return; }

      const res = await fetch('/api/users/import', {
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
      setError('Import failed.');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-white">Users</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setShowImport(!showImport); setImportResult(null); }}
            className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded-md transition-colors"
          >
            {showImport ? 'Cancel Import' : 'Import'}
          </button>
          <button
            onClick={() => { setShowCreateForm(!showCreateForm); if (!showCreateForm && formProfiles.length === 0) addProfileToForm(); }}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-md transition-colors"
          >
            {showCreateForm ? 'Cancel' : '+ New User'}
          </button>
        </div>
      </div>

      {/* Token display modal */}
      {newToken && (
        <div className="bg-green-900/30 border border-green-700 rounded-lg p-4">
          <h3 className="text-green-300 font-medium mb-2">Token Generated</h3>
          <p className="text-gray-400 text-sm mb-2">
            Copy this token now — it will not be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-gray-800 px-3 py-2 rounded text-green-300 text-sm font-mono break-all">
              {newToken}
            </code>
            <button
              onClick={() => { navigator.clipboard.writeText(newToken); }}
              className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded transition-colors"
            >
              Copy
            </button>
          </div>
          {onboardingCode && (
            <div className="mt-3">
              <p className="text-gray-400 text-sm mb-1">Onboarding link:</p>
              <code className="block bg-gray-800 px-3 py-2 rounded text-blue-300 text-sm font-mono break-all">
                {window.location.origin}/welcome/{onboardingCode}
              </code>
            </div>
          )}
          <button
            onClick={() => { setNewToken(null); setOnboardingCode(null); }}
            className="mt-3 text-sm text-gray-400 hover:text-white transition-colors"
          >
            Dismiss
          </button>
        </div>
      )}

      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-lg p-3 text-red-300 text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 text-red-400 hover:text-red-200">×</button>
        </div>
      )}

      {/* Import form */}
      {showImport && (
        <div className="bg-gray-800/60 border border-gray-700 rounded-lg p-5 space-y-3">
          <h3 className="text-sm font-semibold text-gray-300">Bulk Import Users</h3>
          <p className="text-xs text-gray-500">
            Paste a JSON array or CSV data. CSV format: first row = headers (email required), extra columns become custom attributes.
          </p>
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-400">Default profile:</label>
            <select
              value={importProfile}
              onChange={(e) => setImportProfile(e.target.value)}
              className="bg-gray-900 border border-gray-600 rounded px-2 py-1 text-sm text-gray-200"
            >
              <option value="">None (update only)</option>
              {profiles.map((p) => (
                <option key={p.name} value={p.name}>{p.label || p.name}</option>
              ))}
            </select>
          </div>
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder={'email,name,client_id\ndupont@gmail.com,Dupont,CLT-00042\nmartin@yahoo.fr,Martin,CLT-00043'}
            rows={8}
            className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm text-gray-200 font-mono"
          />
          <div className="flex items-center gap-3">
            <button
              onClick={handleImport}
              disabled={importing || !importText.trim()}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-md disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {importing ? 'Importing...' : 'Import'}
            </button>
            {importResult && (
              <span className="text-sm text-gray-300">
                <span className="text-green-400">{importResult.created} created</span>,{' '}
                <span className="text-blue-400">{importResult.updated} updated</span>
                {importResult.errors.length > 0 && (
                  <span className="text-red-400">, {importResult.errors.length} errors</span>
                )}
              </span>
            )}
          </div>
          {importResult?.errors && importResult.errors.length > 0 && (
            <div className="text-xs text-red-400 max-h-32 overflow-auto space-y-1">
              {importResult.errors.map((err, i) => (
                <div key={i}>Line {err.index + 1}{err.email ? ` (${err.email})` : ''}: {err.reason}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Create form */}
      {showCreateForm && (
        <form onSubmit={handleCreate} className="bg-gray-800 rounded-lg p-4 space-y-3">
          <h3 className="text-white font-medium">Create User</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-gray-400 mb-1" htmlFor="form-name">Name <span className="text-red-400">*</span></label>
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
              <label className="block text-sm text-gray-400 mb-1" htmlFor="form-email">Email <span className="text-red-400">*</span></label>
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
              <label className="flex items-center gap-1 text-sm text-gray-400 mb-1" htmlFor="form-role">
                Role
                <HelpTip content="Admin : accès complet à la gestion des utilisateurs, tokens et configuration. User : accès limité aux serveurs MCP autorisés." position="top" maxWidth={300} size="xs" />
              </label>
              <select
                id="form-role"
                value={formRole}
                onChange={(e) => setFormRole(e.target.value as 'admin' | 'user')}
                className="w-full px-3 py-1.5 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500/50"
              >
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <div>
              <label className="flex items-center gap-1 text-sm text-gray-400 mb-1" htmlFor="form-rate-limit">
                Rate limit (req/min, 0 = unlimited)
                <HelpTip content="Limite le nombre de requêtes par minute pour cet utilisateur. Saisissez 0 pour ne pas appliquer de limite." position="top" maxWidth={280} size="xs" />
              </label>
              <input
                id="form-rate-limit"
                type="number"
                min={0}
                value={formRateLimitRpm}
                onChange={(e) => setFormRateLimitRpm(Math.max(0, parseInt(e.target.value, 10) || 0))}
                className="w-full px-3 py-1.5 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500/50"
              />
            </div>
          </div>

          {/* Profile accesses */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm text-gray-400">MCP Server Access</label>
              <button
                type="button"
                onClick={addProfileToForm}
                className="text-xs text-blue-400 hover:text-blue-300"
              >
                + Add profile
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
                  <option value="">Select a profile</option>
                  {profiles.map((p) => (
                    <option key={p.name} value={p.name}>{p.label || p.name}</option>
                  ))}
                </select>
                <select
                  value={fp.accessMode}
                  onChange={(e) => updateFormProfile(i, 'accessMode', e.target.value)}
                  title="MCP : accès API uniquement. Chat : interface de chat navigateur uniquement. Les deux : accès complet aux deux modes."
                  className="px-3 py-1.5 bg-gray-700 border border-gray-600 rounded text-white text-sm"
                >
                  <option value="both">MCP + Chat</option>
                  <option value="mcp">MCP only</option>
                  <option value="chat">Chat only</option>
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
              <label className="text-sm text-gray-400">Custom Attributes</label>
              <button
                type="button"
                onClick={() => setFormCustomAttrs([...formCustomAttrs, { key: '', value: '' }])}
                className="text-xs text-blue-400 hover:text-blue-300"
              >
                + Add attribute
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
                      placeholder="Key (e.g. client_id)"
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
                      placeholder="Value (e.g. CLT-00042)"
                      className="flex-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-sm text-gray-200"
                    />
                    <button
                      type="button"
                      onClick={() => setFormCustomAttrs(formCustomAttrs.filter((_, j) => j !== i))}
                      className="text-gray-500 hover:text-red-400 transition-colors"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}
            {formCustomAttrs.length === 0 && (
              <p className="text-xs text-gray-500">No custom attributes. Used for data scoping when the user&apos;s email isn&apos;t the identifier in the database.</p>
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
              Send invitation email
              <HelpTip content="Envoie automatiquement un e-mail contenant le lien d'inscription à l'utilisateur." position="right" size="xs" />
            </span>
          </label>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowCreateForm(false)}
              className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded transition-colors"
            >
              Create User
            </button>
          </div>
        </form>
      )}

      {/* Filters */}
      <div className="flex gap-3 items-center">
        <input
          type="text"
          placeholder="Search by name or email..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="flex-1 px-3 py-1.5 bg-gray-800 border border-gray-700 rounded text-white text-sm placeholder-gray-500"
        />
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded text-white text-sm"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="disabled">Disabled</option>
          <option value="invited">Invited</option>
        </select>
        <select
          value={filterProfile}
          onChange={(e) => setFilterProfile(e.target.value)}
          className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded text-white text-sm"
        >
          <option value="">All profiles</option>
          {profiles.map((p) => (
            <option key={p.name} value={p.name}>{p.label || p.name}</option>
          ))}
        </select>
      </div>

      {/* User table */}
      {loading ? (
        <div className="text-gray-400 text-center py-8">Loading users...</div>
      ) : users.length === 0 ? (
        <div className="text-gray-500 text-center py-8">
          No users yet. Click "+ New User" to create one.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-gray-400 border-b border-gray-700">
              <tr>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Profiles</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Last Active</th>
                <th className="px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody className="text-gray-300">
              {users.map((user) => (
                <tr
                  key={user.id}
                  className="border-b border-gray-800 hover:bg-gray-800/50 cursor-pointer"
                  onClick={() => setSelectedUser(user)}
                >
                  <td className="px-3 py-2 font-medium text-white">{user.name}</td>
                  <td className="px-3 py-2">{user.email}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {user.profiles.map((p) => (
                        <span
                          key={p.profileName}
                          title={`Serveur MCP : ${p.profileName} — Mode d'accès : ${p.accessMode === 'both' ? 'MCP + Chat' : p.accessMode === 'mcp' ? 'MCP uniquement' : 'Chat uniquement'}`}
                          className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-os-700/20 text-os-400 border border-os-600/30"
                        >
                          {p.profileName}
                          <span className="ml-1 text-gray-500">({p.accessMode})</span>
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2"><StatusBadge status={user.status} /></td>
                  <td className="px-3 py-2 text-gray-500">{formatDate(user.lastActiveAt)}</td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                      {user.status === 'active' ? (
                        <button
                          onClick={() => handleDisable(user.id)}
                          title="Désactiver le compte — l'utilisateur ne pourra plus se connecter."
                          className="px-2 py-1 bg-red-900/50 hover:bg-red-900 text-red-300 text-xs rounded transition-colors"
                        >
                          Disable
                        </button>
                      ) : user.status === 'disabled' ? (
                        <button
                          onClick={() => handleEnable(user.id)}
                          title="Réactiver le compte et générer un nouveau token d'accès."
                          className="px-2 py-1 bg-green-900/50 hover:bg-green-900 text-green-300 text-xs rounded transition-colors"
                        >
                          Enable
                        </button>
                      ) : null}
                      {user.status === 'invited' && (
                        <button
                          onClick={() => handleResendInvitation(user.id)}
                          title="Renvoyer l'e-mail d'invitation avec un nouveau lien d'inscription."
                          className="text-xs text-os-400 hover:text-os-300 px-2 py-1 transition-colors"
                        >
                          Resend invitation
                        </button>
                      )}
                      <button
                        onClick={() => handleRegenerateToken(user.id)}
                        title="Générer un nouveau token — l'ancien sera immédiatement invalidé."
                        className="px-2 py-1 bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs rounded transition-colors"
                      >
                        New Token
                      </button>
                      <button
                        onClick={() => handleDelete(user.id)}
                        title="Supprimer définitivement cet utilisateur et tous ses accès. Action irréversible."
                        className="px-2 py-1 bg-gray-700 hover:bg-red-900 text-gray-400 hover:text-red-300 text-xs rounded transition-colors"
                      >
                        Delete
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
