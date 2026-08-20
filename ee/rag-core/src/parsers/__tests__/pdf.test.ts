// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// unpdf is mocked so these tests exercise the ACTUAL bug fix (page boundaries
// → markdown headings → structural chunking) without needing a real PDF
// fixture. getDocumentProxy's return value is opaque to our code — it's
// only ever handed straight to extractText — so a placeholder is fine.
// ---------------------------------------------------------------------------

const extractTextMock = vi.fn();
vi.mock('unpdf', () => ({
  getDocumentProxy: vi.fn().mockResolvedValue({}),
  extractText: (...args: unknown[]) => extractTextMock(...args),
}));

describe('parsers/pdf', () => {
  it('tags the result "markdown" (not "plain") so the structural chunker is used', async () => {
    extractTextMock.mockResolvedValueOnce({ text: ['Page one content.'] });
    const { parse } = await import('../pdf.js');
    const result = await parse(Buffer.from('fake pdf bytes'));
    expect(result.format).toBe('markdown');
  });

  it('marks each page as its own "## Page N" heading, in order', async () => {
    extractTextMock.mockResolvedValueOnce({
      text: ['First slide text.', 'Second slide text.', 'Third slide text.'],
    });
    const { parse } = await import('../pdf.js');
    const result = await parse(Buffer.from('fake pdf bytes'));

    expect(result.text).toContain('## Page 1\n\nFirst slide text.');
    expect(result.text).toContain('## Page 2\n\nSecond slide text.');
    expect(result.text).toContain('## Page 3\n\nThird slide text.');
    // Order preserved.
    expect(result.text.indexOf('Page 1')).toBeLessThan(result.text.indexOf('Page 2'));
    expect(result.text.indexOf('Page 2')).toBeLessThan(result.text.indexOf('Page 3'));
  });

  it('a multi-page PDF produces multiple chunks via the markdown chunker — the actual reported bug', async () => {
    // Regression for the exact report: a short slide deck whose TOTAL text
    // easily fits under one token window used to come back as a single
    // chunk (format: 'plain' → chunkPlainText). Tagging it 'markdown'
    // routes it through the structural chunker instead, which splits on
    // the page headings regardless of total token count.
    extractTextMock.mockResolvedValueOnce({
      text: ['Slide one.', 'Slide two.', 'Slide three.', 'Slide four.', 'Slide five.'],
    });
    const { parse } = await import('../pdf.js');
    const { pickChunker } = await import('../../chunker/index.js');

    const result = await parse(Buffer.from('fake pdf bytes'));
    const chunker = pickChunker(result.format);
    const chunks = chunker(result.text);

    expect(chunks.length).toBeGreaterThan(1);
  });

  it('preserves the ORIGINAL page number when an earlier page has no extractable text (e.g. image-only slide)', async () => {
    extractTextMock.mockResolvedValueOnce({
      text: ['', '   ', 'Third page has real text.'],
    });
    const { parse } = await import('../pdf.js');
    const result = await parse(Buffer.from('fake pdf bytes'));

    // Must say "Page 3", not "Page 1" — page 3 is genuinely the third page
    // of the source PDF, even though pages 1-2 were dropped as empty.
    expect(result.text).toContain('## Page 3\n\nThird page has real text.');
    expect(result.text).not.toContain('Page 1');
    expect(result.text).not.toContain('Page 2');
  });

  it('reports pageCount as the TOTAL page count, including empty/image-only pages', async () => {
    extractTextMock.mockResolvedValueOnce({ text: ['', 'some text', ''] });
    const { parse } = await import('../pdf.js');
    const result = await parse(Buffer.from('fake pdf bytes'));
    expect(result.metadata?.['pageCount']).toBe(3);
  });

  it('a PDF with no extractable text on any page returns an empty string', async () => {
    extractTextMock.mockResolvedValueOnce({ text: ['', '  ', ''] });
    const { parse } = await import('../pdf.js');
    const result = await parse(Buffer.from('fake pdf bytes'));
    expect(result.text).toBe('');
  });

  it('handles mergePages-style single-string text (defensive — unpdf contract when mergePages is true)', async () => {
    extractTextMock.mockResolvedValueOnce({ text: 'a single merged string' });
    const { parse } = await import('../pdf.js');
    const result = await parse(Buffer.from('fake pdf bytes'));
    expect(result.text).toContain('## Page 1');
    expect(result.text).toContain('a single merged string');
  });
});
