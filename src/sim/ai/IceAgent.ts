import type { EventBus } from '../../core/EventBus';
import type { Rng } from '../../core/math';
import { StateMachine } from '../../core/StateMachine';
import { Tuning } from '../config';
import type { NetGraph } from '../graph/NetworkGenerator';
import { dijkstra, shortestTree } from '../graph/pathfinding';
import type { IceGroup, IceRole, IceState, NetworkLink, SimEvents } from '../types';
import type { AIBlackboard } from './AIBlackboard';

/** What an ICE agent may ask of the world. Implemented by `Sim`, so agents never import it. */
export interface IceWorld {
  readonly graph: NetGraph;
  readonly bb: AIBlackboard;
  readonly bus: EventBus<SimEvents>;
  readonly rng: Rng;
  readonly entry: number;
  readonly lockdown: boolean;
  readonly time: number;
  routeToSession(): number[];
  purgeNode(node: number, agent: number): void;
  /** Node label if the player can see that node, otherwise a vague stand-in. */
  visibleLabel(node: number): string;
}

/**
 * Hierarchical FSM. Leaves are the five states below; each belongs to a group (Searching, Hunting, Down)
 * that decides shared behaviour: movement speed, whether decoy reports are believed, whether owned
 * nodes get purged. The adjacency table is the only way a state can change.
 */
const ALLOWED: Record<IceState, readonly IceState[]> = {
  Patrol: ['Investigate', 'Triangulate', 'Lockdown', 'Rebooting'],
  Investigate: ['Patrol', 'Triangulate', 'Lockdown', 'Rebooting'],
  Triangulate: ['Investigate', 'Patrol', 'Lockdown', 'Rebooting'],
  Lockdown: ['Investigate', 'Rebooting'],
  Rebooting: ['Patrol'],
};

export const groupOf = (s: IceState): IceGroup => (s === 'Patrol' || s === 'Investigate' ? 'Searching' : s === 'Rebooting' ? 'Down' : 'Hunting');

/** Patrols favour the deep, valuable layers; the entry and DMZ only see the odd visitor. */
const LAYER_BIAS = [0.06, 0.4, 1.2, 1.3, 1.1];

export class IceAgent {
  at: number;
  prev = -1;
  to = -1;
  progress = 0;
  edge: NetworkLink | null = null;
  /** Remaining nodes to walk through, excluding the one the agent stands on. */
  path: number[] = [];
  target = -1;
  role: IceRole | null = null;
  purge = 0;
  reboot = 0;
  dwell = 0;
  readonly fsm: StateMachine<IceState>;

  constructor(
    readonly id: number,
    start: number,
    private readonly w: IceWorld,
  ) {
    this.at = start;
    this.dwell = w.rng.range(0.2, 1.5);
    this.fsm = new StateMachine<IceState>('Patrol', ALLOWED, {
      Investigate: { exit: () => this.w.bb.release(this.id) },
      Triangulate: {
        enter: () => {
          this.resetRoute();
          this.role = this.w.bb.assignRole(this.id);
        },
        exit: () => this.dropClaims(),
      },
      Lockdown: { enter: () => this.resetRoute(), exit: () => this.dropClaims() },
      Rebooting: { enter: () => this.dropClaims() },
    });
  }

  get state(): IceState {
    return this.fsm.state;
  }

  get group(): IceGroup {
    return groupOf(this.fsm.state);
  }

  private readonly cost = (e: NetworkLink): number => e.latency / (1 + Tuning.iceHeatPull * e.alertHeat);

  private resetRoute(): void {
    this.target = -1;
    this.path.length = 0;
    this.purge = 0;
  }

  private dropClaims(): void {
    this.w.bb.release(this.id);
    this.w.bb.dropRole(this.id);
    this.role = null;
    this.purge = 0;
  }

  private go(to: IceState): void {
    const from = this.fsm.state;
    if (from === to || !this.fsm.request(to)) return;
    this.w.bus.emit('AGENT_STATE_CHANGED', { agent: this.id, from, to });
    const tag = `ICE-${this.id}`;
    if (to === 'Investigate' && from === 'Patrol') {
      this.w.bus.emit('LOG', { text: `${tag} heard something at ${this.w.visibleLabel(this.target)}.`, tone: 'warn' });
    } else if (to === 'Triangulate') {
      this.w.bus.emit('LOG', { text: `${tag} found a compromised node. Hunting (${this.role}).`, tone: 'bad' });
    } else if (to === 'Lockdown') {
      this.w.bus.emit('LOG', { text: `${tag} entered LOCKDOWN.`, tone: 'bad' });
    }
  }

