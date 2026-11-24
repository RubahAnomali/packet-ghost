import type { Renderer } from '../render/Renderer';
import { KIND } from '../sim/config';
import type { Sim } from '../sim/Sim';
import type { CommandName } from '../sim/types';

const RING: { cmd: CommandName; label: string }[] = [
  { cmd: 'scan', label: 'SCAN' },
  { cmd: 'probe', label: 'PROBE' },
  { cmd: 'inject', label: 'INJECT' },
  { cmd: 'spoof', label: 'SPOOF' },
  { cmd: 'pivot', label: 'PIVOT' },
  { cmd: 'decoy', label: 'DECOY' },
  { cmd: 'wipe', label: 'WIPE' },
  { cmd: 'nuke', label: 'NUKE' },
];

/**
 * Radial action ring around the selected node. Every button calls the same dispatcher entry point the
 * terminal does; it only decides which buttons look usable by asking `can()`.
 */
export class NodePanel {
  readonly el = document.createElement('div');
  private readonly card = document.createElement('div');
  private readonly buttons = new Map<CommandName, HTMLButtonElement>();
  private hoverCmd: CommandName | null = null;
  private readonly cache = new Map<CommandName, string>();
  private cardText = '';
  private node = -1;

  constructor(
    host: HTMLElement,
    private readonly sim: Sim,
    private readonly renderer: Renderer,
    private readonly run: (cmd: CommandName, node: number | null) => void,
  ) {
    this.el.id = 'radial';
    this.el.hidden = true;
    this.card.className = 'card';
    this.el.append(this.card);
    RING.forEach((r, i) => {
      const a = (i / RING.length) * Math.PI * 2 - Math.PI / 2;
      const b = document.createElement('button');
      b.className = 'rb';
      b.textContent = r.label;
      b.style.left = `${Math.cos(a) * 84 - 22}px`;
      b.style.top = `${Math.sin(a) * 84 - 22}px`;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.node >= 0 && !b.classList.contains('off')) this.run(r.cmd, this.arg(r.cmd, this.node));
      });
      b.addEventListener('mouseenter', () => (this.hoverCmd = r.cmd));
      b.addEventListener('mouseleave', () => (this.hoverCmd = null));
      b.addEventListener('mousedown', (e) => e.stopPropagation());
      this.buttons.set(r.cmd, b);
      this.el.append(b);
    });
    this.el.addEventListener('mousedown', (e) => e.stopPropagation());
    host.append(this.el);
  }

  /** A bare `scan` means "around my session", so on the session node the ring sends no target. */
  private arg(cmd: CommandName, node: number): number | null {
    return cmd === 'scan' && node === this.sim.session ? null : node;
  }

  private describe(id: number): string {
    const s = this.sim;
    const n = s.node(id);
    const known = n.knowledge >= 2 || n.owned;
    const disguised = n.kind === 'Honeypot' && n.knowledge < 3 && !s.reveal;
    const type = !known ? 'Unknown host' : disguised ? KIND.AuthVault.name : KIND[n.kind].name;
    const status = n.owned ? 'OWNED' : s.isFrontier(id) ? 'in reach' : 'out of reach';
    const lines = [`${n.label}  ${type}`, `${status}${n.id === s.session ? ' | session' : ''}${known && n.locked && !n.owned ? ' | firewall locked' : ''}${n.knowledge >= 3 || n.owned ? ` | security ${n.security}` : ''}`];
    if (this.hoverCmd) {
      const c = s.dispatcher.get(this.hoverCmd);
      const why = s.dispatcher.can(this.hoverCmd, this.arg(this.hoverCmd, id));
      lines.push('', c.usage, why ? `x ${why}` : c.summary);
    } else if (known && !disguised) lines.push('', KIND[n.kind].blurb);
    else if (disguised) lines.push('', KIND.AuthVault.blurb);
    return lines.join('\n');
  }

  /** Call every frame. `node` is the selected node id or -1. */
  update(node: number): void {
    const show = node >= 0 && this.sim.visible(node) && this.sim.phase === 'play';
    this.el.hidden = !show;
    this.node = show ? node : -1;
    if (!show) return;
    const p = this.renderer.toScreen(this.sim.node(node).x, this.sim.node(node).y);
    const margin = 120;
    const x = Math.min(Math.max(p.x, margin), this.renderer.W - margin);
    const y = Math.min(Math.max(p.y, margin), this.renderer.H - margin - 30);
    this.el.style.transform = `translate(${x}px, ${y}px)`;
    for (const [cmd, b] of this.buttons) {
      const why = this.sim.dispatcher.can(cmd, this.arg(cmd, node));
      const key = why ?? '';
      if (this.cache.get(cmd) === `${node}|${key}`) continue;
      this.cache.set(cmd, `${node}|${key}`);
      b.classList.toggle('off', why !== null);
      b.title = why ? `${cmd}: ${why}` : this.sim.dispatcher.get(cmd).summary;
    }
    const text = this.describe(node);
    if (text !== this.cardText) {
      this.cardText = text;
      this.card.textContent = text;
    }
  }
}
