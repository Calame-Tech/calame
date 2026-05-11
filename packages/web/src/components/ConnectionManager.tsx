import { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch } from '../lib/api.js';
import type {
  DatabaseSchema,
  DatabaseType,
  NamedConnection,
  SslConfig,
  SshTunnelConfig,
} from '../types/schema.js';
import HelpTip from './HelpTip.js';

interface ConnectionManagerProps {
  connections: NamedConnection[];
  onConnectionsChange: (connections: NamedConnection[]) => void;
  onSchemaLoaded: (connectionName: string, schema: DatabaseSchema) => void;
  editConnectionName?: string;
}

/** Remote connection status from GET /api/connections */
interface ConnectionStatus {
  label: string;
  databaseType: DatabaseType;
  tableCount: number;
  connected: boolean;
  sslConfig?: SslConfig;
  sshConfig?: SshTunnelConfig;
}

const DB_OPTIONS: {
  type: DatabaseType;
  label: string;
  placeholder: string;
  helpText: string;
}[] = [
  {
    type: 'postgresql',
    label: 'PostgreSQL',
    placeholder: 'postgresql://user:password@localhost:5432/mydb',
    helpText: 'Format: postgresql://user:password@host:port/database',
  },
  {
    type: 'mysql',
    label: 'MySQL',
    placeholder: 'mysql://user:password@localhost:3306/mydb',
    helpText: 'Format: mysql://user:password@host:port/database',
  },
  {
    type: 'sqlite',
    label: 'SQLite',
    placeholder: 'sqlite:///path/to/database.db',
    helpText: 'Format: sqlite:///path/to/database.db',
  },
];

