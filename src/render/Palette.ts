/** Cold teal for what is yours, amber and vermilion for heat and ICE. Deliberately not neon-on-black. */
export const C = {
  bg: '#07090c',
  bgHi: '#0c1318',
  grid: '#0e161b',
  linkDim: '#1b2830',
  link: '#2c424d',
  linkOwned: '#6fd6c3',
  node: '#9fb5bd',
  nodeDim: '#4d636c',
  nodeFaint: '#2b3a42',
  owned: '#7fe7d4',
  ownedFill: 'rgba(127, 231, 212, 0.16)',
  gold: '#d9c36a',
  amber: '#e9b44c',
  hot: '#ff5a3c',
  ice: '#ff4b3a',
  iceDown: '#6a4a48',
  text: '#b8c7cc',
  textDim: '#5d7078',
  white: '#e8fff9',
  packet: '#bff7ec',
  decoy: '#e9b44c',
};

const hex = (c: string): [number, number, number] => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
const mix = (a: [number, number, number], b: [number, number, number], t: number): string => {
  const k = Math.max(0, Math.min(1, t));
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * k)},${Math.round(a[1] + (b[1] - a[1]) * k)},${Math.round(a[2] + (b[2] - a[2]) * k)})`;
};
const LINK = hex(C.link);
const AMBER = hex(C.amber);
const HOT = hex(C.hot);

/** Link colour by alert heat: steel at 0, amber around 0.8, vermilion from 1.6 up. */
export function heatColor(h: number): string {
  if (h <= 0.8) return mix(LINK, AMBER, h / 0.8);
  return mix(AMBER, HOT, (h - 0.8) / 0.8);
}
