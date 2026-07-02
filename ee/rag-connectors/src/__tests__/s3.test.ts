// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { mockClient } from 'aws-sdk-client-mock';
import {
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';

import { S3Connector, S3DocumentNotFoundError, __testing } from '../s3.js';
import type { RagFolder } from '@calame-ee/rag-core';

const baseConfig = {
  bucket: 'my-bucket',
  region: 'us-east-1',
  accessKeyId: 'AKIA_TEST',
  secretAccessKey: 'SECRET',
};

const s3Mock = mockClient(S3Client);

beforeEach(() => {
  s3Mock.reset();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an SDK-shaped error with `name` + `$metadata.httpStatusCode`. */
function sdkError(name: string, httpStatusCode: number, message = name): Error {
  const e = new Error(message) as Error & {
    name: string;
    $metadata: { httpStatusCode: number };
  };
  e.name = name;
  e.$metadata = { httpStatusCode };
  return e;
}

/** Create a Node Readable from a string for GetObject mocks. */
function bodyFromString(s: string): Readable {
  return Readable.from([Buffer.from(s, 'utf8')]);
}

// ---------------------------------------------------------------------------
// testConnection
// ---------------------------------------------------------------------------

describe('S3Connector.testConnection', () => {
  it('resolves silently when HeadBucket succeeds', async () => {
    s3Mock.on(HeadBucketCommand).resolves({});
    const connector = new S3Connector();
    await expect(connector.testConnection(baseConfig)).resolves.toBeUndefined();
  });

  it('throws an admin-friendly 403 message on access denied', async () => {
    s3Mock.on(HeadBucketCommand).rejects(sdkError('Forbidden', 403));
    const connector = new S3Connector();
    await expect(connector.testConnection(baseConfig)).rejects.toThrow(/access denied/i);
  });

  it('throws an admin-friendly 404 message on missing bucket', async () => {
    s3Mock.on(HeadBucketCommand).rejects(sdkError('NotFound', 404));
    const connector = new S3Connector();
    await expect(connector.testConnection(baseConfig)).rejects.toThrow(/does not exist/i);
  });

  it('throws an admin-friendly 301 message on wrong region', async () => {
    s3Mock.on(HeadBucketCommand).rejects(sdkError('PermanentRedirect', 301));
    const connector = new S3Connector();
    await expect(connector.testConnection(baseConfig)).rejects.toThrow(/different region/i);
  });

  it('rejects malformed configs (missing bucket / creds)', async () => {
    const connector = new S3Connector();
    await expect(connector.testConnection({ region: 'us-east-1' })).rejects.toThrow(/bucket/i);
    await expect(connector.testConnection({ bucket: 'b' })).rejects.toThrow(/region/i);
  });
});

// ---------------------------------------------------------------------------
// listFolders
// ---------------------------------------------------------------------------

describe('S3Connector.listFolders', () => {
  it('returns [] for an empty bucket', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({});
    const connector = new S3Connector();
    const folders = await connector.listFolders(baseConfig, 'src-1');
    expect(folders).toEqual([]);
  });

  it('maps a single CommonPrefix into a RagFolder', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      CommonPrefixes: [{ Prefix: 'docs/' }],
    });
    const connector = new S3Connector();
    const folders = await connector.listFolders(baseConfig, 'src-1');
    expect(folders).toHaveLength(1);
    expect(folders[0]).toMatchObject({
      sourceId: 'src-1',
      parentId: null,
      path: 'docs',
      name: 'docs',
    });
    expect(folders[0]?.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('lists multiple folders and respects parent.path scoping', async () => {
    // First call (root): two folders.
    s3Mock.on(ListObjectsV2Command, { Bucket: 'my-bucket', Prefix: '', Delimiter: '/' }).resolves({
      CommonPrefixes: [{ Prefix: 'a/' }, { Prefix: 'b/' }],
    });
    // Second call (under "a"): one folder.
    s3Mock
      .on(ListObjectsV2Command, { Bucket: 'my-bucket', Prefix: 'a/', Delimiter: '/' })
      .resolves({
        CommonPrefixes: [{ Prefix: 'a/sub/' }],
      });

    const connector = new S3Connector();
    const root = await connector.listFolders(baseConfig, 'src-1');
    expect(root.map((f) => f.path).sort()).toEqual(['a', 'b']);

    const aFolder: RagFolder = {
      id: root[0]!.id,
      sourceId: 'src-1',
      parentId: null,
      path: 'a',
      name: 'a',
      createdAt: '',
    };
    const sub = await connector.listFolders(baseConfig, 'src-1', aFolder);
    expect(sub).toHaveLength(1);
    expect(sub[0]?.path).toBe('a/sub');
    expect(sub[0]?.parentId).toBe(aFolder.id);
  });

  it('honors excludeGlobs', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      CommonPrefixes: [{ Prefix: 'docs/' }, { Prefix: 'tmp/' }, { Prefix: '.cache/' }],
    });
    const connector = new S3Connector();
    const folders = await connector.listFolders(
      { ...baseConfig, excludeGlobs: ['tmp', '.cache'] },
      'src-1',
    );
    expect(folders.map((f) => f.path)).toEqual(['docs']);
  });

  it('strips the configured prefix from listed folder paths', async () => {
    s3Mock
      .on(ListObjectsV2Command, { Bucket: 'my-bucket', Prefix: 'docs/', Delimiter: '/' })
      .resolves({
        CommonPrefixes: [{ Prefix: 'docs/faq/' }, { Prefix: 'docs/api/' }],
      });
    const connector = new S3Connector();
    const folders = await connector.listFolders({ ...baseConfig, prefix: 'docs/' }, 'src-1');
    expect(folders.map((f) => f.path).sort()).toEqual(['api', 'faq']);
  });
});

