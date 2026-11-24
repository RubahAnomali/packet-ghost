import { Rng } from '../../core/math';
import type { NetworkLink, NetworkNode, NodeKind } from '../types';
import { Graph } from './Graph';
import { dijkstra, reachable } from './pathfinding';

export type NetGraph = Graph<NetworkNode, NetworkLink>;

export interface GeneratedNetwork {
  graph: NetGraph;
  entry: number;
  core: number;
  vaults: number[];
  honeypots: number[];
  /** How many candidate topologies were rejected before this one passed validation, plus one. */
  attempts: number;
  seed: number;
  level: number;
}

interface Plan {
  dmz: number;
  adm: number;
  fw: number;
  log: number;
  vault: number;
  hp: number;
}

/** One plan per contract. Later contracts are wider and have more firewalls and decoys. */
const PLANS: Plan[] = [
  { dmz: 2, adm: 1, fw: 1, log: 1, vault: 1, hp: 1 },
  { dmz: 3, adm: 1, fw: 2, log: 1, vault: 1, hp: 1 },
  { dmz: 3, adm: 2, fw: 2, log: 1, vault: 1, hp: 2 },
];

const COL_GAP = 250;
const ROW_GAP = 128;
const LAYERS = 5;

export function generateNetwork(seed: number, level: number): GeneratedNetwork {
  const lv = Math.max(1, Math.min(PLANS.length, level));
  for (let attempt = 0; attempt < 120; attempt++) {
    const built = build(new Rng(seed + attempt * 7919), PLANS[lv - 1]!, lv);
    if (validateNetwork(built.graph, built.entry, built.core, built.vaults) === null) {
      return { ...built, attempts: attempt + 1, seed, level: lv };
    }
  }
  throw new Error(`no valid network for seed ${seed}, level ${lv}`);
}

function shuffle<T>(arr: T[], rng: Rng): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

function build(rng: Rng, plan: Plan, level: number): Omit<GeneratedNetwork, 'attempts' | 'seed' | 'level'> {
  const specs: { kind: NodeKind; layer: number }[] = [{ kind: 'EntryProxy', layer: 0 }];
  const add = (kind: NodeKind, layer: number, n: number): void => {
    for (let i = 0; i < n; i++) specs.push({ kind, layer });
  };
  add('DMZRouter', 1, plan.dmz);
  add('AdminWorkstation', 1, plan.adm);
  add('FirewallGate', 2, plan.fw);
  add('LogServer', 2, plan.log);
  add('AuthVault', 3, plan.vault);
  add('Honeypot', 3, plan.hp);
  add('CoreMainframe', 4, 1);

  // Labels are a shuffled permutation, so an address never hints at depth or type.
  const nums = shuffle(
    Array.from({ length: specs.length - 1 }, (_, i) => i + 2),
    rng,
  );
  const graph: NetGraph = new Graph();
  specs.forEach((s, i) => {
    const n = i === 0 ? 1 : nums[i - 1]!;
    let security = 1;
    if (s.layer >= 3) security++;
    if (level >= 2 && s.layer >= 2 && rng.chance(0.5)) security++;
    if (level >= 3 && s.layer >= 1 && rng.chance(0.3)) security++;
    if (s.kind === 'EntryProxy' || s.kind === 'AdminWorkstation' || s.kind === 'LogServer') security = 1;
    graph.addNode({
      id: i,
      label: `N${String(n).padStart(2, '0')}`,
      kind: s.kind,
      layer: s.layer,
      x: 0,
      y: 0,
      security: Math.min(3, security),
      knowledge: 0,
      owned: false,
      locked: s.kind === 'FirewallGate',
      noiseAcc: 0,
    });
  });

  const idsOf = (k: NodeKind): number[] => graph.nodes.filter((n) => n.kind === k).map((n) => n.id);
  const entry = 0;
  const dmz = idsOf('DMZRouter');
  const adm = idsOf('AdminWorkstation');
  const fw = idsOf('FirewallGate');
  const log = idsOf('LogServer');
  const vaults = idsOf('AuthVault');
  const honeypots = idsOf('Honeypot');
  const core = idsOf('CoreMainframe')[0]!;
  const pick = (a: number[]): number => a[rng.int(0, a.length - 1)]!;

  // Latency and bend are filled in once the layout fixes the link lengths.
  const link = (a: number, b: number): boolean => graph.addEdge({ id: graph.edges.length, a, b, latency: 0.5, bend: 0, alertHeat: 0 });

  // Spanning backbone: every node hangs off something one layer up, so the graph is connected by construction.
  dmz.forEach((d, i) => link(d, i === 0 || rng.chance(0.6) ? entry : pick(dmz.slice(0, i))));
  adm.forEach((a) => link(a, pick(dmz)));
  fw.forEach((f) => link(f, pick(dmz)));
  log.forEach((l) => link(l, rng.chance(0.5) ? pick(dmz) : pick(fw)));
  vaults.forEach((v) => link(v, pick(fw)));
  honeypots.forEach((h) => link(h, pick(fw)));
  link(core, vaults[0]!);

  // Redundant cross-links give the side doors and bypasses that make several routes viable.
  const p = 0.2 + 0.04 * level;
  for (const a of graph.nodes) {
    for (const b of graph.nodes) {
      if (b.id <= a.id || Math.abs(a.layer - b.layer) > 1) continue;
      if (a.id === entry || b.id === core || a.id === core) continue;
      if (a.kind === 'AdminWorkstation' && b.kind === 'AdminWorkstation') continue;
      if (rng.chance(p)) link(a.id, b.id);
    }
  }
  for (const l of log) if (level === 1 || rng.chance(0.8)) link(vaults[0]!, l);
  if (rng.chance(0.7)) link(core, pick(fw));
  for (const h of honeypots) if (rng.chance(0.3)) link(core, h);
  if (fw.length > 1 && rng.chance(0.6)) link(vaults[0]!, pick(fw));

  layout(graph, rng);
  for (const e of graph.edges) {
    const a = graph.nodes[e.a]!;
    const b = graph.nodes[e.b]!;
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    e.latency = 0.28 + d / 520 + rng.range(0, 0.12);
    e.bend = rng.range(-0.16, 0.16);
  }
  return { graph, entry, core, vaults, honeypots };
}

