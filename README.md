# Packet Ghost

A real-time network stealth and topology infiltration game, in the spirit of *Uplink*, *Hacknet* and *Invisible, Inc.* You are a ghost in a corporate network: scan it, crack it one node at a time, steal the core key from an Auth Vault, and breach the Core Mainframe before the global **TRACE** reaches 100%. Autonomous ICE hunters patrol the graph, listen to the noise you make, and share what they hear.

TypeScript (strict), Vite, HTML5 Canvas, procedural WebAudio. No external assets and no runtime dependencies.

```bash
npm install
npm run dev        # http://localhost:5173   (add ?seed=1234 to fix the first contract's seed)
npm run build      # tsc --noEmit + production bundle in dist/
npm run typecheck
npm test           # headless simulation checks (needs no browser)
```

## How it plays

- The network starts fogged. Only your **Entry Proxy** and its neighbours (as `?`) are visible. `scan` names nodes, `probe` reveals the truth (type, security, lock, honeypot).
- Every exploit is **loud**. Noise leaves **alert heat** on the links it travelled, makes the node's monitor file **anomaly reports**, and raises trace.
- A firewall can be brute forced (loud, and it **trips a wire** halfway through) or **spoofed** quietly with a stolen credential. Credentials come from Admin Workstations and from the Auth Vault.
- One of the "vaults" is a **Honeypot**. It looks identical until probed. Breaching it adds 25 trace and forces a lockdown.
- Cracking the real Auth Vault gives the **core key**. The Core Mainframe cannot be injected without it.
- Three contracts (seeds) escalate: 9, 11 and 13+ nodes, more firewalls, more honeypots, more ICE.

### Commands

| Command | Aliases | What it does |
|---|---|---|
| `scan [node]` | `s`, `ping` | Sonar ping. Bare `scan` reveals every neighbour of the session node. |
| `probe <node>` | `p` | Deep scan: true type, security, lock. Exposes honeypots. |
| `inject <node>` | `i`, `breach`, `hack` | Exploit and take a node. Noisy. Core needs the vault key. |
| `spoof <node>` | `sp` | Open a firewall with a stolen credential. Quiet and fast. |
| `pivot <node>` | `pv`, `jump` | Move the session to another owned node. |
| `decoy <node>` | `d`, `bait` | Fire noise packets at any visible node to bait searching ICE. 3 per contract. |
| `wipe [node]` | `w` | Scrub logs on an owned node and cut local heat. With a Log Server owned it scrubs the whole network. 10 s cooldown. |
| `nuke <node>` | | Logic bomb on an owned node. Crashes ICE on or next to it for 8 s. The node is lost. 2 per contract. |
| `disconnect` | `dc`, `dark` | Go dark for 6 s: trace pauses, ICE forgets every report, you cannot issue commands. 30 s cooldown. |
| `help`, `status`, `nodes`, `clear` | `h`, `st`, `ls`, `cls` | Console-only helpers. |

Targets can be written `N07`, `n7` or `7`.

### Controls

| Input | Action |
|---|---|
| `` ` `` or `/` | Focus the console. `Tab` completes (commands, then node names), `Up`/`Down` history, `Esc` leaves. |
| Click a node | Radial action ring around it. Greyed buttons say why in their tooltip. |
| Drag / wheel | Pan / zoom. Arrow keys or WASD also pan. `F` re-frames the network. |
| `P` / `Esc` | Pause. |
| `R` | Instant restart of the **same seed**. |
| `Enter` | Start, next contract, retry (screen buttons also work). `N` on the lost screen = new seed. |
| `M` | Mute. |
| `F1` | Inspector overlay. |

## Architecture

```
src/
  core/        EventBus<E>, ObjectPool<T>, StateMachine<S>, Rng + math
  sim/         everything that decides what happens. No DOM, no canvas, no audio.
    Sim.ts       state, rules, fixed step, jobs, packets, trace, lockdown
    config.ts    FIXED_DT, MAX_FRAME_DT, node archetypes, live-tunable Tuning
    graph/       Graph<N,E>, Dijkstra, NetworkGenerator (+ solvability gate)
    ai/          AIBlackboard, IceAgent (HFSM)
    commands/    ICommand, the nine commands, CommandDispatcher, CommandLine (text front end)
  render/      Renderer (graph, CRT compositing), Fx (rings, sparks, shake, hit-stop requests), Palette
  audio/       SoundEngine (oscillators + filtered noise)
  ui/          Terminal, NodePanel (radial ring), Hud (bar + screens), DebugOverlay
  Game.ts      composition root: frame loop, input, screen flow