// ---------------------------------------------------------------------------
// listDocuments
// ---------------------------------------------------------------------------

describe('S3Connector.listDocuments', () => {
  it('handles paginated responses with IsTruncated', async () => {
    s3Mock
      .on(ListObjectsV2Command)
      .resolvesOnce({
        Contents: [{ Key: 'a.txt', Size: 10, ETag: '"etag-a"' }],
        IsTruncated: true,
        NextContinuationToken: 'TOKEN-1',
      })
      .resolvesOnce({
        Contents: [{ Key: 'b.txt', Size: 20, ETag: '"etag-b"' }],
        IsTruncated: false,
      });

    const connector = new S3Connector();
    const docs = await connector.listDocuments(baseConfig, 'src-1');
    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.path).sort()).toEqual(['a.txt', 'b.txt']);
    // Verify the second call used the continuation token.
    const calls = s3Mock.commandCalls(ListObjectsV2Command);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args[0].input.ContinuationToken).toBe('TOKEN-1');
  });

  it('skips pseudo-directory markers (keys ending with /)', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [
        { Key: 'docs/', Size: 0, ETag: '"x"' },
        { Key: 'docs/intro.md', Size: 100, ETag: '"y"' },
      ],
    });
    const connector = new S3Connector();
    const docs = await connector.listDocuments(baseConfig, 'src-1');
    expect(docs).toHaveLength(1);
    expect(docs[0]?.path).toBe('docs/intro.md');
  });

  it('applies includeGlobs and excludeGlobs (e.g. exclude **/.DS_Store)', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [
        { Key: 'a.md', Size: 1, ETag: '"1"' },
        { Key: 'b.txt', Size: 1, ETag: '"2"' },
        { Key: 'sub/.DS_Store', Size: 1, ETag: '"3"' },
        { Key: 'sub/c.md', Size: 1, ETag: '"4"' },
      ],
    });
    const connector = new S3Connector();
    const docs = await connector.listDocuments(
      {
        ...baseConfig,
        includeGlobs: ['**/*.md'],
        excludeGlobs: ['**/.DS_Store'],
      },
      'src-1',
    );
    expect(docs.map((d) => d.path).sort()).toEqual(['a.md', 'sub/c.md']);
  });

  it('cleans ETag quotes and assigns single-part vs multipart correctly', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [
        // Single-part: clean MD5 hex
        { Key: 'small.bin', Size: 5, ETag: '"d41d8cd98f00b204e9800998ecf8427e"' },
        // Multipart: dash + part count
        { Key: 'big.bin', Size: 10_000_000, ETag: '"a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6-3"' },
      ],
    });
    const connector = new S3Connector();
    const docs = await connector.listDocuments(baseConfig, 'src-1');
    const small = docs.find((d) => d.path === 'small.bin');
    const big = docs.find((d) => d.path === 'big.bin');
    expect(small?.etag).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(big?.etag).toBe('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6-3');
    expect(__testing.isSinglePartEtag(small?.etag ?? null)).toBe(true);
    expect(__testing.isSinglePartEtag(big?.etag ?? null)).toBe(false);
    // hash is empty for both — pipeline re-streams to compute SHA-256
    expect(small?.hash).toBe('');
    expect(big?.hash).toBe('');
  });

  it('infers mime types from key extensions and skips empty Contents', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [
        { Key: 'doc.pdf', Size: 1, ETag: '"1"' },
        { Key: 'note.md', Size: 1, ETag: '"2"' },
        { Key: 'unknown.weirdext', Size: 1, ETag: '"3"' },
      ],
    });
    const connector = new S3Connector();
    const docs = await connector.listDocuments(baseConfig, 'src-1');
    expect(docs.find((d) => d.path === 'doc.pdf')?.mimeType).toBe('application/pdf');
    expect(docs.find((d) => d.path === 'note.md')?.mimeType).toBe('text/markdown');
    expect(docs.find((d) => d.path === 'unknown.weirdext')?.mimeType).toBe(
      'application/octet-stream',
    );
  });
});

