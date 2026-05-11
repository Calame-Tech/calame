// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { countTokens, decodeTokens, encodeTokens } from './tokenizer.js';
import { chunkPlainText } from './plain-chunker.js';
import {
	DEFAULT_MAX_TOKENS,
	MAX_PREAMBLE_TOKENS,
	type Chunk,
	type ChunkOptions,
} from './types.js';
import type { CodeLanguage } from '../parsers/types.js';

/**
 * Options consumed by {@link chunkCode} on top of the standard
 * {@link ChunkOptions}. Both are optional — a missing language degrades to
 * the plain chunker, a missing filename simply omits the `// File:` header.
 */
export interface CodeChunkExtraOptions {
	language?: CodeLanguage;
	filename?: string;
}

export type CodeChunkOptions = ChunkOptions & CodeChunkExtraOptions;

/**
 * Per-language regex patterns matching the FIRST line of a top-level
 * declaration. Patterns are line-anchored (`^…/m` is added at use-site) and
 * are tested AGAINST a SINGLE line that we already know is at indentation 0.
 *
 * We err on the side of recall: a regex that matches slightly more than it
 * should still yields useful chunk boundaries (one extra split is cheap; a
 * missed split means we lose structure). The fallback paths (oversized chunk
 * → hardSplit, no decl found → plain chunker) catch the pathological cases.
 */
const PATTERNS: Record<Exclude<CodeLanguage, 'unknown'>, RegExp[]> = {
	typescript: [
		/^(export\s+(default\s+)?)?(async\s+)?function\s*\*?\s+\w+/,
		/^(export\s+(default\s+)?)?(abstract\s+)?class\s+\w+/,
		/^(export\s+)?interface\s+\w+/,
		/^(export\s+)?type\s+\w+\b/,
		/^(export\s+)?(declare\s+)?(const|let|var)\s+\w+\s*(:\s*[^=]+)?=\s*(async\s*)?(\([^)]*\)|<|\w+\s*=>)/,
		/^(export\s+)?enum\s+\w+/,
		/^(export\s+)?namespace\s+\w+/,
	],
	javascript: [
		/^(export\s+(default\s+)?)?(async\s+)?function\s*\*?\s+\w+/,
		/^(export\s+(default\s+)?)?class\s+\w+/,
		/^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s*)?(\([^)]*\)|\w+\s*=>)/,
	],
	python: [
		/^(async\s+)?def\s+\w+/,
		/^class\s+\w+/,
	],
	go: [
		// Function or method (with receiver). The receiver group is intentionally
		// loose: `func (s *Server) Foo(`, `func (s Server) Foo(`, `func Foo(`.
		/^func\s+(\([^)]*\)\s+)?\w+/,
		/^type\s+\w+\s+(struct|interface)\b/,
		/^type\s+\w+\s+/, // type alias
		/^var\s+\(/, // grouped var declarations
		/^const\s+\(/, // grouped const declarations
	],
	rust: [
		/^(pub(\s*\([^)]*\))?\s+)?(async\s+)?(unsafe\s+)?fn\s+\w+/,
		/^(pub(\s*\([^)]*\))?\s+)?struct\s+\w+/,
		/^(pub(\s*\([^)]*\))?\s+)?enum\s+\w+/,
		/^(pub(\s*\([^)]*\))?\s+)?trait\s+\w+/,
		/^(unsafe\s+)?impl\b/,
		/^(pub(\s*\([^)]*\))?\s+)?mod\s+\w+/,
	],
	java: [
		/^(public|private|protected)?\s*(static\s+)?(final\s+)?(abstract\s+)?(class|interface|enum|record)\s+\w+/,
		// Method (approximate): modifiers + return type + name + '('. Skip if it
		// looks like a control statement (if/for/while/switch).
		/^(public|private|protected)\s+(static\s+)?(final\s+)?(abstract\s+)?(synchronized\s+)?(native\s+)?[\w.<>,\s[\]?]+\s+\w+\s*\([^)]*\)\s*(throws\s+[\w.,\s]+)?\s*\{?\s*$/,
	],
};