  /** Nuke hit: the agent drops everything and reboots. */
  crash(seconds: number): void {
    if (this.to >= 0) {
      if (this.progress >= 0.5) this.at = this.to;
      this.to = -1;
      this.edge = null;
      this.progress = 0;
    }
    this.path.length = 0;
    this.target = -1;
    this.reboot = seconds;
    this.go('Rebooting');
  }

  /** The player went dark: hunting agents lose the trail and fall back to searching. */
  loseTrack(): void {
    if (this.state === 'Triangulate') this.go('Investigate');
  }

  update(dt: number): void {
    this.fsm.update(dt);
    if (this.state === 'Rebooting') {
      this.reboot -= dt;
      if (this.reboot <= 0) this.go('Patrol');
      return;
    }
    if (this.w.lockdown && this.state !== 'Lockdown') this.go('Lockdown');
    else if (!this.w.lockdown && this.state === 'Lockdown') this.go('Investigate');
    if (this.to >= 0) {
      this.advance(dt);
      return;
    }
    switch (this.state) {
      case 'Patrol':
        this.patrol(dt);
        break;
      case 'Investigate':
        this.investigate();
        break;
      case 'Triangulate':
        this.hunt(dt, false);
        break;
      case 'Lockdown':
        this.hunt(dt, true);
        break;
      default:
        break;
    }
  }

  // ---- movement -------------------------------------------------------------------------------

  private speed(): number {
    const g = this.group;
    const mul = g === 'Hunting' ? (this.state === 'Lockdown' ? Tuning.lockSpeedMul : Tuning.huntSpeedMul) : 1;
    return Tuning.iceSpeed * mul;
  }

  private step(): void {
    const next = this.path[0];
    if (next === undefined) return;
    const e = this.w.graph.edgeBetween(this.at, next);
    if (!e) {
      this.path.length = 0;
      return;
    }
    this.path.shift();
    this.edge = e;
    this.to = next;
    this.progress = 0;
  }

  private advance(dt: number): void {
    const e = this.edge;
    if (!e) {
      this.to = -1;
      return;
    }
    this.progress += (dt * this.speed()) / e.latency;
    if (this.progress < 1) return;
    this.prev = this.at;
    this.at = this.to;
    this.to = -1;
    this.edge = null;
    this.progress = 0;
    this.arrive();
  }

  /**
   * Walking onto an owned node may discover it. Quiet nodes are often missed; nodes with hot links or a
   * suspicious history almost never are, and during lockdown nothing is missed.
   */
  private arrive(): void {
    const w = this.w;
    const n = w.graph.nodes[this.at]!;
    if (n.owned && this.at !== w.entry) {
      let heat = 0;
      for (const e of w.graph.edgesOf(this.at)) heat = Math.max(heat, e.alertHeat);
      const p = w.lockdown ? 1 : Math.min(1, 0.15 + 0.5 * heat + 0.2 * (w.bb.suspicion[this.at] ?? 0));
      if (w.rng.chance(p)) {
        w.bb.confirm(this.at, w.time);
        if (this.state === 'Patrol' || this.state === 'Investigate') this.go('Triangulate');
      }
    }
    if (this.state === 'Patrol') this.dwell = w.rng.range(0.35, 1.1);
  }

  private planTo(target: number): boolean {
    if (target === this.at) {
      this.path.length = 0;
      return true;
    }
    const r = dijkstra(this.w.graph, this.at, target, this.cost);
    if (!r) return false;
    this.path = r.path.slice(1);
    return true;
  }

  // ---- Searching group ------------------------------------------------------------------------

  private patrol(dt: number): void {
    if (this.dwell > 0) {
      this.dwell -= dt;
      return;
    }
    const w = this.w;
    const tree = shortestTree(w.graph, this.at, this.cost);
    const lead = w.bb.bestLead(this.id, (n) => tree.dist[n]!);
    if (lead) {
      w.bb.reserve(this.id, lead.node);
      this.target = lead.node;
      if (this.planTo(lead.node)) {
        this.go('Investigate');
        return;
      }
      w.bb.release(this.id);
      this.target = -1;
    }
    const ns = w.graph.neighbors(this.at);
    if (!ns.length) return;
    const weights = ns.map((n) => {
      const nn = w.graph.nodes[n]!;
      let wt = (LAYER_BIAS[nn.layer] ?? 1) * (nn.kind === 'Honeypot' ? 0.8 : 1) + 2.5 * (w.bb.suspicion[n] ?? 0);
      if (n === this.prev) wt *= 0.35;
      return wt;
    });
    let roll = w.rng.next() * weights.reduce((s, v) => s + v, 0);
    let pick = ns[0]!;
    for (let i = 0; i < ns.length; i++) {
      roll -= weights[i]!;
      if (roll <= 0) {
        pick = ns[i]!;
        break;
      }
    }
    this.path = [pick];
    this.step();
  }

