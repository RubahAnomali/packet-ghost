import type { EventBus } from '../core/EventBus';
import { Rng } from '../core/math';
import type { ObjectPool } from '../core/ObjectPool';
import { AGENTS_PER_LEVEL, FIXED_DT, KIND, START_DECOYS, START_NUKES, Tuning } from './config';
import { AIBlackboard } from './ai/AIBlackboard';
import { IceAgent, type IceWorld } from './ai/IceAgent';
import { CommandDispatcher } from './commands/CommandDispatcher';
import { generateNetwork, type NetGraph } from './graph/NetworkGenerator';
import { dijkstra, reachable } from './graph/pathfinding';
import { createPacketPool, type Packet, type PacketKind } from './Packets';
import type { CommandName, LogTone, NetworkNode, SimEvents } from './types';

export type Phase = 'play' | 'won' | 'lost';

export interface Job {
  id: number;
  cmd: CommandName;
  target: number;
  /** Nodes the command's packet travels through, session first. */
  route: number[];
  phase: 'travel' | 'work';
  t: number;
  work: number;
  /** Noise per second while working. */
  noise: number;
  /** If any of these stops being owned the job is aborted. */
  mustOwn: number[];
  packet: Packet | null;
  tripped: boolean;
}

export interface JobSpec {
  cmd: CommandName;
  target: number;
  route: number[];
  work: number;
  noise: number;
  mustOwn: number[];
  packet: PacketKind;
}

const AMBIENT_MAX = 34;

/**
 * The whole game state and its rules. No DOM, no canvas, no audio: everything that happens is reported
 * through the typed `bus`, and time only advances through `update(FIXED_DT)`.
 */
export class Sim implements IceWorld {
  readonly dispatcher = new CommandDispatcher(this);
  readonly packetPool: ObjectPool<Packet> = createPacketPool();
  private readonly cosmetic = new Rng(0xc0ffee);

  graph!: NetGraph;
  bb = new AIBlackboard(0);
  rng = new Rng(1);
  entry = 0;
  core = 0;
  vaults: number[] = [];
  honeypots: number[] = [];
  attempts = 1;

  seed = 1;
  level = 1;
  time = 0;
  phase: Phase = 'play';
  trace = 0;
  traceRate = 0;
  session = 0;
  creds = 0;
  keys = 0;
  decoys = START_DECOYS;
  nukes = START_NUKES;
  wipeCd = 0;
  darkTime = 0;
  darkCd = 0;
  lockdown = false;
  lockdownHold = 0;
  score = 0;
  /** Debug: show the whole network regardless of what has been scanned. */
  reveal = false;

  jobs: Job[] = [];
  packets: Packet[] = [];
  agents: IceAgent[] = [];
  stats = { commands: 0, purged: 0, alerts: 0 };
  /** Bumps whenever ownership or the session changes, to invalidate the route cache. */
  version = 0;

  private jobSeq = 0;
  private traceEmitAcc = 0;
  private ambientTimer = 0;
  private routeCache: { version: number; route: number[] } = { version: -1, route: [] };

  constructor(readonly bus: EventBus<SimEvents>) {
    this.loadContract(1, 1);
  }

  // ---- lifecycle ------------------------------------------------------------------------------