/** Languages whose body extent is detected by counting curly braces. */
const C_LIKE: ReadonlySet<CodeLanguage> = new Set<CodeLanguage>([
	'typescript',
	'javascript',
	'go',
	'rust',
	'java',
]);

/** Line-comment prefix used in the per-chunk preamble. */
function commentPrefix(language: CodeLanguage): string {
	return language === 'python' ? '#' : '//';
}

/**
 * Pre-process a line for brace counting: replace all string / char / template
 * literals with spaces of the same length so braces inside them no longer
 * affect the depth counter. We also strip single-line comments (`//…`, `#…`)
 * so a `}` inside a comment doesn't close a block. Block comments (`/* … *\/`)
 * spanning multiple lines are handled by the caller via a small state
 * machine.
 *
 * The regex pass is intentionally simple — we accept a few false matches
 * (e.g. an escaped backtick inside a template literal) because the cost of
 * a misplaced boundary is small (one chunk slightly off; embeddings still
 * meaningful) and a full tokenizer would explode the dependency surface.
 */
function neutralizeStringsAndComments(
	line: string,
	state: { inBlockComment: boolean },
	language: CodeLanguage,
): string {
	const out: string[] = [];
	let i = 0;
	const lineCommentMarker = language === 'python' ? '#' : '//';
	const supportsBlockComment = language !== 'python'; // Python has no /* */
	const supportsTemplateLiteral = language === 'typescript' || language === 'javascript';

	while (i < line.length) {
		// Continuing a previous block comment?
		if (state.inBlockComment) {
			const end = line.indexOf('*/', i);
			if (end === -1) {
				// Whole rest of the line is inside the comment.
				out.push(' '.repeat(line.length - i));
				i = line.length;
			} else {
				out.push(' '.repeat(end + 2 - i));
				i = end + 2;
				state.inBlockComment = false;
			}
			continue;
		}

		const ch = line[i]!;

		// Start of a block comment.
		if (supportsBlockComment && ch === '/' && line[i + 1] === '*') {
			const end = line.indexOf('*/', i + 2);
			if (end === -1) {
				out.push(' '.repeat(line.length - i));
				i = line.length;
				state.inBlockComment = true;
			} else {
				out.push(' '.repeat(end + 2 - i));
				i = end + 2;
			}
			continue;
		}

		// Line comment.
		if (
			(lineCommentMarker === '//' && ch === '/' && line[i + 1] === '/') ||
			(lineCommentMarker === '#' && ch === '#')
		) {
			out.push(' '.repeat(line.length - i));
			i = line.length;
			continue;
		}

		// String / char / template literal.
		if (ch === '"' || ch === "'" || (supportsTemplateLiteral && ch === '`')) {
			const quote = ch;
			out.push(' ');
			i += 1;
			while (i < line.length) {
				const c = line[i]!;
				if (c === '\\') {
					out.push('  ');
					i += 2;
					continue;
				}
				if (c === quote) {
					out.push(' ');
					i += 1;
					break;
				}
				// Template literal expression `${…}`: the inner expression IS code
				// so we keep braces. Detect with peek: `${`.
				if (quote === '`' && c === '$' && line[i + 1] === '{') {
					// Emit a literal `${` so the brace counter sees an open brace.
					out.push('${');
					i += 2;
					// Switch to "depth scan" mode: read until matching `}` taking
					// nested braces into account, BUT we want the braces to count
					// in the outer counter. The simplest semantic is: treat the
					// expression interior as code, fall through to the main loop.
					// To do that we break out of the string scan.
					// We re-enter the string after the `}`. We track this with a
					// small local depth counter so we know when to come back.
					let depth = 1;
					while (i < line.length && depth > 0) {
						const cc = line[i]!;
						if (cc === '{') depth += 1;
						else if (cc === '}') depth -= 1;
						out.push(cc);
						i += 1;
					}
					// Resume string scan.
					continue;
				}
				out.push(' ');
				i += 1;
			}
			continue;
		}

		out.push(ch);
		i += 1;
	}

	return out.join('');
}

