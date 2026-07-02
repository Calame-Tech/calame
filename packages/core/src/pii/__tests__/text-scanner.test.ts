import { describe, it, expect } from 'vitest';
import { scanTextForPii, applyPiiMasking, DEFAULT_TEXT_PII_CATEGORIES } from '../text-scanner.js';

describe('scanTextForPii', () => {
  it('finds a single email in a paragraph', () => {
    const text = 'Please contact me at john.doe@example.com for details.';
    const spans = scanTextForPii(text);
    expect(spans).toHaveLength(1);
    expect(spans[0].category).toBe('email');
    expect(spans[0].match).toBe('john.doe@example.com');
  });

  it('finds multiple emails and returns them in source order', () => {
    const text = 'From a@b.co and reply to d@e.fr please.';
    const spans = scanTextForPii(text);
    const emails = spans.filter((s) => s.category === 'email');
    expect(emails).toHaveLength(2);
    expect(emails[0].match).toBe('a@b.co');
    expect(emails[1].match).toBe('d@e.fr');
    expect(emails[0].start).toBeLessThan(emails[1].start);
  });

  it('detects various phone number formats', () => {
    // Each phone tested in isolation so unrelated patterns (e.g. ssn lookalikes)
    // don't grab the digits.
    const cases = [
      'Call +1 (555) 123-4567 anytime',
      'My number is 555.123.4567 today',
      'Reach 5551234567 please',
    ];
    for (const text of cases) {
      const spans = scanTextForPii(text, ['phone']);
      expect(spans.length, `phone in: ${text}`).toBeGreaterThanOrEqual(1);
      expect(spans[0].category).toBe('phone');
    }
  });

  it('detects credit card with spaces and dashes', () => {
    const text = 'Charged 4532 1234 5678 9010 today.';
    const spans = scanTextForPii(text, ['credit_card']);
    expect(spans).toHaveLength(1);
    expect(spans[0].category).toBe('credit_card');
    expect(spans[0].match).toBe('4532 1234 5678 9010');
  });

  it('detects IPv4 addresses', () => {
    const text = 'Connection from 192.168.1.1 was denied.';
    const spans = scanTextForPii(text, ['ip_address']);
    expect(spans).toHaveLength(1);
    expect(spans[0].match).toBe('192.168.1.1');
    expect(spans[0].category).toBe('ip_address');
  });

  it('detects US SSN format', () => {
    const text = 'SSN on file: 123-45-6789 (verified).';
    const spans = scanTextForPii(text);
    const ssns = spans.filter((s) => s.category === 'ssn');
    expect(ssns).toHaveLength(1);
    expect(ssns[0].match).toBe('123-45-6789');
  });

  it('resolves overlap by keeping the longer span', () => {
    // A bare SSN "123-45-6789" is 11 chars; a phone-shaped candidate that
    // includes surrounding digits (here "1-123-45-6789") is longer and
    // should win.
    const text = 'Number 1-123-45-6789 on record';
    const spans = scanTextForPii(text);
    // Whichever category wins, only ONE span should cover the digit area.
    const digitSpans = spans.filter((s) => /\d/.test(s.match));
    expect(digitSpans).toHaveLength(1);
    expect(digitSpans[0].match.length).toBeGreaterThanOrEqual('123-45-6789'.length);
  });

  it('respects category filter', () => {
    const text = 'Email a@b.co or call 555.123.4567';
    const onlyEmails = scanTextForPii(text, ['email']);
    expect(onlyEmails).toHaveLength(1);
    expect(onlyEmails[0].category).toBe('email');
  });

  it('returns [] for empty text', () => {
    expect(scanTextForPii('')).toEqual([]);
  });

  it('does not match an address or person name (out of scope by default)', () => {
    const text = 'John Smith lives at 123 Main Street, Springfield.';
    const spans = scanTextForPii(text);
    // "123 Main Street" / "John Smith" must NOT produce spans —
    // false-positive control. (A 7+ digit phone-like substring is also
    // absent here.)
    expect(spans).toEqual([]);
  });

  it('exports the default category list used implicitly', () => {
    expect(DEFAULT_TEXT_PII_CATEGORIES).toEqual([
      'email',
      'phone',
      'credit_card',
      'ip_address',
      'ssn',
    ]);
  });
});

describe('applyPiiMasking', () => {
  it("'replace' mode swaps spans for labelled placeholders", () => {
    const { text, redactionCounts } = applyPiiMasking('Email me at jane@example.com.', 'replace');
    expect(text).toBe('Email me at [EMAIL].');
    expect(redactionCounts.email).toBe(1);
  });

  it("'hash' mode emits a deterministic short hash", () => {
    const a = applyPiiMasking('From a@b.co', 'hash');
    const b = applyPiiMasking('Re: a@b.co', 'hash');
    // Same address → same hash prefix.
    const ha = a.text.match(/\[email:([a-f0-9]+)\]/)?.[1];
    const hb = b.text.match(/\[email:([a-f0-9]+)\]/)?.[1];
    expect(ha).toBeDefined();
    expect(ha).toBe(hb);
    expect(ha).toHaveLength(8);
  });

  it("'truncate' mode keeps head and tail chars", () => {
    const { text } = applyPiiMasking('Card 4532567812349010 declined', 'truncate');
    // First 2 chars "45", last 2 chars "10".
    expect(text).toMatch(/\[CREDIT_CARD:45\*{3}10\]/);
  });

  it("'none' mode preserves text but still reports counts", () => {
    const { text, redactionCounts } = applyPiiMasking('Contact a@b.co or 192.168.1.1', 'none');
    expect(text).toBe('Contact a@b.co or 192.168.1.1');
    expect(redactionCounts.email).toBe(1);
    expect(redactionCounts.ip_address).toBe(1);
  });

  it('returns text unchanged with empty counts when no PII is present', () => {
    const { text, redactionCounts } = applyPiiMasking(
      'A perfectly clean sentence with no secrets.',
      'replace',
    );
    expect(text).toBe('A perfectly clean sentence with no secrets.');
    expect(redactionCounts).toEqual({});
  });

  it('aggregates counts across multiple spans of the same category', () => {
    const { redactionCounts } = applyPiiMasking('a@b.co and c@d.eu', 'replace');
    expect(redactionCounts.email).toBe(2);
  });

  it('is safe on empty input', () => {
    const out = applyPiiMasking('', 'replace');
    expect(out.text).toBe('');
    expect(out.redactionCounts).toEqual({});
  });

  it('is idempotent — masking the masked output adds no new redactions', () => {
    const first = applyPiiMasking('Hi jane@example.com.', 'replace');
    expect(first.redactionCounts.email).toBe(1);
    const second = applyPiiMasking(first.text, 'replace');
    expect(second.text).toBe(first.text);
    expect(second.redactionCounts).toEqual({});
  });
});