  /** Build a fresh network and reset every piece of mutable state. Safe to call at any time. */
  loadContract(seed: number, level: number): void {
    for (const p of this.packets) this.packetPool.release(p);
    this.packets.length = 0;
    this.jobs.length = 0;
    const net = generateNetwork(seed, level);
    this.graph = net.graph;
    this.entry = net.entry;
    this.core = net.core;
    this.vaults = net.vaults;
    this.honeypots = net.honeypots;
    this.attempts = net.attempts;
    this.seed = seed;
    this.level = net.level;
    this.rng = new Rng((Math.imul(seed, 2654435761) ^ (level * 40503)) >>> 0);

    this.time = 0;
    this.phase = 'play';
    this.trace = 0;
    this.traceRate = 0;
    this.creds = 0;
    this.keys = 0;
    this.decoys = START_DECOYS;
    this.nukes = START_NUKES;
    this.wipeCd = 0;
    this.darkTime = 0;
    this.darkCd = 0;
    this.lockdown = false;
    this.lockdownHold = 0;
    this.score = 0;
    this.stats = { commands: 0, purged: 0, alerts: 0 };
    this.jobSeq = 0;
    this.traceEmitAcc = 0;
    this.ambientTimer = 0;
    this.version++;

    this.bb = new AIBlackboard(this.graph.nodes.length);
    const entry = this.graph.nodes[this.entry]!;
    entry.owned = true;
    entry.knowledge = 3;
    entry.locked = false;
    this.session = this.entry;
    this.revealAround();

    const spawnKinds = ['FirewallGate', 'AuthVault', 'Honeypot', 'CoreMainframe', 'LogServer', 'DMZRouter'];
    const pool = this.graph.nodes.filter((n) => spawnKinds.includes(n.kind) && n.layer >= 2).map((n) => n.id);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = this.rng.int(0, i);
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    const count = AGENTS_PER_LEVEL[this.level - 1] ?? 2;
    this.agents = [];
    for (let i = 0; i < count; i++) this.agents.push(new IceAgent(i + 1, pool[i % pool.length]!, this));

    this.bus.emit('CONTRACT_STARTED', { seed, level: this.level });
    this.log(`Contract ${this.level}: reach the Core Mainframe. ${count} ICE agents on the network.`, 'info');
    this.log(`Type 'help', or click a node. Start with 'scan'.`, 'info');
  }

  // ---- queries --------------------------------------------------------------------------------

  node(id: number): NetworkNode {
    return this.graph.nodes[id]!;
  }

  visible(id: number): boolean {
    const n = this.graph.nodes[id];
    return !!n && (this.reveal || n.owned || n.knowledge >= 1);
  }

  visibleLabel(id: number): string {
    return id >= 0 && this.visible(id) ? this.graph.nodes[id]!.label : 'somewhere in the dark';
  }

  isFrontier(id: number): boolean {
    const n = this.graph.nodes[id]!;
    return !n.owned && this.graph.neighbors(id).some((v) => this.graph.nodes[v]!.owned);
  }

  ownedPath(a: number, b: number): number[] | null {
    const r = dijkstra(this.graph, a, b, (e) => e.latency, (id) => this.graph.nodes[id]!.owned);
    return r ? r.path : null;
  }

  fullPath(a: number, b: number): number[] | null {
    const r = dijkstra(this.graph, a, b, (e) => e.latency);
    return r ? r.path : null;
  }

  /** Path from the session through owned nodes to an unowned node that touches the network. */
  approach(target: number): number[] | null {
    let best: { path: number[]; cost: number } | null = null;
    for (const e of this.graph.edgesOf(target)) {
      const n = this.graph.other(e, target);
      if (!this.graph.nodes[n]!.owned) continue;
      const r = dijkstra(this.graph, this.session, n, (x) => x.latency, (id) => this.graph.nodes[id]!.owned);
      if (!r) continue;
      const cost = r.cost + e.latency;
      if (!best || cost < best.cost) best = { path: [...r.path, target], cost };
    }
    return best ? best.path : null;
  }

  /** Entry to session through owned nodes. Cached until ownership changes. */
  routeToSession(): number[] {
    if (this.routeCache.version !== this.version) {
      this.routeCache = { version: this.version, route: this.ownedPath(this.entry, this.session) ?? [this.entry] };
    }
    return this.routeCache.route;
  }

  get routeHops(): number {
    return this.routeToSession().length - 1;
  }

  ownedCount(): number {
    return this.graph.nodes.reduce((n, x) => n + (x.owned ? 1 : 0), 0);
  }

  log(text: string, tone: LogTone): void {
    this.bus.emit('LOG', { text, tone });
  }

  // ---- state changes used by commands and agents ----------------------------------------------

