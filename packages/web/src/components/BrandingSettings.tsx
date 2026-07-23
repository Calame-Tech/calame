import { useState, useCallback } from 'react';
import { apiFetch } from '../lib/api.js';
import { useBranding, DEFAULT_LOGO_SRC, BASE_FONT_OPTIONS } from '../lib/branding.js';
import { Button } from './ui/index.js';

const DEFAULT_ACCENT_COLOR = '#5c7cfa';

/** Human-readable label for a font-family CSS value, e.g. the "Inter" in
 * "'Inter', system-ui, sans-serif". Falls back to the raw value. */
function fontLabel(fontFamily: string): string {
  const first = fontFamily
    .split(',')[0]
    ?.trim()
    .replace(/^['"]|['"]$/g, '');
  return first || fontFamily;
}

/**
 * Branding settings panel — set a custom logo, favicon, accent color, and font.
 */
export default function BrandingSettings() {
  const branding = useBranding();
  const [logo, setLogo] = useState(branding.logo ?? '');
  const [favicon, setFavicon] = useState(branding.favicon ?? '');
  const [accentColor, setAccentColor] = useState(branding.accentColor ?? '');
  const [fontFamily, setFontFamily] = useState(branding.fontFamily ?? '');
  const [customFonts, setCustomFonts] = useState<string[]>(
    branding.fontFamily && !(BASE_FONT_OPTIONS as readonly string[]).includes(branding.fontFamily)
      ? [branding.fontFamily]
      : [],
  );
  const [customFontInput, setCustomFontInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const fontOptions = [...BASE_FONT_OPTIONS, ...customFonts];

  const handleAddCustomFont = useCallback(() => {
    const name = customFontInput.trim();
    if (!name) return;
    const value = `'${name}', system-ui, sans-serif`;
    setCustomFonts((prev) => (prev.includes(value) ? prev : [...prev, value]));
    setFontFamily(value);
    setCustomFontInput('');
  }, [customFontInput]);

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
    if (accentColor && !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(accentColor)) {
      setError('Accent color must be a hex code like #5c7cfa');
      setSaving(false);
      return;
    }
    try {
      const res = await apiFetch('/api/branding', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          logo: logo || null,
          favicon: favicon || null,
          accentColor: accentColor || null,
          fontFamily: fontFamily || null,
        }),
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
  }, [logo, favicon, accentColor, fontFamily]);

  const handleReset = useCallback(() => {
    setLogo('');
    setFavicon('');
    setAccentColor('');
    setFontFamily('');
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-gray-100">Branding</h3>
        <p className="text-sm text-gray-400 mt-1">
          Customize your instance with a custom logo, favicon, accent color, and font — applied
          instance-wide for every user.
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
            <button
              type="button"
              onClick={() => setLogo('')}
              className="text-sm text-gray-500 hover:text-gray-300"
            >
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
            <input
              type="file"
              accept="image/*"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => setFavicon(reader.result as string);
                reader.readAsDataURL(file);
              }}
              className="hidden"
            />
            <span className="text-sm text-os-400 hover:text-os-300">Upload favicon</span>
          </label>
          {favicon && (
            <button
              type="button"
              onClick={() => setFavicon('')}
              className="text-sm text-gray-500 hover:text-gray-300"
            >
              Remove
            </button>
          )}
        </div>
      </div>

      {/* Accent color */}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-gray-300">Accent color</label>
        <div className="flex items-center gap-3">
          <input
            type="color"
            value={accentColor || DEFAULT_ACCENT_COLOR}
            onChange={(e) => setAccentColor(e.target.value)}
            className="h-9 w-9 rounded border border-gray-700 bg-gray-800 p-0.5"
            aria-label="Accent color picker"
          />
          <input
            type="text"
            value={accentColor}
            onChange={(e) => setAccentColor(e.target.value.trim())}
            placeholder={DEFAULT_ACCENT_COLOR}
            className="input-editorial w-32 text-sm"
            aria-label="Accent color hex code"
          />
          {accentColor && (
            <button
              type="button"
              onClick={() => setAccentColor('')}
              className="text-sm text-gray-500 hover:text-gray-300"
            >
              Reset to default
            </button>
          )}
        </div>
      </div>

      {/* Font */}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-gray-300">Font</label>
        <div className="flex items-center gap-3">
          <select
            value={fontFamily || BASE_FONT_OPTIONS[0]}
            onChange={(e) => setFontFamily(e.target.value)}
            className="input-editorial text-sm"
            style={{ fontFamily: fontFamily || BASE_FONT_OPTIONS[0] }}
          >
            {fontOptions.map((font) => (
              <option key={font} value={font} style={{ fontFamily: font }}>
                {fontLabel(font)}
              </option>
            ))}
          </select>
          {fontFamily && (
            <button
              type="button"
              onClick={() => setFontFamily('')}
              className="text-sm text-gray-500 hover:text-gray-300"
            >
              Reset to default
            </button>
          )}
        </div>
        <div className="flex items-center gap-3">
          <input
            type="text"
            value={customFontInput}
            onChange={(e) => setCustomFontInput(e.target.value)}
            placeholder="Add a font by name (e.g. Poppins)"
            className="input-editorial w-64 text-sm"
            aria-label="Add a custom font"
          />
          <button
            type="button"
            onClick={handleAddCustomFont}
            disabled={!customFontInput.trim()}
            className="text-sm text-os-400 hover:text-os-300 disabled:opacity-40 disabled:hover:text-os-400"
          >
            Add
          </button>
        </div>
        <p className="text-xs text-gray-500">
          Added fonts must already be installed on users' devices or loaded elsewhere on the page.
        </p>
      </div>

      {/* Preview */}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-gray-300">Preview</label>
        <div className="flex items-center gap-3 p-3 bg-gray-800/50 rounded-lg border border-gray-700">
          <img src={logo || DEFAULT_LOGO_SRC} alt="Preview" className="h-6 w-6 object-contain" />
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
