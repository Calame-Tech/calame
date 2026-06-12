import { useState, useCallback } from 'react';
import { apiFetch } from '../lib/api.js';
import { useBranding, DEFAULT_LOGO_SRC } from '../lib/branding.js';
import { Card, PageHeader, Button } from './ui/index.js';

/**
 * Branding settings panel — set a custom logo and favicon.
 */
export default function BrandingSettings() {
  const branding = useBranding();
  const [logo, setLogo] = useState(branding.logo ?? '');
  const [favicon, setFavicon] = useState(branding.favicon ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const handleLogoUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setLogo(reader.result as string);
    reader.readAsDataURL(file);
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const res = await apiFetch('/api/branding', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logo: logo || null, favicon: favicon || null }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to save branding');
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSaving(false);
    }
  }, [logo, favicon]);

  const handleReset = useCallback(() => {
    setLogo('');
    setFavicon('');
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-gray-100">Branding</h3>
        <p className="text-sm text-gray-400 mt-1">
          Customize your instance with a custom logo and favicon.
        </p>
      </div>

      {/* Logo */}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-gray-300">Logo</label>
        <div className="flex items-center gap-4">
          <img
            src={logo || DEFAULT_LOGO_SRC}
            alt="Preview"
            className="h-10 w-10 object-contain rounded border border-gray-700 bg-gray-800"
          />
          <label className="cursor-pointer">
            <input type="file" accept="image/*" onChange={handleLogoUpload} className="hidden" />
            <span className="text-sm text-os-400 hover:text-os-300">Upload image</span>
          </label>
          {logo && (
            <button type="button" onClick={() => setLogo('')} className="text-sm text-gray-500 hover:text-gray-300">
              Remove
            </button>
          )}
        </div>
      </div>

      {/* Favicon */}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-gray-300">Favicon</label>
        <div className="flex items-center gap-4">
          <label className="cursor-pointer">
            <input type="file" accept="image/*" onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const reader = new FileReader();
              reader.onload = () => setFavicon(reader.result as string);
              reader.readAsDataURL(file);
            }} className="hidden" />
            <span className="text-sm text-os-400 hover:text-os-300">Upload favicon</span>
          </label>
          {favicon && (
            <button type="button" onClick={() => setFavicon('')} className="text-sm text-gray-500 hover:text-gray-300">
              Remove
            </button>
          )}
        </div>
      </div>

      {/* Preview */}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-gray-300">Preview</label>
        <div className="flex items-center gap-3 p-3 bg-gray-800/50 rounded-lg border border-gray-700">
          <img
            src={logo || DEFAULT_LOGO_SRC}
            alt="Preview"
            className="h-6 w-6 object-contain"
          />
          <span className="text-sm text-gray-300">
            {logo ? 'Custom logo active' : 'Default Calame logo'}
          </span>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3 pt-2">
        <Button variant="primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="secondary" onClick={handleReset} disabled={saving}>
          Reset
        </Button>
        {saved && <span className="text-sm text-green-400">Saved!</span>}
        {error && <span className="text-sm text-red-400">{error}</span>}
      </div>
    </div>
  );
}
