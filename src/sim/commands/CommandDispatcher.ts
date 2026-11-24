import { Tuning } from '../config';
import type { Sim } from '../Sim';
import type { CommandName } from '../types';
import { ALL_COMMANDS } from './commands';
import type { CommandResult, ICommand } from './ICommand';

/**
 * The single entry point for player actions. Typing `inject n7` in the terminal and pressing the
 * Inject button on node N07 both end up in `run('inject', 7)`.
 */
export class CommandDispatcher {
  private readonly byName = new Map<CommandName, ICommand>();
  private readonly byWord = new Map<string, ICommand>();

  constructor(private readonly sim: Sim) {
    for (const c of ALL_COMMANDS) {
      this.byName.set(c.name, c);
      for (const a of c.aliases) this.byWord.set(a, c);
    }
  }

  list(): readonly ICommand[] {
    return ALL_COMMANDS;
  }

  get(name: CommandName): ICommand {
    return this.byName.get(name)!;
  }

  resolve(word: string): ICommand | undefined {
    return this.byWord.get(word.toLowerCase());
  }

  /** Null when the command could be issued right now, otherwise why not. Used to grey out buttons. */
  can(name: CommandName, target: number | null): string | null {
    const s = this.sim;
    const c = this.get(name);
    if (s.phase !== 'play') return 'the contract is over';
    if (s.darkTime > 0) return `session dark (${Math.ceil(s.darkTime)}s)`;
    if (c.usesJob && s.jobs.length >= Tuning.maxJobs) return `session busy (${s.jobs.length} jobs running)`;
    if (c.target === 'none' && target !== null) return `${c.name} takes no target`;
    if (c.target === 'required' && target === null) return 'needs a target node';
    return c.check(s, target);
  }

  run(name: CommandName, target: number | null): CommandResult {
    const s = this.sim;
    const reason = this.can(name, target);
    if (reason) {
      s.bus.emit('COMMAND_REJECTED', { cmd: name, reason });
      s.log(`${name}: ${reason}`, 'warn');
      return { ok: false, message: reason };
    }
    const message = this.get(name).execute(s, target);
    s.stats.commands++;
    s.bus.emit('COMMAND_ISSUED', { cmd: name, target });
    s.log(message, 'info');
    return { ok: true, message };
  }
}
