// Graph view of the data pipeline: MCP servers (top row), Data Configurations
// (middle), sources (bottom), with curved links tracing how sources flow to
// servers. Layout is deterministic — regular slots per row, rows ordered by
// barycenter to minimize link crossings by default. Dragging a node
// horizontally reorders it within its layer (the move sticks and is persisted
// to localStorage as id lists; "Reset layout" restores the barycenter order);
// vertical position always snaps back to the layer row. Hovering or focusing
// a node highlights its full lineage (upstream + downstream); a click pins
// it. Positions are driven imperatively (transform/path updates on refs) so
// drag/spring never re-render the React tree.

import { useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState } from './ui/index.js';
import GraphDetailChip, { type ChipRow } from './GraphDetailChip.js';
import { apiFetch } from '../lib/api.js';
import {
  getConfigurationColumnMasking,
  getConfigurationTableNames,
} from '../lib/configuration-accessors.js';
import {
  clearGraphOrder,
  loadGraphOrder,
  reconcileOrder,
  saveGraphOrder,
} from '../lib/graph-order.js';
import type {
  Configuration,
  NamedConnection,
  Profile,
  ServeStatus,
  UserEntry,
} from '../types/schema.js';

interface ConfigGraphViewProps {
  connections: NamedConnection[];
  configurations: Configuration[];
  profiles: Profile[];
  serveStatus: ServeStatus;
}

type NodeKind = 'source' | 'config' | 'server';

interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  sub: string;
  /** Source dot color (sources only). */
  color?: string;
  stopped?: boolean;
  /** 0 = sources (bottom), 1 = configs, 2 = servers (top). */
  layer: 0 | 1 | 2;
}

interface NodePos {
  x: number;
  y: number;
  vx: number;
  vy: number;
  sx: number;
  sy: number;
}

const SOURCE_COLORS: Record<string, string> = {
  postgresql: '#748FFC',
  mysql: '#FDBA74',
  sqlite: '#6EE7B7',
  document: '#E5E7EB',
  api: '#C084FC',
  mcp: '#E0A45E',
  unknown: '#6B7280',
};

const LAYER_Y = [0.87, 0.52, 0.15];

function slotX(width: number, index: number, count: number): number {
  return width * (count === 1 ? 0.5 : 0.1 + (0.8 * index) / (count - 1));
}

