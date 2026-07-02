// Lazy-loads the EE RAG packages so the CLI works when they are absent
// (apache-only install). `@calame-ee/rag-core` is mandatory — when it is
// missing RAG is disabled entirely. The connector packages are each optional:
// when absent their source types fall through `resolveConnector` and the route
// layer answers 501.

import type { RagLogger } from './types.js';

/**
 * The set of EE modules the runtime wires together. `ragCore` is always
 * present (its absence is reported as a `null` result from `loadEeModules`);
 * every connector package is `null` when not installed.
 */
export interface EeModules {
  ragCore: typeof import('@calame-ee/rag-core');
  ragConnectors: typeof import('@calame-ee/rag-connectors') | null;
  ragGdrive: typeof import('@calame-ee/rag-gdrive') | null;
  ragGsheets: typeof import('@calame-ee/rag-gsheets') | null;
  ragNotion: typeof import('@calame-ee/rag-notion') | null;
  ragMicrosoft: typeof import('@calame-ee/rag-microsoft') | null;
}

/**
 * Lazy-load the EE RAG packages. Returns `null` when the core package
 * (`@calame-ee/rag-core`) is absent — the caller then disables RAG and sets
 * `state.ragDisabledReason`. Each optional connector package degrades to `null`
 * (with a warning) without failing the load.
 */
export async function loadEeModules(log: RagLogger): Promise<EeModules | null> {
  // Lazy-load EE packages. rag-core missing → RAG is disabled silently.
  type RagCoreModule = typeof import('@calame-ee/rag-core');
  let ragCore: RagCoreModule;
  try {
    ragCore = await import('@calame-ee/rag-core');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.info(`RAG features disabled (@calame-ee/rag-core not available): ${msg}`);
    return null;
  }

  // The connectors package provides concrete DocumentSourceConnector
  // implementations (LocalFolderConnector for now). Pre-load it so the route
  // layer can synchronously resolve a connector for a given source type.
  type RagConnectorsModule = typeof import('@calame-ee/rag-connectors');
  let ragConnectors: RagConnectorsModule | null = null;
  try {
    ragConnectors = await import('@calame-ee/rag-connectors');
  } catch {
    log.warn('@calame-ee/rag-connectors not installed — local source sync will return 501.');
  }

  // Google Drive connector lives in its own EE package because the `googleapis`
  // dep is heavy (~100MB with types). Pre-load it conditionally so apache-only
  // installs (or installs that don't need GDrive) skip the cost. When the
  // package is absent, `gdrive` sources will fall through `resolveConnector`
  // and the route layer answers 501.
  type RagGdriveModule = typeof import('@calame-ee/rag-gdrive');
  let ragGdrive: RagGdriveModule | null = null;
  try {
    ragGdrive = await import('@calame-ee/rag-gdrive');
  } catch {
    log.warn(
      '@calame-ee/rag-gdrive not installed — gdrive sources will be unavailable. ' +
        'Install the package and restart to enable Google Drive ingestion.',
    );
  }

  // Google Sheets connector lives in its own EE package — it shares the
  // `googleapis` dep with rag-gdrive but exists separately so admins can pick
  // per-tab granularity + header-aware CSV chunking instead of gdrive's
  // export-the-whole-workbook behaviour. Same lazy-load pattern as the other
  // EE connectors.
  type RagGsheetsModule = typeof import('@calame-ee/rag-gsheets');
  let ragGsheets: RagGsheetsModule | null = null;
  try {
    ragGsheets = await import('@calame-ee/rag-gsheets');
  } catch {
    log.warn(
      '@calame-ee/rag-gsheets not installed — gsheets sources will be unavailable. ' +
        'Install the package and restart to enable Google Sheets ingestion.',
    );
  }

  // Notion connector also lives in its own EE package (separate `@notionhq/client`
  // dep). Same lazy-load pattern as gdrive: when the package is absent, `notion`
  // sources fall through `resolveConnector` and the route layer answers 501.
  type RagNotionModule = typeof import('@calame-ee/rag-notion');
  let ragNotion: RagNotionModule | null = null;
  try {
    ragNotion = await import('@calame-ee/rag-notion');
  } catch {
    log.warn(
      '@calame-ee/rag-notion not installed — notion sources will be unavailable. ' +
        'Install the package and restart to enable Notion ingestion.',
    );
  }

  // Microsoft 365 connectors (SharePoint today, OneDrive / Outlook / Teams
  // potentially later) live in @calame-ee/rag-microsoft. Pulls in the Graph
  // SDK + @azure/identity (~20MB of types); lazy-loaded so apache-only
  // installs that don't need M365 skip the cost. When absent, `sharepoint`
  // sources fall through resolveConnector and the route layer answers 501.
  type RagMicrosoftModule = typeof import('@calame-ee/rag-microsoft');
  let ragMicrosoft: RagMicrosoftModule | null = null;
  try {
    ragMicrosoft = await import('@calame-ee/rag-microsoft');
  } catch {
    log.warn(
      '@calame-ee/rag-microsoft not installed — sharepoint sources will be unavailable. ' +
        'Install the package and restart to enable Microsoft 365 ingestion.',
    );
  }

  return { ragCore, ragConnectors, ragGdrive, ragGsheets, ragNotion, ragMicrosoft };
}