/** Count `{` and `}` in a "neutralized" line. */
function braceDelta(neutralized: string): number {
	let delta = 0;
	for (const ch of neutralized) {
		if (ch === '{') delta += 1;
		else if (ch === '}') delta -= 1;
	}
	return delta;
}

/** Identify "blank or comment-only" lines (used to skip when measuring indent). */
function isBlankOrCommentOnly(line: string, language: CodeLanguage): boolean {
	const trimmed = line.trim();
	if (trimmed.length === 0) return true;
	const marker = language === 'python' ? '#' : '//';
	if (trimmed.startsWith(marker)) return true;
	if (language !== 'python' && (trimmed.startsWith('/*') || trimmed.startsWith('*'))) return true;
	return false;
}

/** A single top-level "section" (declaration + body). */
interface Section {
	/** Line index of the first line of the section (the declaration line). */
	startLine: number;
	/** Exclusive end line. */
	endLine: number;
	/** First non-empty trimmed source of the section — used to name it. */
	declaration: string;
	/** Lines belonging to the section, joined verbatim. */
	body: string;
}

/**
 * Test whether a line matches any top-level pattern for the language. Only
 * lines with zero leading whitespace are eligible — keywords appearing
 * indented inside a function body are NOT new boundaries.
 *
 * We also explicitly reject lines that look like control flow (if, for, …)
 * to keep the Java method regex from over-matching.
 */
function isDeclarationLine(line: string, language: CodeLanguage): boolean {
	if (language === 'unknown') return false;
	// Indented? Not a top-level decl.
	if (line.length > 0 && (line[0] === ' ' || line[0] === '\t')) return false;
	const patterns = PATTERNS[language];
	if (!patterns) return false;

	// Anti-patterns: keywords that look like declarations but aren't.
	const trimmed = line.trim();
	if (
		trimmed.startsWith('if ') ||
		trimmed.startsWith('if(') ||
		trimmed.startsWith('for ') ||
		trimmed.startsWith('for(') ||
		trimmed.startsWith('while ') ||
		trimmed.startsWith('while(') ||
		trimmed.startsWith('switch ') ||
		trimmed.startsWith('switch(') ||
		trimmed.startsWith('return ') ||
		trimmed.startsWith('return(')
	) {
		return false;
	}

	for (const re of patterns) {
		if (re.test(line)) return true;
	}
	return false;
}

/**
 * Detect import / use / package lines that should be grouped into a single
 * "imports" chunk at the top of the file.
 */
function isImportLine(line: string, language: CodeLanguage): boolean {
	const t = line.trimStart();
	switch (language) {
		case 'typescript':
		case 'javascript':
			return /^import\b/.test(t) || /^(export\s+)?\{[^}]+\}\s*from\b/.test(t);
		case 'python':
			return /^(from\s+\S+\s+import\b|import\b)/.test(t);
		case 'go':
			return /^(package\b|import\b|import\s*\()/.test(t);
		case 'rust':
			return /^(use\b|extern\s+crate\b)/.test(t);
		case 'java':
			return /^(package\b|import\b)/.test(t);
		default:
			return false;
	}
}

/** Detect a license / copyright header at the very top of the file. */
function isLicenseLine(line: string, language: CodeLanguage): boolean {
	const t = line.trim();
	if (t.length === 0) return true; // blank line within header
	const marker = language === 'python' ? '#' : '//';
	const blockOpen = '/*';
	const blockMid = '*';
	if (
		t.startsWith(marker) ||
		(language !== 'python' && (t.startsWith(blockOpen) || t.startsWith(blockMid)))
	) {
		const lower = t.toLowerCase();
		return (
			lower.includes('copyright') ||
			lower.includes('license') ||
			lower.includes('spdx-license-identifier') ||
			lower.includes('(c)')
		);
	}
	return false;
}

/**
 * Split the file into top-level sections using a brace-counting (C-like) or
 * indentation-based (Python) walker.
 */
