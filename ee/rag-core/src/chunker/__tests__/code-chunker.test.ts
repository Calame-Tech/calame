// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect } from 'vitest';
import { chunkCode } from '../code-chunker.js';

const TS_THREE_FUNCS = [
	`export function alpha(x: number): number {`,
	`  return x + 1;`,
	`}`,
	``,
	`function beta(y: number) {`,
	`  return y * 2;`,
	`}`,
	``,
	`export async function gamma(z: string) {`,
	`  return z.length;`,
	`}`,
].join('\n');

describe('chunkCode — TypeScript', () => {
	it('emits one chunk per top-level function (3 functions → 3 chunks)', () => {
		const chunks = chunkCode(TS_THREE_FUNCS, {
			maxTokens: 512,
			language: 'typescript',
			filename: 'sample.ts',
		});
		expect(chunks).toHaveLength(3);
		expect(chunks[0]!.text).toContain('function alpha');
		expect(chunks[1]!.text).toContain('function beta');
		expect(chunks[2]!.text).toContain('async function gamma');
		// All chunks carry the preamble header.
		for (const c of chunks) {
			expect(c.text).toMatch(/^\/\/ File: sample\.ts/);
			expect(c.text).toContain('// Language: typescript');
			expect(c.text).toContain('// Top-level:');
		}
		// Positions monotonically increasing.
		expect(chunks.map((c) => c.position)).toEqual([0, 1, 2]);
	});

	it('keeps a TS class with its methods in a single chunk when small', () => {
		const src = [
			`export class Greeter {`,
			`  greet(name: string) {`,
			`    return \`hello \${name}\`;`,
			`  }`,
			`  shout(name: string) {`,
			`    return this.greet(name).toUpperCase();`,
			`  }`,
			`}`,
		].join('\n');
		const chunks = chunkCode(src, {
			maxTokens: 512,
			language: 'typescript',
			filename: 'g.ts',
		});
		expect(chunks).toHaveLength(1);
		expect(chunks[0]!.text).toContain('class Greeter');
		expect(chunks[0]!.text).toContain('greet(');
		expect(chunks[0]!.text).toContain('shout(');
	});

	it('puts imports into their own chunk', () => {
		const src = [
			`import { foo } from './foo';`,
			`import bar from 'bar';`,
			``,
			`export function useBoth() {`,
			`  return foo() + bar();`,
			`}`,
		].join('\n');
		const chunks = chunkCode(src, {
			maxTokens: 512,
			language: 'typescript',
			filename: 'm.ts',
		});
		expect(chunks.length).toBeGreaterThanOrEqual(2);
		const importChunk = chunks.find((c) => c.text.includes('// Top-level: imports'));
		expect(importChunk).toBeDefined();
		expect(importChunk!.text).toContain(`import { foo }`);
		const funcChunk = chunks.find((c) => c.text.includes('useBoth'));
		expect(funcChunk).toBeDefined();
		// Imports should NOT be repeated in the function chunk.
		expect(funcChunk!.text).not.toContain(`from 'bar'`);
	});

	it('preserves brace counting through string literals containing { }', () => {
		const src = [
			`function tricky() {`,
			`  const s = "}{}{";`,
			`  const t = '}}{{';`,
			`  return s + t;`,
			`}`,
			``,
			`function next() {`,
			`  return 1;`,
			`}`,
		].join('\n');
		const chunks = chunkCode(src, {
			maxTokens: 512,
			language: 'typescript',
			filename: 'x.ts',
		});
		expect(chunks).toHaveLength(2);
		expect(chunks[0]!.text).toContain('function tricky');
		expect(chunks[0]!.text).toContain(`"}{}{"`);
		expect(chunks[1]!.text).toContain('function next');
	});

	it('handles template literals with ${} expressions without losing the section', () => {
		const src = [
			'function fmt(name: string) {',
			'  return `hello ${name}! you have ${name.length} chars`;',
			'}',
			'',
			'function next() {',
			'  return 0;',
			'}',
		].join('\n');
		const chunks = chunkCode(src, {
			maxTokens: 512,
			language: 'typescript',
			filename: 'l.ts',
		});
		expect(chunks).toHaveLength(2);
		expect(chunks[0]!.text).toContain('function fmt');
		expect(chunks[0]!.text).toContain('${name}');
	});
});

