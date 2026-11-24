import { SoundEngine } from './audio/SoundEngine';
import { EventBus } from './core/EventBus';
import { Fx } from './render/Fx';
import { Renderer } from './render/Renderer';
import { CONTRACTS, FIXED_DT, MAX_FRAME_DT, MAX_STEPS_PER_FRAME } from './sim/config';
import { Sim } from './sim/Sim';
import type { CommandName, SimEvents } from './sim/types';
import { DebugOverlay } from './ui/DebugOverlay';
import { Hud, type HudAction, type Screen } from './ui/Hud';
import { NodePanel } from './ui/NodePanel';
import { Terminal } from './ui/Terminal';

const SEED_STEP = 977;
const END_DELAY = 0.9;

/**
 * Composition root. Owns the frame loop (fixed-timestep accumulator, dt clamp, hit-stop), DOM input and
 * screen flow. Subscriptions are made once here or in constructors, so contract changes never stack listeners.
 */
export class Game {
  readonly bus = new EventBus<SimEvents>();
  readonly sim = new Sim(this.bus);
  readonly fx = new Fx(this.bus, this.sim);
  readonly sound = new SoundEngine();
  readonly renderer: Renderer;
  readonly hud: Hud;
  readonly terminal: Terminal;
  readonly panel: NodePanel;
  readonly debug: DebugOverlay;

  screen: Screen = 'title';
  selected = -1;
  hover = -1;
  baseSeed = 1;

  private acc = 0;
  private last = 0;
  private raf = 0;
  private running = false;
  private endTimer = 0;
  private fps = 60;
  private frameMs = 16;
  private simMs = 0;
  private stepsThisSecond = 0;
  private tickRate = 60;
  private rateClock = 0;
  private drag: { x: number; y: number; moved: boolean } | null = null;
  private readonly held = new Set<string>();
  private readonly cleanups: (() => void)[] = [];