function splitSections(text: string, language: CodeLanguage): Section[] {
	const lines = text.split(/\r?\n/);
	if (language === 'unknown') return [];

	const sections: Section[] = [];

	if (language === 'python') {
		// Walk top-level declarations (indent 0). A section ends at the next
		// top-level non-blank/non-comment line (i.e. the next `def`, `class`,
		// or stray top-level statement at column 0).
		let i = 0;
		while (i < lines.length) {
			const line = lines[i]!;
			if (isDeclarationLine(line, 'python')) {
				const startLine = i;
				const declaration = line.trim();
				let j = i + 1;
				while (j < lines.length) {
					const candidate = lines[j]!;
					// A new section starts at the next column-0 non-blank,
					// non-comment line. Anything indented OR blank is body.
					if (
						candidate.length > 0 &&
						candidate[0] !== ' ' &&
						candidate[0] !== '\t' &&
						!isBlankOrCommentOnly(candidate, 'python')
					) {
						break;
					}
					j += 1;
				}
				const body = lines.slice(startLine, j).join('\n');
				sections.push({ startLine, endLine: j, declaration, body });
				i = j;
				continue;
			}
			i += 1;
		}
		return sections;
	}

	if (!C_LIKE.has(language)) return [];

	const state = { inBlockComment: false };
	let i = 0;
	while (i < lines.length) {
		const line = lines[i]!;
		if (isDeclarationLine(line, language)) {
			const startLine = i;
			const declaration = line.trim();
			// Count braces from the start of the declaration. Skip to the line
			// containing the first `{` (could be on the same line or a few
			// lines later for K&R style with wrapped parameter lists).
			let depth = 0;
			let sawOpen = false;
			let j = i;
			// Special case: Rust `impl` for traits / structs is always brace-
			// delimited so the generic logic works. Same for everything else.
			while (j < lines.length) {
				const neutralized = neutralizeStringsAndComments(lines[j]!, state, language);
				const delta = braceDelta(neutralized);
				if (!sawOpen && neutralized.includes('{')) sawOpen = true;
				depth += delta;
				if (sawOpen && depth <= 0) {
					j += 1;
					break;
				}
				j += 1;
				if (!sawOpen && j - i > 50) {
					// Defensive: if we walked 50 lines and never saw `{` we're
					// probably looking at a single-line declaration (Rust trait
					// alias, Go type alias, TS `type X = …`). Stop here.
					break;
				}
			}
			// If we never saw `{`, treat the declaration as the section (e.g.
			// `type Foo = Bar;` in TS, `type Foo = string` in Go).
			if (!sawOpen) j = i + 1;
			const endLine = Math.min(j, lines.length);
			const body = lines.slice(startLine, endLine).join('\n');
			sections.push({ startLine, endLine, declaration, body });
			i = endLine;
			continue;
		}
		// Maintain block-comment state even outside declarations so a `/* */`
		// at file scope doesn't confuse a later detection.
		neutralizeStringsAndComments(line, state, language);
		i += 1;
	}

	return sections;
}

/**
 * Extract a contiguous run of import / package lines from the top of the file
 * (skipping over the license header and blank lines). Returns both the joined
 * text AND the line index AFTER which the imports end — callers use it to
 * skip past these lines when scanning for declarations.
 */
function extractImports(
	lines: string[],
	language: CodeLanguage,
): { text: string; endLine: number } | null {
	let i = 0;
	// Skip leading license / shebang / blank lines.
	while (i < lines.length) {
		const line = lines[i]!;
		if (i === 0 && line.startsWith('#!')) {
			i += 1;
			continue;
		}
		if (isLicenseLine(line, language)) {
			i += 1;
			continue;
		}
		break;
	}

	const importStart = i;
	let importEnd = i;
	let sawImport = false;
	while (i < lines.length) {
		const line = lines[i]!;
		if (isImportLine(line, language)) {
			sawImport = true;
			// Greedy: include continuation lines for multi-line Go `import (` or
			// TS `import { … } from '…'` wrapped across lines.
			importEnd = i + 1;
			// Walk forward while inside an open paren / open brace import block.
			let depth = 0;
			const state = { inBlockComment: false };
			const startNeutral = neutralizeStringsAndComments(line, state, language);
			for (const ch of startNeutral) {
				if (ch === '(' || ch === '{') depth += 1;
				else if (ch === ')' || ch === '}') depth -= 1;
			}
			while (depth > 0 && importEnd < lines.length) {
				const neutralized = neutralizeStringsAndComments(lines[importEnd]!, state, language);
				for (const ch of neutralized) {
					if (ch === '(' || ch === '{') depth += 1;
					else if (ch === ')' || ch === '}') depth -= 1;
				}
				importEnd += 1;
			}
			i = importEnd;
			continue;
		}
		// Allow blank lines between imports.
		if (line.trim().length === 0) {
			i += 1;
			continue;
		}
		break;
	}

	if (!sawImport) return null;
	return {
		text: lines.slice(importStart, importEnd).join('\n'),
		endLine: importEnd,
	};
}

