import { KIND, Tuning } from '../config';
import type { Job, Sim } from '../Sim';
import type { ICommand } from './ICommand';

const lbl = (s: Sim, id: number): string => s.graph.nodes[id]!.label;

/** Target must be a visible, unowned node touching the player's network, and known to at least `minK`. */
function frontierCheck(s: Sim, t: number | null, minK: 1 | 2): string | null {
  if (t === null) return 'needs a target node';
  if (!s.visible(t)) return 'no such node';
  const n = s.graph.nodes[t]!;
  if (n.owned) return `${n.label} is already yours`;
  if (!s.isFrontier(t)) return `${n.label} does not touch any node you own`;
  if (n.knowledge < minK) return `${n.label} is unscanned: scan it first`;
  return null;
}

function ownedCheck(s: Sim, t: number | null): string | null {
  if (t === null) return 'needs a target node';
  if (!s.visible(t)) return 'no such node';
  const n = s.graph.nodes[t]!;
  if (!n.owned) return `${n.label} is not yours`;
  return null;
}

function approachRoute(s: Sim, t: number): number[] {
  const r = s.approach(t);
  if (!r) throw new Error('no route to target');
  return r;
}

export const scan: ICommand = {
  name: 'scan',
  aliases: ['scan', 's', 'ping'],
  usage: 'scan [node]',
  summary: 'Sonar ping. Bare scan reveals every neighbour of your session node; with a node it scans that one.',
  target: 'optional',
  usesJob: true,
  check(s, t) {
    if (t === null) {
      const fresh = s.graph.neighbors(s.session).some((v) => s.graph.nodes[v]!.knowledge < 2 && !s.graph.nodes[v]!.owned);
      return fresh ? null : 'nothing new next to your session node';
    }
    const r = frontierCheck(s, t, 1);
    if (r) return r;
    return s.graph.nodes[t]!.knowledge >= 2 ? `${lbl(s, t)} is already scanned` : null;
  },
  execute(s, t) {
    if (t === null) {
      s.startJob({ cmd: 'scan', target: s.session, route: [s.session], work: 1.2, noise: 0.25, mustOwn: [s.session], packet: 'scan' });
      return `scanning around ${lbl(s, s.session)}`;
    }
    const route = approachRoute(s, t);
    s.startJob({ cmd: 'scan', target: t, route, work: 1.2, noise: 0.25, mustOwn: route.slice(0, -1), packet: 'scan' });
    return `scanning ${lbl(s, t)}`;
  },
  complete(s, job) {
    const g = s.graph;
    const hit = job.target === s.session && job.route.length === 1 ? g.neighbors(job.target) : [job.target];
    for (const v of hit) {
      const n = g.nodes[v]!;
      if (!n.owned && n.knowledge < 2) n.knowledge = 2;
      for (const w of g.neighbors(v)) if (g.nodes[w]!.knowledge < 1) g.nodes[w]!.knowledge = 1;
    }
    s.bus.emit('SCAN_PING', { node: job.target });
    s.log(`scan complete around ${lbl(s, job.target)}.`, 'info');
  },
};

export const probe: ICommand = {
  name: 'probe',
  aliases: ['probe', 'p'],
  usage: 'probe <node>',
  summary: 'Deep scan: reveals the true type, security rating and lock. Exposes honeypots.',
  target: 'required',
  usesJob: true,
  check(s, t) {
    const r = frontierCheck(s, t, 1);
    if (r) return r;
    return s.graph.nodes[t!]!.knowledge >= 3 ? `${lbl(s, t!)} is already probed` : null;
  },
  execute(s, t) {
    const route = approachRoute(s, t!);
    s.startJob({ cmd: 'probe', target: t!, route, work: 1.8, noise: 0.5, mustOwn: route.slice(0, -1), packet: 'scan' });
    return `probing ${lbl(s, t!)}`;
  },
  complete(s, job) {
    const n = s.graph.nodes[job.target]!;
    n.knowledge = 3;
    s.bus.emit('PROBED', { node: n.id, kind: n.kind });
    if (n.kind === 'Honeypot') s.log(`${n.label} is a HONEYPOT. Do not breach it.`, 'warn');
    else s.log(`${n.label}: ${KIND[n.kind].name}, security ${n.security}${n.locked ? ', firewall LOCKED' : ''}.`, 'info');
  },
};