  private investigate(): void {
    const w = this.w;
    if (this.target < 0) {
      const tree = shortestTree(w.graph, this.at, this.cost);
      const lead = w.bb.bestLead(this.id, (n) => tree.dist[n]!);
      if (!lead) {
        this.go('Patrol');
        return;
      }
      w.bb.reserve(this.id, lead.node);
      this.target = lead.node;
    }
    if (this.at === this.target) {
      // Nothing owned here (arriving at an owned node would have switched to Triangulate): a false alarm.
      w.bb.suspicion[this.at] = (w.bb.suspicion[this.at] ?? 0) * 0.35;
      w.bb.reports = w.bb.reports.filter((r) => r.node !== this.at);
      this.target = -1;
      this.dwell = 1;
      this.go('Patrol');
      return;
    }
    if (!this.path.length && !this.planTo(this.target)) {
      this.target = -1;
      this.go('Patrol');
      return;
    }
    this.step();
  }

  // ---- Hunting group --------------------------------------------------------------------------

  private othersOwned(): boolean {
    return this.w.graph.nodes.some((n) => n.owned && n.id !== this.w.entry);
  }

  private validTarget(lock: boolean): boolean {
    if (this.target < 0) return false;
    if (this.target === this.w.entry) return lock && !this.othersOwned();
    return this.w.graph.nodes[this.target]!.owned;
  }

  private hunt(dt: number, lock: boolean): void {
    const w = this.w;
    if (!this.validTarget(lock)) {
      this.resetRoute();
      this.pickTarget(lock);
    }
    if (this.target < 0) {
      if (lock) {
        this.target = w.entry;
        this.planTo(w.entry);
      } else {
        this.go(w.bb.hotspots(1).length ? 'Investigate' : 'Patrol');
        return;
      }
    }
    if (this.at === this.target) {
      if (this.target === w.entry) return; // loiter on the origin; the sim adds trace for it
      this.purge += dt * (lock ? Tuning.lockPurgeMul : 1);
      if (this.purge >= Tuning.purgeTime) {
        const node = this.at;
        this.resetRoute();
        w.bb.unconfirm(node);
        w.purgeNode(node, this.id);
      }
      return;
    }
    if (!this.path.length && !this.planTo(this.target)) {
      this.resetRoute();
      return;
    }
    this.step();
  }

  /**
   * Role-based target choice. The chaser goes for the session end of the route, the cutter for the first
   * hop after the entry (severing everything behind it), the flanker for the middle. Reservations in the
   * blackboard keep them from stacking; if every preferred node is taken the agent helps on the nearest.
   */
  private pickTarget(lock: boolean): void {
    const w = this.w;
    const g = w.graph;
    const tree = shortestTree(g, this.at, this.cost);
    const owned = g.nodes.filter((n) => n.owned && n.id !== w.entry && Number.isFinite(tree.dist[n.id]!)).map((n) => n.id);
    if (!owned.length) return;
    let choice = -1;
    if (!lock) {
      const interior = w.routeToSession().filter((id) => id !== w.entry);
      const prefs: number[] = [];
      if (this.role === 'chaser') prefs.push(...[...interior].reverse());
      else if (this.role === 'cutter') prefs.push(...interior);
      else if (this.role === 'flanker' && interior.length) prefs.push(interior[Math.floor(interior.length / 2)]!, ...interior);
      choice = prefs.find((n) => g.nodes[n]!.owned && w.bb.canReserve(this.id, n)) ?? -1;
    }
    if (choice < 0) {
      owned.sort((a, b) => tree.dist[a]! - tree.dist[b]!);
      choice = owned.find((n) => w.bb.canReserve(this.id, n)) ?? owned[0]!;
    }
    this.target = choice;
    w.bb.reserve(this.id, choice);
  }
}
