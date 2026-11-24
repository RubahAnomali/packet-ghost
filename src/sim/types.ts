export type NodeKind =
  | 'EntryProxy'
  | 'DMZRouter'
  | 'FirewallGate'
  | 'AuthVault'
  | 'Honeypot'
  | 'CoreMainframe'
  | 'AdminWorkstation'
  | 'LogServer';

/** 0 = unseen, 1 = detected ("?"), 2 = scanned (type visible), 3 = probed (true type, security, lock). */
export type Knowledge = 0 | 1 | 2 | 3;

export interface NetworkNode {
  id: number;
  /** Type-neutral address, e.g. "N07". Never reveals the archetype. */
  label: string;
  kind: NodeKind;
  layer: number;
  x: number;
  y: number;
  /** 1..3, scales breach time and noise. */
  security: number;
  knowledge: Knowledge;
  owned: boolean;
  /** Firewall lock ring: closed until spoofed or brute-forced. */
  locked: boolean;
  /** Accumulated weighted noise not yet turned into an anomaly report. */
  noiseAcc: number;
}

export interface NetworkLink {
  id: number;
  a: number;
  b: number;
  /** Seconds a packet needs to cross. */
  latency: number;
  /** Curve bend as a fraction of the link length. */
  bend: number;
  /** Noise left on the wire by exploits. Pulls ICE toward it. */
  alertHeat: number;
}

export type CommandName = 'scan' | 'probe' | 'spoof' | 'pivot' | 'inject' | 'decoy' | 'wipe' | 'nuke' | 'disconnect';

export type IceState = 'Patrol' | 'Investigate' | 'Triangulate' | 'Lockdown' | 'Rebooting';
export type IceGroup = 'Searching' | 'Hunting' | 'Down';
export type IceRole = 'chaser' | 'cutter' | 'flanker' | 'sweeper';

export type LogTone = 'info' | 'good' | 'warn' | 'bad';

export interface SimEvents {
  CONTRACT_STARTED: { seed: number; level: number };
  NODE_COMPROMISED: { node: number; how: 'inject' | 'spoof' };
  NODE_PURGED: { node: number; by: number };
  ALERT_TRIGGERED: { node: number; level: number; fake: boolean };
  TRACE_INCREASED: { delta: number; trace: number; source: string };
  PACKET_DELIVERED: { job: number; cmd: CommandName; target: number };
  AGENT_STATE_CHANGED: { agent: number; from: IceState; to: IceState };
  CORE_BREACHED: { score: number };
  CONTRACT_LOST: { reason: string };
  COMMAND_ISSUED: { cmd: CommandName; target: number | null };
  COMMAND_REJECTED: { cmd: CommandName; reason: string };
  SCAN_PING: { node: number };
  PROBED: { node: number; kind: NodeKind };
  TRIPWIRE: { node: number; dx: number; dy: number };
  VAULT_CRACKED: { node: number };
  HONEYPOT_TRIGGERED: { node: number };
  DECOY: { node: number };
  NUKE: { node: number };
  WIPE: { node: number; global: boolean };
  LOCKDOWN: { on: boolean };
  SESSION_MOVED: { node: number };
  DARK: { on: boolean };
  LOG: { text: string; tone: LogTone };
}