/**
 * Build the preamble (comment lines) that prefixes each chunk emitted from
 * the same section. The preamble carries File / Language / Top-level context
 * to the embedding model. Capped at MAX_PREAMBLE_TOKENS — if the declaration
 * line is very long we truncate it.
 */
function buildPreamble(opts: {
	prefix: string;
	filename: string | undefined;
	language: CodeLanguage;
	declaration: string;
	chunkInfo?: { index: number; total: number };
}): string {
	const lines: string[] = [];
	if (opts.filename) lines.push(`${opts.prefix} File: ${opts.filename}`);
	lines.push(`${opts.prefix} Language: ${opts.language}`);
	// Trim very long single-line declarations so the preamble stays small.
	let decl = opts.declaration.replace(/\s+/g, ' ').trim();
	if (decl.length > 160) decl = decl.slice(0, 157) + '…';
	lines.push(`${opts.prefix} Top-level: ${decl}`);
	if (opts.chunkInfo) {
		lines.push(`${opts.prefix} Chunk: ${opts.chunkInfo.index}/${opts.chunkInfo.total}`);
	}
	let preamble = lines.join('\n') + '\n\n';
	// If the preamble itself exceeds the budget, drop the declaration line —
	// File / Language is enough context.
	if (countTokens(preamble) > MAX_PREAMBLE_TOKENS) {
		const trimmed: string[] = [];
		if (opts.filename) trimmed.push(`${opts.prefix} File: ${opts.filename}`);
		trimmed.push(`${opts.prefix} Language: ${opts.language}`);
		if (opts.chunkInfo) {
			trimmed.push(`${opts.prefix} Chunk: ${opts.chunkInfo.index}/${opts.chunkInfo.total}`);
		}
		preamble = trimmed.join('\n') + '\n\n';
	}
	return preamble;
}

/** Last-resort: token-level hard split, preserving the preamble on every slice. */
function hardSplitWithPreamble(
	body: string,
	preambleBuilder: (info: { index: number; total: number }) => string,
	maxTokens: number,
): string[] {
	// First pass: split on blank lines and try to pack greedily.
	const blocks = body.split(/\n\s*\n/).map((b) => b.trim()).filter((b) => b.length > 0);
	if (blocks.length === 0) return [];

	// Reserve a generous preamble budget — we don't know the chunk count yet
	// so we use the worst-case (1/9 → still small).
	const reservedPreamble = preambleBuilder({ index: 99, total: 99 });
	const reservedTokens = countTokens(reservedPreamble);
	const bodyBudget = Math.max(64, maxTokens - reservedTokens);

	const slices: string[] = [];
	let acc: string[] = [];
	let accTokens = 0;
	for (const block of blocks) {
		const blockTokens = countTokens(block);
		if (blockTokens > bodyBudget) {
			// Flush, then hard-token-split the oversized block.
			if (acc.length > 0) {
				slices.push(acc.join('\n\n'));
				acc = [];
				accTokens = 0;
			}
			const tokens = encodeTokens(block);
			for (let s = 0; s < tokens.length; s += bodyBudget) {
				slices.push(decodeTokens(tokens.slice(s, Math.min(s + bodyBudget, tokens.length))));
			}
			continue;
		}
		const separatorCost = acc.length > 0 ? 2 : 0;
		if (accTokens + separatorCost + blockTokens > bodyBudget) {
			slices.push(acc.join('\n\n'));
			acc = [];
			accTokens = 0;
		}
		acc.push(block);
		accTokens += blockTokens + separatorCost;
	}
	if (acc.length > 0) slices.push(acc.join('\n\n'));

	const total = slices.length;
	return slices.map((slice, idx) => preambleBuilder({ index: idx + 1, total }) + slice);
}

