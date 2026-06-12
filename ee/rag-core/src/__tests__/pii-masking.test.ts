// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect } from 'vitest';
import { parseRagPiiConfig, maskSearchResult } from '../pii-masking.js';
import type { RagSearchResult } from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeChunk(text: string, documentId = 'doc-1', folder = 'docs/faq'): RagSearchResult['chunks'][0] {
	return {
		text,
		score: 0.9,
		sourceId: 'src-1',
		folder,
		fileName: 'intro.md',
		position: 0,
		documentId,
	};
}

function makeResult(chunks: RagSearchResult['chunks']): RagSearchResult {
	return { chunks };
}

// ---------------------------------------------------------------------------
// parseRagPiiConfig
// ---------------------------------------------------------------------------

describe('parseRagPiiConfig', () => {
	it('undefined env var → enabled defaults', () => {
		const cfg = parseRagPiiConfig(undefined);
		expect(cfg.enabled).toBe(true);
		expect(cfg.mode).toBe('replace');
		expect(cfg.categories).toEqual(['email', 'phone', 'credit_card', 'ip_address', 'ssn']);
	});

	it("'on' → enabled defaults", () => {
		const cfg = parseRagPiiConfig('on');
		expect(cfg.enabled).toBe(true);
		expect(cfg.mode).toBe('replace');
	});

	it("'off' → disabled", () => {
		const cfg = parseRagPiiConfig('off');
		expect(cfg.enabled).toBe(false);
		expect(cfg.mode).toBe('none');
		expect(cfg.categories).toEqual([]);
	});

	it("'hash' mode alone keeps default categories", () => {
		const cfg = parseRagPiiConfig('hash');
		expect(cfg.enabled).toBe(true);
		expect(cfg.mode).toBe('hash');
		expect(cfg.categories.length).toBeGreaterThan(0);
	});

	it("'replace:email,phone' → mode + category subset", () => {
		const cfg = parseRagPiiConfig('replace:email,phone');
		expect(cfg.mode).toBe('replace');
		expect(cfg.categories).toEqual(['email', 'phone']);
	});

	it("'hash:all' expands to all defaults", () => {
		const cfg = parseRagPiiConfig('hash:all');
		expect(cfg.mode).toBe('hash');
		expect(cfg.categories).toEqual(['email', 'phone', 'credit_card', 'ip_address', 'ssn']);
	});

	it("'truncate' alone keeps default categories", () => {
		const cfg = parseRagPiiConfig('truncate');
		expect(cfg.mode).toBe('truncate');
		expect(cfg.categories.length).toBeGreaterThan(0);
	});

	it("'none' mode is reported as disabled (no-op fast path)", () => {
		const cfg = parseRagPiiConfig('none');
		expect(cfg.mode).toBe('none');
		expect(cfg.enabled).toBe(false);
	});

	it('unknown mode falls back to safe defaults (not silently disabled)', () => {
		const cfg = parseRagPiiConfig('garbage');
		expect(cfg.enabled).toBe(true);
		expect(cfg.mode).toBe('replace');
	});

	it('unknown category tokens are dropped; empty result falls back to defaults', () => {
		const cfg = parseRagPiiConfig('replace:unicorn,phantom');
		expect(cfg.mode).toBe('replace');
		// All tokens invalid → defaults.
		expect(cfg.categories).toEqual(['email', 'phone', 'credit_card', 'ip_address', 'ssn']);
	});

	it('partial unknown tokens are dropped, valid ones kept', () => {
		const cfg = parseRagPiiConfig('replace:email,unicorn');
		expect(cfg.categories).toEqual(['email']);
	});
});

// ---------------------------------------------------------------------------
// maskSearchResult
// ---------------------------------------------------------------------------

describe('maskSearchResult', () => {
	it('masks emails in every chunk and aggregates counts', () => {
		const input = makeResult([
			makeChunk('Contact a@b.co for support.'),
			makeChunk('Or write to ops@example.net for billing.'),
		]);
		const { result, redactionCounts } = maskSearchResult(input, parseRagPiiConfig('on'));
		expect(result.chunks[0].text).toBe('Contact [EMAIL] for support.');
		expect(result.chunks[1].text).toBe('Or write to [EMAIL] for billing.');
		expect(redactionCounts.email).toBe(2);
	});

	it('config.enabled=false leaves chunks untouched and returns empty counts', () => {
		const input = makeResult([makeChunk('Email a@b.co please.')]);
		const cfg = parseRagPiiConfig('off');
		const { result, redactionCounts } = maskSearchResult(input, cfg);
		expect(result.chunks[0].text).toBe('Email a@b.co please.');
		expect(redactionCounts).toEqual({});
	});

	it('idempotent — masking the masked output adds no new redactions', () => {
		const cfg = parseRagPiiConfig('on');
		const first = maskSearchResult(
			makeResult([makeChunk('write to a@b.co or 1.2.3.4')]),
			cfg,
		);
		expect(first.redactionCounts.email).toBe(1);
		expect(first.redactionCounts.ip_address).toBe(1);

		const second = maskSearchResult(first.result, cfg);
		expect(second.result.chunks[0].text).toBe(first.result.chunks[0].text);
		expect(second.redactionCounts).toEqual({});
	});

	it('handles an empty result', () => {
		const out = maskSearchResult(makeResult([]), parseRagPiiConfig('on'));
		expect(out.result.chunks).toEqual([]);
		expect(out.redactionCounts).toEqual({});
	});

	it("'hash' mode produces the same hash for identical PII across chunks", () => {
		const cfg = parseRagPiiConfig('hash');
		const out = maskSearchResult(
			makeResult([
				makeChunk('First mention: dup@example.com', 'd1'),
				makeChunk('Second mention: dup@example.com again', 'd2'),
			]),
			cfg,
		);
		const h1 = out.result.chunks[0].text.match(/\[email:([a-f0-9]+)\]/)?.[1];
		const h2 = out.result.chunks[1].text.match(/\[email:([a-f0-9]+)\]/)?.[1];
		expect(h1).toBeDefined();
		expect(h1).toBe(h2);
	});

	it('does not mutate the input result', () => {
		const original = 'Contact a@b.co for help.';
		const input = makeResult([makeChunk(original)]);
		maskSearchResult(input, parseRagPiiConfig('on'));
		expect(input.chunks[0].text).toBe(original);
	});

	it('preserves chunk metadata (score, sourceId, folder, ...)', () => {
		const chunk = makeChunk('Email a@b.co', 'doc-xyz', 'docs/special');
		const { result } = maskSearchResult(makeResult([chunk]), parseRagPiiConfig('on'));
		expect(result.chunks[0].score).toBe(chunk.score);
		expect(result.chunks[0].documentId).toBe('doc-xyz');
		expect(result.chunks[0].folder).toBe('docs/special');
		expect(result.chunks[0].position).toBe(chunk.position);
	});

	it('respects category subset (only emails masked)', () => {
		const cfg = parseRagPiiConfig('replace:email');
		const { result, redactionCounts } = maskSearchResult(
			makeResult([makeChunk('Contact a@b.co or 555.123.4567')]),
			cfg,
		);
		expect(result.chunks[0].text).toContain('[EMAIL]');
		// Phone left intact since not in the subset.
		expect(result.chunks[0].text).toContain('555.123.4567');
		expect(redactionCounts.email).toBe(1);
		expect(redactionCounts.phone).toBeUndefined();
	});
});
