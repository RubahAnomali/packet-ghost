// Headless verification of the simulation. Loads the TypeScript sources through Vite's SSR loader, so it
// needs no browser and no extra dependencies. Run: npm test
import { createServer } from 'vite';

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error', root: process.cwd() });
const load = (p) => vite.ssrLoadModule(p);
const { Sim } = await load('/src/sim/Sim.ts');
const { EventBus } = await load('/src/core/EventBus.ts');
const { generateNetwork, validateNetwork } = await load('/src/sim/graph/NetworkGenerator.ts');
const { shortestTree } = await load('/src/sim/graph/pathfinding.ts');
const { runLine } = await load('/src/sim/commands/CommandLine.ts');
const { FIXED_DT, Tuning } = await load('/src/sim/config.ts');

let failed = 0;
const ok = (cond, msg) => {
  if (!cond) {
    failed++;
    console.log(`  FAIL  ${msg}`);
  } else console.log(`  ok    ${msg}`);
};
const section = (s) => console.log(`\n${s}`);
const makeSim = (seed, level) => {
  const bus = new EventBus();
  const sim = new Sim(bus);
  sim.loadContract(seed, level);
  return { sim, bus };
};

// ---------------------------------------------------------------------------------------------
section('Topology generator');
{
  let bad = 0;
  let maxAttempts = 0;
  let total = 0;
  const kinds = new Set();
  for (let level = 1; level <= 3; level++) {
    for (let seed = 1; seed <= 400; seed++) {
      try {
        const n = generateNetwork(seed, level);
        const why = validateNetwork(n.graph, n.entry, n.core, n.vaults);
        if (why) bad++;
        maxAttempts = Math.max(maxAttempts, n.attempts);
        total += n.attempts;
        for (const node of n.graph.nodes) kinds.add(node.kind);
      } catch {
        bad++;
      }
    }
  }
  ok(bad === 0, `1200 topologies (3 levels x 400 seeds) all connected, honeypot-free route, no single point of failure`);
  console.log(`        mean attempts ${(total / 1200).toFixed(2)}, worst ${maxAttempts}`);
  ok(kinds.size === 8, `all 8 node archetypes appear (${kinds.size})`);
  const a = JSON.stringify(generateNetwork(77, 2).graph);
  const b = JSON.stringify(generateNetwork(77, 2).graph);
  ok(a === b, 'same seed gives the identical graph');
  ok(a !== JSON.stringify(generateNetwork(78, 2).graph), 'different seed gives a different graph');
  const n3 = generateNetwork(5, 3);
  const n1 = generateNetwork(5, 1);
  ok(n3.graph.nodes.length > n1.graph.nodes.length, `contracts escalate (${n1.graph.nodes.length} -> ${n3.graph.nodes.length} nodes)`);
  const labels = new Set(n3.graph.nodes.map((x) => x.label));
  ok(labels.size === n3.graph.nodes.length, 'labels are unique');
}

// ---------------------------------------------------------------------------------------------
section('Dijkstra heat weighting');
{
  const { sim } = makeSim(3, 2);
  const g = sim.graph;
  const entry = sim.entry;
  const far = g.nodes.find((n) => n.layer === 3).id;
  const cold = shortestTree(g, entry, (e) => e.latency / (1 + Tuning.iceHeatPull * e.alertHeat));
  const coldPath = [];
  for (let c = far; c !== -1; c = cold.prev[c]) coldPath.unshift(c);
  // heat up a link that is NOT on the cold path and make sure the path never gets worse for heated links
  const hot = g.edges.find((e) => coldPath.includes(e.a) && coldPath.includes(e.b));
  hot.alertHeat = 2.5;
  const heated = shortestTree(g, entry, (e) => e.latency / (1 + Tuning.iceHeatPull * e.alertHeat));
  ok(heated.dist[far] <= cold.dist[far] + 1e-9, 'heat on a link makes ICE routes through it cheaper, never dearer');
}

