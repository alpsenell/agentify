/**
 * Deterministic sparkline series + SVG path builders. Rendered at build
 * time so the charts are plain markup (no canvas, no JS needed to paint).
 */
export const SPARK_W = 100;
export const SPARK_H = 46;

export function series(seed: number, amp: number, days: number, zero: boolean): number[] {
  if (zero) return Array.from({ length: 34 }, () => 0.02);
  const step = 0.42 + seed * 0.13;
  return Array.from({ length: 34 }, (_, i) =>
    0.22 + amp * Math.abs(Math.sin(i * step + seed * 1.7 + days * 0.6)) * (0.72 + 0.28 * Math.sin(i * 0.19 + seed)));
}

export interface SparkPaths {
  line: string;
  area: string;
  endX: number;
  endY: number;
}

const r = (n: number) => Math.round(n * 100) / 100;

export function sparkPaths(pts: number[], w = SPARK_W, h = SPARK_H): SparkPaths {
  const coords = pts.map((v, i) => [r((i / (pts.length - 1)) * w), r(h - v * (h - 4) - 2)] as const);
  const line = coords.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join('');
  const area = `${line}L${w} ${h}L0 ${h}Z`;
  const [endX, endY] = coords[coords.length - 1];
  return { line, area, endX, endY };
}