export const inject: ICommand = {
  name: 'inject',
  aliases: ['inject', 'i', 'breach', 'hack'],
  usage: 'inject <node>',
  summary: 'Exploit a node and take it. Noisy. A locked firewall trips a wire halfway through.',
  target: 'required',
  usesJob: true,
  check(s, t) {
    const r = frontierCheck(s, t, 2);
    if (r) return r;
    if (s.graph.nodes[t!]!.kind === 'CoreMainframe' && s.keys < 1) return 'the core needs a vault key: crack an Auth Vault first';
    return null;
  },
  execute(s, t) {
    const n = s.graph.nodes[t!]!;
    const info = KIND[n.kind];
    const route = approachRoute(s, t!);
    const work = info.injectTime * (0.7 + 0.3 * n.security);
    s.startJob({ cmd: 'inject', target: t!, route, work, noise: info.noise * (0.8 + 0.2 * n.security), mustOwn: route.slice(0, -1), packet: 'cmd' });
    return `injecting ${n.label} (${work.toFixed(1)}s, loud)`;
  },
  complete(s, job) {
    const n = s.graph.nodes[job.target]!;
    if (n.owned) return;
    s.setOwned(n.id, 'inject');
    s.addTrace(KIND[n.kind].breachTrace, 'breach');
    switch (n.kind) {
      case 'AuthVault':
        s.keys += 1;
        s.creds += 2;
        s.bus.emit('VAULT_CRACKED', { node: n.id });
        s.log(`${n.label} cracked. Core key and 2 credentials recovered.`, 'good');
        break;
      case 'Honeypot':
        s.triggerHoneypot(n.id);
        break;
      case 'CoreMainframe':
        s.win();
        break;
      case 'AdminWorkstation':
        s.creds += 1;
        s.log(`${n.label} owned. 1 credential lifted.`, 'good');
        break;
      case 'LogServer':
        s.log(`${n.label} owned. Wipe now scrubs the whole network.`, 'good');
        break;
      case 'FirewallGate':
        s.log(`${n.label} brute forced. The wire was tripped.`, 'warn');
        break;
      default:
        s.log(`${n.label} owned.`, 'good');
    }
  },
};

export const spoof: ICommand = {
  name: 'spoof',
  aliases: ['spoof', 'sp'],
  usage: 'spoof <node>',
  summary: 'Present a stolen credential to a firewall gate. Quiet and fast, but burns 1 credential.',
  target: 'required',
  usesJob: true,
  check(s, t) {
    const r = frontierCheck(s, t, 2);
    if (r) return r;
    if (s.graph.nodes[t!]!.kind !== 'FirewallGate') return 'spoof only works on firewall gates';
    return s.creds < 1 ? 'no credentials: breach an admin workstation or vault' : null;
  },
  execute(s, t) {
    const route = approachRoute(s, t!);
    s.startJob({ cmd: 'spoof', target: t!, route, work: 2, noise: 0.1, mustOwn: route.slice(0, -1), packet: 'cmd' });
    return `spoofing ${lbl(s, t!)} with a stolen credential`;
  },
  complete(s, job) {
    const n = s.graph.nodes[job.target]!;
    if (n.owned || s.creds < 1) return;
    s.creds -= 1;
    s.setOwned(n.id, 'spoof');
    s.log(`${n.label} opened quietly. ${s.creds} credential${s.creds === 1 ? '' : 's'} left.`, 'good');
  },
};

export const pivot: ICommand = {
  name: 'pivot',
  aliases: ['pivot', 'pv', 'jump'],
  usage: 'pivot <node>',
  summary: 'Move your session to another node you own. Deeper sessions trace slower; ICE chases the session first.',
  target: 'required',
  usesJob: false,
  check(s, t) {
    const r = ownedCheck(s, t);
    if (r) return r;
    return t === s.session ? 'already your session node' : null;
  },
  execute(s, t) {
    s.setSession(t!);
    return `session pivoted to ${lbl(s, t!)}`;
  },
};

export const decoy: ICommand = {
  name: 'decoy',
  aliases: ['decoy', 'd', 'bait'],
  usage: 'decoy <node>',
  summary: 'Fire noise packets at any visible node. Searching ICE goes to look; hunting ICE ignores it.',
  target: 'required',
  usesJob: true,
  check(s, t) {
    if (t === null) return 'needs a target node';
    if (!s.visible(t)) return 'no such node';
    if (t === s.session) return 'pick a node other than your session';
    return s.decoys < 1 ? 'out of decoys' : null;
  },
  execute(s, t) {
    const path = s.fullPath(s.session, t!);
    s.decoys -= 1;
    s.startJob({ cmd: 'decoy', target: t!, route: path ?? [s.session, t!], work: 0, noise: 0, mustOwn: [], packet: 'decoy' });
    return `decoy launched at ${lbl(s, t!)} (${s.decoys} left)`;
  },
  complete(s, job) {
    const g = s.graph;
    s.raise(job.target, 3, true);
    for (const e of g.edgesOf(job.target)) e.alertHeat = Math.min(Tuning.heatMax, e.alertHeat + 0.6);
    s.bus.emit('DECOY', { node: job.target });
    s.log(`decoy noise erupted at ${lbl(s, job.target)}.`, 'info');
  },
};