```

The simulation talks to the outside world only through a typed `EventBus<SimEvents>`: `NODE_COMPROMISED`, `NODE_PURGED`, `ALERT_TRIGGERED`, `TRACE_INCREASED`, `PACKET_DELIVERED`, `AGENT_STATE_CHANGED`, `CORE_BREACHED`, plus `TRIPWIRE`, `VAULT_CRACKED`, `LOCKDOWN`, `LOG` and a few more. Rendering, audio, the terminal log and effects are all subscribers.

### Fixed timestep

`Sim.update(FIXED_DT)` runs at **60 Hz**. The game loop accumulates real time, clamps a long frame to `MAX_FRAME_DT = 0.05 s`, and runs at most six steps per frame, so trace, packet travel, purge timers and AI ticks behave the same on any hardware. A 50 ms hit-stop (vault or core cracked) simply skips stepping for three frames. Background traffic uses its own RNG so it can never change an outcome.

### Procedural topology (`NetworkGenerator`)

Seeded (`mulberry32`). Layers: `EntryProxy` -> `DMZRouter` (+ `AdminWorkstation` side nodes) -> `FirewallGate` (+ `LogServer`) -> `AuthVault` and `Honeypot` -> `CoreMainframe`.

1. A **spanning backbone** attaches every node to one in the layer above, so the graph is connected by construction.
2. **Redundant cross-links** (probability grows with the contract) add side doors: a Log Server linked to the vault bypasses the firewall, the core links to a firewall as well as the vault, honeypots sit beside the real way in.
3. A **validation gate** rejects any candidate that is disconnected, has no honeypot-free route entry -> vault -> core, or has a **single point of failure** (removing any one interior node on the shortest route disconnects the target). Rejected candidates are re-rolled from a derived seed. Over 1,200 generated topologies (3 levels x 400 seeds) all pass; the mean is 2.5 attempts and the worst 19.
4. Layered layout with barycentre ordering. Addresses are a shuffled permutation (`N07`), so a label never hints at depth or type.

Links carry `latency` (packet travel time) and `alertHeat` (noise left on the wire, decays exponentially).

### Dijkstra with alert-heat weighting

ICE agents path with Dijkstra where the cost of a link is `latency / (1 + iceHeatPull * alertHeat)`. Hot wires are **cheaper**, so searching agents are drawn along the trail your noise left. `shortestTree` supports a `passable` predicate: a node may be reached but not expanded through, which is how "walk to the node next to my network" and "route through owned nodes only" are both expressed. The player's own command packets use latency-only costs over owned nodes.

### AI Blackboard + HFSM tracers

`AIBlackboard` is the shared memory: anomaly reports (with a fake flag for decoys), a per-node **suspicion** map that decays, confirmed-compromised nodes, **reservations** (which agent is heading where, one agent per node, two for a loud one) and **role claims**. Agents never talk to each other; they read and write the blackboard, which is what makes them triangulate instead of stacking.

Each `IceAgent` is a hierarchical FSM. Five leaf states, three groups, and an adjacency table that is the only way to change state (illegal requests are counted and rejected):

| Group | State | Behaviour |
|---|---|---|
| Searching | `Patrol` | Weighted walk, biased toward deep layers and suspicious neighbours. Pulls the best unreserved lead from the blackboard. |
| Searching | `Investigate` | Heat-weighted Dijkstra to the loudest report. A false alarm clears suspicion and goes back to patrol. Believes decoys. |
| Hunting | `Triangulate` | Found an owned node. Roles: **chaser** (the session end of your route), **cutter** (the first hop after the entry, severing everything behind it), **flanker** (the middle), **sweeper** (nearest). Purges owned nodes; ignores decoys. |
| Hunting | `Lockdown` | Global. Everything gets purged nearest-first, faster, with trace x1.5. Ends when trace falls under 55 and the hold timer is up. |
| Down | `Rebooting` | Crashed by a nuke for 8 s. |

Walking onto an owned node **may** discover it. The chance is `0.15 + 0.5 * adjacent heat + 0.2 * suspicion`, and 1 during lockdown, so a quietly spoofed node survives patrols that would find a loudly brute-forced one. Purging a node also drops everything that was only connected through it, and if the session was cut off you are ejected back to the entry (+8 trace).

Trace rises from a baseline that falls with the number of hops in your route (bounce through proxies to buy time), from noise, from tripwires, purges, and from hunters sitting on your entry. `disconnect` clears the blackboard; `decoy` writes fake reports into it; `nuke` reboots the agents it touches; `wipe` decays heat.

### Command pattern and input parity

Every action is an `ICommand` (`check`, `execute`, optional `complete`). `CommandDispatcher.run(name, target)` is the only way in. The terminal parses text to the dispatcher (`runLine`), the node ring calls the dispatcher directly, and `dispatcher.can()` is what greys buttons out. The headless suite runs the same scenario through both paths and asserts the event streams and final state are identical.

### Presentation

- Graph: layered layout, curved links with packets riding the same curve, firewall lock rings, per-agent alert-radius pulses (wider when hunting), a marching-dash highlight on the live route, purge progress arcs, sonar rings on scan.
- CRT: scanlines always; a chromatic-aberration pass, glitch strips, a rolling band and a red vignette ramp up as trace passes 55%.
- Hit-stop (50 ms) on cracking a vault or the core; directional shake on firewall tripwires; flashes on lockdown, nuke and breach.
- Audio: mechanical keystrokes in the console, modem handshake chirps on `inject`/`spoof`/`probe`, sonar pings, packet whooshes, a drone that climbs and pulses with trace plus a siren layer in lockdown, arpeggios for vault and core.

### F1 inspector

Live FPS, frame and sim time, measured tick rate, seed, generator attempts, active vs pooled packets and fx, the **blackboard** (reports, suspicion hotspots, confirmed nodes, reservations), each agent's group/state/role/target/purge/history and its **planned Dijkstra path** (also drawn on the graph), a **Reveal fog** toggle, cheats for testing, and sliders for the main tuning values.

## Verification

- `npx tsc --noEmit` and `npm run build` are clean.
- `npm test` loads the TypeScript through Vite's SSR loader and checks: generator (1,200 topologies connected, honeypot-free route, no single point of failure, deterministic, escalating), heat weighting, text-vs-button parity, rule guards, trace/lockdown/honeypot, severing and nuke, ICE state transitions (no illegal request in any run), replay determinism, and clean resets (no leftover jobs, packets, blackboard entries, listeners; packet pool stays bounded).
- A scripted bot (takes credentials first, uses decoys before loud work, nukes a hunter mid-purge) clears **22/40, 13/40 and 10/40** seeds on contracts 1, 2 and 3.
- In the browser: title, play, pause, win, loss and next-contract flows, the console (Tab completion, history, focus keys), the action ring, the inspector and the lockdown/aberration visuals were exercised with no console errors.

## Honest limits

- **Playtested by hand.** The author has played the game personally and had friends play it. The automated checks above ran in a Browser pane that throttles `requestAnimationFrame` to about 20 fps, so the bot numbers come from that, and no formal playtest data (win rates, timings) was recorded. The F1 sliders are there for tuning.
- The bot is deliberately simple (no probing, no pivoting, no route planning around ICE). Human win rates will differ, probably upward on contract 1 and unknown on 3.
- Audio was not listened to; it is built from the event stream and checked only for not throwing.
- No touch input, no save data, no settings menu.