  revealAround(): void {
    for (const n of this.graph.nodes) {
      if (!n.owned) continue;
      for (const v of this.graph.neighbors(n.id)) {
        const m = this.graph.nodes[v]!;
        if (m.knowledge < 1) m.knowledge = 1;
      }
    }
  }

  setOwned(id: number, how: 'inject' | 'spoof'): void {
    const n = this.graph.nodes[id]!;
    n.owned = true;
    n.locked = false;
    n.knowledge = 3;
    this.version++;
    this.revealAround();
    this.bus.emit('NODE_COMPROMISED', { node: id, how });
  }

  setSession(id: number): void {
    this.session = id;
    this.version++;
    this.bus.emit('SESSION_MOVED', { node: id });
  }

  /** Drops ownership of one node, then of everything that is no longer connected to the entry through owned nodes. */
  releaseNode(id: number): void {
    const n = this.graph.nodes[id]!;
    if (!n.owned || id === this.entry) return;
    n.owned = false;
    const alive = reachable(this.graph, this.entry, (v) => this.graph.nodes[v]!.owned);
    for (const m of this.graph.nodes) {
      if (m.owned && !alive.has(m.id)) {
        m.owned = false;
        this.bb.unconfirm(m.id);
        this.bus.emit('NODE_PURGED', { node: m.id, by: -1 });
        this.log(`${m.label} lost: its route to the entry was cut.`, 'bad');
      }
    }
    if (!this.graph.nodes[this.session]!.owned) this.session = this.entry;
    this.version++;
    this.cancelBrokenJobs();
  }

  purgeNode(id: number, agent: number): void {
    const n = this.graph.nodes[id]!;
    if (!n.owned || id === this.entry) return;
    const before = this.session;
    this.releaseNode(id);
    this.stats.purged++;
    this.addTrace(Tuning.purgeHitTrace, 'purge');
    this.bus.emit('NODE_PURGED', { node: id, by: agent });
    this.log(`ICE-${agent} purged ${n.label}.`, 'bad');
    if (this.session !== before) {
      this.addTrace(Tuning.ejectTrace, 'ejected');
      this.log('Session ejected back to the entry proxy.', 'bad');
    }
  }

  addTrace(delta: number, source: string): void {
    if (delta <= 0 || this.phase !== 'play') return;
    this.trace = Math.min(100, this.trace + delta);
    this.traceEmitAcc += delta;
    if (this.traceEmitAcc >= 0.5) {
      this.bus.emit('TRACE_INCREASED', { delta: this.traceEmitAcc, trace: this.trace, source });
      this.traceEmitAcc = 0;
    }
  }

  reduceTrace(delta: number): void {
    this.trace = Math.max(0, this.trace - delta);
  }

  /** An anomaly report: somebody monitoring `node` noticed something. */
  raise(node: number, strength: number, fake = false): void {
    this.bb.report(node, strength, this.time, fake);
    if (!fake) this.stats.alerts++;
    this.bus.emit('ALERT_TRIGGERED', { node, level: this.bb.suspicion[node] ?? strength, fake });
  }

  /** Exploit noise: leaves heat on the wire along the route, may trip the node's monitor, and raises trace. */
  addNoise(route: number[], node: number, amount: number): void {
    if (amount <= 0) return;
    for (let i = 0; i + 1 < route.length; i++) {
      const e = this.graph.edgeBetween(route[i]!, route[i + 1]!);
      if (e) e.alertHeat = Math.min(Tuning.heatMax, e.alertHeat + amount * Tuning.heatPerNoise);
    }
    const n = this.graph.nodes[node]!;
    n.noiseAcc += amount * KIND[n.kind].monitor;
    while (n.noiseAcc >= Tuning.reportEvery) {
      n.noiseAcc -= Tuning.reportEvery;
      this.raise(node, 1);
    }
    this.addTrace(amount * Tuning.traceFromNoise, 'noise');
  }

