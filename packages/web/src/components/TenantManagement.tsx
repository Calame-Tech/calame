import { useState, useEffect, useCallback } from 'react';
import { apiFetch, apiGet, getCurrentTenant, removeTenantFromHistory } from '../lib/api.js';
import { Button, Card, EmptyState } from './ui/index.js';

/**
 * Tenant administration page (Phase D of the multi-tenancy story).
 *
 * Lists every tenant discovered by the backend (which aggregates DISTINCT
 * tenant_id across every tenanted table) with per-resource counts, and lets
 * an admin hard-delete a tenant. The default tenant and the currently active
 * tenant cannot be deleted from this UI — the API also rejects 'default',
 * but the UI surface makes it visually obvious so the admin doesn't try.
 *
 * The destructive flow is two-step:
 *   1. Click "Supprimer" → modal opens with a typed-confirmation input.
 *   2. The admin types the exact tenant id → the DELETE call fires.
 * The API additionally requires an `X-Confirm-Destructive` header parameterised
 * by the tenant id (anti-fat-finger defense in depth — even a Postman tab
 * pointed at a stale tenant can't accidentally delete the wrong one).
 */

interface TenantSummary {
  id: string;
  counts: Record<string, number>;
  totalResources: number;
}

interface TenantsListResponse {
  success: boolean;
  tenants?: TenantSummary[];
  message?: string;
}

/** Resource columns shown in the table. Keys must align with the camelCase
 *  count names emitted by GET /api/tenants. */
const RESOURCE_COLUMNS: Array<{ key: string; label: string }> = [
  { key: 'profiles', label: 'Profiles' },
  { key: 'configurations', label: 'Configurations' },
  { key: 'aiSettings', label: 'AI Settings' },
  { key: 'tokens', label: 'Tokens' },
  { key: 'users', label: 'Users' },
  { key: 'ragSources', label: 'RAG Sources' },
];

const LockIcon = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
    strokeWidth={1.5}
    stroke="currentColor"
    className="w-3.5 h-3.5"
    aria-hidden="true"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"
    />
  </svg>
);

const CheckIcon = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
    strokeWidth={2}
    stroke="currentColor"
    className="w-3.5 h-3.5"
    aria-hidden="true"
  >
    <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
  </svg>
);