export const wipe: ICommand = {
  name: 'wipe',
  aliases: ['wipe', 'w'],
  usage: 'wipe [node]',
  summary: 'Scrub logs on an owned node (default: your session). Cuts nearby alert heat. With a Log Server owned it scrubs everything.',
  target: 'optional',
  usesJob: true,
  check(s, t) {
    if (s.wipeCd > 0) return `wipe is cooling down (${Math.ceil(s.wipeCd)}s)`;
    return t === null ? null : ownedCheck(s, t);
  },
  execute(s, t) {
    const target = t ?? s.session;
    const route = s.ownedPath(s.session, target);
    if (!route) throw new Error('no route to wipe target');
    s.wipeCd = Tuning.wipeCooldown;
    s.startJob({ cmd: 'wipe', target, route, work: 2.5, noise: 0, mustOwn: route, packet: 'cmd' });
    return `wiping logs on ${lbl(s, target)}`;
  },
  complete(s, job) {
    const g = s.graph;
    const global = g.nodes.some((n) => n.kind === 'LogServer' && n.owned);
    if (global) {
      for (const e of g.edges) e.alertHeat *= Tuning.wipeHeatKeep;
      for (let i = 0; i < s.bb.suspicion.length; i++) s.bb.suspicion[i] = s.bb.suspicion[i]! * 0.3;
      s.reduceTrace(Tuning.logWipeTrace);
    } else {
      for (const e of g.edgesOf(job.target)) e.alertHeat *= Tuning.wipeHeatKeep;
      s.bb.suspicion[job.target] = 0;
      s.bb.reports = s.bb.reports.filter((r) => r.node !== job.target);
      s.reduceTrace(Tuning.wipeTrace);
    }
    s.bus.emit('WIPE', { node: job.target, global });
    s.log(global ? 'Log Server wipe: network-wide heat scrubbed.' : `logs wiped on ${lbl(s, job.target)}.`, 'good');
  },
};

export const nuke: ICommand = {
  name: 'nuke',
  aliases: ['nuke'],
  usage: 'nuke <node>',
  summary: 'Logic bomb on an owned node. Crashes ICE on or next to it. The node is lost, and it is loud.',
  target: 'required',
  usesJob: true,
  check(s, t) {
    const r = ownedCheck(s, t);
    if (r) return r;
    if (t === s.entry) return 'the entry proxy cannot be detonated';
    return s.nukes < 1 ? 'out of logic bombs' : null;
  },
  execute(s, t) {
    const route = s.ownedPath(s.session, t!);
    if (!route) throw new Error('no route to nuke target');
    s.startJob({ cmd: 'nuke', target: t!, route, work: 0.8, noise: 0, mustOwn: route, packet: 'nuke' });
    return `arming logic bomb on ${lbl(s, t!)}`;
  },
  complete(s, job) {
    const n = s.graph.nodes[job.target]!;
    if (!n.owned || s.nukes < 1) return;
    s.nukes -= 1;
    const blast = new Set<number>([n.id, ...s.graph.neighbors(n.id)]);
    let downed = 0;
    for (const a of s.agents) {
      if (blast.has(a.at) && a.state !== 'Rebooting') {
        a.crash(Tuning.nukeReboot);
        downed++;
      }
    }
    for (const e of s.graph.edgesOf(n.id)) e.alertHeat = Math.min(Tuning.heatMax, e.alertHeat + 1.2);
    s.bus.emit('NUKE', { node: n.id });
    s.releaseNode(n.id);
    s.addTrace(Tuning.nukeTrace, 'nuke');
    s.raise(n.id, 3);
    s.log(downed ? `Logic bomb: ${downed} ICE agent${downed === 1 ? '' : 's'} crashed. ${n.label} is gone.` : `Logic bomb detonated at ${n.label}. No ICE in range.`, downed ? 'good' : 'warn');
  },
};

export const disconnect: ICommand = {
  name: 'disconnect',
  aliases: ['disconnect', 'dc', 'dark'],
  usage: 'disconnect',
  summary: 'Go dark. ICE forgets every report and trace stops climbing, but you cannot issue commands for a few seconds.',
  target: 'none',
  usesJob: false,
  check(s) {
    return s.darkCd > 0 ? `disconnect is cooling down (${Math.ceil(s.darkCd)}s)` : null;
  },
  execute(s) {
    s.goDark();
    return `session dark for ${Tuning.darkTime}s`;
  },
};

export const ALL_COMMANDS: readonly ICommand[] = [scan, probe, inject, spoof, pivot, decoy, wipe, nuke, disconnect];

export type { Job };
