import { CONTRACTS } from '../sim/config';
import type { Sim } from '../sim/Sim';

export type Screen = 'title' | 'play' | 'paused' | 'won' | 'lost' | 'final';
export type HudAction = 'start' | 'resume' | 'retry' | 'newseed' | 'next' | 'again' | 'disconnect' | 'mute' | 'help';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

/** Top bar (trace, resources, cooldowns) and the full-screen panels for title, pause and results. */
export class Hud {
  private readonly bar = el('div');
  private readonly screenEl = el('div');
  private readonly contract = el('div', 'contract');
  private readonly pct = el('b');
  private readonly fill = el('div');
  private readonly banner = el('div', 'banner');
  private readonly stats = el('div', 'stats');
  private readonly chips = new Map<string, HTMLElement>();
  private readonly dcBtn = el('button', 'chip btn', 'DISCONNECT');
  private cb: (a: HudAction) => void = () => {};
  private shown: Screen | '' = '';

  constructor(host: HTMLElement) {
    this.bar.id = 'hud';
    const left = el('div', 'hud-left');
    left.append(el('div', 'brand', 'PACKET GHOST'), this.contract);
    const mid = el('div', 'hud-trace');
    const lab = el('div', 'trace-label');
    lab.append(el('span', '', 'TRACE'), this.pct);
    const bar = el('div', 'bar');
    this.fill.id = 'tracefill';
    bar.append(this.fill);
    for (const at of [55, 82]) {
      const t = el('i', 'tick');
      t.style.left = `${at}%`;
      bar.append(t);
    }
    mid.append(lab, bar, this.banner);
    for (const k of ['CREDS', 'KEY', 'DECOY', 'BOMB', 'HOPS', 'WIPE', 'ICE']) {
      const c = el('div', 'chip');
      this.chips.set(k, c);
      this.stats.append(c);
    }
    this.dcBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.cb('disconnect');
    });
    this.dcBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    this.stats.append(this.dcBtn);
    const right = el('div', 'hud-right');
    right.append(this.stats);
    this.bar.append(left, mid, right);

    this.screenEl.id = 'screen';
    this.screenEl.hidden = true;
    this.screenEl.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button[data-act]') as HTMLElement | null;
      if (b) this.cb(b.dataset.act as HudAction);
    });
    host.append(this.bar, this.screenEl);
  }

  onAction(cb: (a: HudAction) => void): void {
    this.cb = cb;
  }

  private setChip(k: string, text: string, tone = ''): void {
    const c = this.chips.get(k)!;
    const full = `${k} ${text}`;
    if (c.textContent !== full) c.textContent = full;
    const cls = `chip ${tone}`.trim();
    if (c.className !== cls) c.className = cls;
  }

  update(sim: Sim): void {
    const t = `${sim.level}/${CONTRACTS}  seed ${sim.seed}`;
    const label = `CONTRACT ${t}`;
    if (this.contract.textContent !== label) this.contract.textContent = label;
    const pct = `${sim.trace.toFixed(0)}%`;
    if (this.pct.textContent !== pct) this.pct.textContent = pct;
    this.fill.style.width = `${sim.trace}%`;
    const tone = sim.trace >= 82 ? 'crit' : sim.trace >= 55 ? 'warn' : '';
    if (this.fill.className !== tone) this.fill.className = tone;
    const msg = sim.darkTime > 0 ? `SESSION DARK ${Math.ceil(sim.darkTime)}s: trace paused, ICE is blind` : sim.lockdown ? 'LOCKDOWN: ICE purging, trace x1.5' : '';
    if (this.banner.textContent !== msg) {
      this.banner.textContent = msg;
      this.banner.className = `banner ${sim.darkTime > 0 ? 'dark' : sim.lockdown ? 'lock' : ''}`;
    }
    this.setChip('CREDS', String(sim.creds), sim.creds ? 'ok' : '');
    this.setChip('KEY', sim.keys ? 'YES' : 'no', sim.keys ? 'ok' : '');
    this.setChip('DECOY', String(sim.decoys));
    this.setChip('BOMB', String(sim.nukes));
    this.setChip('HOPS', String(sim.routeHops));
    this.setChip('WIPE', sim.wipeCd > 0 ? `${Math.ceil(sim.wipeCd)}s` : 'ready', sim.wipeCd > 0 ? 'cool' : 'ok');
    this.setChip('ICE', `${sim.agents.filter((a) => a.group === 'Hunting').length}/${sim.agents.length} hunting`, sim.agents.some((a) => a.group === 'Hunting') ? 'warn' : '');
    const dc = sim.darkCd > 0 ? `DISCONNECT ${Math.ceil(sim.darkCd)}s` : 'DISCONNECT';
    if (this.dcBtn.textContent !== dc) this.dcBtn.textContent = dc;
    this.dcBtn.classList.toggle('off', sim.darkCd > 0 || sim.darkTime > 0);
  }

  // ---- screens --------------------------------------------------------------------------------

  show(kind: Screen, sim?: Sim): void {
    if (kind === this.shown && kind !== 'won' && kind !== 'lost') return;
    this.shown = kind;
    const s = this.screenEl;
    s.hidden = kind === 'play';
    s.textContent = '';
    if (kind === 'play') return;
    const panel = el('div', 'panel');
    const btn = (act: HudAction, text: string, key: string, primary = false): HTMLButtonElement => {
      const b = el('button', primary ? 'pbtn primary' : 'pbtn');
      b.dataset.act = act;
      b.append(el('span', '', text), el('kbd', '', key));
      return b;
    };
    const row = el('div', 'prow');
    if (kind === 'title') {
      panel.append(
        el('h1', '', 'PACKET GHOST'),
        el('p', 'sub', 'Real-time network infiltration. You are a ghost in somebody else\'s wires.'),
        el('ul', 'how'),
      );
      const ul = panel.querySelector('ul')!;
      for (const t of [
        'Scan, probe and breach your way across a corporate network, one node at a time.',
        'Every exploit is loud. Noise leaves heat on the wire and tells the ICE hunters where to look.',
        'Crack an Auth Vault for the core key, then breach the Core before TRACE reaches 100%.',
        'One vault is a honeypot. Probe before you inject, and spoof firewalls with stolen credentials.',
        'Bounce through proxies to trace slower. Decoy, wipe, disconnect or nuke when the hunters close in.',
      ])
        ul.append(el('li', '', t));
      row.append(btn('start', 'Begin contract', 'Enter', true));
    } else if (kind === 'paused') {
      panel.append(el('h1', '', 'PAUSED'), el('p', 'sub', 'The trace waits for nobody except you.'));
      row.append(btn('resume', 'Resume', 'P', true), btn('retry', 'Restart this seed', 'R'));
    } else if (kind === 'won' && sim) {
      panel.append(
        el('h1', 'good', 'CORE BREACHED'),
        el('p', 'sub', `Contract ${sim.level} of ${CONTRACTS} complete.`),
        el('p', 'big', `${sim.score}`),
        el('p', 'sub', `trace ${sim.trace.toFixed(0)}%  |  time ${sim.time.toFixed(0)}s  |  ${sim.stats.commands} commands  |  ${sim.stats.purged} nodes purged`),
      );
      row.append(btn('next', sim.level >= CONTRACTS ? 'Finish' : 'Next contract', 'Enter', true), btn('retry', 'Replay seed', 'R'));
    } else if (kind === 'lost' && sim) {
      panel.append(el('h1', 'bad', 'TRACED'), el('p', 'sub', 'They found the other end of the wire.'), el('p', 'sub', `survived ${sim.time.toFixed(0)}s  |  ${sim.ownedCount()} nodes held at the end`));
      row.append(btn('retry', 'Retry same seed', 'R', true), btn('newseed', 'New seed', 'N'));
    } else if (kind === 'final') {
      panel.append(el('h1', 'good', 'ALL CONTRACTS CLEAR'), el('p', 'sub', 'Three networks breached and not a single squeal from the ICE. Probably.'));
      row.append(btn('again', 'New run', 'Enter', true));
    }
    panel.append(row);
    if (kind === 'title' || kind === 'paused') {
      const k = el('p', 'keys', '` or / console   click node: action ring   drag: pan   wheel: zoom   F: fit   P: pause   R: restart   M: mute   F1: inspector');
      panel.append(k);
    }
    s.append(panel);
  }
}