export default function TenantManagement() {
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Delete confirm modal state
  const [pendingDelete, setPendingDelete] = useState<TenantSummary | null>(null);
  const [confirmInput, setConfirmInput] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const currentTenant = getCurrentTenant();

  const fetchTenants = useCallback(async () => {
    setError(null);
    try {
      const data = await apiGet<TenantsListResponse>('/api/tenants');
      if (data.success && data.tenants) {
        setTenants(data.tenants);
      } else {
        setError(data.message ?? 'Failed to load tenants.');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchTenants();
  }, [fetchTenants]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchTenants();
  };

  const openDeleteModal = (tenant: TenantSummary) => {
    setPendingDelete(tenant);
    setConfirmInput('');
    setDeleteError(null);
  };

  const closeDeleteModal = () => {
    setPendingDelete(null);
    setConfirmInput('');
    setDeleteError(null);
    setDeleting(false);
  };

  const performDelete = async () => {
    if (!pendingDelete) return;
    if (confirmInput !== pendingDelete.id) {
      setDeleteError(
        `Veuillez saisir exactement "${pendingDelete.id}" pour confirmer la suppression.`,
      );
      return;
    }

    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await apiFetch(`/api/tenants/${encodeURIComponent(pendingDelete.id)}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: {
          'X-Confirm-Destructive': `delete-tenant-${pendingDelete.id}`,
        },
      });
      const data = (await res.json()) as { success: boolean; message?: string };
      if (!res.ok || !data.success) {
        setDeleteError(data.message ?? `Delete failed with status ${res.status}.`);
        setDeleting(false);
        return;
      }
      // Drop the deleted tenant from local history so the workspace switcher
      // doesn't surface a stale entry the next time the dropdown opens.
      removeTenantFromHistory(pendingDelete.id);
      closeDeleteModal();
      // Re-fetch so the table reflects the new state.
      await fetchTenants();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setDeleteError(msg);
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <Card className="p-6">
        <p className="text-sm text-gray-400">Chargement des workspaces…</p>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="p-6 border border-red-500/30 bg-red-500/5">
        <p className="text-sm text-red-300">Erreur : {error}</p>
        <Button variant="secondary" size="sm" onClick={handleRefresh} className="mt-3">
          Réessayer
        </Button>
      </Card>
    );
  }

  if (tenants.length === 0) {
    return (
      <EmptyState
        title="Aucun workspace trouvé"
        description="Les workspaces sont créés implicitement par le premier INSERT. Utilisez le workspace switcher dans la sidebar pour basculer vers un nouveau contexte."
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Action bar */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-gray-400">
          {tenants.length} workspace{tenants.length > 1 ? 's' : ''} actif
          {tenants.length > 1 ? 's' : ''} sur cette instance.
        </p>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleRefresh}
          disabled={refreshing}
          aria-busy={refreshing}
        >
          {refreshing ? 'Actualisation…' : 'Actualiser'}
        </Button>
      </div>

      {/* Table */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-white/5 border-b border-white/10">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium text-gray-300">Workspace</th>
                {RESOURCE_COLUMNS.map((col) => (
                  <th
                    key={col.key}
                    className="text-right px-3 py-2.5 font-medium text-gray-400 font-mono-plex text-xs"
                  >
                    {col.label}
                  </th>
                ))}
                <th className="text-right px-3 py-2.5 font-medium text-gray-300">Total</th>
                <th className="text-right px-4 py-2.5 font-medium text-gray-300 w-32">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((tenant) => {
                const isDefault = tenant.id === 'default';
                const isCurrent = tenant.id === currentTenant;
                const isProtected = isDefault || isCurrent;
                return (
                  <tr
                    key={tenant.id}
                    className="border-b border-white/5 last:border-b-0 hover:bg-white/[0.02]"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-gray-200">{tenant.id}</span>
                        {isDefault && (
                          <span
                            title="Le tenant par défaut ne peut pas être supprimé — c'est le contexte implicite des installations mono-tenant."
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-gray-700/50 text-gray-400 text-[10px] font-mono-plex"
                          >
                            {LockIcon}
                            DEFAULT
                          </span>
                        )}
                        {isCurrent && !isDefault && (
                          <span
                            title="Workspace actif — bascule vers un autre workspace avant de pouvoir supprimer celui-ci."
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-violet-500/15 text-violet-300 text-[10px] font-mono-plex border border-violet-500/30"
                          >
                            {CheckIcon}
                            ACTIF
                          </span>
                        )}
                      </div>
                    </td>
                    {RESOURCE_COLUMNS.map((col) => (
                      <td
                        key={col.key}
                        className="text-right px-3 py-3 font-mono-plex text-xs text-gray-400"
                      >
                        {tenant.counts[col.key] ?? 0}
                      </td>
                    ))}
                    <td className="text-right px-3 py-3 font-mono-plex text-xs text-gray-200 font-semibold">
                      {tenant.totalResources}
                    </td>
                    <td className="text-right px-4 py-3">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={isProtected}
                        onClick={() => openDeleteModal(tenant)}
                        title={
                          isDefault
                            ? 'Le tenant par défaut ne peut pas être supprimé.'
                            : isCurrent
                              ? 'Bascule vers un autre workspace pour pouvoir supprimer celui-ci.'
                              : `Supprimer définitivement "${tenant.id}"`
                        }
                        className={
                          isProtected
                            ? 'text-gray-600 cursor-not-allowed'
                            : 'text-red-400 hover:bg-red-500/10 hover:text-red-300'
                        }
                      >
                        Supprimer
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Hint footer */}
      <p className="text-xs text-gray-500 leading-relaxed">
        Les workspaces sont créés implicitement : la première écriture avec un{' '}
        <code className="font-mono-plex text-gray-400">tenant_id</code> donné suffit à matérialiser
        un nouveau workspace. Pour en créer un, utilisez le sélecteur de workspace dans la sidebar.
      </p>

      {/* Confirm modal */}
      {pendingDelete && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="tenant-delete-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          onClick={(e) => {
            // Close when clicking the backdrop (but not the modal itself).
            if (e.target === e.currentTarget && !deleting) closeDeleteModal();
          }}
        >
          <Card className="max-w-lg w-full p-6 border border-red-500/30 bg-gray-950">
            <h2
              id="tenant-delete-modal-title"
              className="text-lg font-semibold text-red-300 mb-3"
            >
              Supprimer définitivement le workspace ?
            </h2>
            <p className="text-sm text-gray-300 leading-relaxed">
              Vous êtes sur le point de supprimer le workspace{' '}
              <code className="font-mono-plex text-red-300 bg-red-500/10 px-1.5 py-0.5 rounded">
                {pendingDelete.id}
              </code>
              . Cette action est <strong className="text-red-300">irréversible</strong> et
              supprimera tous les profiles, configurations, sources RAG, tokens, utilisateurs et
              données associées à ce workspace.
            </p>

            {/* Resource summary */}
            <div className="mt-4 p-3 rounded-lg bg-white/5 border border-white/10">
              <p className="text-xs text-gray-500 font-mono-plex uppercase tracking-wider mb-2">
                Données qui seront supprimées
              </p>
              <ul className="space-y-1">
                {RESOURCE_COLUMNS.map((col) => {
                  const n = pendingDelete.counts[col.key] ?? 0;
                  if (n === 0) return null;
                  return (
                    <li key={col.key} className="flex justify-between text-xs">
                      <span className="text-gray-400">{col.label}</span>
                      <span className="font-mono-plex text-gray-200">{n}</span>
                    </li>
                  );
                })}
                {pendingDelete.totalResources === 0 && (
                  <li className="text-xs text-gray-500 italic">
                    Aucune ressource — suppression idempotente.
                  </li>
                )}
              </ul>
            </div>

            {/* Typed confirmation input */}
            <div className="mt-5">
              <label htmlFor="tenant-confirm-input" className="block text-xs text-gray-400 mb-1.5">
                Saisissez{' '}
                <code className="font-mono-plex text-red-300">{pendingDelete.id}</code> pour
                confirmer :
              </label>
              <input
                id="tenant-confirm-input"
                type="text"
                value={confirmInput}
                onChange={(e) => {
                  setConfirmInput(e.target.value);
                  setDeleteError(null);
                }}
                disabled={deleting}
                autoFocus
                placeholder={pendingDelete.id}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-red-500/60 focus:border-red-500/40"
              />
              {deleteError && (
                <p role="alert" className="mt-2 text-xs text-red-400 leading-tight">
                  {deleteError}
                </p>
              )}
            </div>

            {/* Action buttons */}
            <div className="mt-6 flex items-center justify-end gap-2">
              <Button variant="secondary" size="md" onClick={closeDeleteModal} disabled={deleting}>
                Annuler
              </Button>
              <Button
                variant="danger"
                size="md"
                onClick={performDelete}
                disabled={deleting || confirmInput !== pendingDelete.id}
                loading={deleting}
              >
                {deleting ? 'Suppression…' : 'Supprimer définitivement'}
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