export default function ConfigGraphView({
  connections,
  configurations,
  profiles,
  serveStatus,
}: ConfigGraphViewProps) {
  // ---- graph model (deterministic, from props) ----------------------------
  const {
    nodes,
    edges,
    order: computedOrder,
    chips,
  } = useMemo(() => {
    const connByName = new Map(connections.map((c) => [c.name, c]));

    // Source ids = SQL connections plus any extra source ids referenced by
    // configurations (knowledge bases / api / mcp sources).
    const sourceKinds = new Map<string, string>();
    for (const conn of connections) sourceKinds.set(conn.name, conn.databaseType);
    for (const cfg of configurations) {
      for (const id of cfg.sources ?? []) {
        if (!sourceKinds.has(id)) sourceKinds.set(id, cfg.scopes?.[id]?.kind ?? 'unknown');
      }
    }

    const edges: Array<[string, string]> = [];
    for (const cfg of configurations) {
      for (const id of cfg.sources ?? []) edges.push([`s:${id}`, `c:${cfg.name}`]);
    }
    for (const p of profiles) {
      for (const cfgName of p.configurations ?? []) {
        if (configurations.some((c) => c.name === cfgName)) {
          edges.push([`c:${cfgName}`, `m:${p.name}`]);
        }
      }
    }

    // Barycenter ordering: servers keep their given order; configs order by
    // the mean slot of the servers mounting them; sources by the mean slot of
    // the configs using them. Unlinked items go last, ties broken by index.
    const serverOrder = profiles.map((p) => `m:${p.name}`);
    const serverSlot = new Map(serverOrder.map((id, i) => [id, i]));

    const configOrder = configurations
      .map((cfg, idx) => {
        const slots = edges
          .filter(([a]) => a === `c:${cfg.name}`)
          .map(([, b]) => serverSlot.get(b) ?? 0);
        const bary = slots.length > 0 ? slots.reduce((a, b) => a + b, 0) / slots.length : 1e9 + idx;
        return { id: `c:${cfg.name}`, bary, idx };
      })
      .sort((a, b) => a.bary - b.bary || a.idx - b.idx)
      .map((e) => e.id);
    const configSlot = new Map(configOrder.map((id, i) => [id, i]));

    const sourceIds = Array.from(sourceKinds.keys());
    const sourceOrder = sourceIds
      .map((sid, idx) => {
        const slots = edges
          .filter(([a]) => a === `s:${sid}`)
          .map(([, b]) => configSlot.get(b) ?? 0);
        const bary = slots.length > 0 ? slots.reduce((a, b) => a + b, 0) / slots.length : 1e9 + idx;
        return { id: `s:${sid}`, bary, idx };
      })
      .sort((a, b) => a.bary - b.bary || a.idx - b.idx)
      .map((e) => e.id);

    // Nodes + detail chip content.
    const nodes: GraphNode[] = [];
    const chips = new Map<string, { kind: string; title: string; rows: ChipRow[] }>();

    for (const sid of sourceIds) {
      const kind = sourceKinds.get(sid) ?? 'unknown';
      const conn = connByName.get(sid);
      const usedBy = configurations.filter((c) => (c.sources ?? []).includes(sid)).length;
      nodes.push({
        id: `s:${sid}`,
        kind: 'source',
        label: conn?.label || sid,
        sub: kind === 'document' ? 'knowledge' : kind,
        color: SOURCE_COLORS[kind] ?? SOURCE_COLORS.unknown,
        layer: 0,
      });
      chips.set(`s:${sid}`, {
        kind: `source · ${kind === 'document' ? 'knowledge base' : kind}`,
        title: conn?.label || sid,
        rows: [
          { k: 'Type', v: kind },
          { k: 'Used by', v: `${usedBy} configuration${usedBy !== 1 ? 's' : ''}` },
        ],
      });
    }

    for (const cfg of configurations) {
      const srcCount = (cfg.sources ?? []).length;
      const tables = getConfigurationTableNames(cfg).length;
      const masked = Object.values(getConfigurationColumnMasking(cfg)).reduce(
        (sum, cols) => sum + Object.values(cols).filter((m) => m.maskingMode !== 'none').length,
        0,
      );
      const mountedBy = profiles.filter((p) => p.configurations?.includes(cfg.name));
      nodes.push({
        id: `c:${cfg.name}`,
        kind: 'config',
        label: cfg.label || cfg.name,
        sub: `${srcCount} src${masked > 0 ? ` · ${masked} masked` : ''}`,
        layer: 1,
      });
      const rows: ChipRow[] = [
        {
          k: 'Sources',
          v: (cfg.sources ?? []).map((sid) => connByName.get(sid)?.label || sid).join(' · ') || '—',
        },
        { k: 'Tables', v: String(tables) },
      ];
      if (masked > 0) rows.push({ k: 'Masked columns', v: String(masked), tone: 'pii' });
      rows.push({
        k: 'Mounted by',
        v: mountedBy.map((p) => p.label || p.name).join(' · ') || '—',
      });
      chips.set(`c:${cfg.name}`, {
        kind: 'data configuration',
        title: cfg.label || cfg.name,
        rows,
      });
    }

    for (const p of profiles) {
      const active = serveStatus.profileStatuses?.[p.name]?.active === true;
      const cfgCount = (p.configurations ?? []).length;
      nodes.push({
        id: `m:${p.name}`,
        kind: 'server',
        label: p.label || p.name,
        sub: `${p.authMode ?? 'open'} · ${active ? 'ACTIVE' : 'STOPPED'}`,
        stopped: !active,
        layer: 2,
      });
      chips.set(`m:${p.name}`, {
        kind: `mcp server · ${active ? 'active' : 'stopped'}`,
        title: p.label || p.name,
        rows: [
          { k: 'Auth', v: p.authMode ?? 'open' },
          { k: 'Status', v: active ? 'ACTIVE' : 'STOPPED', tone: active ? 'ok' : undefined },
          { k: 'Configurations', v: String(cfgCount) },
        ],
      });
    }

    const order: Record<number, string[]> = { 0: sourceOrder, 1: configOrder, 2: serverOrder };
    return { nodes, edges, order, chips };
  }, [connections, configurations, profiles, serveStatus.profileStatuses]);

  // ---- imperative position/render machinery --------------------------------
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const nodeEls = useRef(new Map<string, SVGGElement>());
  const edgeEls = useRef(new Map<number, SVGPathElement>());
  const posRef = useRef(new Map<string, NodePos>());
  const draggingRef = useRef<string | null>(null);
  const animatingRef = useRef(new Set<string>());
  // Distinguish a real drag from a click: pointer travel beyond a small
  // threshold marks the gesture as a drag (reorders on release, suppresses
  // the click-to-pin that follows pointerup).
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const didDragRef = useRef(false);

  const reduceMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const [ready, setReady] = useState(false);
  const [settled, setSettled] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [pinnedId, setPinnedId] = useState<string | null>(null);

  // Drop pinned/focused ids that no longer exist (e.g. the pinned resource
  // was deleted) — otherwise the graph stays dimmed with nothing highlighted.
  useEffect(() => {
    const ids = new Set(nodes.map((n) => n.id));
    setPinnedId((prev) => (prev !== null && !ids.has(prev) ? null : prev));
    setFocusedId((prev) => (prev !== null && !ids.has(prev) ? null : prev));
  }, [nodes]);

  // ---- persistent per-layer order ------------------------------------------
  // Barycenter is the default; a saved arrangement (drag-reorder) overrides
  // it. Only ids are persisted — on load and on every model change the saved
  // order is reconciled: stale ids dropped, new ids inserted at their
  // computed position.
  const [order, setOrder] = useState<Record<0 | 1 | 2, string[]>>(() => {
    const saved = loadGraphOrder();
    if (!saved) return computedOrder;
    return {
      0: reconcileOrder(saved.sources, computedOrder[0]),
      1: reconcileOrder(saved.configs, computedOrder[1]),
      2: reconcileOrder(saved.servers, computedOrder[2]),
    };
  });
  const [hasSavedOrder, setHasSavedOrder] = useState(() => loadGraphOrder() !== null);
  // When true, the next layout pass springs displaced nodes to their new
  // slots instead of snapping them (set by reorder commits and reset).
  const springNextLayoutRef = useRef(false);

  useEffect(() => {
    setOrder((prev) => {
      const next: Record<0 | 1 | 2, string[]> = {
        0: reconcileOrder(prev[0], computedOrder[0]),
        1: reconcileOrder(prev[1], computedOrder[1]),
        2: reconcileOrder(prev[2], computedOrder[2]),
      };
      const same = ([0, 1, 2] as const).every(
        (l) => next[l].length === prev[l].length && next[l].every((id, i) => id === prev[l][i]),
      );
      return same ? prev : next;
    });
  }, [computedOrder]);

  const render = () => {
    for (const [i, path] of edgeEls.current) {
      const [aId, bId] = edges[i];
      const a = posRef.current.get(aId);
      const b = posRef.current.get(bId);
      if (!a || !b) continue;
      const my = (a.y + b.y) / 2;
      path.setAttribute('d', `M${a.x},${a.y} C${a.x},${my} ${b.x},${my} ${b.x},${b.y}`);
    }
    for (const [id, el] of nodeEls.current) {
      const p = posRef.current.get(id);
      if (p) el.setAttribute('transform', `translate(${p.x},${p.y})`);
    }
  };

  const layout = (spring = false) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const toSpring: string[] = [];
    for (const layer of [0, 1, 2] as const) {
      const ids = order[layer];
      ids.forEach((id, i) => {
        const p = posRef.current.get(id);
        if (!p) return;
        p.sx = slotX(rect.width, i, ids.length);
        p.sy = LAYER_Y[layer] * rect.height;
        if (draggingRef.current === id || animatingRef.current.has(id)) return;
        if (spring && (Math.abs(p.x - p.sx) > 0.5 || Math.abs(p.y - p.sy) > 0.5)) {
          toSpring.push(id);
        } else {
          p.x = p.sx;
          p.y = p.sy;
        }
      });
    }
    render();
    // Spring displaced nodes to their new slots (reduced motion: springBack
    // places them instantly).
    for (const id of toSpring) springBack(id);
  };

  // Keep the latest layout closure reachable from the mount-only resize
  // listener (the model — and thus `order` — can change between resizes).
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // (Re)build the position map when the model or the order changes, then lay
  // out — springing displaced nodes when the change came from a reorder.
  useEffect(() => {
    const next = new Map<string, NodePos>();
    for (const n of nodes) {
      next.set(n.id, posRef.current.get(n.id) ?? { x: 0, y: 0, vx: 0, vy: 0, sx: 0, sy: 0 });
    }
    posRef.current = next;
    layout(springNextLayoutRef.current);
    springNextLayoutRef.current = false;
  }, [nodes, edges, order]);

  // Resize handling + staged reveal on mount.
  useEffect(() => {
    layoutRef.current();
    const onResize = () => layoutRef.current();
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined' && wrapRef.current) {
      ro = new ResizeObserver(onResize);
      ro.observe(wrapRef.current);
    } else {
      window.addEventListener('resize', onResize);
    }
    const raf = requestAnimationFrame(() => setReady(true));
    const settleTimer = setTimeout(() => setSettled(true), reduceMotion ? 0 : 950);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', onResize);
      cancelAnimationFrame(raf);
      clearTimeout(settleTimer);
    };
  }, []);

  // Spring back to slot, only for the released node.
  const springBack = (id: string) => {
    const p = posRef.current.get(id);
    if (!p) return;
    if (reduceMotion) {
      p.x = p.sx;
      p.y = p.sy;
      render();
      return;
    }
    animatingRef.current.add(id);
    const step = () => {
      if (draggingRef.current === id || !posRef.current.has(id)) {
        animatingRef.current.delete(id);
        return;
      }
      p.vx = (p.vx + (p.sx - p.x) * 0.09) * 0.78;
      p.vy = (p.vy + (p.sy - p.y) * 0.09) * 0.78;
      p.x += p.vx;
      p.y += p.vy;
      render();
      if (
        Math.abs(p.sx - p.x) > 0.4 ||
        Math.abs(p.sy - p.y) > 0.4 ||
        Math.abs(p.vx) > 0.2 ||
        Math.abs(p.vy) > 0.2
      ) {
        requestAnimationFrame(step);
      } else {
        p.x = p.sx;
        p.y = p.sy;
        animatingRef.current.delete(id);
        render();
      }
    };
    requestAnimationFrame(step);
  };

  // Commit a drag as a reorder: nearest slot from the drop x-position, splice
  // into the layer's order, persist, and let the layout effect spring every
  // displaced node to its new slot. Vertical position always snaps back to
  // the layer row (sy never changes with the drop y).
  const commitReorder = (node: GraphNode) => {
    const rect = svgRef.current?.getBoundingClientRect();
    const p = posRef.current.get(node.id);
    const ids = order[node.layer];
    const from = ids.indexOf(node.id);
    if (!rect || rect.width === 0 || !p || from < 0 || ids.length <= 1) {
      springBack(node.id);
      return;
    }
    let to = 0;
    let bd = Infinity;
    for (let j = 0; j < ids.length; j++) {
      const d = Math.abs(p.x - slotX(rect.width, j, ids.length));
      if (d < bd) {
        bd = d;
        to = j;
      }
    }
    if (to === from) {
      springBack(node.id);
      return;
    }
    const nextIds = [...ids];
    nextIds.splice(from, 1);
    nextIds.splice(to, 0, node.id);
    const next = { ...order, [node.layer]: nextIds };
    springNextLayoutRef.current = true;
    setOrder(next);
    saveGraphOrder({ sources: next[0], configs: next[1], servers: next[2] });
    setHasSavedOrder(true);
  };

  // Clear the saved arrangement and spring back to the barycenter order.
  const resetLayout = () => {
    clearGraphOrder();
    setHasSavedOrder(false);
    springNextLayoutRef.current = true;
    setOrder(computedOrder);
  };

  // ---- directional lineage (upstream + downstream of a node) ---------------
  const lineage = (id: string) => {
    const down = new Set([id]);
    const up = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [a, b] of edges) {
        if (down.has(a) && !down.has(b)) {
          down.add(b);
          grew = true;
        }
        if (up.has(b) && !up.has(a)) {
          up.add(a);
          grew = true;
        }
      }
    }
    return { down, up };
  };

  const activeId = focusedId ?? pinnedId;
  const { hotNodes, hotEdges } = useMemo(() => {
    if (!activeId) return { hotNodes: new Set<string>(), hotEdges: new Set<number>() };
    const { down, up } = lineage(activeId);
    const hotNodes = new Set([...down, ...up]);
    const hotEdges = new Set<number>();
    edges.forEach(([a, b], i) => {
      if ((down.has(a) && down.has(b)) || (up.has(a) && up.has(b))) hotEdges.add(i);
    });
    return { hotNodes, hotEdges };
  }, [activeId, edges]);

  const chip = activeId ? chips.get(activeId) : undefined;

  // ---- users granted on a pinned server -------------------------------------
  // Fetched lazily on the first pin of each server node, cached in a ref for
  // the component's lifetime; state only mirrors the cache to trigger renders.
  const usersCacheRef = useRef(new Map<string, UserEntry[]>());
  const [usersByProfile, setUsersByProfile] = useState<Record<string, UserEntry[]>>({});
  useEffect(() => {
    if (!pinnedId || !pinnedId.startsWith('m:')) return;
    const profileName = pinnedId.slice(2);
    if (usersCacheRef.current.has(profileName)) return;
    let cancelled = false;
    (async () => {
      let users: UserEntry[] = [];
      try {
        const res = await apiFetch(`/api/users?profileName=${encodeURIComponent(profileName)}`, {
          credentials: 'include',
        });
        const data = await res.json();
        if (data.success && Array.isArray(data.users)) users = data.users as UserEntry[];
      } catch {
        // Endpoint unavailable — show the empty state rather than an error.
      }
      usersCacheRef.current.set(profileName, users);
      if (!cancelled) setUsersByProfile((prev) => ({ ...prev, [profileName]: users }));
    })();
    return () => {
      cancelled = true;
    };
  }, [pinnedId]);

  // Users section only for the pinned server's own chip (not while hovering
  // another node): loaded list, or 'loading' while the fetch is in flight.
  const pinnedServerName =
    activeId && activeId === pinnedId && activeId.startsWith('m:') ? activeId.slice(2) : undefined;
  const chipUsers =
    pinnedServerName !== undefined
      ? (usersByProfile[pinnedServerName] ?? ('loading' as const))
      : undefined;

  if (nodes.length === 0) {
    return (
      <EmptyState
        title="Nothing to graph yet"
        description="Add a source, a Data Configuration or an MCP server to see how data flows."
      />
    );
  }

  const svgClass = [
    'cfg-graph w-full h-full block',
    ready ? 'ready' : '',
    settled ? 'settled' : '',
    activeId ? 'focused' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div ref={wrapRef} className="relative w-full h-[560px] min-h-[420px]">
      <svg
        ref={svgRef}
        className={svgClass}
        role="application"
        aria-label="Interactive graph of sources, data configurations and MCP servers"
        onClick={() => setPinnedId(null)}
      >
        {edges.map(([a, b], i) => (
          <path
            key={`${a}->${b}`}
            className={`lk ${hotEdges.has(i) ? 'hot' : ''}`}
            ref={(el) => {
              if (el) edgeEls.current.set(i, el);
              else edgeEls.current.delete(i);
            }}
          />
        ))}
        {nodes.map((n) => (
          <g
            key={n.id}
            className={`nd l${n.layer} ${n.stopped ? 'stopped' : ''} ${hotNodes.has(n.id) ? 'hot' : ''}`}
            tabIndex={0}
            role="button"
            aria-label={`${n.kind} ${n.label}`}
            ref={(el) => {
              if (el) nodeEls.current.set(n.id, el);
              else nodeEls.current.delete(n.id);
            }}
            onPointerDown={(e) => {
              draggingRef.current = n.id;
              dragStartRef.current = { x: e.clientX, y: e.clientY };
              didDragRef.current = false;
              const p = posRef.current.get(n.id);
              if (p) {
                p.vx = 0;
                p.vy = 0;
              }
              e.currentTarget.setPointerCapture(e.pointerId);
              e.preventDefault();
            }}
            onPointerMove={(e) => {
              if (draggingRef.current !== n.id) return;
              const start = dragStartRef.current;
              if (start && Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) > 4) {
                didDragRef.current = true;
              }
              const rect = svgRef.current?.getBoundingClientRect();
              const p = posRef.current.get(n.id);
              if (!rect || !p) return;
              p.x = e.clientX - rect.left;
              p.y = e.clientY - rect.top;
              render();
            }}
            onPointerUp={() => {
              if (draggingRef.current === n.id) {
                draggingRef.current = null;
                if (didDragRef.current) commitReorder(n);
                else springBack(n.id);
              }
            }}
            onPointerCancel={() => {
              // A cancelled touch gesture (scroll takeover, palm rejection…)
              // must release the drag too, or the node stays excluded from
              // layout() forever. Cancelled gestures never reorder.
              if (draggingRef.current === n.id) {
                draggingRef.current = null;
                didDragRef.current = false;
                springBack(n.id);
              }
            }}
            onMouseEnter={() => setFocusedId(n.id)}
            onMouseLeave={() => setFocusedId(null)}
            onFocus={() => setFocusedId(n.id)}
            onBlur={() => setFocusedId(null)}
            onClick={(e) => {
              e.stopPropagation();
              // A drag is not a pin-toggle.
              if (didDragRef.current) {
                didDragRef.current = false;
                return;
              }
              setPinnedId((prev) => (prev === n.id ? null : n.id));
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setPinnedId((prev) => (prev === n.id ? null : n.id));
              }
            }}
          >
            {n.kind === 'source' && <circle className="shape" r="10" fill={n.color} />}
            {n.kind === 'config' && (
              <rect
                className="shape"
                x="-9"
                y="-9"
                width="18"
                height="18"
                rx="4"
                transform="rotate(45)"
                fill="rgb(11 16 27)"
                stroke="rgb(var(--color-os-400))"
                strokeWidth="1.6"
              />
            )}
            {n.kind === 'server' && (
              <rect
                className="shape"
                x="-48"
                y="-16"
                width="96"
                height="32"
                rx="7"
                fill="rgb(11 16 27)"
                stroke={n.stopped ? 'rgb(75 85 99)' : 'rgb(var(--color-os-400))'}
                strokeWidth="1.6"
              />
            )}
            <text
              y={n.kind === 'server' ? 4 : n.kind === 'config' ? 30 : 27}
              textAnchor="middle"
              className="font-display pointer-events-none"
              fontSize="12"
              fontWeight="600"
              fill={n.stopped ? 'rgb(107 114 128)' : 'rgb(243 244 246)'}
            >
              {n.label}
            </text>
            <text
              y={n.kind === 'server' ? 30 : n.kind === 'config' ? 43 : 40}
              textAnchor="middle"
              className="font-mono-plex pointer-events-none"
              fontSize="9"
              fill="rgb(75 85 99)"
            >
              {n.sub}
            </text>
          </g>
        ))}
      </svg>

      {/* Legend */}
      <div className="absolute left-4 bottom-4 card-primary rounded-xl px-4 py-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 font-mono-plex text-[11px] text-gray-400">
        <span className="inline-flex items-center gap-1.5">
          <svg width="12" height="12" aria-hidden="true">
            <circle cx="6" cy="6" r="5" fill="#748FFC" />
          </svg>
          source
        </span>
        <span className="inline-flex items-center gap-1.5">
          <svg width="14" height="14" aria-hidden="true">
            <rect
              x="3"
              y="3"
              width="8"
              height="8"
              rx="2"
              fill="rgb(11 16 27)"
              stroke="#748FFC"
              strokeWidth="1.5"
              transform="rotate(45 7 7)"
            />
          </svg>
          data configuration
        </span>
        <span className="inline-flex items-center gap-1.5">
          <svg width="26" height="14" aria-hidden="true">
            <rect
              x="1"
              y="1"
              width="24"
              height="12"
              rx="4"
              fill="rgb(11 16 27)"
              stroke="#748FFC"
              strokeWidth="1.5"
            />
          </svg>
          mcp server
        </span>
        <span>dashed = stopped</span>
      </div>

      {/* Reset layout — only when a dragged arrangement is saved */}
      {hasSavedOrder && (
        <button
          type="button"
          onClick={resetLayout}
          className="absolute top-3 right-3 card-primary rounded-lg px-3 py-1.5 font-mono-plex text-[11px] text-gray-400 hover:text-gray-200 hover:border-white/10 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-os-500/40"
          title="Clear the saved arrangement and restore the computed order"
        >
          Reset layout
        </button>
      )}

      {/* Detail chip */}
      <GraphDetailChip
        chip={chip}
        offsetForReset={hasSavedOrder}
        users={chipUsers}
        profileName={pinnedServerName}
      />
    </div>
  );
}
