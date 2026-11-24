import type { Sim } from '../Sim';
import type { CommandName } from '../types';
import type { CommandResult } from './ICommand';

/** "N07", "n7" and "7" all name the same node. Returns null when the node does not exist or is not visible. */
export function parseNodeRef(sim: Sim, word: string): number | null {
  const m = /^n?0*(\d+)$/i.exec(word.trim());
  if (!m) return null;
  const label = `N${m[1]!.padStart(2, '0')}`;
  const node = sim.graph.nodes.find((n) => n.label === label);
  return node && sim.visible(node.id) ? node.id : null;
}

/**
 * Pure text front end for game commands. Returns undefined when the first word is not a game command
 * (so the terminal can try its own meta commands), otherwise the dispatcher's result.
 */
export function runLine(sim: Sim, line: string): CommandResult | undefined {
  const [word, arg, ...rest] = line.trim().split(/\s+/);
  if (!word) return undefined;
  const cmd = sim.dispatcher.resolve(word);
  if (!cmd) return undefined;
  if (rest.length) return reject(sim, cmd.name, `usage: ${cmd.usage}`);
  let target: number | null = null;
  if (arg !== undefined) {
    if (cmd.target === 'none') return reject(sim, cmd.name, `usage: ${cmd.usage}`);
    target = parseNodeRef(sim, arg);
    if (target === null) return reject(sim, cmd.name, `unknown node '${arg}'`);
  } else if (cmd.target === 'required') {
    return reject(sim, cmd.name, `usage: ${cmd.usage}`);
  }
  return sim.dispatcher.run(cmd.name, target);
}

function reject(sim: Sim, name: CommandName, message: string): CommandResult {
  sim.bus.emit('COMMAND_REJECTED', { cmd: name, reason: message });
  sim.log(`${name}: ${message}`, 'warn');
  return { ok: false, message };
}
