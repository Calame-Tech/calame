// Persistence helpers for the Data Configurations graph layout order.
// Only node ids are persisted (per layer); the graph reconciles the saved
// arrangement against the live model on load — stale ids are dropped and new
// ids slot in at their computed (barycenter) position. Pure logic is kept
// separate from storage so it can be unit-tested directly.

export interface GraphOrder {
  sources: string[];
  configs: string[];
  servers: string[];
}

export const GRAPH_ORDER_STORAGE_KEY = 'calame.configGraph.order.v1';

/**
 * Merges a saved id order with the freshly computed (barycenter) order:
 * - ids unknown to the live model are dropped;
 * - ids missing from the saved order are inserted right after their closest
 *   preceding computed neighbor already present, so new resources appear at
 *   their computed position instead of being dumped at the end.
 */
export function reconcileOrder(
  saved: readonly string[] | undefined,
  computed: readonly string[],
): string[] {
  if (!saved || saved.length === 0) return [...computed];
  const known = new Set(computed);
  const result = saved.filter((id) => known.has(id));
  const present = new Set(result);
  computed.forEach((id, i) => {
    if (present.has(id)) return;
    let insertAt = 0;
    for (let j = i - 1; j >= 0; j--) {
      const idx = result.indexOf(computed[j]);
      if (idx >= 0) {
        insertAt = idx + 1;
        break;
      }
    }
    result.splice(insertAt, 0, id);
    present.add(id);
  });
  return result;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Loads the saved order, or null when absent/corrupt/mis-shaped. */
export function loadGraphOrder(key = GRAPH_ORDER_STORAGE_KEY): GraphOrder | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const o = parsed as Record<string, unknown>;
    if (!isStringArray(o.sources) || !isStringArray(o.configs) || !isStringArray(o.servers)) {
      return null;
    }
    return { sources: o.sources, configs: o.configs, servers: o.servers };
  } catch {
    return null;
  }
}

export function saveGraphOrder(order: GraphOrder, key = GRAPH_ORDER_STORAGE_KEY): void {
  try {
    localStorage.setItem(key, JSON.stringify(order));
  } catch {
    // Storage full / unavailable — layout persistence is best-effort.
  }
}

export function clearGraphOrder(key = GRAPH_ORDER_STORAGE_KEY): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}