/** Trim leading blank lines from a string. */
function lstripBlankLines(s: string): string {
	return s.replace(/^(?:\s*\n)+/, '');
}

/**
 * Structure-aware chunker for source code. See the module-level docs for
 * the high-level strategy.
 */
export function chunkCode(text: string, opts: CodeChunkOptions = {}): Chunk[] {
	const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
	const language: CodeLanguage = opts.language ?? 'unknown';
	const filename = opts.filename;

	if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
		throw new Error(`chunkCode: maxTokens must be a positive integer, got ${maxTokens}`);
	}

	if (!text || text.trim().length === 0) return [];

	// Unknown language → no boundaries we can trust → fall back to plain.
	if (language === 'unknown') {
		return chunkPlainText(text, opts);
	}

	const prefix = commentPrefix(language);
	const lines = text.split(/\r?\n/);

	// 1. Drop leading license header lines from the indexable content. We
	//    still scan past them for import detection.
	let firstContentLine = 0;
	while (firstContentLine < lines.length && isLicenseLine(lines[firstContentLine]!, language)) {
		firstContentLine += 1;
	}

	// 2. Imports chunk.
	const imports = extractImports(lines, language);

	// 3. Sections (top-level declarations).
	const sections = splitSections(text, language);

	// If we found neither imports nor declarations, the file has no usable
	// structure (it's a script-like file) → fall back to the plain chunker.
	if (sections.length === 0 && !imports) {
		// Skip license-only files.
		const remaining = lines.slice(firstContentLine).join('\n');
		if (remaining.trim().length === 0) return [];
		// Also skip pure-comment files.
		const nonComment = lines
			.slice(firstContentLine)
			.filter((l) => !isBlankOrCommentOnly(l, language));
		if (nonComment.length === 0) return [];
		return chunkPlainText(remaining, opts);
	}

	const outputs: string[] = [];

	if (imports) {
		const importPreamble = buildPreamble({
			prefix,
			filename,
			language,
			declaration: 'imports',
		});
		const importBody = lstripBlankLines(imports.text);
		const candidate = importPreamble + importBody;
		if (countTokens(candidate) <= maxTokens) {
			outputs.push(candidate);
		} else {
			// Imports alone exceed the limit (rare but happens for huge Go
			// import blocks). Hard split.
			const slices = hardSplitWithPreamble(
				importBody,
				(info) =>
					buildPreamble({
						prefix,
						filename,
						language,
						declaration: 'imports',
						chunkInfo: info,
					}),
				maxTokens,
			);
			for (const s of slices) outputs.push(s);
		}
	}

	for (const section of sections) {
		const preamble = buildPreamble({
			prefix,
			filename,
			language,
			declaration: section.declaration,
		});
		const body = section.body;
		const candidate = preamble + body;
		const tokenCount = countTokens(candidate);
		if (tokenCount <= maxTokens) {
			outputs.push(candidate);
			continue;
		}

		// Oversized section → split into multiple sub-chunks. Each carries the
		// same Top-level declaration line plus a Chunk: i/N counter so a reader
		// (or the LLM) knows this is part of a larger unit.
		const slices = hardSplitWithPreamble(
			body,
			(info) =>
				buildPreamble({
					prefix,
					filename,
					language,
					declaration: section.declaration,
					chunkInfo: info,
				}),
			maxTokens,
		);
		for (const s of slices) outputs.push(s);
	}

	if (outputs.length === 0) {
		// Defensive: we recognized structure but produced nothing. Fall back.
		const remaining = lines.slice(firstContentLine).join('\n');
		if (remaining.trim().length === 0) return [];
		return chunkPlainText(remaining, opts);
	}

	return outputs.map((t, position) => ({
		position,
		text: t,
		tokenCount: countTokens(t),
	}));
}