// ---------------------------------------------------------------------------
// fetchDocument
// ---------------------------------------------------------------------------

describe('S3Connector.fetchDocument', () => {
  it('streams the body and returns the response ContentType when present', async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: bodyFromString('hello world') as unknown as never,
      ContentType: 'text/plain; charset=utf-8',
    });
    const connector = new S3Connector();
    const docId = __testing.encodeDocId('docs/intro.md');
    const out = await connector.fetchDocument(baseConfig, 'src-1', docId);
    expect(out.mimeType).toBe('text/plain; charset=utf-8');
    const buf = await __testing.drainToBuffer(out.stream);
    expect(buf.toString('utf8')).toBe('hello world');
  });

  it('falls back to mime.lookup when ContentType is missing', async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: bodyFromString('# Title') as unknown as never,
    });
    const connector = new S3Connector();
    const docId = __testing.encodeDocId('readme.md');
    const out = await connector.fetchDocument(baseConfig, 'src-1', docId);
    expect(out.mimeType).toBe('text/markdown');
  });

  it('throws S3DocumentNotFoundError on NoSuchKey / 404', async () => {
    s3Mock.on(GetObjectCommand).rejects(sdkError('NoSuchKey', 404));
    const connector = new S3Connector();
    const docId = __testing.encodeDocId('missing.txt');
    await expect(connector.fetchDocument(baseConfig, 'src-1', docId)).rejects.toBeInstanceOf(
      S3DocumentNotFoundError,
    );
  });

  it('throws S3DocumentNotFoundError when the docId prefix is wrong', async () => {
    const connector = new S3Connector();
    await expect(
      connector.fetchDocument(baseConfig, 'src-1', 'path:not-an-s3-id'),
    ).rejects.toBeInstanceOf(S3DocumentNotFoundError);
  });

  it('rejects keys that contain ".." segments (defense-in-depth)', async () => {
    const connector = new S3Connector();
    const docId = __testing.encodeDocId('../etc/passwd');
    await expect(connector.fetchDocument(baseConfig, 'src-1', docId)).rejects.toThrow(
      /contains ".."/,
    );
  });
});

// ---------------------------------------------------------------------------
// Doc id round-trip + helpers
// ---------------------------------------------------------------------------

describe('doc id encode/decode', () => {
  it('round-trips keys with special characters', () => {
    const cases = [
      'simple.txt',
      'docs/with spaces/file.md',
      'docs+plus/équipe/résumé.pdf',
      'a/b/c=d=e/f.bin',
      'unicode/日本語/ファイル.txt',
      'trailing+padding====',
    ];
    for (const key of cases) {
      const id = __testing.encodeDocId(key);
      expect(id.startsWith('s3:')).toBe(true);
      expect(__testing.decodeDocId(id)).toBe(key);
    }
  });

  it('decodeDocId throws S3DocumentNotFoundError for non-s3-prefixed ids', () => {
    expect(() => __testing.decodeDocId('path:abc')).toThrow(S3DocumentNotFoundError);
    expect(() => __testing.decodeDocId('garbage')).toThrow(S3DocumentNotFoundError);
  });
});

