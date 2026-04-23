import { useState } from 'react';
import type { Profile } from '../types/schema.js';
import HelpTip from './HelpTip.js';

interface ProfileManagerProps {
  profiles: Profile[];
  activeIndex: number;
  onSwitch: (index: number) => void;
  onCreate: (name: string, label: string) => void;
  onDuplicate: (index: number) => void;
  onDelete: (index: number) => void;
  onRename: (index: number, label: string) => void;
  onSave: () => void;
  onLoad: () => void;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export default function ProfileManager({
  profiles,
  activeIndex,
  onSwitch,
  onCreate,
  onDuplicate,
  onDelete,
  onRename,
  onSave,
  onLoad,
}: ProfileManagerProps) {
  const [creating, setCreating] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState('');

  const handleCreate = () => {
    const label = newLabel.trim();
    if (!label) return;
    const name = slugify(label);
    if (!name || profiles.some((p) => p.name === name)) return;
    onCreate(name, label);
    setNewLabel('');
    setCreating(false);
  };

  const handleRename = (index: number) => {
    const label = editLabel.trim();
    if (!label) return;
    onRename(index, label);
    setEditingIndex(null);
    setEditLabel('');
  };

  return (
    <div className="px-6 py-3 border-b border-gray-800/80 bg-gray-900/30">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-medium text-gray-500 uppercase tracking-wider mr-1">Profiles</span>

        {profiles.map((profile, i) => (
          <div key={profile.name} className="flex items-center gap-0">
            {editingIndex === i ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleRename(i);
                }}
                className="flex items-center gap-1"
              >
                <input
                  type="text"
                  value={editLabel}
                  onChange={(e) => setEditLabel(e.target.value)}
                  autoFocus
                  className="px-2 py-1 text-xs rounded bg-gray-800 border border-os-500 text-gray-100 focus:outline-none w-24"
                  onBlur={() => setEditingIndex(null)}
                  onKeyDown={(e) => e.key === 'Escape' && setEditingIndex(null)}
                />
              </form>
            ) : (
              <button
                onClick={() => onSwitch(i)}
                onDoubleClick={() => {
                  setEditingIndex(i);
                  setEditLabel(profile.label);
                }}
                title="Cliquer pour activer ce profil. Double-cliquer pour renommer."
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all duration-200 ${
                  i === activeIndex
                    ? 'bg-os-700/80 text-white shadow-sm'
                    : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/70'
                }`}
              >
                {profile.label}
              </button>
            )}

            {i === activeIndex && profiles.length > 1 && (
              <div className="flex items-center ml-0.5 gap-0.5">
                <button
                  onClick={() => onDuplicate(i)}
                  title="Dupliquer ce profil avec ses paramètres actuels"
                  className="p-1 text-gray-500 hover:text-gray-300 transition-colors"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </button>
                <button
                  onClick={() => {
                    if (confirm(`Delete profile "${profile.label}"?`)) {
                      onDelete(i);
                    }
                  }}
                  title="Supprimer ce profil définitivement"
                  className="p-1 text-gray-500 hover:text-red-400 transition-colors"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        ))}

        {/* Add profile button */}
        {creating ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleCreate();
            }}
            className="flex items-center gap-1"
          >
            <input
              type="text"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="Profile name..."
              autoFocus
              className="px-2 py-1 text-xs rounded bg-gray-800 border border-gray-700 text-gray-100 placeholder-gray-500 focus:outline-none focus:border-os-500 w-28"
              onBlur={() => {
                if (!newLabel.trim()) setCreating(false);
              }}
              onKeyDown={(e) => e.key === 'Escape' && setCreating(false)}
            />
            <button
              type="submit"
              className="px-2 py-1 text-xs rounded bg-os-700 text-white hover:bg-os-600 transition-colors"
            >
              Add
            </button>
          </form>
        ) : (
          <button
            onClick={() => setCreating(true)}
            className="flex items-center gap-1 px-2 py-1.5 text-xs text-gray-500 hover:text-gray-300 hover:bg-gray-800/70 rounded-lg transition-all duration-200"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New
          </button>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Save / Load buttons */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={onSave}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-gray-400 hover:text-gray-200 border border-gray-700 hover:border-gray-600 rounded-lg transition-all duration-200"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
            </svg>
            Save
          </button>
          <HelpTip content="Save all profiles to calame-profiles.json." position="bottom" size="xs" />
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={onLoad}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-gray-400 hover:text-gray-200 border border-gray-700 hover:border-gray-600 rounded-lg transition-all duration-200"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            Load
          </button>
          <HelpTip content="Load profiles from calame-profiles.json (replaces the current configuration)." position="bottom" size="xs" />
        </div>
      </div>
    </div>
  );
}
