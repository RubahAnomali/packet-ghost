import { FIXED_DT, Tuning } from '../sim/config';
import type { Sim } from '../sim/Sim';
import type { Fx } from '../render/Fx';

export interface DebugStats {
  fps: number;
  frameMs: number;
  tickRate: number;
  simMs: number;
}

const SLIDERS: { key: keyof typeof Tuning; min: number; max: number; step: number }[] = [
  { key: 'traceBase', min: 0, max: 1, step: 0.01 },
  { key: 'iceSpeed', min: 0.3, max: 2.5, step: 0.05 },
  { key: 'purgeTime', min: 1, max: 12, step: 0.1 },
  { key: 'heatDecay', min: 0, max: 0.3, step: 0.005 },
  { key: 'iceHeatPull', min: 0, max: 5, step: 0.1 },
  { key: 'lockdownAt', min: 40, max: 100, step: 1 },
  { key: 'traceFromNoise', min: 0, max: 3, step: 0.05 },
  { key: 'reportEvery', min: 0.2, max: 4, step: 0.1 },
];

/** F1 inspector: performance, pools, the AI blackboard, every agent's HFSM state and plan, plus tuning sliders. */
export class DebugOverlay {
  readonly el = document.createElement('div');
  private readonly info = document.createElement('pre');
  private readonly ai = document.createElement('pre');
  private readonly revealBtn = document.createElement('button');
  private acc = 0;

  constructor(
    host: HTMLElement,
    private readonly sim: Sim,
    private readonly fx: Fx,
  ) {
    this.el.id = 'debug';
    this.el.hidden = true;
    const h = document.createElement('h3');
    h.textContent = 'INSPECTOR  (F1)';
    this.el.append(h, this.info, this.ai);

    const row = document.createElement('div');
    row.className = 'row';
    this.revealBtn.textContent = 'Reveal fog: off';
    this.revealBtn.addEventListener('click', () => {
      sim.reveal = !sim.reveal;
      this.revealBtn.textContent = `Reveal fog: ${sim.reveal ? 'on' : 'off'}`;
    });
    const btn = (label: string, fn: () => void): void => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', fn);
      row.append(b);
    };
    row.append(this.revealBtn);
    btn('+10 trace', () => sim.addTrace(10, 'debug'));
    btn('trace 0', () => (sim.trace = 0));
    btn('+2 creds', () => (sim.creds += 2));
    btn('+key', () => (sim.keys += 1));
    btn('+bomb', () => (sim.nukes += 1));
    btn('+decoy', () => (sim.decoys += 1));
    btn('reset cooldowns', () => {
      sim.wipeCd = 0;
      sim.darkCd = 0;
    });
    this.el.append(row);

    for (const s of SLIDERS) {
      const w = document.createElement('label');
      w.className = 'slider';
      const name = document.createElement('span');
      name.textContent = s.key;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(s.min);
      input.max = String(s.max);
      input.step = String(s.step);
      input.value = String(Tuning[s.key]);
      const val = document.createElement('span');
      val.textContent = String(Tuning[s.key]);
      input.addEventListener('input', () => {
        Tuning[s.key] = Number(input.value);
        val.textContent = input.value;
      });
      w.append(name, input, val);
      this.el.append(w);
    }
    host.append(this.el);
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  toggle(): void {
    this.el.hidden = !this.el.hidden;
  }

  update(dt: number, perf: DebugStats): void {
    if (this.el.hidden) return;
    this.acc += dt;
    if (this.acc < 0.15) return;
    this.acc = 0;
    const s = this.sim;
    const pool = s.packetPool;
    const job = s.packets.filter((p) => p.kind !== 'ambient').length;
    const label = (id: number): string => (id >= 0 ? s.graph.nodes[id]!.label : '-');
    this.info.textContent = [
      `fps ${perf.fps.toFixed(0)}   frame ${perf.frameMs.toFixed(1)}ms   sim ${perf.simMs.toFixed(2)}ms`,
      `tick ${perf.tickRate.toFixed(0)} Hz (fixed ${(1 / FIXED_DT).toFixed(0)})   sim time ${s.time.toFixed(1)}s`,
      `seed ${s.seed}   level ${s.level}   graph attempts ${s.attempts}   nodes ${s.graph.nodes.length}   links ${s.graph.edges.length}`,
      `packets active ${s.packets.length} (cmd ${job}, ambient ${s.packets.length - job})   pooled ${pool.available}   allocated ${pool.allocated}`,
      `fx rings ${this.fx.rings.length}/${this.fx.pooled.rings}   sparks ${this.fx.sparks.length}/${this.fx.pooled.sparks}   (active/pooled)`,
      `trace ${s.trace.toFixed(1)} (+${s.traceRate.toFixed(2)}/s)   lockdown ${s.lockdown}   hold ${s.lockdownHold.toFixed(1)}   dark ${s.darkTime.toFixed(1)}`,
      `jobs ${s.jobs.length}: ${s.jobs.map((j) => `${j.cmd}>${label(j.target)}${j.phase === 'travel' ? '~' : ` ${(j.t / Math.max(0.01, j.work)).toFixed(0)}`}`).join(' ') || '-'}`,
    ].join('\n');

    const bb = s.bb;
    const lines = ['-- AI BLACKBOARD --'];
    lines.push(`reports ${bb.reports.length}: ${bb.reports.slice(-6).map((r) => `${label(r.node)}${r.fake ? '*' : ''}`).join(' ') || '-'}`);
    lines.push(`suspicion: ${bb.hotspots(6).map(([n, v]) => `${label(n)}=${v.toFixed(1)}`).join('  ') || '-'}`);
    lines.push(`confirmed: ${[...bb.confirmed.keys()].map(label).join(' ') || '-'}   last ${label(bb.lastKnown)}`);
    lines.push(`reserved: ${bb.reservationList().map(([n, a]) => `${label(n)}<-ICE${a.join(',')}`).join('  ') || '-'}`);
    lines.push('-- ICE AGENTS (HFSM) --');
    for (const a of s.agents) {
      lines.push(`ICE-${a.id} ${a.group}/${a.state} at ${label(a.at)}${a.to >= 0 ? `>${label(a.to)}` : ''} role ${a.role ?? '-'} tgt ${label(a.target)} purge ${a.purge.toFixed(1)}`);
      lines.push(`   plan: ${[label(a.at), ...a.path.map(label)].join(' > ')}   rejected ${a.fsm.rejected}   hist ${a.fsm.history.slice(-3).join('>') || '-'}`);
    }
    this.ai.textContent = lines.join('\n');
  }
}
