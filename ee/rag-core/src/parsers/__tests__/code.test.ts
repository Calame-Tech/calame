// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect } from 'vitest';
import { detectLanguageFromFilename, parse, hasCodeExtension } from '../code.js';
import { getParserForMimeType } from '../index.js';

describe('detectLanguageFromFilename', () => {
	it('maps .ts and .tsx to typescript', () => {
		expect(detectLanguageFromFilename('foo.ts')).toBe('typescript');
		expect(detectLanguageFromFilename('foo.tsx')).toBe('typescript');
		expect(detectLanguageFromFilename('Foo.TS')).toBe('typescript');
	});

	it('maps .js / .jsx / .mjs / .cjs to javascript', () => {
		expect(detectLanguageFromFilename('foo.js')).toBe('javascript');
		expect(detectLanguageFromFilename('foo.jsx')).toBe('javascript');
		expect(detectLanguageFromFilename('foo.mjs')).toBe('javascript');
		expect(detectLanguageFromFilename('foo.cjs')).toBe('javascript');
	});

	it('maps .py to python, .go to go, .rs to rust, .java to java', () => {
		expect(detectLanguageFromFilename('foo.py')).toBe('python');
		expect(detectLanguageFromFilename('foo.go')).toBe('go');
		expect(detectLanguageFromFilename('foo.rs')).toBe('rust');
		expect(detectLanguageFromFilename('Foo.java')).toBe('java');
	});

	it('returns unknown for files without a recognized extension', () => {
		expect(detectLanguageFromFilename('README')).toBe('unknown');
		expect(detectLanguageFromFilename('foo.unknown')).toBe('unknown');
		expect(detectLanguageFromFilename('Makefile')).toBe('unknown');
		expect(detectLanguageFromFilename(undefined)).toBe('unknown');
		expect(detectLanguageFromFilename('')).toBe('unknown');
	});

	it('strips directory prefixes (POSIX and Windows separators)', () => {
		expect(detectLanguageFromFilename('src/foo/bar.py')).toBe('python');
		expect(detectLanguageFromFilename('src\\foo\\bar.rs')).toBe('rust');
		expect(detectLanguageFromFilename('/abs/path/Main.java')).toBe('java');
	});

	it('treats dotfiles without extension as unknown', () => {
		expect(detectLanguageFromFilename('.gitignore')).toBe('unknown');
		expect(detectLanguageFromFilename('.env')).toBe('unknown');
	});
});

describe('hasCodeExtension', () => {
	it('returns true for recognized extensions only', () => {
		expect(hasCodeExtension('foo.ts')).toBe(true);
		expect(hasCodeExtension('foo.py')).toBe(true);
		expect(hasCodeExtension('foo.md')).toBe(false);
		expect(hasCodeExtension(undefined)).toBe(false);
	});
});

describe('parse (code parser)', () => {
	it('returns the buffer as UTF-8 text with format=code and detected language', async () => {
		const buf = Buffer.from('def foo():\n    return 1\n', 'utf8');
		const out = await parse(buf, 'sample.py');
		expect(out.text).toContain('def foo()');
		expect(out.format).toBe('code');
		expect(out.language).toBe('python');
		expect(out.filename).toBe('sample.py');
	});

	it('falls back to language="unknown" when filename is not provided', async () => {
		const buf = Buffer.from('print(42)\n', 'utf8');
		const out = await parse(buf);
		expect(out.format).toBe('code');
		expect(out.language).toBe('unknown');
		expect(out.filename).toBeUndefined();
	});

	it('strips directory prefixes when storing the filename', async () => {
		const buf = Buffer.from('package main\n', 'utf8');
		const out = await parse(buf, 'src/cmd/main.go');
		expect(out.filename).toBe('main.go');
		expect(out.language).toBe('go');
	});
});

describe('getParserForMimeType (code dispatch)', () => {
	it('routes text/typescript to the code parser', async () => {
		const parser = getParserForMimeType('text/typescript', 'foo.ts');
		const out = await parser(Buffer.from('export function hi() {}', 'utf8'), 'foo.ts');
		expect(out.format).toBe('code');
		expect(out.language).toBe('typescript');
	});

	it('routes text/x-python to the code parser', async () => {
		const parser = getParserForMimeType('text/x-python', 'foo.py');
		const out = await parser(Buffer.from('def hi(): pass', 'utf8'), 'foo.py');
		expect(out.format).toBe('code');
		expect(out.language).toBe('python');
	});

	it('routes text/plain to the code parser when filename has a code extension', async () => {
		const parser = getParserForMimeType('text/plain', 'foo.py');
		const out = await parser(Buffer.from('def hi(): pass', 'utf8'), 'foo.py');
		expect(out.format).toBe('code');
		expect(out.language).toBe('python');
	});

	it('keeps text/plain on the plain parser for non-code filenames', async () => {
		const parser = getParserForMimeType('text/plain', 'README');
		const out = await parser(Buffer.from('hello world', 'utf8'), 'README');
		expect(out.format).toBe('plain');
	});

	it('rescues an unknown MIME type when the filename hints at code', async () => {
		const parser = getParserForMimeType('application/octet-stream', 'foo.rs');
		const out = await parser(Buffer.from('fn main() {}', 'utf8'), 'foo.rs');
		expect(out.format).toBe('code');
		expect(out.language).toBe('rust');
	});

	it('still throws on truly unsupported MIME types', () => {
		expect(() => getParserForMimeType('application/x-bizarre')).toThrowError();
	});
});