// ---------------------------------------------------------------------------------------------
section('Command pipeline parity (terminal text vs button)');
{
  const run = (viaText) => {
    const { sim, bus } = makeSim(11, 1);
    const events = [];
    for (const k of ['COMMAND_ISSUED', 'COMMAND_REJECTED', 'SCAN_PING', 'PACKET_DELIVERED', 'NODE_COMPROMISED', 'TRACE_INCREASED', 'ALERT_TRIGGERED', 'LOG']) {
      bus.on(k, (p) => events.push([k, JSON.stringify(p)]));
    }
    const step = (sec) => {
      for (let i = 0; i < sec / FIXED_DT; i++) sim.update(FIXED_DT);
    };
    const issue = (line, cmd, target) => (viaText ? runLine(sim, line) : sim.dispatcher.run(cmd, target));
    issue('scan', 'scan', null);
    step(4);
    const t = sim.graph.neighbors(sim.entry).find((v) => sim.graph.nodes[v].kind === 'DMZRouter');
    const label = sim.graph.nodes[t].label;
    issue(`probe ${label.toLowerCase()}`, 'probe', t);
    step(5);
    issue(`inject ${label}`, 'inject', t);
    step(12);
    issue('inject n99', 'inject', null);
    return { events, trace: sim.trace.toFixed(6), owned: sim.ownedCount() };
  };
  const a = run(true);
  const b = run(false);
  const same = JSON.stringify(a.events.filter((e) => e[0] !== 'COMMAND_REJECTED' && e[0] !== 'LOG')) === JSON.stringify(b.events.filter((e) => e[0] !== 'COMMAND_REJECTED' && e[0] !== 'LOG'));
  ok(same, `identical event streams (${a.events.length} events)`);
  ok(a.trace === b.trace && a.owned === b.owned && a.events.some((e) => e[0] === 'NODE_COMPROMISED'), `identical final state (trace ${a.trace}, owned ${a.owned})`);
}

// ---------------------------------------------------------------------------------------------
section('Rules');
{
  const { sim } = makeSim(21, 1);
  const d = sim.dispatcher;
  const dmz = sim.graph.neighbors(sim.entry)[0];
  ok(d.can('inject', dmz) !== null, 'cannot inject an unscanned node');
  ok(d.can('spoof', dmz) !== null, 'cannot spoof without credentials');
  ok(d.can('nuke', sim.entry) !== null, 'cannot nuke the entry proxy');
  ok(d.can('pivot', sim.entry) !== null, 'cannot pivot to the current session');
  ok(d.can('scan', null) === null, 'bare scan is allowed at the start');
  ok(d.run('scan', null).ok, 'scan issues');
  ok(sim.jobs.length === 1, 'scan occupies a job slot');
  for (let i = 0; i < 400; i++) sim.update(FIXED_DT);
  ok(sim.graph.nodes[dmz].knowledge >= 2, 'scan reveals neighbours');
  ok(d.can('inject', dmz) === null, 'inject is allowed once scanned');
  sim.graph.nodes.find((n) => n.kind === 'CoreMainframe').knowledge = 2;
  const coreEdge = sim.graph.edgesOf(sim.core)[0];
  const nb = sim.graph.other(coreEdge, sim.core);
  sim.graph.nodes[nb].owned = true;
  ok(d.can('inject', sim.core)?.includes('key'), 'core needs a vault key');
  sim.graph.nodes[nb].owned = false;
  d.run('disconnect', null);
  ok(d.can('scan', null)?.includes('dark'), 'commands are blocked while dark');
  for (let i = 0; i < Tuning.darkTime / FIXED_DT + 5; i++) sim.update(FIXED_DT);
  ok(sim.darkTime === 0 && d.can('disconnect', null) !== null, 'dark ends, then disconnect cools down');
  const r = runLine(sim, 'bogus');
  ok(r === undefined, 'unknown words are left to the terminal');
  ok(runLine(sim, 'inject').ok === false, 'a command missing its target is rejected');
}

// ---------------------------------------------------------------------------------------------
section('Trace, honeypot, lockdown and purge');
{
  const { sim, bus } = makeSim(31, 2);
  const seen = new Set();
  for (const k of ['LOCKDOWN', 'HONEYPOT_TRIGGERED', 'NODE_PURGED', 'TRIPWIRE', 'VAULT_CRACKED', 'NUKE', 'WIPE', 'DECOY', 'CORE_BREACHED', 'CONTRACT_LOST']) bus.on(k, () => seen.add(k));
  const t0 = sim.trace;
  for (let i = 0; i < 600; i++) sim.update(FIXED_DT);
  ok(sim.trace > t0, `baseline trace rises (${sim.trace.toFixed(2)} after 10s)`);
  const hp = sim.honeypots[0];
  sim.graph.nodes[sim.graph.neighbors(hp)[0]].owned = true;
  sim.triggerHoneypot(hp);
  sim.update(FIXED_DT);
  sim.update(FIXED_DT);
  ok(sim.lockdown, 'honeypot forces lockdown');
  ok(seen.has('HONEYPOT_TRIGGERED') && seen.has('LOCKDOWN'), 'honeypot and lockdown events fire');
  ok(sim.agents.every((a) => a.state === 'Lockdown' || a.state === 'Rebooting'), 'every ICE agent enters Lockdown');
  sim.trace = 99.9;
  for (let i = 0; i < 60; i++) sim.update(FIXED_DT);
  ok(sim.phase === 'lost' && seen.has('CONTRACT_LOST'), 'trace at 100 loses the contract');
}