  constructor(canvas: HTMLCanvasElement, host: HTMLElement) {
    this.renderer = new Renderer(canvas, this.sim, this.fx);
    this.sound.bind(this.bus);
    this.hud = new Hud(host);
    this.terminal = new Terminal(host, this.sim, this.bus, () => this.sound.key());
    this.panel = new NodePanel(host, this.sim, this.renderer, (cmd, node) => this.exec(cmd, node));
    this.debug = new DebugOverlay(host, this.sim, this.fx);
    this.hud.onAction((a) => this.onAction(a));

    this.baseSeed = this.urlSeed() ?? ((Math.random() * 90000) | 0) + 1;
    this.sim.loadContract(this.baseSeed, 1);
    this.renderer.fit(true);
    this.hud.show('title');

    this.listen<KeyboardEvent>(window, 'keydown', (e) => this.onKey(e));
    this.listen<KeyboardEvent>(window, 'keyup', (e) => this.held.delete(e.code));
    this.listen(window, 'blur', () => this.held.clear());
    this.listen(window, 'resize', () => {
      this.renderer.resize();
      this.renderer.fit(true);
    });
    this.listen<MouseEvent>(canvas, 'mousedown', (e) => this.onDown(e));
    this.listen<MouseEvent>(window, 'mousemove', (e) => this.onMove(e));
    this.listen<MouseEvent>(window, 'mouseup', (e) => this.onUp(e));
    this.listen<WheelEvent>(
      canvas,
      'wheel',
      (e) => {
        e.preventDefault();
        this.renderer.zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
      },
      { passive: false },
    );
    this.listen(document, 'visibilitychange', () => {
      if (document.hidden && this.screen === 'play') this.setScreen('paused');
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  dispose(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    for (const c of this.cleanups) c();
    this.cleanups.length = 0;
    this.fx.dispose();
    this.sound.dispose();
    this.terminal.dispose();
    this.bus.clear();
  }

  private listen<T extends Event>(t: EventTarget, type: string, fn: (e: T) => void, opts?: AddEventListenerOptions): void {
    const h = fn as unknown as EventListener;
    t.addEventListener(type, h, opts);
    this.cleanups.push(() => t.removeEventListener(type, h, opts));
  }

  private urlSeed(): number | null {
    const v = new URLSearchParams(location.search).get('seed');
    const n = v ? parseInt(v, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  // ---- contract flow --------------------------------------------------------------------------

  private contractSeed(level: number): number {
    return this.baseSeed + (level - 1) * SEED_STEP;
  }

  /** Load a contract and clear every piece of presentation state with it. */
  private load(seed: number, level: number): void {
    this.sim.loadContract(seed, level);
    this.fx.clear();
    this.renderer.fit(true);
    this.selected = -1;
    this.acc = 0;
    this.endTimer = 0;
    this.held.clear();
    this.terminal.blur();
    this.setScreen('play');
  }

  startRun(): void {
    this.baseSeed = this.urlSeed() ?? ((Math.random() * 90000) | 0) + 1;
    this.load(this.contractSeed(1), 1);
  }

  /** R: same network, fresh state. */
  retry(): void {
    this.load(this.sim.seed, this.sim.level);
  }

  /** A different network at the same contract level. */
  newSeed(): void {
    const level = this.sim.level;
    this.baseSeed = ((Math.random() * 90000) | 0) + 1;
    this.load(this.contractSeed(level), level);
  }

  nextContract(): void {
    if (this.sim.level >= CONTRACTS) {
      this.setScreen('final');
      return;
    }
    this.load(this.contractSeed(this.sim.level + 1), this.sim.level + 1);
  }

  private setScreen(s: Screen): void {
    this.screen = s;
    if (s !== 'play') this.terminal.blur();
    this.hud.show(s, this.sim);
  }

  /** The single place UI buttons and the terminal's friends call commands. The terminal itself uses runLine. */
  exec(cmd: CommandName, node: number | null): void {
    if (this.screen !== 'play') return;
    this.terminal.echo(node === null ? cmd : `${cmd} ${this.sim.node(node).label.toLowerCase()}`);
    this.sim.dispatcher.run(cmd, node);
  }

  private onAction(a: HudAction): void {
    this.sound.unlock();
    this.sound.click();
    switch (a) {
      case 'start':
      case 'again':
        return this.startRun();
      case 'resume':
        return this.setScreen('play');
      case 'retry':
        return this.retry();
      case 'newseed':
        return this.newSeed();
      case 'next':
        return this.nextContract();
      case 'disconnect':
        return this.exec('disconnect', null);
      default:
        return;
    }
  }

  // ---- input ----------------------------------------------------------------------------------

  private onKey(e: KeyboardEvent): void {
    if (this.terminal.focused) return;
    this.sound.unlock();
    if (['Space', 'Tab', 'F1', 'Slash', 'Backquote'].includes(e.code)) e.preventDefault();
    if (e.code === 'F1') {
      if (!e.repeat) this.debug.toggle();
      return;
    }
    if (e.repeat) {
      if (this.screen === 'play') this.held.add(e.code);
      return;
    }
    if (e.code === 'KeyM') return this.sound.toggleMute();
    if (this.screen === 'title') {
      if (e.code === 'Enter' || e.code === 'Space') this.startRun();
      return;
    }
    if (this.screen === 'final') {
      if (e.code === 'Enter') this.startRun();
      return;
    }
    if (e.code === 'KeyR') return this.retry();
    if (this.screen === 'won') {
      if (e.code === 'Enter') this.nextContract();
      return;
    }
    if (this.screen === 'lost') {
      if (e.code === 'Enter') this.retry();
      else if (e.code === 'KeyN') this.newSeed();
      return;
    }
    if (e.code === 'KeyP' || e.code === 'Escape') {
      if (e.code === 'Escape' && this.selected >= 0) this.selected = -1;
      else this.setScreen(this.screen === 'paused' ? 'play' : 'paused');
      return;
    }
    if (this.screen !== 'play') return;
    if (e.code === 'Backquote' || e.code === 'Slash') {
      this.terminal.focus();
      return;
    }
    if (e.code === 'KeyF') this.renderer.fit();
    this.held.add(e.code);
  }

  private onDown(e: MouseEvent): void {
    this.sound.unlock();
    this.terminal.blur();
    this.drag = { x: e.clientX, y: e.clientY, moved: false };
  }

  private onMove(e: MouseEvent): void {
    if (this.drag) {
      const dx = e.clientX - this.drag.x;
      const dy = e.clientY - this.drag.y;
      if (!this.drag.moved && Math.hypot(dx, dy) > 4) this.drag.moved = true;
      if (this.drag.moved) {
        this.renderer.pan(dx, dy);
        this.drag.x = e.clientX;
        this.drag.y = e.clientY;
      }
    }
    this.hover = (e.target as HTMLElement | null)?.id === 'game' ? this.renderer.pick(e.clientX, e.clientY) : -1;
  }

  private onUp(e: MouseEvent): void {
    const d = this.drag;
    this.drag = null;
    if (!d || d.moved || this.screen !== 'play' || (e.target as HTMLElement | null)?.id !== 'game') return;
    const id = this.renderer.pick(e.clientX, e.clientY);
    this.selected = id === this.selected ? -1 : id;
    if (id >= 0) this.sound.click();
  }

  // ---- loop -----------------------------------------------------------------------------------

  /** Run the sim for `seconds` of game time without waiting for real frames. Used by scripted tests. */
  advance(seconds: number): void {
    const n = Math.round(seconds / FIXED_DT);
    for (let i = 0; i < n; i++) {
      this.sim.update(FIXED_DT);
      if (i % 4 === 0) this.fx.update(FIXED_DT * 4);
    }
    this.checkEnd(seconds);
  }

  private checkEnd(dt: number): void {
    if (this.screen !== 'play' || this.sim.phase === 'play') return;
    this.endTimer += dt;
    if (this.endTimer >= END_DELAY) this.setScreen(this.sim.phase === 'won' ? 'won' : 'lost');
  }

  private frame(now: number): void {
    if (!this.running) return;
    this.raf = requestAnimationFrame((t) => this.frame(t));
    const real = Math.min((now - this.last) / 1000, MAX_FRAME_DT);
    this.last = now;
    this.frameMs = this.frameMs * 0.9 + real * 1000 * 0.1;
    this.fps = this.fps * 0.9 + (1 / Math.max(real, 0.001)) * 0.1;

    const sim = this.sim;
    const t0 = performance.now();
    if (this.screen === 'play' || (this.screen !== 'paused' && sim.phase !== 'play')) {
      if (this.fx.hitStop > 0) {
        this.fx.hitStop -= real;
      } else if (this.screen === 'play') {
        this.acc += real;
        let steps = 0;
        while (this.acc >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
          sim.update(FIXED_DT);
          this.acc -= FIXED_DT;
          steps++;
        }
        if (steps === MAX_STEPS_PER_FRAME) this.acc = 0;
        this.stepsThisSecond += steps;
      }
    }
    this.simMs = this.simMs * 0.9 + (performance.now() - t0) * 0.1;
    this.rateClock += real;
    if (this.rateClock >= 1) {
      this.tickRate = this.stepsThisSecond / this.rateClock;
      this.stepsThisSecond = 0;
      this.rateClock = 0;
    }

    this.fx.update(real);
    this.renderer.update(real);
    this.panCamera(real);
    this.checkEnd(real);

    this.terminal.updatePrompt();
    this.hud.update(sim);
    this.panel.update(this.screen === 'play' ? this.selected : -1);
    this.panel.el.classList.toggle('flip', this.selected >= 0 && this.renderer.toScreen(sim.node(this.selected).x, 0).x > this.renderer.W * 0.6);
    this.debug.update(real, { fps: this.fps, frameMs: this.frameMs, tickRate: this.tickRate, simMs: this.simMs });
    this.sound.setTension(sim.trace / 100, sim.lockdown, this.screen === 'play');
    this.renderer.draw({ selected: this.selected, hover: this.hover, debug: this.debug.visible });
  }

  private panCamera(dt: number): void {
    if (this.screen !== 'play' || this.terminal.focused) return;
    let dx = 0;
    let dy = 0;
    if (this.held.has('ArrowLeft') || this.held.has('KeyA')) dx += 1;
    if (this.held.has('ArrowRight') || this.held.has('KeyD')) dx -= 1;
    if (this.held.has('ArrowUp') || this.held.has('KeyW')) dy += 1;
    if (this.held.has('ArrowDown') || this.held.has('KeyS')) dy -= 1;
    if (dx || dy) this.renderer.pan(dx * 520 * dt, dy * 520 * dt);
  }
}
