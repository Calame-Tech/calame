// Connector resolution: maps a source `type` string to a concrete connector
// instance from whichever EE packages are installed. Every remote-API connector
// is wrapped with the shared rate limiter before being returned. Types whose
// package is absent resolve to `null` so the route layer can answer 501.

import type { ConnectorLike, RateLimiter } from '@calame-ee/rag-core';
import type { EeModules } from './bootstrap.js';

/**
 * Build the runtime's `resolveConnector(type)` function over the loaded EE
 * modules. Phase 1 wired `local`; Phase 3 adds `s3` and `http`. Phase 3+ adds
 * `gdrive`, `gsheets`, `notion`, and `sharepoint` (each in a separate package).
 * Other types (git, …) still return null so the route layer can answer 501 with
 * a clear message.
 *
 * Every remote-API connector is wrapped with `setRateLimiter(rateLimiter)`
 * before returning so the queue / poller / watcher trigger paths all share
 * one process-wide bucket per (type, credential). `local` is filesystem-only
 * and skips the wiring — no upstream quota to honor.
 */
export function buildConnectorResolver(
  modules: EeModules,
  rateLimiter: RateLimiter,
): (type: string) => ConnectorLike | null {
  const { ragConnectors, ragGdrive, ragGsheets, ragNotion, ragMicrosoft } = modules;

  const withRateLimiter = <T extends { setRateLimiter?: (l: RateLimiter | undefined) => void }>(
    connector: T,
  ): T => {
    if (typeof connector.setRateLimiter === 'function') {
      connector.setRateLimiter(rateLimiter);
    }
    return connector;
  };

  return (type: string): ConnectorLike | null => {
    if (type === 'gdrive') {
      if (!ragGdrive) return null;
      return withRateLimiter(new ragGdrive.GDriveConnector()) as unknown as ConnectorLike;
    }
    if (type === 'gsheets') {
      if (!ragGsheets) return null;
      return withRateLimiter(new ragGsheets.GSheetsConnector()) as unknown as ConnectorLike;
    }
    if (type === 'notion') {
      if (!ragNotion) return null;
      return withRateLimiter(new ragNotion.NotionConnector()) as unknown as ConnectorLike;
    }
    if (type === 'sharepoint') {
      if (!ragMicrosoft) return null;
      return withRateLimiter(new ragMicrosoft.SharePointConnector()) as unknown as ConnectorLike;
    }
    if (!ragConnectors) return null;
    if (type === 'local') {
      // No rate limit needed — local filesystem has no upstream quota.
      return new ragConnectors.LocalFolderConnector() as unknown as ConnectorLike;
    }
    if (type === 's3') {
      return withRateLimiter(new ragConnectors.S3Connector()) as unknown as ConnectorLike;
    }
    if (type === 'http') {
      return withRateLimiter(new ragConnectors.HttpConnector()) as unknown as ConnectorLike;
    }
    return null;
  };
}
