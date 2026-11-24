import type { GEdge, GNode, Graph } from './Graph';

export type EdgeCost<E> = (e: E, from: number, to: number) => number;

export interface Tree {
  dist: number[];
  prev: number[];
}

/**
 * Dijkstra from one source to every node. `passable` restricts which nodes may be *expanded through*;
 * an impassable node can still be reached as an endpoint, which is how "walk to an unowned node next
 * to my network" is expressed. O(n^2) on purpose: networks here are 10 to 20 nodes.
 */
export function shortestTree<N extends GNode, E extends GEdge>(
  g: Graph<N, E>,
  from: number,
  cost: EdgeCost<E>,
  passable?: (id: number) => boolean,
): Tree {
  const n = g.nodes.length;
  const dist: number[] = new Array<number>(n).fill(Infinity);
  const prev: number[] = new Array<number>(n).fill(-1);
  const done: boolean[] = new Array<boolean>(n).fill(false);
  dist[from] = 0;
  for (;;) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!done[i] && dist[i]! < best) {
        best = dist[i]!;
        u = i;
      }
    }
    if (u < 0) break;
    done[u] = true;
    if (u !== from && passable && !passable(u)) continue;
    for (const e of g.edgesOf(u)) {
      const v = g.other(e, u);
      if (done[v]) continue;
      const nd = dist[u]! + cost(e, u, v);
      if (nd < dist[v]!) {
        dist[v] = nd;
        prev[v] = u;
      }
    }
  }
  return { dist, prev };
}

export function pathFromTree(t: Tree, from: number, to: number): number[] | null {
  if (!Number.isFinite(t.dist[to])) return null;
  const path: number[] = [to];
  let cur = to;
  while (cur !== from) {
    cur = t.prev[cur]!;
    if (cur < 0) return null;
    path.push(cur);
  }
  return path.reverse();
}

export interface PathResult {
  path: number[];
  cost: number;
}

export function dijkstra<N extends GNode, E extends GEdge>(
  g: Graph<N, E>,
  from: number,
  to: number,
  cost: EdgeCost<E>,
  passable?: (id: number) => boolean,
): PathResult | null {
  const t = shortestTree(g, from, cost, passable);
  const path = pathFromTree(t, from, to);
  return path ? { path, cost: t.dist[to]! } : null;
}

/** Nodes reachable from `from`, entering only nodes for which `passable` is true. */
export function reachable<N extends GNode, E extends GEdge>(
  g: Graph<N, E>,
  from: number,
  passable: (id: number) => boolean = () => true,
): Set<number> {
  const seen = new Set<number>([from]);
  const queue = [from];
  while (queue.length) {
    const u = queue.pop()!;
    for (const v of g.neighbors(u)) {
      if (seen.has(v) || !passable(v)) continue;
      seen.add(v);
      queue.push(v);
    }
  }
  return seen;
}
