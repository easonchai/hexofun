/**
 * Hexagon stage geometry — ported from the designer prototype
 * ("HEX Voltage Refined"): 36 tiles on the hexagon's six edges, an inner dot
 * lattice, and the laser's dot-to-dot travel path. Pure functions, no DOM.
 */

export const STAGE_W = 620;
export const STAGE_H = 600;
export const CENTER_X = 310;
export const CENTER_Y = 300;
export const OUTER_R = 265;
/** Tenth-of-a-USDC cell of the hexpot ticker, in stage coordinates. */
export const HEXPOT_X = CENTER_X;
export const HEXPOT_Y = STAGE_H + 15;

export interface TilePoint {
  /** Display number 1..36 (protocol tile index is n-1). */
  n: number;
  x: number;
  y: number;
  rot: number;
}

export interface Dot {
  x: number;
  y: number;
  key: string;
}

export interface Geo {
  tiles: TilePoint[];
  dots: Dot[];
  hexPts: string;
  cx: number;
  cy: number;
}

const dotKey = (x: number, y: number): string =>
  `${Math.round(x)}_${Math.round(y)}`;

/** Stage layout: vertex ring, edge tiles (t_i = .1481 + i*.1407), inner dots. */
export function computeGeo(): Geo {
  const verts: [number, number][] = [];
  for (let k = 0; k < 6; k += 1) {
    const a = ((-90 + 60 * k) * Math.PI) / 180;
    verts.push([
      CENTER_X + OUTER_R * Math.cos(a),
      CENTER_Y + OUTER_R * Math.sin(a),
    ]);
  }

  const tiles: TilePoint[] = [];
  let n = 1;
  for (let k = 0; k < 6; k += 1) {
    const [ax, ay] = verts[k]!;
    const [bx, by] = verts[(k + 1) % 6]!;
    const rot = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
    for (let i = 0; i < 6; i += 1) {
      const t = 0.1481 + i * 0.1407;
      const x = ax + (bx - ax) * t;
      const y = ay + (by - ay) * t;
      tiles.push({
        n: n++,
        x: +x.toFixed(1),
        y: +y.toFixed(1),
        rot: +rot.toFixed(1),
      });
    }
  }

  // Inscribed inner hexagon bounding the dot lattice.
  const iR = OUTER_R - 52;
  const iv: [number, number][] = [];
  for (let k = 0; k < 6; k += 1) {
    const a = ((-90 + 60 * k) * Math.PI) / 180;
    iv.push([CENTER_X + iR * Math.cos(a), CENTER_Y + iR * Math.sin(a)]);
  }

  const inside = (x: number, y: number): boolean => {
    let c = false;
    for (let i = 0, j = 5; i < 6; j = i++) {
      const [xi, yi] = iv[i]!;
      const [xj, yj] = iv[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
        c = !c;
    }
    return c;
  };

  const dots: Dot[] = [];
  let row = 0;
  for (let y = CENTER_Y - 195; y <= CENTER_Y + 195; y += 26, row++) {
    for (
      let x = CENTER_X - 210 + (row % 2 ? 14 : 0);
      x <= CENTER_X + 210;
      x += 28
    ) {
      if (inside(x, y)) dots.push({ x, y, key: dotKey(x, y) });
    }
  }

  return {
    tiles,
    dots,
    hexPts: verts
      .map((v) => `${v[0]!.toFixed(1)},${v[1]!.toFixed(1)}`)
      .join(" "),
    cx: CENTER_X,
    cy: CENTER_Y,
  };
}

export interface LaserPath {
  /** SVG path data: center origin → lattice hops → target tile. */
  pathD: string;
  /** Lattice dots the beam touches, in strike order (dot key → delay/symbol). */
  activeDotTimes: Record<string, { delay: number; sym: number }>;
}

const LASER_DURATION = 0.9; // seconds, matches the CSS animation

/**
 * Walks from the lattice center to the target tile through nearby dots,
 * preferring progress toward the target on the tail. Deterministic given a
 * seeded RNG so reveals can be replayed in tests.
 */
export function genPath(
  geo: Geo,
  tx: number,
  ty: number,
  rng: () => number = Math.random,
): LaserPath {
  const { dots, cx, cy } = geo;
  let cur = dots.reduce((best, dot) =>
    (dot.x - cx) ** 2 + (dot.y - cy) ** 2 <
    (best.x - cx) ** 2 + (best.y - cy) ** 2
      ? dot
      : best,
  );
  const pts: Dot[] = [cur];
  const wander = 8 + Math.floor(rng() * 5);

  const hops = (limit: number, exclude: number) =>
    dots.filter(
      (dot) =>
        dot !== cur &&
        Math.hypot(dot.x - cur!.x, dot.y - cur!.y) < limit &&
        !pts.slice(-exclude).includes(dot),
    );

  for (let i = 0; i < wander; i++) {
    const neighbors = hops(52, 4);
    if (!neighbors.length) break;
    cur = neighbors[Math.floor(rng() * neighbors.length)]!;
    pts.push(cur);
  }

  let guard = 0;
  while (Math.hypot(cur.x - tx, cur.y - ty) > 75 && guard++ < 40) {
    const neighbors = hops(52, 3);
    if (!neighbors.length) break;
    neighbors.sort(
      (a, b) => Math.hypot(a.x - tx, a.y - ty) - Math.hypot(b.x - tx, b.y - ty),
    );
    cur = neighbors[Math.min(neighbors.length - 1, Math.floor(rng() * 2))]!;
    pts.push(cur);
  }

  pts.push({ x: tx, y: ty, key: dotKey(tx, ty) });

  const allPts = [{ x: cx, y: cy, key: "origin" }, ...pts];
  const segLens: number[] = [];
  let totalLen = 0;
  for (let i = 1; i < allPts.length; i++) {
    const seg = Math.hypot(
      allPts[i]!.x - allPts[i - 1]!.x,
      allPts[i]!.y - allPts[i - 1]!.y,
    );
    segLens.push(seg);
    totalLen += seg;
  }

  const activeDotTimes: Record<string, { delay: number; sym: number }> = {};
  let cum = 0;
  for (let i = 0; i < segLens.length; i++) {
    cum += segLens[i]!;
    const pt = allPts[i + 1]!;
    if (i + 1 < allPts.length - 1) {
      const time = (cum / totalLen) * LASER_DURATION;
      if (activeDotTimes[pt.key] === undefined) {
        activeDotTimes[pt.key] = {
          delay: +time.toFixed(3),
          sym: (i - 1 + 6) % 6,
        };
      }
    }
  }

  const pathD =
    "M" + allPts.map((p) => `${Math.round(p.x)} ${Math.round(p.y)}`).join(" L");
  return { pathD, activeDotTimes };
}

export interface FlyToken {
  sym: number;
  delay: number;
  pathD: string;
}

export const FLY_DURATION = 0.68; // matches .fly-symbol-token CSS
export const FLY_STAGGER = 0.045;

/**
 * One flying token per lattice symbol the laser stamped, launched in strike
 * order, plus the winning tile's own symbol last — the hexpot absorption.
 */
export function buildFlyTokens(
  activeDotTimes: Record<string, { delay: number; sym: number }>,
  winTile: TilePoint,
  rng: () => number = Math.random,
): FlyToken[] {
  const sources = Object.entries(activeDotTimes)
    .map(([key, info]) => {
      const [xs, ys] = key.split("_");
      return { key, x: +xs!, y: +ys!, sym: info.sym, order: info.delay };
    })
    .sort((a, b) => a.order - b.order);

  sources.push({
    key: "win",
    x: winTile.x,
    y: winTile.y,
    sym: Math.floor(rng() * 6),
    order: Number.POSITIVE_INFINITY,
  });

  return sources.map((src, i) => {
    const delay = +(i * FLY_STAGGER).toFixed(3);
    const midX = (src.x + HEXPOT_X) / 2 + (src.x < HEXPOT_X ? -35 : 35);
    const midY = (src.y + HEXPOT_Y) / 2 - 25;
    return {
      sym: src.sym,
      delay,
      pathD: `M ${Math.round(src.x)} ${Math.round(src.y)} Q ${Math.round(midX)} ${Math.round(midY)} ${HEXPOT_X} ${HEXPOT_Y}`,
    };
  });
}

/** Last token arrival in ms — when the hexpot odometer lands its increment. */
export function lastFlyArrivalMs(tokens: FlyToken[]): number {
  return tokens.length
    ? Math.round((tokens[tokens.length - 1]!.delay + FLY_DURATION) * 1000)
    : 0;
}