describe('chunkCode — Python', () => {
	it('emits one chunk per top-level def / class', () => {
		const src = [
			`async def fetch(url):`,
			`    return await get(url)`,
			``,
			`class Service:`,
			`    def do(self):`,
			`        return 1`,
			`    def stop(self):`,
			`        pass`,
		].join('\n');
		const chunks = chunkCode(src, {
			maxTokens: 512,
			language: 'python',
			filename: 'svc.py',
		});
		expect(chunks).toHaveLength(2);
		expect(chunks[0]!.text).toContain('async def fetch');
		expect(chunks[1]!.text).toContain('class Service');
		expect(chunks[1]!.text).toContain('def do');
		expect(chunks[1]!.text).toContain('def stop');
		// Preamble uses `#` for Python.
		for (const c of chunks) {
			expect(c.text).toMatch(/^# File: svc\.py/);
		}
	});

	it('keeps nested defs inside the outer def (indentation-based body)', () => {
		const src = [
			`def outer():`,
			`    def inner():`,
			`        return 1`,
			`    return inner()`,
			``,
			`def sibling():`,
			`    return 2`,
		].join('\n');
		const chunks = chunkCode(src, {
			maxTokens: 512,
			language: 'python',
			filename: 'n.py',
		});
		expect(chunks).toHaveLength(2);
		expect(chunks[0]!.text).toContain('def outer');
		expect(chunks[0]!.text).toContain('def inner');
		expect(chunks[1]!.text).toContain('def sibling');
	});

	it('routes through pickChunker with language hint', () => {
		const src = `def hi():\n    return 'hello'\n`;
		const chunks = chunkCode(src, { language: 'python', filename: 'h.py' });
		expect(chunks).toHaveLength(1);
		expect(chunks[0]!.text).toContain('def hi');
	});
});

describe('chunkCode — Go', () => {
	it('separates func, method, and struct into distinct chunks', () => {
		const src = [
			`package main`,
			``,
			`type Server struct {`,
			`    Port int`,
			`}`,
			``,
			`func (s *Server) Start() error {`,
			`    return nil`,
			`}`,
			``,
			`func Run() {`,
			`    s := &Server{Port: 8080}`,
			`    s.Start()`,
			`}`,
		].join('\n');
		const chunks = chunkCode(src, {
			maxTokens: 512,
			language: 'go',
			filename: 'srv.go',
		});
		// We expect the package import line + 3 declarations. The `package`
		// keyword is captured as an "imports" chunk by extractImports.
		expect(chunks.length).toBeGreaterThanOrEqual(3);
		expect(chunks.some((c) => c.text.includes('type Server struct'))).toBe(true);
		expect(chunks.some((c) => c.text.includes('func (s *Server) Start'))).toBe(true);
		expect(chunks.some((c) => c.text.includes('func Run()'))).toBe(true);
	});
});

describe('chunkCode — Rust', () => {
	it('keeps an impl block intact in one chunk', () => {
		const src = [
			`pub struct Counter {`,
			`    n: u64,`,
			`}`,
			``,
			`impl Counter {`,
			`    pub fn new() -> Self {`,
			`        Counter { n: 0 }`,
			`    }`,
			`    pub fn tick(&mut self) {`,
			`        self.n += 1;`,
			`    }`,
			`}`,
		].join('\n');
		const chunks = chunkCode(src, {
			maxTokens: 512,
			language: 'rust',
			filename: 'counter.rs',
		});
		expect(chunks).toHaveLength(2);
		const implChunk = chunks.find((c) => c.text.includes('impl Counter'));
		expect(implChunk).toBeDefined();
		expect(implChunk!.text).toContain('pub fn new');
		expect(implChunk!.text).toContain('pub fn tick');
	});
});

describe('chunkCode — Java', () => {
	it('captures a class and its methods', () => {
		const src = [
			`package com.example;`,
			``,
			`public class Calculator {`,
			`    public int add(int a, int b) {`,
			`        return a + b;`,
			`    }`,
			`    public int sub(int a, int b) {`,
			`        return a - b;`,
			`    }`,
			`}`,
		].join('\n');
		const chunks = chunkCode(src, {
			maxTokens: 512,
			language: 'java',
			filename: 'Calculator.java',
		});
		// Imports + class chunk (the methods sit inside the class body which is
		// the C-like top-level section).
		expect(chunks.length).toBeGreaterThanOrEqual(1);
		const classChunk = chunks.find((c) => c.text.includes('class Calculator'));
		expect(classChunk).toBeDefined();
		expect(classChunk!.text).toContain('public int add');
		expect(classChunk!.text).toContain('public int sub');
	});
});

describe('chunkCode — fallbacks', () => {
	it('falls back to the plain chunker when language is unknown', () => {
		const src = 'just some\ntext with no\nrecognized structure\n';
		const chunks = chunkCode(src, { maxTokens: 512, language: 'unknown' });
		expect(chunks.length).toBeGreaterThanOrEqual(1);
		// No preamble headers because we routed to plain.
		expect(chunks[0]!.text).not.toContain('// Language:');
	});

	it('falls back to the plain chunker when the file has no top-level declaration', () => {
		const src = `let x = 1;\nlet y = 2;\nconsole.log(x + y);\n`;
		const chunks = chunkCode(src, {
			maxTokens: 512,
			language: 'typescript',
			filename: 's.ts',
		});
		expect(chunks).toHaveLength(1);
		// Plain output (no preamble).
		expect(chunks[0]!.text).not.toContain('// Top-level:');
	});

	it('returns zero chunks for an empty file', () => {
		expect(chunkCode('', { language: 'typescript', filename: 'e.ts' })).toEqual([]);
		expect(chunkCode('   \n\n', { language: 'python', filename: 'e.py' })).toEqual([]);
	});

	it('returns zero chunks for a comment-only file', () => {
		const tsOnly = [`// just a note`, `// nothing real here`, ``].join('\n');
		expect(chunkCode(tsOnly, { language: 'typescript', filename: 'c.ts' })).toEqual([]);
		const pyOnly = [`# pure comments`, `# nothing here`, ``].join('\n');
		expect(chunkCode(pyOnly, { language: 'python', filename: 'c.py' })).toEqual([]);
	});

	it('splits an oversized section into multiple chunks with Chunk: N/M markers', () => {
		const longBody = Array.from({ length: 80 }, (_, i) => `  const v${i} = ${i};`).join('\n');
		const src = [
			`export function huge() {`,
			longBody,
			`  return 0;`,
			`}`,
		].join('\n');
		const chunks = chunkCode(src, {
			maxTokens: 200,
			language: 'typescript',
			filename: 'h.ts',
		});
		expect(chunks.length).toBeGreaterThan(1);
		for (const c of chunks) {
			expect(c.text).toMatch(/\/\/ Chunk: \d+\/\d+/);
			expect(c.tokenCount).toBeLessThanOrEqual(200);
		}
	});

	it('skips a leading license header (BUSL / Copyright) from the indexed content', () => {
		const src = [
			`// SPDX-License-Identifier: BUSL-1.1`,
			`// Copyright (c) 2026 Calame.`,
			``,
			`export function ok() {`,
			`  return true;`,
			`}`,
		].join('\n');
		const chunks = chunkCode(src, {
			maxTokens: 512,
			language: 'typescript',
			filename: 'lic.ts',
		});
		expect(chunks).toHaveLength(1);
		expect(chunks[0]!.text).toContain('function ok');
		// The license header is not part of the chunk body.
		expect(chunks[0]!.text).not.toContain('Copyright (c)');
	});

	it('builds a preamble that contains filename, language, and the top-level declaration', () => {
		const src = `export function foo(a: number) {\n  return a;\n}\n`;
		const [chunk] = chunkCode(src, {
			maxTokens: 512,
			language: 'typescript',
			filename: 'pre.ts',
		});
		expect(chunk!.text).toContain('// File: pre.ts');
		expect(chunk!.text).toContain('// Language: typescript');
		expect(chunk!.text).toMatch(/\/\/ Top-level:.*function foo/);
	});
});
