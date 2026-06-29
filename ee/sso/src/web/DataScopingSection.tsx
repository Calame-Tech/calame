// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { useState, useMemo } from 'react';
import type {
  Profile,
  Configuration,
  DataScopeRule,
} from '../../../../packages/web/src/types/schema.js';
import { getConfigurationSelectedTables } from '../../../../packages/web/src/lib/configuration-accessors.js';
import { getProfileSelectedTables } from '../../../../packages/web/src/lib/profile-accessors.js';

interface DataScopingSectionProps {
  profile: Profile;
  configurations: Configuration[];
  onScopeRulesChange: (rules: DataScopeRule[], sharedTables: string[]) => void;
}

export default function DataScopingSection({
  profile,
  configurations,
  onScopeRulesChange,
}: DataScopingSectionProps) {
  const rules = profile.dataScopeRules ?? [];
  const shared = profile.sharedTables ?? [];

  const availableTables = useMemo(() => {
    const tables = new Set<string>();
    const cfgNames = profile.configurations ?? [];
    if (cfgNames.length > 0) {
      for (const cfgName of cfgNames) {
        const cfg = configurations.find((c) => c.name === cfgName);
        if (cfg) {
          for (const t of Object.keys(getConfigurationSelectedTables(cfg))) tables.add(t);
        }
      }
    } else {
      for (const t of Object.keys(getProfileSelectedTables(profile))) tables.add(t);
    }
    return [...tables].sort();
  }, [profile, configurations]);

  const columnsPerTable = useMemo(() => {
    const result: Record<string, string[]> = {};
    const cfgNames = profile.configurations ?? [];
    if (cfgNames.length > 0) {
      for (const cfgName of cfgNames) {
        const cfg = configurations.find((c) => c.name === cfgName);
        if (cfg) {
          for (const [table, cols] of Object.entries(getConfigurationSelectedTables(cfg))) {
            result[table] = [...new Set([...(result[table] ?? []), ...cols])];
          }
        }
      }
    } else {
      for (const [table, cols] of Object.entries(getProfileSelectedTables(profile))) {
        result[table] = [...cols];
      }
    }
    return result;
  }, [profile, configurations]);

  const unassignedTables = useMemo(() => {
    const assigned = new Set([...rules.map((r) => r.tableName), ...shared]);
    return availableTables.filter((t) => !assigned.has(t));
  }, [availableTables, rules, shared]);

  const [newRuleTable, setNewRuleTable] = useState('');

  const addRule = () => {
    if (!newRuleTable) return;
    const cols = columnsPerTable[newRuleTable] ?? [];
    const newRule: DataScopeRule = {
      tableName: newRuleTable,
      column: cols[0] ?? '',
      identityField: 'email',
    };
    onScopeRulesChange([...rules, newRule], shared);
    setNewRuleTable('');
  };

  const updateRule = (index: number, patch: Partial<DataScopeRule>) => {
    const updated = [...rules];
    updated[index] = { ...updated[index], ...patch };
    if (patch.identityField && patch.identityField !== 'custom') {
      delete updated[index].customKey;
    }
    onScopeRulesChange(updated, shared);
  };

  const removeRule = (index: number) => {
    onScopeRulesChange(
      rules.filter((_, i) => i !== index),
      shared,
    );
  };

  const addSharedTable = (table: string) => {
    if (!table) return;
    onScopeRulesChange(rules, [...shared, table]);
  };

  const removeSharedTable = (table: string) => {
    onScopeRulesChange(
      rules,
      shared.filter((t) => t !== table),
    );
  };

  const hasRules = rules.length > 0;

  return (
    <div className="space-y-4">
      {/* Explanation */}
      <div className="card-primary p-4">
        <h3 className="text-sm font-semibold text-gray-300 mb-2">
          Data Scoping (Row-Level Isolation)
        </h3>
        <p className="text-sm text-gray-400 mb-3">
          Restrict each user to only see their own data. Configure rules that automatically filter
          database rows based on the authenticated user&apos;s identity.
        </p>
        {!hasRules && (
          <p className="text-xs text-gray-500">
            No scope rules configured. All authenticated users see all rows in all tables.
          </p>
        )}
        {hasRules && (
          <div className="flex items-center gap-2 text-xs text-amber-400 bg-amber-950/30 border border-amber-800/50 rounded-lg p-2">
            <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path
                fillRule="evenodd"
                d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z"
                clipRule="evenodd"
              />
            </svg>
            <span>
              Strict mode active: tables without a scope rule or shared designation will be{' '}
              <strong>blocked</strong> (0 results). This profile requires individual authentication
              (not &quot;open&quot; mode).
            </span>
          </div>
        )}
      </div>

      {/* Scope Rules */}
      <div className="card-primary p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-gray-300">Scope Rules</h3>
          <span className="text-xs text-gray-500">
            {rules.length} rule{rules.length !== 1 ? 's' : ''}
          </span>
        </div>

        {rules.length > 0 && (
          <div className="space-y-3 mb-4">
            {rules.map((rule, i) => {
              const cols = columnsPerTable[rule.tableName] ?? [];
              return (
                <div
                  key={i}
                  className="flex items-start gap-2 p-3 rounded-lg border border-white/5 bg-gray-900/30"
                >
                  <div className="flex-shrink-0 min-w-[120px]">
                    <label className="text-xs text-gray-500 block mb-1">Table</label>
                    <span className="text-sm text-blue-300 font-mono">{rule.tableName}</span>
                  </div>

                  <div className="flex-1 min-w-[120px]">
                    <label className="text-xs text-gray-500 block mb-1">Column</label>
                    <select
                      value={rule.column}
                      onChange={(e) => updateRule(i, { column: e.target.value })}
                      className="w-full bg-gray-900 border border-white/10 rounded px-2 py-1 text-sm text-gray-200"
                    >
                      <option value="">Select column...</option>
                      {cols.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="flex-1 min-w-[120px]">
                    <label className="text-xs text-gray-500 block mb-1">Match with</label>
                    <select
                      value={rule.identityField}
                      onChange={(e) =>
                        updateRule(i, {
                          identityField: e.target.value as DataScopeRule['identityField'],
                        })
                      }
                      className="w-full bg-gray-900 border border-white/10 rounded px-2 py-1 text-sm text-gray-200"
                    >
                      <option value="email">User email</option>
                      <option value="externalId">External ID (OIDC sub)</option>
                      <option value="custom">Custom attribute</option>
                    </select>
                  </div>

                  {rule.identityField === 'custom' && (
                    <div className="flex-1 min-w-[100px]">
                      <label className="text-xs text-gray-500 block mb-1">Attribute key</label>
                      <input
                        type="text"
                        value={rule.customKey ?? ''}
                        onChange={(e) => updateRule(i, { customKey: e.target.value })}
                        placeholder="e.g. client_id"
                        className="w-full bg-gray-900 border border-white/10 rounded px-2 py-1 text-sm text-gray-200"
                      />
                    </div>
                  )}

                  <button
                    onClick={() => removeRule(i)}
                    className="mt-5 text-gray-500 hover:text-red-400 transition-colors"
                    title="Remove rule"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {unassignedTables.length > 0 && (
          <div className="flex items-center gap-2">
            <select
              value={newRuleTable}
              onChange={(e) => setNewRuleTable(e.target.value)}
              className="bg-gray-900 border border-white/10 rounded px-2 py-1.5 text-sm text-gray-200"
            >
              <option value="">Select table...</option>
              {unassignedTables
                .filter((t) => !shared.includes(t))
                .map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
            </select>
            <button
              onClick={addRule}
              disabled={!newRuleTable}
              className="px-3 py-1.5 text-sm rounded bg-os-600 hover:bg-os-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              + Add Scope Rule
            </button>
          </div>
        )}
      </div>

      {/* Shared Tables */}
      {hasRules && (
        <div className="card-primary p-4">
          <h3 className="text-sm font-semibold text-gray-300 mb-2">Shared Tables</h3>
          <p className="text-xs text-gray-500 mb-3">
            Tables listed here are visible to all authenticated users without filtering (e.g.,
            product catalogs, reference data).
          </p>

          {shared.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-3">
              {shared.map((table) => (
                <span
                  key={table}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-green-600/30 bg-green-700/10 text-sm text-green-300"
                >
                  {table}
                  <button
                    onClick={() => removeSharedTable(table)}
                    className="text-green-500/60 hover:text-red-400 transition-colors"
                  >
                    <svg
                      className="w-3.5 h-3.5"
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
                </span>
              ))}
            </div>
          )}

          {unassignedTables.length > 0 && (
            <div className="flex items-center gap-2">
              <select
                id="shared-table-select"
                className="bg-gray-900 border border-white/10 rounded px-2 py-1.5 text-sm text-gray-200"
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) {
                    addSharedTable(e.target.value);
                    e.target.value = '';
                  }
                }}
              >
                <option value="">Select table...</option>
                {unassignedTables.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <span className="text-xs text-gray-500">Mark as shared (no scoping)</span>
            </div>
          )}

          {unassignedTables.length === 0 && shared.length === 0 && (
            <p className="text-xs text-gray-500">All tables are assigned to scope rules.</p>
          )}
        </div>
      )}
    </div>
  );
}