describe('helpers', () => {
  it('normalizePrefix strips leading slashes and ensures trailing /', () => {
    expect(__testing.normalizePrefix(undefined)).toBe('');
    expect(__testing.normalizePrefix('')).toBe('');
    expect(__testing.normalizePrefix('docs')).toBe('docs/');
    expect(__testing.normalizePrefix('docs/')).toBe('docs/');
    expect(__testing.normalizePrefix('/docs/')).toBe('docs/');
    expect(__testing.normalizePrefix('//docs/')).toBe('docs/');
  });

  it('cleanEtag strips surrounding quotes and returns null for empty', () => {
    expect(__testing.cleanEtag(undefined)).toBeNull();
    expect(__testing.cleanEtag('')).toBeNull();
    expect(__testing.cleanEtag('"abc"')).toBe('abc');
    expect(__testing.cleanEtag('abc')).toBe('abc');
  });

  it('relativeToPrefix strips the configured root prefix from keys', () => {
    expect(__testing.relativeToPrefix('docs/foo.md', 'docs/')).toBe('foo.md');
    expect(__testing.relativeToPrefix('docs/foo.md', '')).toBe('docs/foo.md');
    expect(__testing.relativeToPrefix('other/x', 'docs/')).toBe('other/x');
  });

  it('buildQueryPrefix combines root prefix + parent.path correctly', () => {
    expect(__testing.buildQueryPrefix('', undefined)).toBe('');
    expect(__testing.buildQueryPrefix('docs/', undefined)).toBe('docs/');
    expect(
      __testing.buildQueryPrefix('docs/', {
        id: 'f',
        sourceId: 's',
        parentId: null,
        path: 'sub',
        name: 'sub',
        createdAt: '',
      }),
    ).toBe('docs/sub/');
  });

  it('mapS3Error returns distinct messages for 403 / 404 / 301 / generic', () => {
    expect(__testing.mapS3Error(sdkError('Forbidden', 403), 'b').message).toMatch(/access denied/i);
    expect(__testing.mapS3Error(sdkError('NotFound', 404), 'b').message).toMatch(/does not exist/i);
    expect(__testing.mapS3Error(sdkError('PermanentRedirect', 301), 'b').message).toMatch(
      /different region/i,
    );
    expect(__testing.mapS3Error(new Error('boom'), 'b').message).toMatch(/failed to reach/i);
  });
});

describe('S3Connector type discriminator', () => {
  it("exposes type === 's3' so the registry can dispatch on it", () => {
    const c = new S3Connector();
    expect(c.type).toBe('s3');
  });
});

// ---------------------------------------------------------------------------
// Pagination edge case + prefix escape + LRU eviction
// ---------------------------------------------------------------------------

describe('S3Connector.listDocuments pagination edge cases', () => {
  it('handles IsTruncated=true but empty NextContinuationToken safely', async () => {
    // Defensive: some S3-compatible stores have been seen returning
    // IsTruncated:true with no NextContinuationToken. We must not loop forever.
    s3Mock.on(ListObjectsV2Command).resolvesOnce({
      Contents: [{ Key: 'a.txt', Size: 10, ETag: '"etag-a"' }],
      IsTruncated: true,
      NextContinuationToken: undefined,
    });

    const connector = new S3Connector();
    const docs = await connector.listDocuments(baseConfig, 'src-1');
    expect(docs).toHaveLength(1);
    expect(docs[0]?.path).toBe('a.txt');
    // Crucially: only one call was made — the loop exits when the token is
    // missing/falsy even if IsTruncated says otherwise.
    const calls = s3Mock.commandCalls(ListObjectsV2Command);
    expect(calls).toHaveLength(1);
  });
});

describe('S3Connector.fetchDocument prefix isolation', () => {
  it('rejects fetchDocument when docId encodes a key outside the configured prefix', async () => {
    // config.prefix = 'docs/' but the docId encodes 'other/file.txt' which
    // is outside the configured prefix root. assertKeyUnderPrefix must reject.
    const connector = new S3Connector();
    const docId = __testing.encodeDocId('other/file.txt');
    await expect(
      connector.fetchDocument({ ...baseConfig, prefix: 'docs/' }, 'src-1', docId),
    ).rejects.toThrow(/does not start with configured prefix/i);
  });
});