/** Layered drawing: one column per tier, rows ordered by the barycenter of already-placed neighbours. */
function layout(g: NetGraph, rng: Rng): void {
  const y = new Map<number, number>();
  for (let layer = 0; layer < LAYERS; layer++) {
    const ids = g.nodes.filter((n) => n.layer === layer).map((n) => n.id);
    shuffle(ids, rng);
    const bary = (id: number): number => {
      const ys = g.neighbors(id).filter((v) => g.nodes[v]!.layer < layer && y.has(v)).map((v) => y.get(v)!);
      return ys.length ? ys.reduce((s, v) => s + v, 0) / ys.length : 0;
    };
    if (layer > 0) ids.sort((a, b) => bary(a) - bary(b));
    ids.forEach((id, i) => {
      const n = g.nodes[id]!;
      n.x = (layer - 2) * COL_GAP + rng.range(-16, 16);
      n.y = (i - (ids.length - 1) / 2) * ROW_GAP + rng.range(-20, 20);
      y.set(id, n.y);
    });
  }
}

/**
 * Solvability gate. Returns null when the topology is acceptable, else the reason it was rejected.
 *  - connected
 *  - a route to a vault and on to the core exists that never touches a honeypot
 *  - no single node (other than the endpoints) is the only way to the vault or to the core
 */
export function validateNetwork(g: NetGraph, entry: number, core: number, vaults: number[]): string | null {
  const noHp = (id: number): boolean => g.nodes[id]!.kind !== 'Honeypot';
  if (reachable(g, entry).size !== g.nodes.length) return 'disconnected';
  const vault = vaults[0]!;
  const unit = (): number => 1;

  const toVault = dijkstra(g, entry, vault, unit, (id) => noHp(id) && id !== core);
  if (!toVault) return 'no honeypot-free route to the vault';
  const toCore = dijkstra(g, entry, core, unit, noHp);
  if (!toCore) return 'no honeypot-free route to the core';
  if (!reachable(g, vault, noHp).has(core)) return 'vault cannot reach the core';

  const robust = (path: number[], target: number, ok: (id: number) => boolean): boolean => {
    for (const v of path.slice(1, -1)) {
      if (!reachable(g, entry, (id) => id !== v && ok(id)).has(target)) return false;
    }
    return true;
  };
  if (!robust(toVault.path, vault, (id) => noHp(id) && id !== core)) return 'single point of failure before the vault';
  if (!robust(toCore.path, core, noHp)) return 'single point of failure before the core';
  return null;
}
