import { clamp, TAU } from '../core/math';
import { KIND, Tuning } from '../sim/config';
import type { IceAgent } from '../sim/ai/IceAgent';
import type { Packet } from '../sim/Packets';
import type { Sim } from '../sim/Sim';
import type { NetworkLink, NetworkNode, NodeKind } from '../sim/types';
import type { Fx } from './Fx';
import { C, heatColor } from './Palette';

export interface ViewState {
  selected: number;
  hover: number;
  debug: boolean;
}

const NODE_R = 17;
const ALERT_R: Record<string, number> = { Patrol: 52, Investigate: 72, Triangulate: 98, Lockdown: 128, Rebooting: 30 };
const STATE_TAG: Record<string, string> = { Patrol: 'PAT', Investigate: 'INV', Triangulate: 'TRI', Lockdown: 'LCK', Rebooting: 'RBT' };
const FONT = '11px "Cascadia Mono", Consolas, "Courier New", monospace';

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly scene = document.createElement('canvas');
  private readonly sctx: CanvasRenderingContext2D;
  private readonly tmp = document.createElement('canvas');
  private readonly tctx: CanvasRenderingContext2D;
  private scanPattern: CanvasPattern | null = null;

  W = 800;
  H = 600;
  dpr = 1;
  /** Space the HUD and the terminal take, so the graph centres in what is left. */
  padTop = 74;
  padBottom = 200;
  cam = { x: 0, y: 0, zoom: 1 };
  private goal = { x: 0, y: 0, zoom: 1 };
  time = 0;
  private userMoved = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly sim: Sim,
    private readonly fx: Fx,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.sctx = this.scene.getContext('2d')!;
    this.tctx = this.tmp.getContext('2d')!;
    this.resize();
    this.fit(true);
  }

  // ---- camera ---------------------------------------------------------------------------------

  resize(): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.W = Math.max(320, window.innerWidth);
    this.H = Math.max(240, window.innerHeight);
    for (const c of [this.canvas, this.scene, this.tmp]) {
      c.width = Math.round(this.W * this.dpr);
      c.height = Math.round(this.H * this.dpr);
    }
    this.padBottom = this.W < 900 ? 170 : 200;
    this.buildScanPattern();
  }

  private buildScanPattern(): void {
    const c = document.createElement('canvas');
    const step = Math.max(3, Math.round(3 * this.dpr));
    c.width = 1;
    c.height = step;
    const g = c.getContext('2d')!;
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.fillRect(0, step - Math.max(1, Math.round(this.dpr)), 1, Math.max(1, Math.round(this.dpr)));
    this.scanPattern = this.ctx.createPattern(c, 'repeat');
  }

  private originY(): number {
    return this.padTop + (this.H - this.padTop - this.padBottom) / 2;
  }

  /**
   * Frame everything the player can see. Until the player pans or zooms by hand the camera keeps
   * re-framing as the network is revealed; `F` hands control back to it.
   */
  fit(snap = false): void {
    this.userMoved = false;
    this.refit(snap);
  }

  private refit(snap: boolean): void {
    const shown = this.sim.graph.nodes.filter((n) => this.sim.visible(n.id));
    const ns = shown.length ? shown : this.sim.graph.nodes;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const n of ns) {
      x0 = Math.min(x0, n.x);
      x1 = Math.max(x1, n.x);
      y0 = Math.min(y0, n.y);
      y1 = Math.max(y1, n.y);
    }
    const w = Math.max(360, x1 - x0 + 190);
    const h = Math.max(240, y1 - y0 + 170);
    const zoom = clamp(Math.min(this.W / w, (this.H - this.padTop - this.padBottom) / h), 0.35, 1.25);
    this.goal = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, zoom };
    if (snap) this.cam = { ...this.goal };
  }

  pan(dxPx: number, dyPx: number): void {
    this.userMoved = true;
    this.goal.x -= dxPx / this.cam.zoom;
    this.goal.y -= dyPx / this.cam.zoom;
    this.cam.x = this.goal.x;
    this.cam.y = this.goal.y;
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    this.userMoved = true;
    const before = this.toWorld(sx, sy);
    const z = clamp(this.cam.zoom * factor, 0.3, 2.6);
    this.cam.zoom = z;
    this.goal.zoom = z;
    const after = this.toWorld(sx, sy);
    this.cam.x += before.x - after.x;
    this.cam.y += before.y - after.y;
    this.goal.x = this.cam.x;
    this.goal.y = this.cam.y;
  }

  toWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.W / 2) / this.cam.zoom + this.cam.x, y: (sy - this.originY()) / this.cam.zoom + this.cam.y };
  }

  toScreen(wx: number, wy: number): { x: number; y: number } {
    return { x: (wx - this.cam.x) * this.cam.zoom + this.W / 2, y: (wy - this.cam.y) * this.cam.zoom + this.originY() };
  }

  /** Visible node under a screen point, or -1. */
  pick(sx: number, sy: number): number {
    const w = this.toWorld(sx, sy);
    let best = -1;
    let bd = (NODE_R * 1.7) ** 2;
    for (const n of this.sim.graph.nodes) {
      if (!this.sim.visible(n.id)) continue;
      const d = (n.x - w.x) ** 2 + (n.y - w.y) ** 2;
      if (d < bd) {
        bd = d;
        best = n.id;
      }
    }
    return best;
  }

  update(dt: number): void {
    this.time += dt;
    if (!this.userMoved) this.refit(false);
    const k = Math.min(1, dt * 5);
    this.cam.x += (this.goal.x - this.cam.x) * k;
    this.cam.y += (this.goal.y - this.cam.y) * k;
    this.cam.zoom += (this.goal.zoom - this.cam.zoom) * k;
  }

  // ---- geometry -------------------------------------------------------------------------------

  private ctrl(e: NetworkLink): { x: number; y: number } {
    const a = this.sim.graph.nodes[e.a]!;
    const b = this.sim.graph.nodes[e.b]!;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return { x: mx - dy * e.bend, y: my + dx * e.bend };
  }

  /** Point on a link, `t` of the way from node `from` to the other end. Packets and ICE use this so they ride the drawn curve. */
  linkPoint(e: NetworkLink, from: number, t: number): { x: number; y: number } {
    const g = this.sim.graph;
    const a = g.nodes[e.a]!;
    const b = g.nodes[e.b]!;
    const u = from === e.a ? t : 1 - t;
    const c = this.ctrl(e);
    const v = 1 - u;
    return { x: v * v * a.x + 2 * v * u * c.x + u * u * b.x, y: v * v * a.y + 2 * v * u * c.y + u * u * b.y };
  }

  private agentPos(a: IceAgent): { x: number; y: number } {
    const g = this.sim.graph;
    if (a.to >= 0 && a.edge) return this.linkPoint(a.edge, a.at, a.progress);
    const n = g.nodes[a.at]!;
    const ang = a.id * 2.1 + this.time * 0.6;
    return { x: n.x + Math.cos(ang) * 22, y: n.y + Math.sin(ang) * 22 };
  }

  private agentVisible(a: IceAgent): boolean {
    return this.sim.reveal || this.sim.visible(a.at) || (a.to >= 0 && this.sim.visible(a.to));
  }

  // ---- frame ----------------------------------------------------------------------------------

  draw(view: ViewState): void {
    const c = this.sctx;
    const sim = this.sim;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    const bg = c.createRadialGradient(this.W * this.dpr * 0.5, this.H * this.dpr * 0.5, 0, this.W * this.dpr * 0.5, this.H * this.dpr * 0.5, Math.max(this.W, this.H) * this.dpr * 0.75);
    bg.addColorStop(0, C.bgHi);
    bg.addColorStop(1, C.bg);
    c.fillStyle = bg;
    c.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const z = this.cam.zoom;
    c.setTransform(this.dpr * z, 0, 0, this.dpr * z, this.dpr * (this.W / 2 - this.cam.x * z), this.dpr * (this.originY() - this.cam.y * z));
    this.drawGrid(c);
    this.drawLinks(c);
    this.drawRoute(c);
    this.drawPackets(c);
    for (const n of sim.graph.nodes) if (sim.visible(n.id)) this.drawNode(c, n, view);
    this.drawPurgeArcs(c);
    for (const a of sim.agents) if (this.agentVisible(a)) this.drawAgent(c, a);
    this.drawFx(c);
    if (view.debug) this.drawDebug(c);

    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawLabels(c, view);
    this.present();
  }

  private drawGrid(c: CanvasRenderingContext2D): void {
    const step = 80;
    const tl = this.toWorld(0, 0);
    const br = this.toWorld(this.W, this.H);
    c.strokeStyle = C.grid;
    c.lineWidth = 1 / this.cam.zoom;
    c.beginPath();
    for (let x = Math.floor(tl.x / step) * step; x <= br.x; x += step) {
      c.moveTo(x, tl.y);
      c.lineTo(x, br.y);
    }
    for (let y = Math.floor(tl.y / step) * step; y <= br.y; y += step) {
      c.moveTo(tl.x, y);
      c.lineTo(br.x, y);
    }
    c.stroke();
  }

  private curve(c: CanvasRenderingContext2D, e: NetworkLink): void {
    const a = this.sim.graph.nodes[e.a]!;
    const b = this.sim.graph.nodes[e.b]!;
    const k = this.ctrl(e);
    c.beginPath();
    c.moveTo(a.x, a.y);
    c.quadraticCurveTo(k.x, k.y, b.x, b.y);
  }

  private drawLinks(c: CanvasRenderingContext2D): void {
    const g = this.sim.graph;
    for (const e of g.edges) {
      const a = g.nodes[e.a]!;
      const b = g.nodes[e.b]!;
      if (!this.sim.visible(a.id) || !this.sim.visible(b.id)) continue;
      const both = a.owned && b.owned;
      const known = a.knowledge >= 2 && b.knowledge >= 2;
      this.curve(c, e);
      c.setLineDash(known || both ? [] : [3, 6]);
      c.strokeStyle = both ? C.linkOwned : e.alertHeat > 0.05 ? heatColor(e.alertHeat) : known ? C.link : C.linkDim;
      c.globalAlpha = both ? 0.55 : 1;
      c.lineWidth = both ? 2.2 : 1.4 + Math.min(2, e.alertHeat);
      c.stroke();
    }
    c.setLineDash([]);
    c.globalAlpha = 1;
  }

  /** The chain entry -> session, with marching dashes so the live route reads at a glance. */
  private drawRoute(c: CanvasRenderingContext2D): void {
    const route = this.sim.routeToSession();
    if (route.length < 2) return;
    c.setLineDash([9, 9]);
    c.lineDashOffset = -this.time * 38;
    c.strokeStyle = C.white;
    c.lineWidth = 1.6;
    c.globalAlpha = 0.85;
    for (let i = 0; i + 1 < route.length; i++) {
      const e = this.sim.graph.edgeBetween(route[i]!, route[i + 1]!);
      if (!e) continue;
      this.curve(c, e);
      c.stroke();
    }
    c.setLineDash([]);
    c.globalAlpha = 1;
  }

  private packetColor(p: Packet): string {
    switch (p.kind) {
      case 'decoy':
        return C.decoy;
      case 'nuke':
        return '#ffffff';
      case 'scan':
        return C.owned;
      case 'ambient':
        return '#34505c';
      default:
        return C.packet;
    }
  }

  private drawPackets(c: CanvasRenderingContext2D): void {
    const g = this.sim.graph;
    for (const p of this.packets()) {
      const from = p.path[p.seg]!;
      const to = p.path[p.seg + 1]!;
      const e = g.edgeBetween(from, to);
      if (!e) continue;
      if (!this.sim.visible(from) || !this.sim.visible(to)) continue;
      const col = this.packetColor(p);
      const amb = p.kind === 'ambient';
      for (let i = amb ? 2 : 6; i >= 0; i--) {
        const t = p.t - i * 0.045;
        if (t < 0) continue;
        const pt = this.linkPoint(e, from, t);
        c.globalAlpha = (1 - i / (amb ? 3 : 7)) * (amb ? 0.55 : 1);
        c.fillStyle = col;
        c.beginPath();
        c.arc(pt.x, pt.y, (amb ? 1.5 : 3.4) * (1 - i * 0.09), 0, TAU);
        c.fill();
      }
      if (!amb) {
        const pt = this.linkPoint(e, from, p.t);
        c.globalAlpha = 0.22;
        c.beginPath();
        c.arc(pt.x, pt.y, 8, 0, TAU);
        c.fill();
      }
    }
    c.globalAlpha = 1;
  }

  private packets(): readonly Packet[] {
    return this.sim.packets;
  }

  // ---- nodes ----------------------------------------------------------------------------------

  private glyph(c: CanvasRenderingContext2D, kind: NodeKind, r: number): void {
    c.beginPath();
    switch (kind) {
      case 'EntryProxy':
        c.moveTo(0, -r * 1.15);
        c.lineTo(r * 1.15, 0);
        c.lineTo(0, r * 1.15);
        c.lineTo(-r * 1.15, 0);
        c.closePath();
        break;
      case 'DMZRouter':
        c.arc(0, 0, r, 0, TAU);
        break;
      case 'FirewallGate':
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * TAU + TAU / 12;
          c.lineTo(Math.cos(a) * r * 1.1, Math.sin(a) * r * 1.1);
        }
        c.closePath();
        break;
      case 'AuthVault':
      case 'Honeypot':
        c.roundRect(-r * 0.9, -r * 0.9, r * 1.8, r * 1.8, 4);
        break;
      case 'CoreMainframe':
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * TAU + TAU / 16;
          c.lineTo(Math.cos(a) * r * 1.3, Math.sin(a) * r * 1.3);
        }
        c.closePath();
        break;
      case 'AdminWorkstation':
        c.roundRect(-r * 0.8, -r * 0.65, r * 1.6, r * 1.3, 3);
        break;
      case 'LogServer':
        c.roundRect(-r * 0.75, -r * 0.95, r * 1.5, r * 1.9, 3);
        break;
    }
  }

  private glyphDetail(c: CanvasRenderingContext2D, kind: NodeKind, r: number, trap: boolean): void {
    c.beginPath();
    switch (kind) {
      case 'EntryProxy':
        c.arc(0, 0, r * 0.35, 0, TAU);
        break;
      case 'DMZRouter':
        c.arc(0, 0, r * 0.28, 0, TAU);
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * TAU + TAU / 8;
          c.moveTo(Math.cos(a) * r * 0.55, Math.sin(a) * r * 0.55);
          c.lineTo(Math.cos(a) * r * 0.85, Math.sin(a) * r * 0.85);
        }
        break;
      case 'FirewallGate':
        c.moveTo(-r * 0.55, -r * 0.2);
        c.lineTo(r * 0.55, -r * 0.2);
        c.moveTo(-r * 0.55, r * 0.2);
        c.lineTo(r * 0.55, r * 0.2);
        c.moveTo(0, -r * 0.55);
        c.lineTo(0, r * 0.55);
        break;
      case 'AuthVault':
      case 'Honeypot':
        if (trap) {
          c.moveTo(-r * 0.5, -r * 0.5);
          c.lineTo(r * 0.5, r * 0.5);
          c.moveTo(r * 0.5, -r * 0.5);
          c.lineTo(-r * 0.5, r * 0.5);
        } else {
          c.arc(0, -r * 0.18, r * 0.26, 0, TAU);
          c.moveTo(0, r * 0.08);
          c.lineTo(0, r * 0.55);
        }
        break;
      case 'CoreMainframe':
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * TAU + TAU / 16;
          c.lineTo(Math.cos(a) * r * 0.72, Math.sin(a) * r * 0.72);
        }
        c.closePath();
        c.moveTo(r * 0.2, 0);
        c.arc(0, 0, r * 0.2, 0, TAU);
        break;
      case 'AdminWorkstation':
        c.arc(0, -r * 0.2, r * 0.2, 0, TAU);
        c.moveTo(-r * 0.4, r * 0.4);
        c.quadraticCurveTo(0, -r * 0.1, r * 0.4, r * 0.4);
        break;
      case 'LogServer':
        for (let i = -1; i <= 1; i++) {
          c.moveTo(-r * 0.4, i * r * 0.42);
          c.lineTo(r * 0.4, i * r * 0.42);
        }
        break;
    }
    c.stroke();
  }

  private drawNode(c: CanvasRenderingContext2D, n: NetworkNode, view: ViewState): void {
    const t = this.time;
    const k = this.sim.reveal && n.knowledge < 2 && !n.owned ? 2 : n.knowledge;
    c.save();
    c.translate(n.x, n.y);
    c.lineWidth = 1.6;
    if (k < 2 && !n.owned) {
      c.setLineDash([3, 4]);
      c.strokeStyle = C.nodeDim;
      c.fillStyle = '#0a1014';
      c.beginPath();
      c.arc(0, 0, NODE_R * 0.85, 0, TAU);
      c.fill();
      c.stroke();
      c.setLineDash([]);
      c.restore();
      return;
    }
    const shown: NodeKind = n.kind === 'Honeypot' && n.knowledge < 3 && !this.sim.reveal ? 'AuthVault' : n.kind;
    const trap = n.kind === 'Honeypot' && (n.knowledge >= 3 || this.sim.reveal);
    const stroke = trap ? C.hot : n.owned ? C.owned : k >= 3 ? C.node : C.nodeDim;
    if (n.owned) {
      c.shadowColor = C.owned;
      c.shadowBlur = 14;
    }
    c.fillStyle = n.owned ? C.ownedFill : '#0a1014';
    c.strokeStyle = stroke;
    this.glyph(c, shown, NODE_R);
    c.fill();
    c.stroke();
    c.shadowBlur = 0;
    c.lineWidth = 1.2;
    this.glyphDetail(c, shown, NODE_R, trap);

    // Firewall lock ring: dashed and turning while closed, a faint broken arc once opened.
    if (shown === 'FirewallGate') {
      c.strokeStyle = n.locked ? C.amber : C.linkDim;
      c.lineWidth = 1.5;
      c.setLineDash(n.locked ? [6, 5] : [2, 12]);
      c.lineDashOffset = -t * (n.locked ? 14 : 0);
      c.beginPath();
      c.arc(0, 0, NODE_R * 1.55, 0, TAU);
      c.stroke();
      c.setLineDash([]);
    }
    // Security pips once the node is understood.
    if (k >= 3 || n.owned) {
      c.fillStyle = trap ? C.hot : C.nodeDim;
      for (let i = 0; i < n.security; i++) c.fillRect(-n.security * 3 + i * 6, NODE_R * 1.2 + 14, 4, 4);
    }
    if (n.id === this.sim.session) {
      const pulse = 1 + Math.sin(t * 4) * 0.12;
      c.strokeStyle = C.white;
      c.lineWidth = 1.6;
      c.beginPath();
      c.arc(0, 0, NODE_R * 1.55 * pulse, 0, TAU);
      c.stroke();
    }
    if (n.id === view.selected) {
      c.strokeStyle = C.white;
      c.lineWidth = 1.6;
      const s = NODE_R * 1.9;
      const q = 7;
      c.beginPath();
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        c.moveTo(sx * s, sy * (s - q));
        c.lineTo(sx * s, sy * s);
        c.lineTo(sx * (s - q), sy * s);
      }
      c.stroke();
    } else if (n.id === view.hover) {
      c.strokeStyle = C.textDim;
      c.lineWidth = 1;
      c.beginPath();
      c.arc(0, 0, NODE_R * 1.7, 0, TAU);
      c.stroke();
    }
    c.restore();
  }

  private drawPurgeArcs(c: CanvasRenderingContext2D): void {
    for (const a of this.sim.agents) {
      if (a.purge <= 0 || a.to >= 0) continue;
      const n = this.sim.graph.nodes[a.at]!;
      if (!this.sim.visible(n.id)) continue;
      const f = clamp(a.purge / Tuning.purgeTime, 0, 1);
      c.strokeStyle = C.ice;
      c.lineWidth = 3;
      c.beginPath();
      c.arc(n.x, n.y, NODE_R * 1.3, -Math.PI / 2, -Math.PI / 2 + TAU * f);
      c.stroke();
    }
  }

  private drawAgent(c: CanvasRenderingContext2D, a: IceAgent): void {
    const p = this.agentPos(a);
    const st = a.state;
    const down = st === 'Rebooting';
    const hunt = a.group === 'Hunting';
    const col = down ? C.iceDown : hunt ? C.ice : C.amber;
    const R = ALERT_R[st] ?? 60;
    const pulse = (this.time * (hunt ? 1.4 : 0.7) + a.id * 0.37) % 1;
    c.strokeStyle = col;
    c.lineWidth = 1.2;
    c.globalAlpha = down ? 0.15 : 0.32 * (1 - pulse);
    c.beginPath();
    c.arc(p.x, p.y, R * (0.55 + 0.45 * pulse), 0, TAU);
    c.stroke();
    c.globalAlpha = down ? 0.08 : 0.14;
    c.setLineDash([4, 6]);
    c.beginPath();
    c.arc(p.x, p.y, R, 0, TAU);
    c.stroke();
    c.setLineDash([]);
    c.globalAlpha = 1;
    c.save();
    c.translate(p.x, p.y);
    c.rotate(this.time * (hunt ? 1.6 : 0.5) + a.id);
    c.fillStyle = down ? '#1a1212' : '#12090a';
    c.strokeStyle = col;
    c.lineWidth = 2;
    c.shadowColor = col;
    c.shadowBlur = down ? 0 : 10;
    c.beginPath();
    c.moveTo(0, -9);
    c.lineTo(8, 0);
    c.lineTo(0, 9);
    c.lineTo(-8, 0);
    c.closePath();
    c.fill();
    c.stroke();
    c.shadowBlur = 0;
    c.fillStyle = down ? C.iceDown : '#ffe0d8';
    c.beginPath();
    c.arc(0, 0, 2.6, 0, TAU);
    c.fill();
    c.restore();
  }

  private drawFx(c: CanvasRenderingContext2D): void {
    for (const r of this.fx.rings) {
      if (r.delay > 0) continue;
      c.globalAlpha = (1 - r.t / r.life) * 0.9;
      c.strokeStyle = r.color;
      c.lineWidth = r.width * (1 - r.t / r.life * 0.6);
      c.beginPath();
      c.arc(r.x, r.y, r.r, 0, TAU);
      c.stroke();
    }
    for (const s of this.fx.sparks) {
      c.globalAlpha = 1 - s.t / s.life;
      c.fillStyle = s.color;
      c.fillRect(s.x - 1.2, s.y - 1.2, 2.4, 2.4);
    }
    c.globalAlpha = 1;
  }

  /** F1 overlay on the graph: each agent's planned Dijkstra path, its target, and the blackboard's suspicion hotspots. */
  private drawDebug(c: CanvasRenderingContext2D): void {
    const g = this.sim.graph;
    for (const a of this.sim.agents) {
      const pts = [this.agentPos(a)];
      for (const id of a.path) pts.push({ x: g.nodes[id]!.x, y: g.nodes[id]!.y });
      c.strokeStyle = a.group === 'Hunting' ? C.ice : C.amber;
      c.lineWidth = 2;
      c.setLineDash([2, 5]);
      c.beginPath();
      pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
      c.stroke();
      c.setLineDash([]);
      if (a.target >= 0) {
        const t = g.nodes[a.target]!;
        c.beginPath();
        c.arc(t.x, t.y, NODE_R * 2.1, 0, TAU);
        c.stroke();
      }
    }
    c.fillStyle = C.hot;
    for (const [id, s] of this.sim.bb.hotspots(8)) {
      const n = g.nodes[id]!;
      c.globalAlpha = Math.min(0.5, s * 0.12);
      c.beginPath();
      c.arc(n.x, n.y, NODE_R * (1.4 + s * 0.5), 0, TAU);
      c.fill();
    }
    c.globalAlpha = 1;
  }

  /** Text is drawn in screen space so it stays crisp and the same size at any zoom. */
  private drawLabels(c: CanvasRenderingContext2D, view: ViewState): void {
    c.font = FONT;
    c.textAlign = 'center';
    const z = this.cam.zoom;
    for (const n of this.sim.graph.nodes) {
      if (!this.sim.visible(n.id)) continue;
      const p = this.toScreen(n.x, n.y);
      const k = this.sim.reveal && n.knowledge < 2 && !n.owned ? 2 : n.knowledge;
      if (k < 2 && !n.owned) {
        c.fillStyle = C.nodeDim;
        c.fillText('?', p.x, p.y + 4);
        c.fillStyle = C.textDim;
        c.fillText(n.label, p.x, p.y + NODE_R * z + 15);
        continue;
      }
      const shown: NodeKind = n.kind === 'Honeypot' && n.knowledge < 3 && !this.sim.reveal ? 'AuthVault' : n.kind;
      const trap = n.kind === 'Honeypot' && (n.knowledge >= 3 || this.sim.reveal);
      c.fillStyle = n.owned ? C.owned : trap ? C.hot : C.text;
      c.fillText(n.label, p.x, p.y + NODE_R * z + 15);
      c.fillStyle = trap ? C.hot : C.textDim;
      c.fillText(trap ? 'HONEYPOT' : KIND[shown].short, p.x, p.y + NODE_R * z + 27);
      if (n.id === this.sim.session) {
        c.fillStyle = C.white;
        c.fillText('SESSION', p.x, p.y - NODE_R * z * 1.9);
      } else if (n.id === view.selected && !n.owned && n.locked && k >= 2) {
        c.fillStyle = C.amber;
        c.fillText('LOCKED', p.x, p.y - NODE_R * z * 1.9);
      }
    }
    for (const a of this.sim.agents) {
      if (!this.agentVisible(a)) continue;
      const p = this.agentPos(a);
      const s = this.toScreen(p.x, p.y);
      c.fillStyle = a.state === 'Rebooting' ? C.iceDown : C.ice;
      c.fillText(`ICE-${a.id} ${STATE_TAG[a.state]}`, s.x, s.y - 16);
    }
    c.textAlign = 'start';
  }

  // ---- compositing ----------------------------------------------------------------------------

  /** Scene to screen: shake, chromatic aberration near the trace limit, glitch strips, scanlines, vignette, flash. */
  private present(): void {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const trace = this.sim.trace;
    const stress = clamp((trace - 55) / 45, 0, 1);
    const ab = Math.max(stress * 0.9, this.fx.aberration);
    const sh = this.fx.shakeOffset(this.time);
    const sx = sh.x * this.dpr;
    const sy = sh.y * this.dpr;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    if (ab < 0.03) {
      ctx.drawImage(this.scene, sx, sy);
    } else {
      const off = ab * 5 * this.dpr;
      const passes: [string, number][] = [
        ['rgb(255,0,0)', -off],
        ['rgb(0,255,0)', 0],
        ['rgb(0,0,255)', off],
      ];
      for (const [col, dx] of passes) {
        const t = this.tctx;
        t.globalCompositeOperation = 'source-over';
        t.drawImage(this.scene, 0, 0);
        t.globalCompositeOperation = 'multiply';
        t.fillStyle = col;
        t.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = 'lighter';
        ctx.drawImage(this.tmp, dx + sx, sy);
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    const glitch = Math.max(this.fx.glitch, stress > 0.5 ? (stress - 0.5) * 0.5 : 0);
    if (glitch > 0.05 && Math.random() < glitch * 1.4) {
      for (let i = 0; i < 2; i++) {
        const y = Math.floor(Math.random() * h);
        const sl = Math.floor(6 + Math.random() * 26 * this.dpr);
        ctx.drawImage(this.canvas, 0, y, w, sl, (Math.random() - 0.5) * 36 * this.dpr * glitch, y, w, sl);
      }
    }

    if (this.scanPattern) {
      ctx.globalAlpha = 0.34 + 0.4 * stress;
      ctx.fillStyle = this.scanPattern;
      ctx.fillRect(0, 0, w, h);
    }
    if (stress > 0.15) {
      const y = ((this.time * 140) % (h + 200)) - 100;
      const band = ctx.createLinearGradient(0, y - 60, 0, y + 60);
      band.addColorStop(0, 'rgba(255,90,60,0)');
      band.addColorStop(0.5, `rgba(255,90,60,${0.05 + stress * 0.07})`);
      band.addColorStop(1, 'rgba(255,90,60,0)');
      ctx.globalAlpha = 1;
      ctx.fillStyle = band;
      ctx.fillRect(0, y - 60, w, 120);
    }
    ctx.globalAlpha = 1;
    const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, `rgba(${Math.round(stress * 40)},0,0,0.55)`);
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
    if (this.fx.flash > 0.01) {
      ctx.globalAlpha = clamp(this.fx.flash, 0, 0.85);
      ctx.fillStyle = this.fx.flashColor;
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
    }
  }
}
