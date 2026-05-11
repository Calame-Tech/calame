import { useState } from 'react';
import { apiFetch } from '../lib/api.js';
import type { DatabaseSchema, DatabaseType, SslConfig } from '../types/schema.js';

interface ConnectionFormProps {
  connectionString: string;
  setConnectionString: (value: string) => void;
  databaseType: DatabaseType;
  setDatabaseType: (value: DatabaseType) => void;
  onConnected: (schema: DatabaseSchema) => void;
}

const DB_OPTIONS: { type: DatabaseType; label: string; description: string; placeholder: string; helpText: string }[] = [
  {
    type: 'postgresql',
    label: 'PostgreSQL',
    description: 'Full-featured relational database',
    placeholder: 'postgresql://user:password@localhost:5432/mydb',
    helpText: 'Format: postgresql://user:password@host:port/database',
  },
  {
    type: 'mysql',
    label: 'MySQL',
    description: 'Popular open-source relational database',
    placeholder: 'mysql://user:password@localhost:3306/mydb',
    helpText: 'Format: mysql://user:password@host:port/database',
  },
  {
    type: 'sqlite',
    label: 'SQLite',
    description: 'Lightweight file-based database',
    placeholder: 'sqlite:///path/to/database.db',
    helpText: 'Format: sqlite:///path/to/database.db',
  },
];

const TEXTAREA_CLASS =
  'input-editorial w-full text-xs resize-none';

