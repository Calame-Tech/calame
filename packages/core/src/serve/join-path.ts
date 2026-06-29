import type { Relation } from '../introspect/types.js';

export interface JoinHop {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

/**
 * BFS sur le graphe non-orienté des FK pour trouver le chemin le plus court
 * de `from` à `to` en maximum `maxDepth` arêtes.
 * Chaque `Relation` est traitée comme une arête bidirectionnelle.
 * Retourne null si aucun chemin n'existe dans la limite.
 */
export function findJoinPath(
  from: string,
  to: string,
  relations: Relation[],
  maxDepth = 3,
): JoinHop[] | null {
  if (from === to) return [];

  // Build adjacency list (bidirectional)
  const adj = new Map<string, Array<JoinHop>>();
  for (const r of relations) {
    if (!adj.has(r.fromTable)) adj.set(r.fromTable, []);
    if (!adj.has(r.toTable)) adj.set(r.toTable, []);
    adj.get(r.fromTable)!.push({
      fromTable: r.fromTable,
      fromColumn: r.fromColumn,
      toTable: r.toTable,
      toColumn: r.toColumn,
    });
    adj.get(r.toTable)!.push({
      fromTable: r.toTable,
      fromColumn: r.toColumn,
      toTable: r.fromTable,
      toColumn: r.fromColumn,
    });
  }

  // BFS
  const queue: Array<{ table: string; path: JoinHop[] }> = [{ table: from, path: [] }];
  const visited = new Set<string>([from]);

  while (queue.length > 0) {
    const { table, path } = queue.shift()!;
    if (path.length >= maxDepth) continue;

    for (const hop of adj.get(table) ?? []) {
      if (visited.has(hop.toTable)) continue;
      const newPath = [...path, hop];
      if (hop.toTable === to) return newPath;
      visited.add(hop.toTable);
      queue.push({ table: hop.toTable, path: newPath });
    }
  }

  return null;
}

/**
 * Retourne toutes les tables atteignables depuis au moins une autre table
 * en ≤ maxDepth hops dans les relations.
 * Utilisé pour construire le Set `joinable` exposé au LLM.
 */
export function computeTransitiveClosure(
  tableNames: string[],
  relations: Relation[],
  maxDepth = 3,
): Set<string> {
  // Build adjacency list (bidirectional)
  const adj = new Map<string, Array<{ to: string }>>();
  for (const r of relations) {
    if (!adj.has(r.fromTable)) adj.set(r.fromTable, []);
    if (!adj.has(r.toTable)) adj.set(r.toTable, []);
    adj.get(r.fromTable)!.push({ to: r.toTable });
    adj.get(r.toTable)!.push({ to: r.fromTable });
  }

  const reachable = new Set<string>();
  for (const name of tableNames) {
    const visited = new Set<string>([name]);
    const q: Array<{ t: string; depth: number }> = [{ t: name, depth: 0 }];
    while (q.length > 0) {
      const { t, depth } = q.shift()!;
      if (depth >= maxDepth) continue;
      for (const { to } of adj.get(t) ?? []) {
        if (!visited.has(to)) {
          visited.add(to);
          q.push({ t: to, depth: depth + 1 });
        }
      }
    }
    // If this table can reach at least one other table, both are joinable
    if (visited.size > 1) {
      for (const t of visited) {
        reachable.add(t);
      }
    }
  }
  return reachable;
}
