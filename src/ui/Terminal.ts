import type { EventBus } from '../core/EventBus';
import { KIND } from '../sim/config';
import { runLine } from '../sim/commands/CommandLine';
import type { Sim } from '../sim/Sim';
import type { LogTone, SimEvents } from '../sim/types';

const META = ['help', 'clear', 'status', 'nodes'];
const MAX_LINES = 140;

/**
 * Docked console. Game commands are handed to `runLine`, which goes through the same dispatcher the
 * node buttons use; only `help`, `clear`, `status` and `nodes` live here because they print, not act.
 */
export class Terminal {
  readonly el = document.createElement('div');
  private readonly logEl = document.createElement('div');
  private readonly prompt = document.createElement('span');
  readonly input = document.createElement('input');
  private readonly history: string[] = [];
  private histPos = -1;
  private draft = '';
  private tab: { stem: string; list: string[]; i: number } | null = null;
  private readonly off: (() => void)[] = [];

  constructor(
    host: HTMLElement,
    private readonly sim: Sim,
    bus: EventBus<SimEvents>,
    private readonly onKey: () => void,
  ) {
    this.el.id = 'term';
    this.logEl.id = 'termlog';
    const row = document.createElement('div');
    row.id = 'termrow';
    this.prompt.id = 'prompt';
    this.input.id = 'cmd';
    this.input.type = 'text';
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.input.placeholder = "type a command, or 'help'   (` or / to focus)";
    row.append(this.prompt, this.input);
    this.el.append(this.logEl, row);
    host.append(this.el);

    this.off.push(bus.on('LOG', (e) => this.log(e.text, e.tone)));
    this.off.push(bus.on('CONTRACT_STARTED', () => this.clear()));
    this.input.addEventListener('keydown', (e) => this.keydown(e));
    this.input.addEventListener('focus', () => this.el.classList.add('focus'));
    this.input.addEventListener('blur', () => this.el.classList.remove('focus'));
  }

  dispose(): void {
    for (const o of this.off) o();
    this.off.length = 0;
    this.el.remove();
  }

  get focused(): boolean {
    return document.activeElement === this.input;
  }

  focus(): void {
    this.input.focus();
  }

  blur(): void {
    this.input.blur();
  }

  /** Refresh the prompt so it always names the current session node. */
  updatePrompt(): void {
    const t = `ghost@${this.sim.graph.nodes[this.sim.session]!.label.toLowerCase()} >`;
    if (this.prompt.textContent !== t) this.prompt.textContent = t;
  }

  clear(): void {
    this.logEl.textContent = '';
  }

  log(text: string, tone: LogTone | 'echo' = 'info'): void {
    const d = document.createElement('div');
    d.className = `l ${tone}`;
    d.textContent = text;
    this.logEl.append(d);
    while (this.logEl.childElementCount > MAX_LINES) this.logEl.firstElementChild?.remove();
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  echo(line: string): void {
    this.log(`> ${line}`, 'echo');
  }

  // ---- input ----------------------------------------------------------------------------------

  private keydown(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.key === 'Tab') {
      e.preventDefault();
      this.complete(e.shiftKey);
      return;
    }
    this.tab = null;
    if (e.key === 'Enter') {
      e.preventDefault();
      this.submit(this.input.value);
      this.input.value = '';
      return;
    }
    if (e.key === 'Escape' || e.key === '`' || e.key === '~') {
      e.preventDefault();
      this.blur();
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (!this.history.length) return;
      if (this.histPos < 0) this.draft = this.input.value;
      this.histPos = e.key === 'ArrowUp' ? Math.min(this.history.length - 1, this.histPos + 1) : this.histPos - 1;
      this.input.value = this.histPos < 0 ? this.draft : this.history[this.history.length - 1 - this.histPos]!;
      return;
    }
    if (e.key.length === 1 || e.key === 'Backspace') this.onKey();
  }

  submit(line: string): void {
    const text = line.trim();
    if (!text) return;
    this.history.push(text);
    if (this.history.length > 60) this.history.shift();
    this.histPos = -1;
    this.echo(text);
    this.exec(text);
  }

