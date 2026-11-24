import type { IceRole } from '../types';
import { Tuning } from '../config';

export interface AnomalyReport {
  node: number;
  strength: number;
  t: number;
  /** Decoy noise. Searching agents believe it, hunting agents ignore it. */
  fake: boolean;
}

const MAX_REPORTS = 18;
const REPORT_TTL = 25;
const ROLE_ORDER: IceRole[] = ['chaser', 'cutter', 'flanker', 'sweeper'];

/**
 * Shared memory for every ICE agent: what was heard, where, who is already going there and in which role.
 * Agents read and write it instead of talking to each other, which is what lets them triangulate
 * instead of stacking on one node.
 */
export class AIBlackboard {
  reports: AnomalyReport[] = [];
  suspicion: number[] = [];
  /** Nodes an agent has confirmed as compromised, with the time it was confirmed. */
  confirmed = new Map<number, number>();
  /** node -> ids of agents heading there. */
  private reservations = new Map<number, number[]>();
  roles = new Map<number, IceRole>();
  lastKnown = -1;

  constructor(nodeCount: number) {
    this.reset(nodeCount);
  }

  reset(nodeCount: number): void {
    this.reports.length = 0;
    this.suspicion = new Array<number>(nodeCount).fill(0);
    this.confirmed.clear();
    this.reservations.clear();
    this.roles.clear();
    this.lastKnown = -1;
  }

  report(node: number, strength: number, t: number, fake = false): void {
    this.suspicion[node] = Math.min(5, (this.suspicion[node] ?? 0) + strength);
    this.reports.push({ node, strength, t, fake });
    if (this.reports.length > MAX_REPORTS) this.reports.shift();
  }

  confirm(node: number, t: number): void {
    this.confirmed.set(node, t);
    this.lastKnown = node;
    this.suspicion[node] = Math.max(this.suspicion[node] ?? 0, 2);
  }

  unconfirm(node: number): void {
    this.confirmed.delete(node);
    if (this.lastKnown === node) this.lastKnown = -1;
  }

  tick(dt: number, now: number): void {
    const k = Math.exp(-Tuning.suspicionDecay * dt);
    for (let i = 0; i < this.suspicion.length; i++) this.suspicion[i] = this.suspicion[i]! * k;
    this.reports = this.reports.filter((r) => now - r.t < REPORT_TTL);
  }

  /** The player went dark: forget everything that was heard. */
  clearIntel(): void {
    this.reports.length = 0;
    this.confirmed.clear();
    this.lastKnown = -1;
    for (let i = 0; i < this.suspicion.length; i++) this.suspicion[i] = this.suspicion[i]! * 0.25;
  }

  // ---- reservations ---------------------------------------------------------------------------

  reserve(agent: number, node: number): void {
    this.release(agent);
    const list = this.reservations.get(node) ?? [];
    list.push(agent);
    this.reservations.set(node, list);
  }

  release(agent: number): void {
    for (const [node, list] of this.reservations) {
      const i = list.indexOf(agent);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0) this.reservations.delete(node);
    }
  }

  dropRole(agent: number): void {
    this.roles.delete(agent);
  }

  reservedBy(node: number): number[] {
    return this.reservations.get(node) ?? [];
  }

  /** One agent per node, two for a loud one. */
  canReserve(agent: number, node: number): boolean {
    const others = this.reservedBy(node).filter((a) => a !== agent).length;
    return others < ((this.suspicion[node] ?? 0) >= 3 ? 2 : 1);
  }

  /** Best node to investigate for `agent`: loud and close, and not already taken. */
  bestLead(agent: number, cost: (node: number) => number): { node: number; score: number } | null {
    let best: { node: number; score: number } | null = null;
    for (let n = 0; n < this.suspicion.length; n++) {
      const s = this.suspicion[n]!;
      if (s < 0.9 || !this.canReserve(agent, n)) continue;
      const c = cost(n);
      if (!Number.isFinite(c)) continue;
      const score = s / (1 + c * 0.35);
      if (!best || score > best.score) best = { node: n, score };
    }
    return best;
  }

  assignRole(agent: number): IceRole {
    const taken = new Set(this.roles.values());
    const role = ROLE_ORDER.find((r) => !taken.has(r)) ?? 'chaser';
    this.roles.set(agent, role);
    return role;
  }

  hotspots(n: number): [number, number][] {
    return this.suspicion
      .map((s, i): [number, number] => [i, s])
      .filter(([, s]) => s > 0.15)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n);
  }

  reservationList(): [number, number[]][] {
    return [...this.reservations.entries()];
  }
}
