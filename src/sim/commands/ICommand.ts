import type { Job, Sim } from '../Sim';
import type { CommandName } from '../types';

export interface CommandResult {
  ok: boolean;
  message: string;
}

/**
 * One player action. The CLI and the node context menu both go through `CommandDispatcher.run`, which
 * calls `check` and then `execute`, so there is exactly one code path per action.
 */
export interface ICommand {
  readonly name: CommandName;
  readonly aliases: readonly string[];
  readonly usage: string;
  readonly summary: string;
  readonly target: 'none' | 'optional' | 'required';
  /** Whether it occupies one of the session's job slots. */
  readonly usesJob: boolean;
  /** Null when the command could run now, otherwise the reason it cannot. */
  check(sim: Sim, target: number | null): string | null;
  /** Starts the action (usually a job) and returns the line to show the player. */
  execute(sim: Sim, target: number | null): string;
  /** Runs when a job finishes its work phase. */
  complete?(sim: Sim, job: Job): void;
}