export default function ConnectionForm({
  connectionString,
  setConnectionString,
  databaseType,
  setDatabaseType,
  onConnected,
}: ConnectionFormProps) {
  const [showPassword, setShowPassword] = useState(false);
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [tableCount, setTableCount] = useState<number | null>(null);

  // SSL state
  const [sslExpanded, setSslExpanded] = useState(false);
  const [sslEnabled, setSslEnabled] = useState(false);
  const [sslCa, setSslCa] = useState('');
  const [sslCert, setSslCert] = useState('');
  const [sslKey, setSslKey] = useState('');
  const [sslRejectUnauthorized, setSslRejectUnauthorized] = useState(true);

  const activeOption = DB_OPTIONS.find((o) => o.type === databaseType)!;

  const handleTest = async () => {
    setStatus('loading');
    setTableCount(null);
    setMessage('');

    const sslConfig: SslConfig | undefined =
      databaseType !== 'sqlite' && sslEnabled
        ? {
            enabled: true,
            ca: sslCa.trim() || undefined,
            cert: sslCert.trim() || undefined,
            key: sslKey.trim() || undefined,
            rejectUnauthorized: sslRejectUnauthorized,
          }
        : undefined;

    try {
      const connectRes = await apiFetch('/api/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionString, databaseType, sslConfig }),
      });
      const connectData = await connectRes.json();

      if (!connectData.success) {
        setStatus('error');
        setMessage(connectData.message || 'Connection failed');
        return;
      }

      setMessage('Connection successful! Fetching schema...');

      const schemaRes = await apiFetch('/api/schema');
      const schemaRaw = await schemaRes.json();
      const schemaData: DatabaseSchema = schemaRaw.schema ?? schemaRaw;
      const count = connectData.tableCount ?? schemaData.tables.length;

      setTableCount(count);
      setStatus('success');
      setMessage('Connection successful!');
      onConnected(schemaData);
    } catch {
      setStatus('error');
      setMessage('Failed to reach the server');
    }
  };

  return (
    <div className="max-w-xl mx-auto">
      <div className="flex items-center gap-3 mb-4">
        <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-os-700/20 ring-1 ring-os-600/30">
          <svg className="w-5 h-5 text-os-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125v-3.75" />
          </svg>
        </div>
        <div>
          <h2 className="heading-md">Base de données</h2>
          <p className="text-sm text-gray-500">Connectez-vous à votre base de données</p>
        </div>
      </div>

      {/* Database type selector */}
      <div className="mb-4">
        <p className="eyebrow mb-3">Database Type</p>
        <div className="flex flex-col gap-3">
          {DB_OPTIONS.map((opt) => (
            <label
              key={opt.type}
              className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all duration-200 ${
                databaseType === opt.type
                  ? 'border-os-600/60 bg-os-700/10 ring-1 ring-os-600/20'
                  : 'border-white/5 hover:border-white/10 bg-gray-900/40'
              }`}
            >
              <input
                type="radio"
                name="databaseType"
                value={opt.type}
                checked={databaseType === opt.type}
                onChange={() => setDatabaseType(opt.type)}
                className="mt-0.5 text-os-500 focus:ring-os-500/30 focus:ring-offset-0"
              />
              <div>
                <span className="text-sm font-medium text-gray-200">{opt.label}</span>
                <p className="text-xs text-gray-500 mt-0.5">{opt.description}</p>
              </div>
            </label>
          ))}
        </div>
      </div>

      <p className="eyebrow mb-2">Chaîne de connexion</p>
      <div className="relative">
        <input
          type={showPassword ? 'text' : 'password'}
          value={connectionString}
          onChange={(e) => setConnectionString(e.target.value)}
          placeholder={activeOption.placeholder}
          className="input-editorial w-full pr-16"
        />
        <button
          onClick={() => setShowPassword(!showPassword)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-500 hover:text-gray-300"
          type="button"
          aria-label={showPassword ? 'Hide connection string' : 'Show connection string'}
        >
          {showPassword ? 'Hide' : 'Show'}
        </button>
      </div>
      <p className="mt-2 text-xs text-gray-500">
        {activeOption.helpText}
      </p>

      {/* SSL/TLS section — only for PostgreSQL and MySQL */}
      {databaseType !== 'sqlite' && (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setSslExpanded(!sslExpanded)}
            className="flex items-center gap-2 text-sm text-gray-400 hover:text-gray-200 transition-colors duration-150 focus:outline-none focus:ring-1 focus:ring-os-500/40 rounded px-1"
            aria-expanded={sslExpanded}
            aria-controls="ssl-section"
          >
            <svg
              className={`w-3.5 h-3.5 transition-transform duration-200 ${sslExpanded ? 'rotate-90' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
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

          {sslExpanded && (
            <div id="ssl-section" className="mt-3 space-y-3 pl-2 border-l-2 border-white/10">
              {/* Enable toggle */}
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
                  {/* CA Certificate */}
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1" htmlFor="ssl-ca">
                      CA Certificate (PEM)
                    </label>
                    <textarea
                      id="ssl-ca"
                      value={sslCa}
                      onChange={(e) => setSslCa(e.target.value)}
                      rows={4}
                      placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
                      className={TEXTAREA_CLASS}
                    />
                    <p className="mt-1 text-xs text-gray-600">
                      Paste your server CA certificate in PEM format.
                    </p>
                  </div>

                  {/* Client Certificate */}
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1" htmlFor="ssl-cert">
                      Client Certificate (PEM, optional)
                    </label>
                    <textarea
                      id="ssl-cert"
                      value={sslCert}
                      onChange={(e) => setSslCert(e.target.value)}
                      rows={4}
                      placeholder="-----BEGIN CERTIFICATE-----"
                      className={TEXTAREA_CLASS}
                    />
                  </div>

                  {/* Client Key */}
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1" htmlFor="ssl-key">
                      Client Key (PEM, optional)
                    </label>
                    <textarea
                      id="ssl-key"
                      value={sslKey}
                      onChange={(e) => setSslKey(e.target.value)}
                      rows={4}
                      placeholder="-----BEGIN PRIVATE KEY-----"
                      className={TEXTAREA_CLASS}
                    />
                  </div>

                  {/* Verify server certificate */}
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={sslRejectUnauthorized}
                      onChange={(e) => setSslRejectUnauthorized(e.target.checked)}
                      className="rounded border-gray-600 bg-gray-700 text-os-500 focus:ring-os-500/30 focus:ring-offset-0"
                    />
                    <span className="text-sm text-gray-300">Verify server certificate</span>
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

      <button
        onClick={handleTest}
        disabled={!connectionString || status === 'loading'}
        className="mt-4 px-6 py-2 bg-os-700 hover:bg-os-600 disabled:opacity-50 rounded-lg font-medium transition-all duration-200 shadow-md shadow-os-900/20 hover:shadow-lg hover:shadow-os-900/30 disabled:shadow-none flex items-center gap-2"
        type="button"
      >
        {status === 'loading' && (
          <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        )}
        {status === 'loading' ? 'Test en cours...' : 'Tester la connexion'}
      </button>

      {status === 'success' && (
        <div className="mt-4 p-3 rounded-lg bg-green-500/10 border border-green-500/20" role="status">
          <p className="text-green-400 text-sm font-medium">{message}</p>
          {tableCount !== null && (
            <p className="text-green-300/70 text-xs mt-1">
              Found {tableCount} table{tableCount !== 1 ? 's' : ''} in the database
            </p>
          )}
        </div>
      )}
      {status === 'error' && (
        <div className="mt-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20" role="alert">
          <p className="text-red-400 text-sm font-medium">{message}</p>
        </div>
      )}
    </div>
  );
}
