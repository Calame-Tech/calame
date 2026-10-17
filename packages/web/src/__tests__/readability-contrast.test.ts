import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Readability guard for the Sources → knowledge base → MCP screens (tester
// feedback point 03). The app ships a single dark theme: text sits on
// bg-gray-950 or on cards (bg-gray-900/80 over gray-950). Secondary text used to
// be gray-500/600 (3.8:1 / 2.4:1) and badges 9–10px; this pins the AA levels.

const REPO = resolve(__dirname, '../../../..');

const SCREENS = [
  'packages/web/src/components/SourcesPage.tsx',
  'packages/web/src/components/AddSourceModal.tsx',
  'packages/web/src/pages/McpDetailPage.tsx',
  'ee/rag-core/src/web/DocumentUploader.tsx',
  'ee/rag-core/src/web/EmbeddingUsageCard.tsx',
  'ee/rag-core/src/web/FolderTreeView.tsx',
  'ee/rag-core/src/web/IngestionStatusCard.tsx',
  'ee/rag-core/src/web/KnowledgeBaseManager.tsx',
  'ee/rag-core/src/web/RagAccessSelector.tsx',
  'ee/rag-core/src/web/ReindexDialog.tsx',
  'ee/rag-core/src/web/SourceForm.tsx',
  'ee/rag-core/src/web/SyncHistoryPanel.tsx',
];

type Rgb = [number, number, number];

// Tailwind default palette values.
const GRAY_300: Rgb = [209, 213, 219];
const GRAY_400: Rgb = [156, 163, 175];
const GRAY_500: Rgb = [107, 114, 128];
const GRAY_900: Rgb = [17, 24, 39];
const GRAY_950: Rgb = [3, 7, 18];
// Default accent (index.css --color-os-*).
const OS_300: Rgb = [145, 167, 255];
const OS_400: Rgb = [116, 143, 252];

function mix(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return fg.map((c, i) => c * alpha + bg[i] * (1 - alpha)) as Rgb;
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const CARD = mix(GRAY_900, GRAY_950, 0.8);

describe('readability of the Sources / knowledge base / MCP screens', () => {
  it('secondary text tokens reach WCAG AA (4.5:1) on page and card surfaces', () => {
    for (const fg of [GRAY_300, GRAY_400, OS_300, OS_400]) {
      expect(contrast(fg, GRAY_950)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(fg, CARD)).toBeGreaterThanOrEqual(4.5);
    }
    // The previous secondary tone did not, which is why it is banned below.
    expect(contrast(GRAY_500, CARD)).toBeLessThan(4.5);
  });

  it('dimmed rows (deleted, not indexed, ingest error) stay above 4.5:1', () => {
    // RagAccessSelector / FolderTreeView: gray-300 text in an opacity-70 row,
    // gray-400 text in an opacity-80 row.
    expect(contrast(mix(GRAY_300, CARD, 0.7), CARD)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(mix(GRAY_400, CARD, 0.8), CARD)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(SCREENS)('%s uses no sub-AA gray text nor sub-11px text', (file) => {
    const src = readFileSync(resolve(REPO, file), 'utf8');
    expect(src).not.toMatch(/(?<![\w:-])text-gray-(500|600)\b/);
    // Placeholders are exempt from WCAG contrast; gray-500 keeps them dimmer
    // than hints so an example is not mistaken for a typed value.
    expect(src).not.toMatch(/(?<![\w:-])placeholder-gray-600\b/);
    expect(src).not.toMatch(/text-\[(8|9|10)px\]/);
    expect(src).not.toMatch(/opacity-(40|50)'/);
  });

  it('keeps labels distinct from hints and hover states distinct from rest', () => {
    const mcp = readFileSync(resolve(REPO, 'packages/web/src/pages/McpDetailPage.tsx'), 'utf8');
    for (const key of ['responseMode', 'documentWrite', 'authMode']) {
      expect(mcp).toMatch(new RegExp(`text-gray-300">\\{t\\('${key}\\.label'\\)`));
      expect(mcp).toMatch(new RegExp(`text-gray-400[^"]*">\\{t\\('${key}\\.hint'\\)`));
    }
    for (const file of SCREENS) {
      const src = readFileSync(resolve(REPO, file), 'utf8');
      expect(src).not.toMatch(/(?<![\w:-])text-gray-(\d+)\b[^"]* hover:text-gray-\1\b/);
    }
  });

  it('shared eyebrow labels are 11px gray-400', () => {
    const css = readFileSync(resolve(REPO, 'packages/web/src/index.css'), 'utf8');
    const eyebrow = css.match(/\.eyebrow \{[^}]*\}/)?.[0] ?? '';
    expect(eyebrow).toContain('font-size: 11px');
    expect(eyebrow).toContain('color: rgb(156 163 175)');
  });
});