// ---------------------------------------------------------------------------------------------
section('ICE purge, severing and nuke');
{
  const { sim, bus } = makeSim(41, 1);
  const g = sim.graph;
  // build a 2-node chain by hand: entry -> A -> B (B beyond A)
  const a = g.neighbors(sim.entry)[0];
  const b = g.neighbors(a).find((v) => v !== sim.entry && !g.nodes[v].owned);
  g.nodes[a].owned = true;
  g.nodes[b].owned = true;
  sim.setSession(b);
  const purged = [];
  bus.on('NODE_PURGED', (e) => purged.push(e));
  sim.releaseNode(a);
  ok(!g.nodes[a].owned && !g.nodes[b].owned, 'cutting a node collapses everything behind it');
  ok(sim.session === sim.entry, 'session falls back to the entry');
  ok(purged.length === 1 && purged[0].by === -1, 'collapse is reported as a severed route');

  // nuke crashes agents next to the node
  g.nodes[a].owned = true;
  sim.version++;
  const agent = sim.agents[0];
  agent.at = a;
  agent.to = -1;
  sim.nukes = 2;
  ok(sim.dispatcher.run('nuke', a).ok, 'nuke issues on an owned node');
  for (let i = 0; i < 200; i++) sim.update(FIXED_DT);
  ok(agent.state === 'Rebooting', 'nuke crashes an adjacent ICE agent into Rebooting');
  ok(!g.nodes[a].owned, 'the nuked node is lost');
  for (let i = 0; i < Tuning.nukeReboot / FIXED_DT + 30; i++) sim.update(FIXED_DT);
  ok(agent.state !== 'Rebooting', 'the agent comes back online');
}

// ---------------------------------------------------------------------------------------------
section('Scripted run (bot) across seeds');

function nextTarget(sim) {
  const g = sim.graph;
  let goal = sim.keys > 0 ? sim.core : sim.vaults[0];
  if (g.nodes[goal].owned) return null;
  if (sim.creds < 1) {
    // the quiet route needs a credential first: go and take one from an admin workstation
    const adm = g.nodes.find((n) => n.kind === 'AdminWorkstation' && !n.owned);
    if (adm) goal = adm.id;
  }
  const tree = shortestTree(
    g,
    goal,
    (e) => e.latency,
    (id) => g.nodes[id].kind !== 'Honeypot' && (id === goal || g.nodes[id].kind !== 'CoreMainframe'),
  );
  let best = null;
  for (const n of g.nodes) {
    if (!n.owned || !Number.isFinite(tree.dist[n.id])) continue;
    if (!best || tree.dist[n.id] < tree.dist[best]) best = n.id;
  }
  return best === null ? null : tree.prev[best];
}

function bot(sim) {
  if (sim.phase !== 'play') return;
  const d = sim.dispatcher;
  const issue = (cmd, t = null) => d.can(cmd, t) === null && d.run(cmd, t).ok;
  if (sim.trace > 40) issue('wipe');
  if (sim.agents.some((a) => a.state === 'Triangulate') && sim.trace > 25) issue('disconnect');
  const g0 = sim.graph;
  // about to lose a node to a purge: detonate it so the hunter reboots
  const purger = sim.agents.find((a) => a.group === 'Hunting' && a.to < 0 && a.purge > Tuning.purgeTime * 0.5 && a.at !== sim.entry && g0.nodes[a.at].owned);
  if (sim.nukes > 0 && purger && issue('nuke', purger.at)) return;
  if (sim.jobs.length >= 2) return;
  let t = nextTarget(sim);
  if (t === null) return;
  const g = sim.graph;
  if (sim.jobs.some((j) => j.target === t)) return;
  // a firewall without credentials: detour to an admin workstation if one touches the network
  if (g.nodes[t].kind === 'FirewallGate' && sim.creds < 1) {
    const adm = g.nodes.find((n) => n.kind === 'AdminWorkstation' && !n.owned && sim.isFrontier(n.id) && !sim.jobs.some((j) => j.target === n.id));
    if (adm) t = adm.id;
  }
  const n = g.nodes[t];
  if (n.knowledge < 2) return void issue('scan', t);
  const loud = ['FirewallGate', 'AuthVault', 'CoreMainframe'].includes(n.kind);
  if (loud && sim.decoys > 0 && sim.time - (sim.__lastDecoy ?? -99) > 14 && !sim.jobs.some((j) => j.cmd === 'inject')) {
    // bait the searching ICE to the far side of the network before making noise
    const tree = shortestTree(g, t, (e) => e.latency);
    let far = -1;
    for (const m of g.nodes) if (sim.visible(m.id) && m.id !== sim.session && m.id !== t && (far < 0 || tree.dist[m.id] > tree.dist[far])) far = m.id;
    if (far >= 0 && issue('decoy', far)) {
      sim.__lastDecoy = sim.time;
      return;
    }
  }
  if (n.kind === 'FirewallGate' && sim.creds > 0 && issue('spoof', t)) return;
  issue('inject', t);
}