/** Generate a slug from a label: lowercase, spaces to hyphens, strip special chars */
function slugify(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

const DB_TYPE_COLORS: Record<DatabaseType, string> = {
  postgresql: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  mysql: 'bg-orange-500/20 text-orange-300 border-orange-500/30',
  sqlite: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
};

export default function ConnectionManager({
  connections,
  onConnectionsChange,
  onSchemaLoaded,
  editConnectionName,
}: ConnectionManagerProps) {
  // Remote statuses keyed by connection name
  const [statuses, setStatuses] = useState<Record<string, ConnectionStatus>>({});
  // Form visibility
  const [showForm, setShowForm] = useState(false);
  // Form fields
  const [formLabel, setFormLabel] = useState('');
  const [formName, setFormName] = useState('');
  const [formNameManual, setFormNameManual] = useState(false);
  const [formDbType, setFormDbType] = useState<DatabaseType>(
    () => (localStorage.getItem('calame-dbtype') as DatabaseType) || 'postgresql',
  );
  const [formConnStr, setFormConnStr] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  // Toggle to show/hide the identifier (slug) field
  const [showIdentifier, setShowIdentifier] = useState(false);
  // Form state
  const [formStatus, setFormStatus] = useState<'idle' | 'testing' | 'connecting' | 'success' | 'error'>('idle');
  const [formMessage, setFormMessage] = useState('');
  // SSL state
  const [sslExpanded, setSslExpanded] = useState(false);
  const [sslEnabled, setSslEnabled] = useState(false);
  const [sslCa, setSslCa] = useState('');
  const [sslCert, setSslCert] = useState('');
  const [sslKey, setSslKey] = useState('');
  const [sslRejectUnauthorized, setSslRejectUnauthorized] = useState(true);
  // SSH Tunnel state
  const [sshExpanded, setSshExpanded] = useState(false);
  const [sshEnabled, setSshEnabled] = useState(false);
  const [sshHost, setSshHost] = useState('');
  const [sshPort, setSshPort] = useState(22);
  const [sshUsername, setSshUsername] = useState('');
  const [sshPrivateKey, setSshPrivateKey] = useState('');
  const [sshPassword, setSshPassword] = useState('');
  const [sshDbHost, setSshDbHost] = useState('');
  const [sshDbPort, setSshDbPort] = useState(5432);
  // Reveal connection string (edit mode)
  const [connStringRevealed, setConnStringRevealed] = useState(false);
  const [showRevealPrompt, setShowRevealPrompt] = useState(false);
  const [revealPassword, setRevealPassword] = useState('');
  const [revealStatus, setRevealStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [revealError, setRevealError] = useState('');
  // Whether we're editing an existing connection (has a saved conn string)
  const [hasSavedConnStr, setHasSavedConnStr] = useState(false);
  // Delete confirmation
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // Edit mode: holds the connection name being edited, or null
  const [editingConnection, setEditingConnection] = useState<string | null>(null);
  // Polling ref
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Fetch connection statuses ────────────────────────────────────
  const fetchStatuses = useCallback(async () => {
    try {
      const res = await apiFetch('/api/connections');
      const data = await res.json();
      if (data.success && data.connections) {
        setStatuses(data.connections as Record<string, ConnectionStatus>);
      }
    } catch {
      // Server may not be reachable yet
    }
  }, []);

  // On mount + poll every 10s
  useEffect(() => {
    fetchStatuses();
    pollRef.current = setInterval(fetchStatuses, 10_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchStatuses]);

  // ── Auto-generate name from label ────────────────────────────────
  useEffect(() => {
    if (!formNameManual) {
      setFormName(slugify(formLabel));
    }
  }, [formLabel, formNameManual]);

  // ── Persist dbType preference ────────────────────────────────────
  useEffect(() => {
    localStorage.setItem('calame-dbtype', formDbType);
  }, [formDbType]);

  // ── Helpers ──────────────────────────────────────────────────────
  const resetForm = () => {
    setShowForm(false);
    setFormLabel('');
    setFormName('');
    setFormNameManual(false);
    setFormDbType((localStorage.getItem('calame-dbtype') as DatabaseType) || 'postgresql');
    setFormConnStr('');
    setFormStatus('idle');
    setFormMessage('');
    setShowPassword(false);
    setShowIdentifier(false);
    setEditingConnection(null);
    setSslExpanded(false);
    setSslEnabled(false);
    setSslCa('');
    setSslCert('');
    setSslKey('');
    setSslRejectUnauthorized(true);
    setSshExpanded(false);
    setSshEnabled(false);
    setSshHost('');
    setSshPort(22);
    setSshUsername('');
    setSshPrivateKey('');
    setSshPassword('');
    setSshDbHost('');
    setSshDbPort(5432);
    setConnStringRevealed(false);
    setShowRevealPrompt(false);
    setRevealPassword('');
    setRevealStatus('idle');
    setRevealError('');
    setHasSavedConnStr(false);
  };

  const handleRevealConnectionString = async () => {
    if (!editingConnection || !revealPassword) return;
    setRevealStatus('loading');
    setRevealError('');
    try {
      const res = await fetch(`/api/connections/${encodeURIComponent(editingConnection)}/reveal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ password: revealPassword }),
      });
      const data = await res.json();
      if (data.success) {
        setFormConnStr(data.connectionString);
        setConnStringRevealed(true);
        setShowRevealPrompt(false);
        setShowPassword(true);
        setRevealStatus('idle');
        setRevealPassword('');
      } else {
        setRevealStatus('error');
        setRevealError(data.message || 'Incorrect password.');
      }
    } catch {
      setRevealStatus('error');
      setRevealError('Failed to reach the server.');
    }
  };

  const activeDbOption = DB_OPTIONS.find((o) => o.type === formDbType)!;

  // ── Start editing a connection ─────────────────────────────────
  const startEdit = (name: string) => {
    const local = connections.find((c) => c.name === name);
    const remote = statuses[name];
    setEditingConnection(name);
    setFormLabel(local?.label || remote?.label || name);
    setFormName(name);
    setFormNameManual(true);
    setFormDbType(local?.databaseType || remote?.databaseType || 'postgresql');
    setFormConnStr('');
    setHasSavedConnStr(true);
    setConnStringRevealed(false);
    setShowRevealPrompt(false);
    setShowForm(true);
    setFormStatus('idle');
    setFormMessage('');
    setShowPassword(false);
    setShowIdentifier(false);
    // Restore SSL state from saved config
    const savedSsl = local?.sslConfig || remote?.sslConfig;
    if (savedSsl?.enabled) {
      setSslExpanded(true);
      setSslEnabled(true);
      setSslCa(savedSsl.ca || '');
      setSslCert(savedSsl.cert || '');
      setSslKey(savedSsl.key || '');
      setSslRejectUnauthorized(savedSsl.rejectUnauthorized ?? true);
    } else {
      setSslExpanded(false);
      setSslEnabled(false);
      setSslCa('');
      setSslCert('');
      setSslKey('');
      setSslRejectUnauthorized(true);
    }
    // Restore SSH state from saved config
    const savedSsh = local?.sshConfig || remote?.sshConfig;
    if (savedSsh?.enabled) {
      setSshExpanded(true);
      setSshEnabled(true);
      setSshHost(savedSsh.host);
      setSshPort(savedSsh.port);
      setSshUsername(savedSsh.username);
      setSshPrivateKey(savedSsh.privateKey || '');
      setSshPassword(savedSsh.password || '');
      setSshDbHost(savedSsh.dbHost);
      setSshDbPort(savedSsh.dbPort);
    } else {
      setSshExpanded(false);
      setSshEnabled(false);
      setSshHost('');
      setSshPort(22);
      setSshUsername('');
      setSshPrivateKey('');
      setSshPassword('');
      setSshDbHost('');
      setSshDbPort(5432);
    }
  };

  // ── Auto-open edit form when editConnectionName is provided ─────
  useEffect(() => {
    if (editConnectionName && !editingConnection) {
      startEdit(editConnectionName);
    }
  }, [editConnectionName]);

  // ── Test connection ──────────────────────────────────────────────
  const buildSslConfig = (): SslConfig | undefined => {
    if (formDbType === 'sqlite' || !sslEnabled) return undefined;
    return {
      enabled: true,
      ca: sslCa.trim() || undefined,
      cert: sslCert.trim() || undefined,
      key: sslKey.trim() || undefined,
      rejectUnauthorized: sslRejectUnauthorized,
    };
  };

  const buildSshConfig = (): SshTunnelConfig | undefined => {
    if (!sshEnabled) return undefined;
    return {
      enabled: true,
      host: sshHost,
      port: sshPort,
      username: sshUsername,
      privateKey: sshPrivateKey.trim() || undefined,
      password: sshPassword || undefined,
      dbHost: sshDbHost,
      dbPort: sshDbPort,
    };
  };

  const handleTest = async () => {
    if (!formConnStr || !formName) return;
    setFormStatus('testing');
    setFormMessage('');
    try {
      const res = await fetch(`/api/connections/${encodeURIComponent(formName)}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connectionString: formConnStr,
          databaseType: formDbType,
          sslConfig: buildSslConfig(),
          sshConfig: buildSshConfig(),
        }),
      });
      const data = await res.json();
      if (data.success) {
        setFormStatus('success');
        setFormMessage('Connexion réussie !');
      } else {
        setFormStatus('error');
        setFormMessage(data.message || 'Échec du test de connexion.');
      }
    } catch {
      setFormStatus('error');
      setFormMessage('Failed to reach the server.');
    }
  };

  // ── Connect (create) ────────────────────────────────────────────
  // ── Build card data from local connections + remote statuses ─────
  const allConnectionNames = new Set([
    ...connections.map((c) => c.name),
    ...Object.keys(statuses),
  ]);

  // Check if name already exists (skip the current name when editing)
  const nameAlreadyExists =
    formName.length > 0 &&
    allConnectionNames.has(formName) &&
    formName !== editingConnection;

  const handleConnect = async () => {
    if (!formConnStr || !formName || !formLabel) return;
    if (nameAlreadyExists) {
      setFormStatus('error');
      setFormMessage(
        `A connection with identifier "${formName}" already exists.`,
      );
      return;
    }
    setFormStatus('connecting');
    setFormMessage('');
    try {
      // If editing, delete the old connection first then recreate
      if (editingConnection) {
        await fetch(`/api/connections/${encodeURIComponent(editingConnection)}`, {
          method: 'DELETE',
        });
      }

      const res = await apiFetch('/api/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formName,
          label: formLabel,
          databaseType: formDbType,
          connectionString: formConnStr,
          sslConfig: buildSslConfig(),
          sshConfig: buildSshConfig(),
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setFormStatus('error');
        setFormMessage(data.message || 'Failed to create connection.');
        return;
      }

      // Re-fetch all connections from backend to stay in sync
      const allRes = await apiFetch('/api/connections');
      const allData = await allRes.json();
      if (allData.success && allData.connections) {
        const allConns: NamedConnection[] = Object.entries(allData.connections).map(
          ([n, info]: [string, unknown]) => {
            const c = info as Record<string, unknown>;
            return {
              name: n,
              label: (c.label as string) ?? n,
              databaseType: (c.databaseType as DatabaseType) ?? 'postgresql',
              connectionString: n === formName ? formConnStr : '',
            };
          },
        );
        onConnectionsChange(allConns);
      }

      // Fetch schema for the new connection
      try {
        const schemaRes = await fetch(`/api/schema/${encodeURIComponent(formName)}`);
        const schemaRaw = await schemaRes.json();
        const schemaData: DatabaseSchema = schemaRaw.schema ?? schemaRaw;
        if (schemaData.tables) {
          onSchemaLoaded(formName, schemaData);
        }
      } catch {
        // Schema fetch is optional
      }

      // Also fetch schemas for all other connected connections
      if (allData.success && allData.connections) {
        for (const [n, info] of Object.entries(allData.connections) as [string, Record<string, unknown>][]) {
          if (n !== formName && info.connected && (info.tableCount as number) > 0) {
            try {
              const sRes = await fetch(`/api/schema/${encodeURIComponent(n)}`);
              const sData = await sRes.json();
              const sSchema = sData.schema ?? sData;
              if (sSchema.tables) {
                onSchemaLoaded(n, sSchema as DatabaseSchema);
              }
            } catch {
              // skip
            }
          }
        }
      }

      await fetchStatuses();
      resetForm();
    } catch {
      setFormStatus('error');
      setFormMessage('Failed to reach the server.');
    }
  };

  // ── Delete connection ────────────────────────────────────────────
  const handleDelete = async (name: string) => {
    try {
      const res = await fetch(`/api/connections/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (data.success) {
        // Re-fetch all connections from backend to stay in sync
        const allRes = await apiFetch('/api/connections');
        const allData = await allRes.json();
        if (allData.success && allData.connections) {
          const allConns: NamedConnection[] = Object.entries(allData.connections).map(
            ([n, info]: [string, unknown]) => {
              const c = info as Record<string, unknown>;
              return {
                name: n,
                label: (c.label as string) ?? n,
                databaseType: (c.databaseType as DatabaseType) ?? 'postgresql',
                connectionString: '',
              };
            },
          );
          onConnectionsChange(allConns);
        } else {
          onConnectionsChange([]);
        }
        await fetchStatuses();
      }
    } catch {
      // Silently fail — next poll will reconcile
    }
    setConfirmDelete(null);
  };

  // Determine form title based on mode
  const formTitle = editingConnection ? 'Modifier la base de données' : 'Nouvelle base de données';

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-os-700/20 ring-1 ring-os-600/30">
          <svg
            className="w-5 h-5 text-os-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125v-3.75"
            />
          </svg>
        </div>
        <div>
          <h2 className="heading-md">Databases</h2>
          <p className="text-sm text-gray-500">Manage your database connections</p>
        </div>
      </div>

      {/* Connection cards grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[...allConnectionNames].map((name) => {
          const local = connections.find((c) => c.name === name);
          const remote = statuses[name];
          const label = local?.label || remote?.label || name;
          const dbType = local?.databaseType || remote?.databaseType || 'postgresql';
          const connected = remote?.connected ?? false;
          const tableCount = remote?.tableCount ?? 0;

          return (
            <div
              key={name}
              className="relative p-4 card-interactive"
            >
              {/* Action buttons (edit + delete) */}
              {confirmDelete === name ? (
                <div className="absolute top-2 right-2 flex items-center gap-1">
                  <button
                    onClick={() => handleDelete(name)}
                    title="Confirmer la suppression définitive"
                    className="px-2 py-0.5 text-xs bg-red-600 hover:bg-red-500 text-white rounded transition-all duration-200"
                  >
                    Yes
                  </button>
                  <button
                    onClick={() => setConfirmDelete(null)}
                    title="Annuler la suppression"
                    className="px-2 py-0.5 text-xs bg-gray-600 hover:bg-gray-500 text-white rounded transition-all duration-200"
                  >
                    No
                  </button>
                </div>
              ) : (
                <div className="absolute top-2 right-2 flex items-center gap-1">
                  {/* Edit button */}
                  <button
                    onClick={() => startEdit(name)}
                    title="Modifier la configuration de cette connexion"
                    className="p-1 text-gray-500 hover:text-os-400 transition-all duration-200 rounded hover:bg-os-500/10"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zM16.862 4.487L19.5 7.125"
                      />
                    </svg>
                  </button>
                  {/* Delete button */}
                  <button
                    onClick={() => setConfirmDelete(name)}
                    title="Supprimer cette connexion de la liste"
                    className="p-1 text-gray-500 hover:text-red-400 transition-all duration-200 rounded hover:bg-red-500/10"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              )}

              {/* Status dot + name */}
              <div className="flex items-center gap-2 mb-2 pr-16">
                <span
                  title={connected ? 'Connexion active' : 'Non connecté — cliquez sur Modifier pour vous connecter'}
                  className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${
                    connected ? 'bg-green-400 shadow-sm shadow-green-400/50' : 'bg-gray-500'
                  }`}
                />
                <span className="text-sm font-semibold text-gray-100 truncate">{label}</span>
              </div>

              {/* Subtitle: slug name */}
              <p className="text-xs text-gray-500 mb-3 truncate">{name}</p>

              {/* Database type badge + status */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span
                    title={`Base de données ${dbType}`}
                    className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${DB_TYPE_COLORS[dbType]}`}
                  >
                    {dbType}
                  </span>
                  {remote?.sslConfig?.enabled && (
                    <span
                      title="Chiffrement SSL/TLS activé sur cette connexion"
                      className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-700/20 text-green-400 border border-green-600/30"
                    >
                      SSL
                    </span>
                  )}
                  {remote?.sshConfig?.enabled && (
                    <span
                      title="Tunnel SSH activé — connexion via un serveur bastion"
                      className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-700/20 text-purple-400 border border-purple-600/30"
                    >
                      SSH
                    </span>
                  )}
                </div>
                {connected && tableCount > 0 ? (
                  <span className="text-xs text-gray-400">
                    {tableCount} table{tableCount !== 1 ? 's' : ''}
                  </span>
                ) : !connected && remote ? (
                  <span className="text-xs text-gray-500 italic">Not connected</span>
                ) : null}
              </div>
            </div>
          );
        })}

        {/* Add new connection card */}
        <button
          onClick={() => {
            if (!showForm) {
              setEditingConnection(null);
              setShowForm(true);
            }
          }}
          className="flex flex-col items-center justify-center p-4 rounded-xl border-2 border-dashed border-white/10 hover:border-os-500/50 bg-gray-800/20 hover:bg-os-700/10 transition-all duration-200 min-h-[120px] cursor-pointer group"
        >
          <svg
            className="w-8 h-8 text-gray-600 group-hover:text-os-400 transition-all duration-200"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          <span className="mt-2 text-sm text-gray-500 group-hover:text-os-400 transition-all duration-200">
            Add database
          </span>
        </button>
      </div>

      {/* Add / Edit form */}
      {showForm && (
        <div className="p-4 card-primary space-y-4">
          <h3 className="heading-md">{formTitle}</h3>

          {/* Label */}
          <div>
            <label className="block eyebrow mb-1.5">Name <span className="text-red-400">*</span></label>
            <input
              type="text"
              value={formLabel}
              onChange={(e) => setFormLabel(e.target.value)}
              placeholder="My Production DB"
              className="input-editorial w-full"
            />
          </div>

          {/* Toggle for identifier field */}
          <div>
            <button
              type="button"
              onClick={() => setShowIdentifier(!showIdentifier)}
              className="text-xs text-gray-500 hover:text-os-400 transition-all duration-200 flex items-center gap-1"
            >
              <svg
                className={`w-3 h-3 transition-transform duration-200 ${showIdentifier ? 'rotate-90' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
              Customize identifier
            </button>

            {/* Identifier (slug) field — shown only when toggled */}
            {showIdentifier && (
              <div className="mt-2">
                <label className="block eyebrow mb-1.5">Identifier</label>
                <input
                  type="text"
                  value={formName}
                  onChange={(e) => {
                    setFormNameManual(true);
                    setFormName(slugify(e.target.value));
                  }}
                  placeholder="my-production-db"
                  className="input-editorial w-full"
                />
                {!formNameManual && formName && !nameAlreadyExists && (
                  <p className="mt-1 text-xs text-gray-500">Auto-generated from name</p>
                )}
                {nameAlreadyExists && (
                  <p className="mt-1 text-xs text-red-400">This identifier is already taken</p>
                )}
              </div>
            )}

            {/* Show auto-generated hint when identifier is hidden */}
            {!showIdentifier && formName && !nameAlreadyExists && (
              <p className="mt-1 text-xs text-gray-500">
                Identifier: <span className="font-mono">{formName}</span> (auto-generated)
              </p>
            )}
            {!showIdentifier && nameAlreadyExists && (
              <p className="mt-1 text-xs text-red-400">This identifier is already taken</p>
            )}
          </div>

          {/* Database type */}
          <div>
            <p className="eyebrow mb-3">Database Type</p>
            <div className="flex flex-col gap-3">
              {DB_OPTIONS.map((opt) => (
                <label
                  key={opt.type}
                  className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all duration-200 ${
                    formDbType === opt.type
                      ? 'border-os-600/60 bg-os-700/10 ring-1 ring-os-600/20'
                      : 'border-white/5 hover:border-white/10 bg-gray-900/40'
                  }`}
                >
                  <input
                    type="radio"
                    name="formDbType"
                    value={opt.type}
                    checked={formDbType === opt.type}
                    onChange={() => setFormDbType(opt.type)}
                    className="mt-0.5 text-os-500 focus:ring-os-500/30 focus:ring-offset-0"
                  />
                  <span className="flex items-center gap-1.5 text-sm font-medium text-gray-200">
                    {opt.label}
                    <HelpTip content={opt.helpText} position="right" maxWidth={320} />
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* Connection string */}
          <div>
            <label className="block eyebrow mb-1.5">
              Chaîne de connexion <span className="text-red-400">*</span>
            </label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={hasSavedConnStr && !connStringRevealed && !formConnStr ? '••••••••••••••••••••••••' : formConnStr}
                onChange={(e) => setFormConnStr(e.target.value)}
                placeholder={activeDbOption.placeholder}
                readOnly={hasSavedConnStr && !connStringRevealed && !formConnStr}
                className={`input-editorial w-full pr-20 ${
                  hasSavedConnStr && !connStringRevealed && !formConnStr ? 'cursor-pointer' : ''
                }`}
                onClick={() => {
                  if (hasSavedConnStr && !connStringRevealed && !formConnStr) {
                    setShowRevealPrompt(true);
                  }
                }}
              />
              <button
                type="button"
                onClick={() => {
                  if (hasSavedConnStr && !connStringRevealed && !formConnStr) {
                    setShowRevealPrompt(true);
                  } else {
                    setShowPassword(!showPassword);
                  }
                }}
                title={
                  hasSavedConnStr && !connStringRevealed && !formConnStr
                    ? 'Révéler la chaîne de connexion (mot de passe administrateur requis)'
                    : showPassword
                      ? 'Masquer la chaîne de connexion'
                      : 'Afficher la chaîne de connexion en clair'
                }
                className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-500 hover:text-gray-300"
              >
                {hasSavedConnStr && !connStringRevealed && !formConnStr ? 'Show' : showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
            <p className="mt-1.5 text-xs text-gray-500">{activeDbOption.helpText}</p>

            {/* Admin password prompt to reveal connection string */}
            {showRevealPrompt && (
              <div className="mt-3 p-3 rounded-lg border border-os-600/40 bg-os-900/20 space-y-2">
                <p className="text-xs text-gray-300">Enter your admin password to reveal the connection string.</p>
                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    value={revealPassword}
                    onChange={(e) => setRevealPassword(e.target.value)}
                    placeholder="Admin password"
                    autoFocus
                    className="input-editorial flex-1 text-sm"
                    onKeyDown={(e) => { if (e.key === 'Enter') handleRevealConnectionString(); }}
                  />
                  <button
                    type="button"
                    onClick={handleRevealConnectionString}
                    disabled={!revealPassword || revealStatus === 'loading'}
                    className="px-3 py-1.5 bg-os-700 hover:bg-os-600 disabled:opacity-50 rounded-lg text-sm font-medium transition-all duration-200"
                  >
                    {revealStatus === 'loading' ? '...' : 'OK'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowRevealPrompt(false); setRevealPassword(''); setRevealError(''); }}
                    className="px-2 py-1.5 text-gray-500 hover:text-gray-300 text-sm transition-all duration-200"
                  >
                    Cancel
                  </button>
                </div>
                {revealStatus === 'error' && (
                  <p className="text-xs text-red-400">{revealError}</p>
                )}
              </div>
            )}
          </div>

          {/* SSL/TLS section — only for PostgreSQL and MySQL */}
          {formDbType !== 'sqlite' && (
            <div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setSslExpanded(!sslExpanded)}
                  className="flex items-center gap-2 text-sm text-gray-400 hover:text-gray-200 transition-colors duration-150 focus:outline-none focus:ring-1 focus:ring-os-500/40 rounded px-1"
                  aria-expanded={sslExpanded}
                >
                  <svg
                    className={`w-3.5 h-3.5 transition-transform duration-200 ${sslExpanded ? 'rotate-90' : ''}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                  SSL/TLS Settings
                  {sslEnabled && (
                    <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-700/30 text-green-400 border border-green-600/30">
                      enabled
                    </span>
                  )}
                </button>
                <HelpTip
                  content="Encrypt the connection with TLS certificates — recommended for any production database"
                  position="right"
                  maxWidth={300}
                />
              </div>

              {sslExpanded && (
                <div className="mt-3 space-y-3 pl-2 border-l-2 border-white/10">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={sslEnabled}
                      onChange={(e) => setSslEnabled(e.target.checked)}
                      className="rounded border-gray-600 bg-gray-700 text-os-500 focus:ring-os-500/30 focus:ring-offset-0"
                    />
                    <span className="text-sm text-gray-300">Enable SSL/TLS</span>
                  </label>

                  {sslEnabled && (
                    <>
                      <div>
                        <label className="block eyebrow mb-1">CA Certificate (PEM)</label>
                        <textarea
                          value={sslCa}
                          onChange={(e) => setSslCa(e.target.value)}
                          rows={4}
                          placeholder={"-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"}
                          className="input-editorial w-full text-xs resize-none"
                        />
                        <p className="mt-1 text-xs text-gray-600">Paste your server CA certificate in PEM format.</p>
                      </div>
                      <div>
                        <label className="block eyebrow mb-1">Client Certificate (PEM, optional)</label>
                        <textarea
                          value={sslCert}
                          onChange={(e) => setSslCert(e.target.value)}
                          rows={3}
                          placeholder="-----BEGIN CERTIFICATE-----"
                          className="input-editorial w-full text-xs resize-none"
                        />
                      </div>
                      <div>
                        <label className="block eyebrow mb-1">Client Key (PEM, optional)</label>
                        <textarea
                          value={sslKey}
                          onChange={(e) => setSslKey(e.target.value)}
                          rows={3}
                          placeholder="-----BEGIN PRIVATE KEY-----"
                          className="input-editorial w-full text-xs resize-none"
                        />
                      </div>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={sslRejectUnauthorized}
                          onChange={(e) => setSslRejectUnauthorized(e.target.checked)}
                          className="rounded border-gray-600 bg-gray-700 text-os-500 focus:ring-os-500/30 focus:ring-offset-0"
                        />
                        <span className="flex items-center gap-1.5 text-sm text-gray-300">
                          Verify server certificate
                          <HelpTip
                            content="If disabled, the server certificate will not be verified — leaves the connection vulnerable to MITM attacks"
                            position="right"
                            maxWidth={300}
                          />
                        </span>
                      </label>
                      {!sslRejectUnauthorized && (
                        <p className="text-xs text-yellow-500/80 bg-yellow-900/10 border border-yellow-700/30 rounded px-2 py-1">
                          Warning: disabling certificate verification exposes you to man-in-the-middle attacks.
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* SSH Tunnel section — all database types */}
          <div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setSshExpanded(!sshExpanded)}
                className="flex items-center gap-2 text-sm text-gray-400 hover:text-gray-200 transition-colors duration-150 focus:outline-none focus:ring-1 focus:ring-os-500/40 rounded px-1"
                aria-expanded={sshExpanded}
              >
                <svg
                  className={`w-3.5 h-3.5 transition-transform duration-200 ${sshExpanded ? 'rotate-90' : ''}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
                SSH Tunnel
                {sshEnabled && (
                  <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-700/30 text-purple-400 border border-purple-600/30">
                    enabled
                  </span>
                )}
              </button>
              <HelpTip
                content="Connect through an SSH bastion to reach databases on private networks"
                position="right"
                maxWidth={320}
              />
            </div>

            {sshExpanded && (
              <div className="mt-3 space-y-3 pl-2 border-l-2 border-white/10">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={sshEnabled}
                    onChange={(e) => setSshEnabled(e.target.checked)}
                    className="rounded border-gray-600 bg-gray-700 text-os-500 focus:ring-os-500/30 focus:ring-offset-0"
                  />
                  <span className="text-sm text-gray-300">Enable SSH Tunnel</span>
                </label>

                {sshEnabled && (
                  <>
                    {/* Visual connection diagram */}
                    <div className="text-xs text-gray-500 bg-gray-800/50 rounded p-2 font-mono">
                      Calame → SSH ({sshHost || '...'}:{sshPort}) → DB ({sshDbHost || '...'}:{sshDbPort})
                    </div>

                    {/* SSH Host + Port */}
                    <div className="grid grid-cols-3 gap-2">
                      <div className="col-span-2">
                        <label className="block eyebrow mb-1">SSH Host</label>
                        <input
                          type="text"
                          value={sshHost}
                          onChange={(e) => setSshHost(e.target.value)}
                          placeholder="bastion.example.com"
                          className="input-editorial w-full text-xs"
                        />
                      </div>
                      <div>
                        <label className="block eyebrow mb-1">SSH Port</label>
                        <input
                          type="number"
                          value={sshPort}
                          onChange={(e) => setSshPort(parseInt(e.target.value, 10) || 22)}
                          className="input-editorial w-full text-xs"
                        />
                      </div>
                    </div>

                    {/* SSH Username */}
                    <div>
                      <label className="block eyebrow mb-1">SSH Username</label>
                      <input
                        type="text"
                        value={sshUsername}
                        onChange={(e) => setSshUsername(e.target.value)}
                        placeholder="ec2-user"
                        className="input-editorial w-full text-xs"
                      />
                    </div>

                    {/* Private Key */}
                    <div>
                      <label className="block eyebrow mb-1">Private Key (PEM)</label>
                      <textarea
                        value={sshPrivateKey}
                        onChange={(e) => setSshPrivateKey(e.target.value)}
                        rows={4}
                        placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                        className="input-editorial w-full text-xs resize-none"
                      />
                    </div>

                    {/* Password */}
                    <div>
                      <label className="block eyebrow mb-1">
                        Password (if no key)
                      </label>
                      <input
                        type="password"
                        value={sshPassword}
                        onChange={(e) => setSshPassword(e.target.value)}
                        className="input-editorial w-full text-xs"
                      />
                    </div>

                    {/* Remote DB Host + Port */}
                    <div className="grid grid-cols-3 gap-2">
                      <div className="col-span-2">
                        <label className="block eyebrow mb-1">
                          DB Host (from bastion)
                        </label>
                        <input
                          type="text"
                          value={sshDbHost}
                          onChange={(e) => setSshDbHost(e.target.value)}
                          placeholder="10.0.1.5"
                          className="input-editorial w-full text-xs"
                        />
                      </div>
                      <div>
                        <label className="block eyebrow mb-1">DB Port</label>
                        <input
                          type="number"
                          value={sshDbPort}
                          onChange={(e) => setSshDbPort(parseInt(e.target.value, 10) || 5432)}
                          className="input-editorial w-full text-xs"
                        />
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Status message */}
          {formStatus === 'success' && (
            <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/20">
              <p className="text-green-400 text-sm font-medium">{formMessage}</p>
            </div>
          )}
          {formStatus === 'error' && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20">
              <p className="text-red-400 text-sm font-medium">{formMessage}</p>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={handleTest}
              disabled={!formConnStr || !formName || formStatus === 'testing' || formStatus === 'connecting'}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 rounded-lg font-medium text-sm transition-all duration-200 flex items-center gap-2"
            >
              {formStatus === 'testing' && (
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              )}
              {formStatus === 'testing' ? 'Testing...' : 'Test'}
            </button>
            <HelpTip content="Test the connection without saving — verifies that the parameters are correct." position="top" />

            <button
              onClick={handleConnect}
              disabled={
                !formConnStr || !formName || !formLabel || formStatus === 'testing' || formStatus === 'connecting'
              }
              className="px-4 py-2 bg-os-700 hover:bg-os-600 disabled:opacity-50 rounded-lg font-medium text-sm transition-all duration-200 shadow-md shadow-os-900/20 hover:shadow-lg hover:shadow-os-900/30 disabled:shadow-none flex items-center gap-2"
            >
              {formStatus === 'connecting' && (
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              )}
              {formStatus === 'connecting' ? 'Connecting...' : 'Connect'}
            </button>
            <HelpTip content="Save and establish the connection — the schema will be imported automatically." position="top" />

            <button
              onClick={resetForm}
              className="px-4 py-2 text-gray-400 hover:text-gray-200 rounded-lg font-medium text-sm transition-all duration-200"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
