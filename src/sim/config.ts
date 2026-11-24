import type { NodeKind } from './types';

/** Simulation step. Everything time-based (trace, travel, purge, AI) advances in these exact increments. */
export const FIXED_DT = 1 / 60;
/** A long frame (tab switch, GC pause) is clamped to this many seconds so timers never jump. */
export const MAX_FRAME_DT = 0.05;
export const MAX_STEPS_PER_FRAME = 6;
export const CONTRACTS = 3;

export interface KindInfo {
  short: string;
  name: string;
  /** Base brute-force seconds (scaled by security). */
  injectTime: number;
  /** Noise per second while breaching. */
  noise: number;
  /** How readily this node's monitors turn noise into anomaly reports. */
  monitor: number;
  /** Instant trace added when the node falls. */
  breachTrace: number;
  blurb: string;
}

export const KIND: Record<NodeKind, KindInfo> = {
  EntryProxy: { short: 'PROXY', name: 'Entry Proxy', injectTime: 0, noise: 0, monitor: 0.2, breachTrace: 0, blurb: 'Your foothold. ICE cannot purge it, but it can sit on it.' },
  DMZRouter: { short: 'DMZ', name: 'DMZ Router', injectTime: 3, noise: 0.5, monitor: 0.5, breachTrace: 0.5, blurb: 'Lightly monitored edge router.' },
  FirewallGate: { short: 'FW', name: 'Firewall Gate', injectTime: 6, noise: 1.2, monitor: 1.0, breachTrace: 1, blurb: 'Locked. Spoof with a credential, or brute force and trip the wire.' },
  AuthVault: { short: 'VAULT', name: 'Auth Vault', injectTime: 5, noise: 0.9, monitor: 0.9, breachTrace: 1, blurb: 'Holds the core key and credentials.' },
  Honeypot: { short: 'VAULT', name: 'Honeypot', injectTime: 4, noise: 1.0, monitor: 1.3, breachTrace: 0, blurb: 'Looks like a vault. Breaching it springs the trap.' },
  CoreMainframe: { short: 'CORE', name: 'Core Mainframe', injectTime: 6.5, noise: 1.2, monitor: 1.0, breachTrace: 0, blurb: 'The contract target. Needs a vault key.' },
  AdminWorkstation: { short: 'ADMIN', name: 'Admin Workstation', injectTime: 3.5, noise: 0.6, monitor: 0.4, breachTrace: 0.5, blurb: 'Someone left credentials on it.' },
  LogServer: { short: 'LOG', name: 'Log Server', injectTime: 3, noise: 0.5, monitor: 0.2, breachTrace: 0.5, blurb: 'Own it and a wipe scrubs the whole network.' },
};

/** Live tuning values. The F1 overlay edits these while the game runs. */
export const Tuning = {
  traceBase: 0.14,
  levelTraceMul: 0.2,
  hopRelief: 0.22,
  traceFromNoise: 0.6,
  heatPerNoise: 0.35,
  heatMax: 2.5,
  heatDecay: 0.045,
  suspicionDecay: 0.05,
  reportEvery: 1.2,
  tripwireTrace: 5,
  honeypotTrace: 25,
  lockdownAt: 82,
  lockdownEnd: 55,
  lockdownHold: 14,
  lockdownMul: 1.5,
  iceTraceEntry: 1.0,
  icePurgeTrace: 0.6,
  purgeHitTrace: 1.5,
  ejectTrace: 8,
  iceSpeed: 0.85,
  iceHeatPull: 1.6,
  purgeTime: 5.5,
  lockPurgeMul: 1.7,
  huntSpeedMul: 1.25,
  lockSpeedMul: 1.4,
  maxJobs: 3,
  packetSpeed: 1,
  wipeCooldown: 10,
  wipeHeatKeep: 0.25,
  wipeTrace: 4,
  logWipeTrace: 9,
  darkTime: 6,
  darkCooldown: 30,
  nukeReboot: 8,
  nukeTrace: 6,
};

export const AGENTS_PER_LEVEL = [2, 3, 3];
export const START_DECOYS = 3;
export const START_NUKES = 2;