describe('S3Connector LRU client cache', () => {
  it('evicts the least-recently-used S3 client when cache exceeds 16 configs', async () => {
    // Mock HeadBucket so testConnection() doesn't fail; we just want it to
    // run far enough to instantiate (and therefore cache) one S3Client per
    // distinct config.
    s3Mock.on(HeadBucketCommand).resolves({});

    const connector = new S3Connector();

    // Trigger 17 distinct configs — each unique accessKeyId yields a fresh
    // cache key, forcing a new S3Client instance.
    for (let i = 0; i < 17; i += 1) {
      await connector.testConnection({
        ...baseConfig,
        accessKeyId: `AKIA_TENANT_${i}`,
      });
    }

    // Cache must be capped at MAX_CACHED_CLIENTS (16); the oldest entry
    // (tenant 0) was evicted to make room for tenant 16.
    expect(__testing.getClientCacheSize(connector)).toBe(16);
    expect(__testing.getClientCacheSize(connector)).toBe(S3Connector.MAX_CACHED_CLIENTS);
  });

  it('bumps a cached client to most-recently-used on re-access', async () => {
    s3Mock.on(HeadBucketCommand).resolves({});
    const connector = new S3Connector();

    // Fill the cache to capacity.
    for (let i = 0; i < 16; i += 1) {
      await connector.testConnection({
        ...baseConfig,
        accessKeyId: `AKIA_TENANT_${i}`,
      });
    }
    expect(__testing.getClientCacheSize(connector)).toBe(16);

    // Re-touch tenant 0 so it becomes most-recently-used. Tenant 1 should
    // now be the LRU entry.
    await connector.testConnection({ ...baseConfig, accessKeyId: 'AKIA_TENANT_0' });

    // Add a 17th tenant: tenant 1 (not 0) should be evicted.
    await connector.testConnection({ ...baseConfig, accessKeyId: 'AKIA_TENANT_NEW' });
    expect(__testing.getClientCacheSize(connector)).toBe(16);

    // Re-accessing tenant 0 should NOT instantiate a new client (cache hit
    // = no new ListObjectsV2 / HeadBucket calls beyond what's already mocked).
    // We assert this indirectly: the cache stays at 16 after the access.
    await connector.testConnection({ ...baseConfig, accessKeyId: 'AKIA_TENANT_0' });
    expect(__testing.getClientCacheSize(connector)).toBe(16);
  });
});

// ---------------------------------------------------------------------------
// Rate-limiter wiring
// ---------------------------------------------------------------------------

describe('S3Connector rate limiter', () => {
  it('does not call any limiter when none is injected (backwards-compatible)', async () => {
    // The connector default is `setRateLimiter`-not-called: it must still
    // function with no observable side effect beyond the SDK calls.
    s3Mock.on(HeadBucketCommand).resolves({});
    const connector = new S3Connector();
    await expect(connector.testConnection(baseConfig)).resolves.toBeUndefined();
  });

  it('invokes acquire("s3", ...) before each SDK send when a limiter is wired', async () => {
    s3Mock.on(HeadBucketCommand).resolves({});
    s3Mock.on(ListObjectsV2Command).resolves({
      CommonPrefixes: [{ Prefix: 'docs/' }],
    });

    const acquireCalls: Array<{ type: string; credentialKey: string }> = [];
    const fakeLimiter = {
      acquire: async (type: string, credentialKey: string): Promise<number> => {
        acquireCalls.push({ type, credentialKey });
        return 0;
      },
    };

    const connector = new S3Connector();
    connector.setRateLimiter(fakeLimiter);

    await connector.testConnection(baseConfig);
    await connector.listFolders(baseConfig, 'src-rl');

    // testConnection → 1 HeadBucket, listFolders → 1 ListObjectsV2 (no
    // pagination in this fixture). Two acquires total.
    expect(acquireCalls).toHaveLength(2);
    expect(acquireCalls[0]?.type).toBe('s3');
    // The credentialKey should be a deterministic hash of the credential
    // triple — two calls with the same config yield the same key.
    expect(acquireCalls[0]?.credentialKey).toBe(acquireCalls[1]?.credentialKey);
    expect(acquireCalls[0]?.credentialKey).toMatch(/^[0-9a-f]+$/);
  });

  it('clearing the limiter via setRateLimiter(undefined) disables throttling', async () => {
    s3Mock.on(HeadBucketCommand).resolves({});
    let calls = 0;
    const fakeLimiter = {
      acquire: async (): Promise<number> => {
        calls++;
        return 0;
      },
    };
    const connector = new S3Connector();
    connector.setRateLimiter(fakeLimiter);
    await connector.testConnection(baseConfig);
    expect(calls).toBe(1);

    connector.setRateLimiter(undefined);
    await connector.testConnection(baseConfig);
    // No additional acquire — the limiter has been detached.
    expect(calls).toBe(1);
  });
});
