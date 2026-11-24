import type { EventBus } from '../core/EventBus';
import { ObjectPool } from '../core/ObjectPool';
import type { Sim } from '../sim/Sim';
import type { SimEvents } from '../sim/types';
import { C } from './Palette';

export interface Ring {
  x: number;
  y: number;
  r: number;
  max: number;
  t: number;
  life: number;
  delay: number;
  color: string;
  width: number;
}

export interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  t: number;
  life: number;
  color: string;
}

/**
 * Presentation reactions to sim events: pooled rings and sparks, screen shake with a direction, the
 * chromatic-aberration pulse, white flashes, and requests for hit-stop. Reads the sim, never changes it.
 */
export class Fx {
  rings: Ring[] = [];
  sparks: Spark[] = [];
  trauma = 0;
  shakeX = 0;
  shakeY = 0;
  aberration = 0;
  flash = 0;
  flashColor = '#ffffff';
  glitch = 0;
  /** Seconds of sim freeze the game loop should honour. */
  hitStop = 0;
  private readonly ringPool = new ObjectPool<Ring>(
    () => ({ x: 0, y: 0, r: 0, max: 0, t: 0, life: 1, delay: 0, color: '#fff', width: 2 }),
    (r) => {
      r.t = 0;
      r.r = 0;
      r.delay = 0;
    },
    24,
  );
  private readonly sparkPool = new ObjectPool<Spark>(
    () => ({ x: 0, y: 0, vx: 0, vy: 0, t: 0, life: 1, color: '#fff' }),
    (s) => {
      s.t = 0;
    },
    96,
  );
  private readonly off: (() => void)[] = [];
  private seed = 1;

  constructor(
    bus: EventBus<SimEvents>,
    private readonly sim: Sim,
  ) {
    const on = <K extends keyof SimEvents>(k: K, f: (p: SimEvents[K]) => void): void => {
      this.off.push(bus.on(k, f));
    };
    on('SCAN_PING', (e) => {
      for (let i = 0; i < 3; i++) this.ring(e.node, 320, 1.5, C.owned, 1.6, i * 0.28);
    });
    on('NODE_COMPROMISED', (e) => {
      this.ring(e.node, 90, 0.8, C.owned, 2.5);
      this.burst(e.node, C.owned, 16);
    });
    on('NODE_PURGED', (e) => {
      this.ring(e.node, 110, 0.9, C.ice, 3);
      this.burst(e.node, C.ice, 18);
      this.glitch = Math.max(this.glitch, 0.35);
      this.addTrauma(0.25);
    });
    on('ALERT_TRIGGERED', (e) => this.ring(e.node, e.fake ? 80 : 60, 0.7, e.fake ? C.decoy : C.amber, 1.5));
    on('TRIPWIRE', (e) => {
      this.addTrauma(0.75, e.dx, e.dy);
      this.aberration = Math.max(this.aberration, 0.8);
      this.ring(e.node, 150, 0.6, C.hot, 3.5);
    });
    on('VAULT_CRACKED', (e) => {
      this.hitStop = Math.max(this.hitStop, 0.05);
      this.flashWith('#d9c36a', 0.35);
      this.ring(e.node, 200, 1, C.gold, 3);
      this.burst(e.node, C.gold, 26);
    });
    on('CORE_BREACHED', () => {
      this.hitStop = Math.max(this.hitStop, 0.05);
      this.flashWith('#e8fff9', 0.8);
      this.aberration = 1;
      const core = sim.core;
      for (let i = 0; i < 4; i++) this.ring(core, 420, 1.6, C.white, 3, i * 0.18);
      this.burst(core, C.white, 40);
    });
    on('HONEYPOT_TRIGGERED', (e) => {
      this.addTrauma(0.9);
      this.flashWith(C.hot, 0.5);
      this.ring(e.node, 300, 1, C.hot, 4);
    });
    on('NUKE', (e) => {
      this.addTrauma(1);
      this.flashWith('#ffffff', 0.7);
      this.ring(e.node, 260, 0.8, '#ffffff', 4);
      this.burst(e.node, '#ffffff', 30);
    });
    on('WIPE', (e) => this.ring(e.node, e.global ? 520 : 160, 1.2, C.owned, 2));
    on('DECOY', (e) => this.ring(e.node, 150, 0.9, C.amber, 2.5));
    on('LOCKDOWN', (e) => {
      if (!e.on) return;
      this.addTrauma(0.5);
      this.flashWith(C.hot, 0.35);
    });
    on('TRACE_INCREASED', (e) => {
      if (e.delta >= 2) this.addTrauma(Math.min(0.35, e.delta * 0.04));
    });
    on('CONTRACT_LOST', () => {
      this.addTrauma(1);
      this.aberration = 1;
    });
  }