  /** Runs one line. Game commands go to the dispatcher; the rest print. */
  private exec(text: string): void {
    const word = text.split(/\s+/)[0]!.toLowerCase();
    if (word === 'help' || word === 'h' || word === '?') return this.help();
    if (word === 'clear' || word === 'cls') return this.clear();
    if (word === 'status' || word === 'st') return this.status();
    if (word === 'nodes' || word === 'ls') return this.nodes();
    if (runLine(this.sim, text) === undefined) this.log(`unknown command '${word}'. Type 'help'.`, 'warn');
  }

  private help(): void {
    this.log('COMMANDS  (targets: N07, n7 or 7)', 'good');
    for (const c of this.sim.dispatcher.list()) {
      this.log(`  ${c.usage.padEnd(16)} ${c.summary}`, 'info');
      this.log(`  ${''.padEnd(16)} aliases: ${c.aliases.filter((a) => a !== c.name).join(', ') || 'none'}`, 'echo');
    }
    this.log('  help, clear, status, nodes (ls)   Tab completes, Up/Down recalls history.', 'info');
    this.log('KEYS  ` or / console, click a node for its action ring, drag pan, wheel zoom, F fit, P pause, R restart, M mute, F1 inspector.', 'info');
    this.log('GOAL  crack an Auth Vault for the key (beware honeypots: probe first), then breach the Core before trace hits 100%.', 'info');
  }

  private status(): void {
    const s = this.sim;
    this.log(
      `trace ${s.trace.toFixed(1)}% (+${s.traceRate.toFixed(2)}/s)${s.lockdown ? ' LOCKDOWN' : ''} | session ${s.node(s.session).label}, ${s.routeHops} hop${s.routeHops === 1 ? '' : 's'} | creds ${s.creds}, key ${s.keys}, decoys ${s.decoys}, bombs ${s.nukes} | owned ${s.ownedCount()}`,
      'info',
    );
    this.log(`jobs ${s.jobs.length}/3 | wipe ${s.wipeCd > 0 ? Math.ceil(s.wipeCd) + 's' : 'ready'} | disconnect ${s.darkCd > 0 ? Math.ceil(s.darkCd) + 's' : 'ready'}`, 'info');
  }

  private nodes(): void {
    const s = this.sim;
    for (const n of s.graph.nodes) {
      if (!s.visible(n.id)) continue;
      const known = n.knowledge >= 2 || n.owned;
      const type = known ? (n.kind === 'Honeypot' && n.knowledge < 3 ? KIND.AuthVault.name : KIND[n.kind].name) : '?';
      const flags = [n.owned ? 'owned' : s.isFrontier(n.id) ? 'reachable' : 'far', n.id === s.session ? 'session' : '', n.locked && known ? 'locked' : '', n.knowledge >= 3 && n.kind === 'Honeypot' ? 'HONEYPOT' : '']
        .filter(Boolean)
        .join(', ');
      this.log(`  ${n.label}  ${type.padEnd(18)} ${flags}`, n.owned ? 'good' : 'info');
    }
  }

  // ---- completion -----------------------------------------------------------------------------

  private complete(back: boolean): void {
    const val = this.input.value;
    const parts = val.split(/\s+/);
    const first = parts.length <= 1;
    if (!this.tab) {
      const stem = parts[parts.length - 1]!.toLowerCase();
      const pool = first
        ? [...new Set([...this.sim.dispatcher.list().flatMap((c) => c.aliases), ...META])]
        : this.sim.graph.nodes.filter((n) => this.sim.visible(n.id)).map((n) => n.label.toLowerCase());
      const list = pool.filter((w) => w.startsWith(stem)).sort();
      if (!list.length) return;
      this.tab = { stem, list, i: back ? list.length - 1 : 0 };
    } else {
      const n = this.tab.list.length;
      this.tab.i = (this.tab.i + (back ? -1 : 1) + n) % n;
    }
    parts[parts.length - 1] = this.tab.list[this.tab.i]!;
    this.input.value = parts.join(' ') + (first && this.tab.list.length === 1 ? ' ' : '');
  }
}