  triggerHoneypot(node: number): void {
    this.bus.emit('HONEYPOT_TRIGGERED', { node });
    this.addTrace(Tuning.honeypotTrace, 'honeypot');
    this.raise(node, 4);
    this.lockdownHold = Tuning.lockdownHold;
    this.log('HONEYPOT! Alarms everywhere. The network is locking down.', 'bad');
  }

  goDark(): void {
    this.darkTime = Tuning.darkTime;
    this.darkCd = Tuning.darkCooldown;
    this.bb.clearIntel();
    for (const a of this.agents) a.loseTrack();
    this.bus.emit('DARK', { on: true });
  }

  win(): void {
    if (this.phase !== 'play') return;
    this.phase = 'won';
    this.score = Math.round(1000 * this.level + (100 - this.trace) * 15 + Math.max(0, 240 - this.time) * 4);
    this.bus.emit('CORE_BREACHED', { score: this.score });
    this.log(`CORE BREACHED. Contract complete, score ${this.score}.`, 'good');
  }

  private lose(reason: string): void {
    if (this.phase !== 'play') return;
    this.phase = 'lost';
    this.bus.emit('CONTRACT_LOST', { reason });
    this.log(`CONTRACT LOST: ${reason}.`, 'bad');
  }

  // ---- jobs and packets -----------------------------------------------------------------------

  startJob(spec: JobSpec): Job {
    const job: Job = {
      id: ++this.jobSeq,
      cmd: spec.cmd,
      target: spec.target,
      route: spec.route,
      phase: spec.route.length > 1 ? 'travel' : 'work',
      t: 0,
      work: spec.work,
      noise: spec.noise,
      mustOwn: spec.mustOwn,
      packet: null,
      tripped: false,
    };
    if (job.phase === 'travel') {
      const p = this.packetPool.acquire();
      p.kind = spec.packet;
      p.path.push(...spec.route);
      p.job = job.id;
      job.packet = p;
      this.packets.push(p);
    }
    this.jobs.push(job);
    return job;
  }

  private dropPacket(p: Packet): void {
    const i = this.packets.indexOf(p);
    if (i >= 0) this.packets.splice(i, 1);
    this.packetPool.release(p);
  }

  private cancelBrokenJobs(): void {
    for (let i = this.jobs.length - 1; i >= 0; i--) {
      const j = this.jobs[i]!;
      if (j.mustOwn.every((id) => this.graph.nodes[id]!.owned)) continue;
      if (j.packet) this.dropPacket(j.packet);
      this.jobs.splice(i, 1);
      this.log(`${j.cmd} aborted: the route was severed.`, 'warn');
    }
  }

  private updatePackets(dt: number): void {
    for (let i = this.packets.length - 1; i >= 0; i--) {
      const p = this.packets[i]!;
      const e = this.graph.edgeBetween(p.path[p.seg]!, p.path[p.seg + 1]!);
      p.t += (dt * Tuning.packetSpeed) / (e ? e.latency : 0.3);
      if (p.t < 1) continue;
      p.t -= 1;
      p.seg++;
      if (p.seg < p.path.length - 1) continue;
      this.packets.splice(i, 1);
      const job = p.job ? this.jobs.find((j) => j.id === p.job) : undefined;
      this.packetPool.release(p);
      if (job) {
        job.packet = null;
        job.phase = 'work';
        this.bus.emit('PACKET_DELIVERED', { job: job.id, cmd: job.cmd, target: job.target });
      }
    }
  }

  private updateJobs(dt: number): void {
    const done: Job[] = [];
    for (const j of this.jobs) {
      if (j.phase !== 'work') continue;
      j.t += dt;
      if (j.noise > 0) this.addNoise(j.route, j.target, j.noise * dt);
      const n = this.graph.nodes[j.target]!;
      if (j.cmd === 'inject' && n.kind === 'FirewallGate' && n.locked && !j.tripped && j.t >= j.work * 0.5) {
        j.tripped = true;
        this.tripwire(j);
      }
      if (j.t >= j.work) done.push(j);
    }
    for (const j of done) {
      const i = this.jobs.indexOf(j);
      if (i < 0) continue;
      this.jobs.splice(i, 1);
      this.dispatcher.get(j.cmd).complete?.(this, j);
    }
  }

