// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { countTokens, decodeTokens, encodeTokens } from './tokenizer.js';
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_MIN_TOKENS,
  MAX_PREAMBLE_TOKENS,
  type Chunk,
  type ChunkOptions,
} from './types.js';

/**
 * Strip a YAML front-matter block delimited by `---` at the top of the file.
 * Returns the markdown body unchanged when no front-matter is present.
 *
 * Duplicated from `parsers/markdown.ts` on purpose: the chunker must be
 * resilient even when the caller forgot to strip the front-matter (e.g. a
 * raw HTML→markdown pipeline).
 */
function stripFrontMatter(text: string): string {
  if (!text.startsWith('---')) return text;
  const closing = text.indexOf('\n---', 3);
  if (closing === -1) return text;
  const afterClosing = text.indexOf('\n', closing + 4);
  return afterClosing === -1 ? '' : text.slice(afterClosing + 1);
}

/** A section bounded by an ATX heading (or the implicit "preamble" section). */
interface MarkdownSection {
  /** Markdown heading level (1..6). Use 0 for the implicit pre-header section. */
  level: number;
  /** Heading text (without leading `#`). Empty string for the pre-header section. */
  heading: string;
  /** Section body — everything between this header and the next one. */
  body: string;
  /** Path of parent headings, from H1 down to (but excluding) this level. */
  parents: Array<{ level: number; heading: string }>;
}

/**
 * Tokenize a markdown document into a flat list of sections in document order.
 *
 * The traversal is line-based — we do NOT use a full markdown AST because:
 *   (a) the only structure we care about for chunking is the heading hierarchy
 *       and the fenced-code-block boundaries,
 *   (b) a line-based scan handles malformed markdown gracefully,
 *   (c) we keep the markdown body verbatim so embeddings see the original
 *       prose, including bold/italic markers (which carry semantic weight).
 *
 * ATX headings (`#`, `##`, …) are recognized only at the start of a line.
 * Setext headings (underlined with `===` / `---`) are NOT supported — they're
 * vanishingly rare in modern markdown and would complicate the parser.
 *
 * Fenced code blocks (```…```) are tracked so a `#` inside a code block is
 * NOT mistaken for a heading. We also flag the line ranges so the splitter
 * keeps the code block atomic.
 */