  dispose(): void {
    for (const o of this.off) o();
    this.off.length = 0;
  }

  clear(): void {
    for (const r of this.rings) this.ringPool.release(r);
    for (const s of this.sparks) this.sparkPool.release(s);
    this.rings.length = 0;
    this.sparks.length = 0;
    this.trauma = 0;
    this.aberration = 0;
    this.flash = 0;
    this.glitch = 0;
    this.hitStop = 0;
    this.shakeX = 0;
    this.shakeY = 0;
  }

  get pooled(): { rings: number; sparks: number } {
    return { rings: this.ringPool.available, sparks: this.sparkPool.available };
  }

  private rand(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  private addTrauma(v: number, dx = 0, dy = 0): void {
    this.trauma = Math.min(1, this.trauma + v);
    if (dx || dy) {
      this.shakeX = dx;
      this.shakeY = dy;
    }
  }

  private flashWith(color: string, amount: number): void {
    this.flash = Math.max(this.flash, amount);
    this.flashColor = color;
  }

  private ring(node: number, max: number, life: number, color: string, width: number, delay = 0): void {
    const n = this.sim.graph.nodes[node];
    if (!n) return;
    const r = this.ringPool.acquire();
    r.x = n.x;
    r.y = n.y;
    r.max = max;
    r.life = life;
    r.color = color;
    r.width = width;
    r.delay = delay;
    this.rings.push(r);
  }

  private burst(node: number, color: string, count: number): void {
    const n = this.sim.graph.nodes[node];
    if (!n) return;
    for (let i = 0; i < count; i++) {
      const s = this.sparkPool.acquire();
      const a = this.rand() * Math.PI * 2;
      const v = 40 + this.rand() * 170;
      s.x = n.x;
      s.y = n.y;
      s.vx = Math.cos(a) * v;
      s.vy = Math.sin(a) * v;
      s.life = 0.4 + this.rand() * 0.6;
      s.color = color;
      this.sparks.push(s);
    }
  }

  update(dt: number): void {
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i]!;
      if (r.delay > 0) {
        r.delay -= dt;
        continue;
      }
      r.t += dt;
      r.r = r.max * (1 - Math.pow(1 - Math.min(1, r.t / r.life), 3));
      if (r.t >= r.life) {
        this.rings.splice(i, 1);
        this.ringPool.release(r);
      }
    }
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i]!;
      s.t += dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vx *= 0.94;
      s.vy *= 0.94;
      if (s.t >= s.life) {
        this.sparks.splice(i, 1);
        this.sparkPool.release(s);
      }
    }
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    if (this.trauma === 0) this.shakeX = this.shakeY = 0;
    this.aberration = Math.max(0, this.aberration - dt * 1.4);
    this.flash = Math.max(0, this.flash - dt * 2.2);
    this.glitch = Math.max(0, this.glitch - dt * 2);
  }

  /** Screen-space shake offset in CSS pixels. Directional when the last shake came with a direction. */
  shakeOffset(time: number): { x: number; y: number } {
    const a = this.trauma * this.trauma * 14;
    if (a < 0.05) return { x: 0, y: 0 };
    const wob = Math.sin(time * 90);
    const jitter = (Math.sin(time * 61) + Math.cos(time * 47)) * 0.5;
    const dx = this.shakeX || jitter;
    const dy = this.shakeY || Math.cos(time * 53);
    return { x: dx * wob * a, y: dy * wob * a };
  }
}