  private tripwire(j: Job): void {
    const a = this.graph.nodes[j.route[Math.max(0, j.route.length - 2)]!]!;
    const b = this.graph.nodes[j.target]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    this.addTrace(Tuning.tripwireTrace, 'tripwire');
    this.raise(j.target, 2);
    this.bus.emit('TRIPWIRE', { node: j.target, dx: (b.x - a.x) / len, dy: (b.y - a.y) / len });
    this.log(`Tripwire on ${b.label}! The firewall knows.`, 'bad');
  }

  // ---- main step ------------------------------------------------------------------------------

  /** Advance one fixed step. Called by the game loop with FIXED_DT, or by tests. */
  update(dt: number = FIXED_DT): void {
    if (this.phase !== 'play') return;
    this.time += dt;
    this.wipeCd = Math.max(0, this.wipeCd - dt);
    this.darkCd = Math.max(0, this.darkCd - dt);
    if (this.darkTime > 0) {
      this.darkTime -= dt;
      if (this.darkTime <= 0) {
        this.darkTime = 0;
        this.bus.emit('DARK', { on: false });
        this.log('Session restored.', 'info');
      }
    }

    const heat = Math.exp(-Tuning.heatDecay * dt);
    for (const e of this.graph.edges) e.alertHeat *= heat;
    const calm = Math.exp(-0.2 * dt);
    for (const n of this.graph.nodes) n.noiseAcc *= calm;
    this.bb.tick(dt, this.time);

    this.updateJobs(dt);
    this.updatePackets(dt);
    for (const a of this.agents) a.update(dt);
    this.updateTrace(dt);
    this.updateLockdown(dt);
    this.updateAmbient(dt);
    if (this.trace >= 100) this.lose('TRACE COMPLETE');
  }

  private updateTrace(dt: number): void {
    let rate = 0;
    if (this.darkTime <= 0) {
      rate += (Tuning.traceBase * (1 + Tuning.levelTraceMul * (this.level - 1))) / (1 + Tuning.hopRelief * this.routeHops);
    }
    for (const a of this.agents) {
      if (a.group !== 'Hunting') continue;
      if (a.to < 0 && a.at === this.entry) rate += Tuning.iceTraceEntry;
      if (a.purge > 0) rate += Tuning.icePurgeTrace;
    }
    if (this.lockdown) rate *= Tuning.lockdownMul;
    this.traceRate = rate;
    this.trace = Math.min(100, this.trace + rate * dt);
  }

  private updateLockdown(dt: number): void {
    if (this.lockdownHold > 0) this.lockdownHold -= dt;
    let on = this.lockdown;
    if (!on && (this.trace >= Tuning.lockdownAt || this.lockdownHold > 0)) on = true;
    else if (on && this.lockdownHold <= 0 && this.trace < Tuning.lockdownEnd) on = false;
    if (on === this.lockdown) return;
    this.lockdown = on;
    this.bus.emit('LOCKDOWN', { on });
    this.log(on ? 'LOCKDOWN: ICE is purging everything and trace is accelerating.' : 'Lockdown lifted.', on ? 'bad' : 'good');
  }

  /** Cosmetic background traffic. Uses its own RNG so it can never change a run's outcome. */
  private updateAmbient(dt: number): void {
    this.ambientTimer -= dt;
    if (this.ambientTimer > 0) return;
    this.ambientTimer = 0.3;
    let n = 0;
    for (const p of this.packets) if (p.kind === 'ambient') n++;
    if (n >= AMBIENT_MAX || !this.graph.edges.length) return;
    const e = this.graph.edges[this.cosmetic.int(0, this.graph.edges.length - 1)]!;
    const p = this.packetPool.acquire();
    p.kind = 'ambient';
    if (this.cosmetic.chance(0.5)) p.path.push(e.a, e.b);
    else p.path.push(e.b, e.a);
    this.packets.push(p);
  }
}