function parseSections(text: string): MarkdownSection[] {
  const lines = text.split(/\r?\n/);
  const sections: MarkdownSection[] = [];
  const stack: Array<{ level: number; heading: string }> = [];
  let buf: string[] = [];
  let currentLevel = 0;
  let currentHeading = '';
  let inFence = false;
  let fenceMarker = '';

  const flush = (): void => {
    const body = buf.join('\n');
    // Drop sections that are completely empty (no heading AND no body).
    if (currentLevel === 0 && body.trim().length === 0) {
      buf = [];
      return;
    }
    sections.push({
      level: currentLevel,
      heading: currentHeading,
      body,
      parents: [...stack],
    });
    buf = [];
  };

  for (const line of lines) {
    // Track fenced code blocks. The opening fence can be ``` or ~~~ with
    // optional language tag; the closing fence must match the marker.
    const fenceMatch = /^(```+|~~~+)/.exec(line.trimStart());
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fenceMatch[1]!;
      } else if (line.trimStart().startsWith(fenceMarker)) {
        inFence = false;
        fenceMarker = '';
      }
      buf.push(line);
      continue;
    }

    // Outside a fence: recognize ATX headings.
    const headingMatch = !inFence ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (headingMatch) {
      // Emit the section accumulated so far (if any).
      if (buf.length > 0 || currentLevel > 0) flush();

      const level = headingMatch[1]!.length;
      const heading = headingMatch[2]!.trim();

      // Maintain the parent stack: pop levels >= current level.
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) {
        stack.pop();
      }

      currentLevel = level;
      currentHeading = heading;
      continue;
    }

    buf.push(line);
    // We need the stack to reflect "parents of the section we're currently
    // filling". For a section whose heading is `## Foo`, its parents are
    // recorded *before* `## Foo` is pushed onto the stack. So we push the
    // current heading right after recording it as the section's owner.
    // To keep the algorithm simple, we re-push at the end of every line —
    // no-op when already there, push when the level just changed.
    if (
      currentLevel > 0 &&
      (stack.length === 0 || stack[stack.length - 1]!.level !== currentLevel)
    ) {
      stack.push({ level: currentLevel, heading: currentHeading });
    }
  }

  // Flush the final section.
  if (buf.length > 0 || currentLevel > 0) flush();
  return sections;
}

/**
 * Build the breadcrumb that prefixes every chunk derived from a section. The
 * preamble is capped at MAX_PREAMBLE_TOKENS — if the path is too long we drop
 * earlier levels and keep the most-specific ones.
 *
 * Example: parents=[H1 "Guide", H2 "Install"], heading="Linux", level=3
 *   → "## Guide > ### Install > #### Linux\n\n"
 *
 * NOTE: the heading level emitted is `parent.level + 1` etc. — we simply
 * mirror the original hierarchy. Same for the leaf heading.
 */
function buildPreamble(section: MarkdownSection): string {
  if (section.level === 0 && section.heading === '') return '';

  const path: Array<{ level: number; heading: string }> = [
    ...section.parents,
    { level: section.level, heading: section.heading },
  ];

  // First attempt: full path.
  const render = (items: typeof path): string =>
    items.map((p) => `${'#'.repeat(Math.min(p.level, 6))} ${p.heading}`).join(' > ') + '\n\n';

  let preamble = render(path);
  while (countTokens(preamble) > MAX_PREAMBLE_TOKENS && path.length > 2) {
    // Drop the earliest (most-general) level. Keep at least the leaf
    // + its immediate parent so context is still meaningful.
    path.shift();
    preamble = render(path);
  }
  if (countTokens(preamble) > MAX_PREAMBLE_TOKENS && path.length > 1) {
    // Still too long — keep only the leaf.
    path.splice(0, path.length - 1);
    preamble = render(path);
  }
  return preamble;
}

/**
 * Split a body into atomic blocks that the chunker treats as indivisible:
 *  - fenced code blocks → one block (kept atomic)
 *  - everything else → split on blank lines (paragraphs)
 *
 * The output preserves order and reading flow.
 */
function splitIntoBlocks(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  let fenceMarker = '';

  const flushCurrent = (): void => {
    const joined = current.join('\n').trim();
    if (joined.length > 0) blocks.push(joined);
    current = [];
  };

  for (const line of lines) {
    const fenceMatch = /^(```+|~~~+)/.exec(line.trimStart());
    if (fenceMatch) {
      if (!inFence) {
        // Start of a fenced code block — flush any accumulated text first.
        flushCurrent();
        inFence = true;
        fenceMarker = fenceMatch[1]!;
        current.push(line);
        continue;
      }
      if (line.trimStart().startsWith(fenceMarker)) {
        // End of the fenced code block — emit it as one atomic block.
        current.push(line);
        blocks.push(current.join('\n'));
        current = [];
        inFence = false;
        fenceMarker = '';
        continue;
      }
      current.push(line);
      continue;
    }

    if (inFence) {
      current.push(line);
      continue;
    }

    if (line.trim().length === 0) {
      flushCurrent();
    } else {
      current.push(line);
    }
  }

  if (inFence) {
    // Unterminated fence — treat what we collected as one block anyway.
    const joined = current.join('\n');
    if (joined.trim().length > 0) blocks.push(joined);
  } else {
    flushCurrent();
  }

  return blocks;
}

/**
 * Split an oversized block (typically a single very long paragraph or a code
 * block that on its own exceeds maxTokens) into hard-token slices. This is the
 * last-resort path and behaves like {@link chunkPlainText}.
 */
function hardSplit(block: string, maxTokens: number): string[] {
  const tokens = encodeTokens(block);
  if (tokens.length <= maxTokens) return [block];

  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += maxTokens) {
    out.push(decodeTokens(tokens.slice(i, Math.min(i + maxTokens, tokens.length))));
  }
  return out;
}

/**
 * Pack blocks greedily into chunks, each prefixed by the section preamble.
 * Honors `maxTokens` strictly. Small leftover chunks are merged downstream by
 * {@link mergeSmallChunks}.
 */
function packBlocks(preamble: string, blocks: string[], maxTokens: number): string[] {
  const preambleTokens = countTokens(preamble);
  const bodyBudget = maxTokens - preambleTokens;
  if (bodyBudget <= 0) {
    // Pathological: preamble alone exceeds maxTokens. Emit each block raw
    // (without preamble) and rely on hardSplit to keep them in budget.
    const out: string[] = [];
    for (const block of blocks) {
      for (const piece of hardSplit(block, maxTokens)) {
        out.push(piece);
      }
    }
    return out;
  }

  const result: string[] = [];
  let acc: string[] = [];
  let accTokens = 0;

  const flushAcc = (): void => {
    if (acc.length === 0) return;
    const body = acc.join('\n\n');
    result.push(`${preamble}${body}`);
    acc = [];
    accTokens = 0;
  };

  for (const block of blocks) {
    const blockTokens = countTokens(block);

    if (blockTokens > bodyBudget) {
      // Block too big to fit even alone — flush accumulator, then hard split.
      flushAcc();
      for (const piece of hardSplit(block, bodyBudget)) {
        result.push(`${preamble}${piece}`);
      }
      continue;
    }

    // Roughly account for the `\n\n` separator we'll add between blocks.
    const separatorCost = acc.length > 0 ? 2 : 0;
    if (accTokens + separatorCost + blockTokens > bodyBudget) {
      flushAcc();
    }
    acc.push(block);
    accTokens += blockTokens + separatorCost;
  }

  flushAcc();
  return result;
}

/**
 * Merge consecutive chunks whose combined size is still under `maxTokens` AND
 * whose individual size is under `minTokens`. This prevents the chunker from
 * emitting many tiny chunks (which dilute embeddings) when a document has
 * lots of short sections.
 *
 * Only adjacent chunks that share the SAME preamble are merged — merging
 * across section boundaries would lose hierarchical context.
 */
function mergeSmallChunks(
  chunks: string[],
  preambles: string[],
  minTokens: number,
  maxTokens: number,
): { texts: string[]; preambles: string[] } {
  const outTexts: string[] = [];
  const outPreambles: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const text = chunks[i]!;
    const preamble = preambles[i]!;

    if (
      outTexts.length > 0 &&
      outPreambles[outPreambles.length - 1] === preamble &&
      countTokens(outTexts[outTexts.length - 1]!) < minTokens
    ) {
      const merged = `${outTexts[outTexts.length - 1]!}\n\n${stripPreamble(text, preamble)}`;
      if (countTokens(merged) <= maxTokens) {
        outTexts[outTexts.length - 1] = merged;
        continue;
      }
    }

    outTexts.push(text);
    outPreambles.push(preamble);
  }

  // Second pass: if current chunk is small, try to merge with the next one
  // (same preamble). This handles the case where the small chunk comes
  // BEFORE its larger sibling.
  for (let i = 0; i < outTexts.length - 1; i++) {
    if (
      countTokens(outTexts[i]!) < minTokens &&
      outPreambles[i] === outPreambles[i + 1] &&
      countTokens(outTexts[i]! + '\n\n' + stripPreamble(outTexts[i + 1]!, outPreambles[i + 1]!)) <=
        maxTokens
    ) {
      const merged = `${outTexts[i]!}\n\n${stripPreamble(outTexts[i + 1]!, outPreambles[i + 1]!)}`;
      outTexts.splice(i, 2, merged);
      outPreambles.splice(i, 2, outPreambles[i]!);
      i -= 1; // re-examine current index against the new neighbour
    }
  }

  return { texts: outTexts, preambles: outPreambles };
}

/** Remove the preamble prefix from a chunk text if present. */
function stripPreamble(text: string, preamble: string): string {
  if (preamble && text.startsWith(preamble)) return text.slice(preamble.length);
  return text;
}

/**
 * Structure-aware chunker for markdown documents.
 *
 * Strategy:
 *   1. Strip optional YAML front-matter.
 *   2. Walk the document and split it into sections on ATX headings.
 *   3. For each section, build a hierarchy preamble ("## Foo > ### Bar > …")
 *      and split the body into atomic blocks (paragraphs / fenced code).
 *   4. Pack blocks greedily into chunks under `maxTokens`. Code blocks larger
 *      than `maxTokens` are hard-split as a last resort.
 *   5. Merge consecutive small chunks (< `minTokens`) within the same section
 *      so the index isn't polluted with very short embeddings.
 *
 * The output keeps the same shape as the plain chunker: `Chunk[]` with
 * positional indices and accurate token counts.
 */
export function chunkMarkdown(text: string, opts: ChunkOptions = {}): Chunk[] {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const minTokens = opts.minTokens ?? DEFAULT_MIN_TOKENS;

  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new Error(`chunkMarkdown: maxTokens must be a positive integer, got ${maxTokens}`);
  }
  if (!Number.isInteger(minTokens) || minTokens < 0) {
    throw new Error(`chunkMarkdown: minTokens must be a non-negative integer, got ${minTokens}`);
  }
  if (minTokens >= maxTokens) {
    throw new Error(
      `chunkMarkdown: minTokens (${minTokens}) must be strictly less than maxTokens (${maxTokens})`,
    );
  }

  if (!text || text.trim().length === 0) {
    return [];
  }

  const body = stripFrontMatter(text);
  const sections = parseSections(body);

  // No structure detected — fall back to paragraph-then-token splitting on
  // the whole document so we don't lose data.
  const hasAnyHeading = sections.some((s) => s.level > 0);
  if (!hasAnyHeading) {
    const blocks = splitIntoBlocks(body);
    if (blocks.length === 0) return [];
    const packed = packBlocks('', blocks, maxTokens);
    return packed
      .filter((c) => c.trim().length > 0)
      .map((t, position) => ({ position, text: t, tokenCount: countTokens(t) }));
  }

  const allChunks: string[] = [];
  const allPreambles: string[] = [];

  for (const section of sections) {
    // Skip the implicit pre-header section if its body is empty (this is
    // the common case for files that open directly with `# Title`).
    const isImplicit = section.level === 0 && section.heading === '';
    if (isImplicit && section.body.trim().length === 0) continue;

    // Skip sections that are just a heading with no body.
    if (!isImplicit && section.body.trim().length === 0) continue;

    const preamble = buildPreamble(section);
    const blocks = splitIntoBlocks(section.body);
    if (blocks.length === 0) continue;

    const packed = packBlocks(preamble, blocks, maxTokens);
    for (const chunk of packed) {
      if (chunk.trim().length === 0) continue;
      allChunks.push(chunk);
      allPreambles.push(preamble);
    }
  }

  const { texts } = mergeSmallChunks(allChunks, allPreambles, minTokens, maxTokens);

  return texts.map((t, position) => ({
    position,
    text: t,
    tokenCount: countTokens(t),
  }));
}
