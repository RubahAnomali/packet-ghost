import type { EventBus } from '../core/EventBus';
import type { SimEvents } from '../sim/types';

type Wave = OscillatorType;

/** Fully procedural audio: oscillators and filtered noise. No sample files. */
export class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private tOsc: OscillatorNode | null = null;
  private tFilter: BiquadFilterNode | null = null;
  private tGain: GainNode | null = null;
  private tLfo: OscillatorNode | null = null;
  private tLfoGain: GainNode | null = null;
  private sirenOsc: OscillatorNode | null = null;
  private sirenGain: GainNode | null = null;
  private lastAlert = -1;
  private lastState = -1;
  muted = false;
  private readonly off: (() => void)[] = [];

  /** Create the AudioContext on the first user gesture. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC();
    } catch {
      return;
    }
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    this.master.connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 1.5;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.startTension();
  }

  toggleMute(): void {
    this.muted = !this.muted;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.5, this.ctx.currentTime, 0.02);
  }

  dispose(): void {
    for (const o of this.off) o();
    this.off.length = 0;
    for (const n of [this.tOsc, this.tLfo, this.sirenOsc]) {
      try {
        n?.stop();
      } catch {
        /* already stopped */
      }
    }
    void this.ctx?.close();
    this.ctx = null;
  }

  // ---- continuous layers ----------------------------------------------------------------------

  /** A low drone that climbs, tightens and pulses as trace rises, plus a siren layer during lockdown. */
  private startTension(): void {
    const ctx = this.ctx!;
    this.tOsc = ctx.createOscillator();
    this.tOsc.type = 'sawtooth';
    this.tOsc.frequency.value = 55;
    this.tFilter = ctx.createBiquadFilter();
    this.tFilter.type = 'lowpass';
    this.tFilter.frequency.value = 300;
    this.tGain = ctx.createGain();
    this.tGain.gain.value = 0;
    this.tLfo = ctx.createOscillator();
    this.tLfo.frequency.value = 2;
    this.tLfoGain = ctx.createGain();
    this.tLfoGain.gain.value = 0;
    this.tLfo.connect(this.tLfoGain).connect(this.tGain.gain);
    this.tOsc.connect(this.tFilter).connect(this.tGain).connect(this.master!);
    this.tOsc.start();
    this.tLfo.start();

    this.sirenOsc = ctx.createOscillator();
    this.sirenOsc.type = 'triangle';
    this.sirenOsc.frequency.value = 720;
    const sweep = ctx.createOscillator();
    sweep.frequency.value = 1.4;
    const sweepGain = ctx.createGain();
    sweepGain.gain.value = 170;
    sweep.connect(sweepGain).connect(this.sirenOsc.frequency);
    this.sirenGain = ctx.createGain();
    this.sirenGain.gain.value = 0;
    this.sirenOsc.connect(this.sirenGain).connect(this.master!);
    this.sirenOsc.start();
    sweep.start();
  }

  /** Call every frame. `trace01` is trace / 100. */
  setTension(trace01: number, lockdown: boolean, active: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.tGain || !this.tFilter || !this.tOsc || !this.tLfo || !this.tLfoGain || !this.sirenGain) return;
    const now = ctx.currentTime;
    const t = active ? Math.max(0, (trace01 - 0.3) / 0.7) : 0;
    const vol = t * t * 0.1;
    this.tGain.gain.setTargetAtTime(vol, now, 0.15);
    this.tLfoGain.gain.setTargetAtTime(vol * 0.9, now, 0.15);
    this.tLfo.frequency.setTargetAtTime(1.5 + t * 9, now, 0.2);
    this.tOsc.frequency.setTargetAtTime(52 + t * 90, now, 0.2);
    this.tFilter.frequency.setTargetAtTime(240 + t * 1500, now, 0.2);
    this.sirenGain.gain.setTargetAtTime(active && lockdown ? 0.035 : 0, now, 0.1);
  }

  // ---- one-shots ------------------------------------------------------------------------------

  private tone(f0: number, f1: number, dur: number, type: Wave, vol: number, delay = 0): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted) return;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + Math.min(0.012, dur / 3));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.03);
  }

  private burst(dur: number, cutoff: number, vol: number, delay = 0, type: BiquadFilterType = 'lowpass', cutoffEnd = cutoff): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise || this.muted) return;
    const t = ctx.currentTime + delay;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(cutoff, t);
    if (cutoffEnd !== cutoff) f.frequency.exponentialRampToValueAtTime(cutoffEnd, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(this.master);
    s.start(t, Math.random());
    s.stop(t + dur + 0.05);
  }

  /** Mechanical keystroke: a dry tick plus a short high click. */
  key(): void {
    this.burst(0.018, 3500, 0.11, 0, 'highpass');
    this.tone(1500 + Math.random() * 500, 700, 0.025, 'square', 0.035);
  }

  click(): void {
    this.tone(1100, 700, 0.04, 'square', 0.05);
  }

  /** Dial-up style handshake: quick alternating carriers over a hiss. */
  private modem(steps: number, vol: number): void {
    const f = [1200, 2200, 1800, 980, 2400, 1500, 2100, 1300, 1900, 2300];
    for (let i = 0; i < steps; i++) this.tone(f[i % f.length]!, f[(i + 3) % f.length]!, 0.045, i % 3 === 0 ? 'square' : 'sine', vol, i * 0.045);
    this.burst(steps * 0.045, 4200, vol * 0.7, 0, 'bandpass');
  }

  private sonar(): void {
    for (let i = 0; i < 3; i++) this.tone(880, 520, 0.7, 'sine', 0.16 / (1 + i * 1.4), i * 0.3);
  }

  private whoosh(): void {
    this.burst(0.28, 500, 0.12, 0, 'bandpass', 2600);
  }

  private siren(): void {
    for (let i = 0; i < 4; i++) this.tone(i % 2 ? 560 : 840, i % 2 ? 560 : 840, 0.22, 'sawtooth', 0.09, i * 0.24);
  }

  bind(bus: EventBus<SimEvents>): void {
    const on = <K extends keyof SimEvents>(k: K, f: (p: SimEvents[K]) => void): void => {
      this.off.push(bus.on(k, f));
    };
    on('COMMAND_ISSUED', (e) => {
      this.whoosh();
      if (e.cmd === 'inject' || e.cmd === 'spoof') this.modem(e.cmd === 'inject' ? 9 : 5, 0.07);
      else if (e.cmd === 'probe') this.modem(4, 0.05);
      else if (e.cmd === 'pivot') this.tone(600, 1200, 0.1, 'triangle', 0.12);
    });
    on('COMMAND_REJECTED', () => this.tone(150, 110, 0.14, 'square', 0.09));
    on('SCAN_PING', () => this.sonar());
    on('PROBED', () => {
      this.tone(1320, 1320, 0.08, 'sine', 0.14);
      this.tone(1760, 1760, 0.1, 'sine', 0.14, 0.09);
    });
    on('PACKET_DELIVERED', () => this.tone(1500, 1500, 0.035, 'square', 0.05));
    on('NODE_COMPROMISED', () => {
      this.tone(660, 660, 0.09, 'triangle', 0.2);
      this.tone(990, 990, 0.14, 'triangle', 0.2, 0.08);
    });
    on('NODE_PURGED', () => {
      this.burst(0.3, 900, 0.3);
      this.tone(140, 55, 0.3, 'sawtooth', 0.14);
    });
    on('ALERT_TRIGGERED', (e) => {
      const now = this.ctx?.currentTime ?? 0;
      if (e.fake || now - this.lastAlert < 0.3) return;
      this.lastAlert = now;
      this.tone(1760, 1760, 0.07, 'square', 0.06);
    });
    on('TRIPWIRE', () => {
      this.tone(95, 70, 0.4, 'sawtooth', 0.2);
      this.burst(0.3, 1800, 0.25, 0, 'bandpass');
    });
    on('VAULT_CRACKED', () => [392, 523, 659, 784].forEach((f, i) => this.tone(f, f, 0.16, 'triangle', 0.22, i * 0.07)));
    on('CORE_BREACHED', () => {
      [262, 330, 392, 523, 659, 784, 1047].forEach((f, i) => this.tone(f, f, 0.5, 'triangle', 0.2, i * 0.08));
      this.tone(131, 131, 1.2, 'sine', 0.25);
    });
    on('HONEYPOT_TRIGGERED', () => {
      this.siren();
      this.burst(0.5, 700, 0.3);
    });
    on('NUKE', () => {
      this.burst(0.8, 600, 0.55);
      this.tone(110, 28, 0.7, 'sine', 0.45);
    });
    on('WIPE', () => this.tone(900, 220, 0.5, 'sine', 0.14));
    on('DECOY', () => [0, 1, 2].forEach((i) => this.tone(1200 + Math.random() * 900, 800, 0.05, 'square', 0.06, i * 0.07)));
    on('LOCKDOWN', (e) => {
      if (e.on) this.siren();
    });
    on('DARK', (e) => (e.on ? this.tone(500, 60, 0.7, 'sine', 0.2) : this.tone(200, 900, 0.3, 'triangle', 0.15)));
    on('AGENT_STATE_CHANGED', (e) => {
      const now = this.ctx?.currentTime ?? 0;
      if (now - this.lastState < 0.2) return;
      this.lastState = now;
      if (e.to === 'Triangulate') this.tone(230, 150, 0.3, 'sawtooth', 0.1);
      else if (e.to === 'Investigate') this.tone(340, 300, 0.12, 'triangle', 0.07);
    });
    on('CONTRACT_LOST', () => {
      this.tone(220, 40, 1, 'sawtooth', 0.25);
      this.burst(1, 500, 0.3);
    });
    on('CONTRACT_STARTED', () => this.tone(440, 880, 0.2, 'triangle', 0.1));
  }
}
