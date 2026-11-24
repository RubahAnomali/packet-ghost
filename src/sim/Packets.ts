import { ObjectPool } from '../core/ObjectPool';

export type PacketKind = 'cmd' | 'scan' | 'decoy' | 'nuke' | 'ambient';

/** A bit of traffic travelling `path` (node ids) one link at a time. `seg` is the link, `t` the progress on it. */
export interface Packet {
  kind: PacketKind;
  path: number[];
  seg: number;
  t: number;
  /** Owning job id, or 0 for ambient traffic. */
  job: number;
}

export function createPacketPool(): ObjectPool<Packet> {
  return new ObjectPool<Packet>(
    () => ({ kind: 'cmd', path: [], seg: 0, t: 0, job: 0 }),
    (p) => {
      p.kind = 'cmd';
      p.path.length = 0;
      p.seg = 0;
      p.t = 0;
      p.job = 0;
    },
    48,
  );
}
