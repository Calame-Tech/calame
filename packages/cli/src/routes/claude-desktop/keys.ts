/**
 * Naming convention for the `mcpServers` key Calame writes into
 * `claude_desktop_config.json`: `calame-<profileName>` for the default
 * tenant, `calame-<tenantId>-<profileName>` otherwise.
 */

import { DEFAULT_TENANT_ID } from '../../tenancy.js';

export const CALAME_SERVER_KEY_PREFIX = 'calame-';

export function buildServerKey(profileName: string, tenantId: string = DEFAULT_TENANT_ID): string {
  if (tenantId === DEFAULT_TENANT_ID) {
    return `${CALAME_SERVER_KEY_PREFIX}${profileName}`;
  }
  return `${CALAME_SERVER_KEY_PREFIX}${tenantId}-${profileName}`;
}