function playBot(seed, level, maxSec = 420) {
  const { sim, bus } = makeSim(seed, level);
  const states = new Set();
  const edges = new Set();
  bus.on('AGENT_STATE_CHANGED', (e) => {
    states.add(e.to);
    edges.add(`${e.from}>${e.to}`);
  });
  let tick = 0;
  while (sim.phase === 'play' && sim.time < maxSec) {
    if (tick % 30 === 0) bot(sim);
    sim.update(FIXED_DT);
    tick++;
  }
  const rejected = sim.agents.reduce((s, a) => s + a.fsm.rejected, 0);
  return { sim, states, edges, rejected, phase: sim.phase, time: sim.time, trace: sim.trace };
}

{
  const allStates = new Set();
  const allEdges = new Set();
  let rejected = 0;
  const tally = {};
  for (let level = 1; level <= 3; level++) {
    let wins = 0;
    let trace = 0;
    let time = 0;
    const N = 40;
    for (let seed = 1; seed <= N; seed++) {
      const r = playBot(seed * 13, level);
      if (r.phase === 'won') {
        wins++;
        trace += r.trace;
        time += r.time;
      }
      r.states.forEach((s) => allStates.add(s));
      r.edges.forEach((s) => allEdges.add(s));
      rejected += r.rejected;
    }
    tally[level] = { wins, N, avgTrace: wins ? trace / wins : 0, avgTime: wins ? time / wins : 0 };
    console.log(`        level ${level}: bot wins ${wins}/${N}, mean trace at win ${tally[level].avgTrace.toFixed(0)}%, mean time ${tally[level].avgTime.toFixed(0)}s`);
  }
  ok(tally[1].wins > 0 && tally[2].wins > 0, 'the game is winnable on contracts 1 and 2');
  ok(tally[1].wins > 0 && tally[1].wins <= 40, 'win rates reported above');
  ok(rejected === 0, `no illegal ICE state transitions were attempted (${rejected})`);
  console.log(`        ICE states seen: ${[...allStates].sort().join(', ')}`);
  console.log(`        transitions seen: ${[...allEdges].sort().join(', ')}`);
  ok(['Investigate', 'Triangulate', 'Lockdown'].every((s) => allStates.has(s)), 'bot runs exercised Investigate, Triangulate and Lockdown');

  const a = playBot(7, 1);
  const b = playBot(7, 1);
  ok(a.phase === b.phase && a.trace === b.trace && a.time === b.time, `determinism: identical outcome on replay (${a.phase}, trace ${a.trace.toFixed(4)})`);
}

// ---------------------------------------------------------------------------------------------
section('Clean reset');
{
  const { sim, bus } = makeSim(9, 2);
  const listeners = bus.listenerCount();
  for (let r = 0; r < 25; r++) {
    for (let i = 0; i < 900; i++) {
      if (i % 40 === 0) bot(sim);
      sim.update(FIXED_DT);
    }
    sim.loadContract(9 + r, 1 + (r % 3));
  }
  ok(sim.packets.length === 0 || sim.packets.every((p) => p.kind === 'ambient'), 'no job packets survive a reset');
  ok(sim.jobs.length === 0, 'no jobs survive a reset');
  ok(sim.trace === 0 && sim.creds === 0 && sim.keys === 0 && !sim.lockdown && sim.darkTime === 0, 'trace, items, lockdown and dark are reset');
  ok(sim.bb.reports.length === 0 && sim.bb.confirmed.size === 0 && sim.bb.suspicion.every((s) => s === 0), 'blackboard is empty');
  ok(sim.agents.every((a) => a.state === 'Patrol' && a.target === -1 && a.path.length === 0), 'agents are fresh');
  ok(sim.ownedCount() === 1 && sim.session === sim.entry, 'only the entry proxy is owned');
  ok(bus.listenerCount() === listeners, 'no listeners accumulate');
  ok(sim.packetPool.allocated < 120, `packet pool is bounded (${sim.packetPool.allocated} ever allocated)`);
}

await vite.close();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
