import { GRID_SIZE, METEOR_IMPACTS_PER_VOLLEY, METEOR_VOLLEYS } from './config.js';

// Boss attack patterns. Each builder returns an array of "waves":
//   { tiles: [{x, y}], step: n }
// `step` is measured in half-channel units — wave warnings appear
// `step * (channelTime / 2)` after the cast starts (per the design: each
// follow-up warning is delayed by half the current channel time), and every
// wave resolves one full channelTime after its own warning appears.

const N = GRID_SIZE;
const CENTER = Math.floor(N / 2);
const SIDES = ['left', 'right', 'top', 'bottom'];

function inBounds(x, y) {
  return x >= 0 && x < N && y >= 0 && y < N;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function allTiles() {
  const tiles = [];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) tiles.push({ x, y });
  }
  return tiles;
}

/** Full row/column at distance `i` from the given side. */
function lineTiles(side, i) {
  const tiles = [];
  for (let j = 0; j < N; j++) {
    if (side === 'left') tiles.push({ x: i, y: j });
    else if (side === 'right') tiles.push({ x: N - 1 - i, y: j });
    else if (side === 'top') tiles.push({ x: j, y: i });
    else tiles.push({ x: j, y: N - 1 - i });
  }
  return tiles;
}

/** Lines sweep across the arena from one side; the far line stays safe. */
function beam() {
  const side = pick(SIDES);
  const waves = [];
  for (let i = 0; i < N - 1; i++) waves.push({ tiles: lineTiles(side, i), step: i });
  return waves;
}

/** Concentric rings sweep inward. The four board corners and the single
 * center tile are safe for the whole mechanic. */
function ring() {
  const waves = [];
  const ringCount = Math.floor(N / 2); // center tile is never a ring
  for (let r = 0; r < ringCount; r++) {
    const tiles = [];
    for (const { x, y } of allTiles()) {
      const inset = Math.min(x, y, N - 1 - x, N - 1 - y);
      if (inset !== r) continue;
      const isBoardCorner = (x === 0 || x === N - 1) && (y === 0 || y === N - 1);
      if (isBoardCorner) continue;
      tiles.push({ x, y });
    }
    waves.push({ tiles, step: r });
  }
  return waves;
}

/** A cone expanding from the center of one side across the board. The
 * spread is tuned so the far corners (to either side) stay safe. */
function cone() {
  const side = pick(SIDES);
  const waves = [];
  for (let d = 0; d < N; d++) {
    const spread = Math.round((d * 2) / (N - 1)); // 0..2 on a 7x7 — far line leaves corners safe
    const tiles = [];
    for (let off = -spread; off <= spread; off++) {
      const lane = CENTER + off;
      if (lane < 0 || lane >= N) continue;
      if (side === 'top') tiles.push({ x: lane, y: d });
      else if (side === 'bottom') tiles.push({ x: lane, y: N - 1 - d });
      else if (side === 'left') tiles.push({ x: d, y: lane });
      else tiles.push({ x: N - 1 - d, y: lane });
    }
    waves.push({ tiles, step: d });
  }
  return waves;
}

/** A fissure travels along a random row/column one tile per half-step,
 * throwing residual attacks out to its sides that land one half-step
 * behind the front. */
function earthquake() {
  const vertical = Math.random() < 0.5; // travels vertically down/up a column, or horizontally along a row
  const lane = Math.floor(Math.random() * N);
  const reversed = Math.random() < 0.5;

  const waves = [];
  for (let s = 0; s < N; s++) {
    const d = reversed ? N - 1 - s : s;
    const main = vertical ? { x: lane, y: d } : { x: d, y: lane };
    waves.push({ tiles: [main], step: s });

    const residual = (
      vertical
        ? [{ x: lane - 1, y: d }, { x: lane + 1, y: d }]
        : [{ x: d, y: lane - 1 }, { x: d, y: lane + 1 }]
    ).filter((t) => inBounds(t.x, t.y));
    if (residual.length > 0) waves.push({ tiles: residual, step: s + 1 });
  }
  return waves;
}

/** The 8 tiles around each living player (their own tile is safe). */
function defamation(players) {
  const seen = new Set();
  const tiles = [];
  for (const p of players) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const x = p.x + dx;
        const y = p.y + dy;
        const key = `${x},${y}`;
        if (!inBounds(x, y) || seen.has(key)) continue;
        seen.add(key);
        tiles.push({ x, y });
      }
    }
  }
  return [{ tiles, step: 0 }];
}

/** Half the board in a checkerboard; the other parity stays safe for the
 * whole mechanic, so any adjacent (orthogonal) step is a dodge. The old
 * inverse follow-up wave was cut — lighting the entire arena forced an
 * awkward diagonal reposition and was too oppressive. */
function checkerboard() {
  const parity = Math.random() < 0.5 ? 0 : 1;
  const first = allTiles().filter(({ x, y }) => (x + y) % 2 === parity);
  return [{ tiles: first, step: 0 }];
}

/** [Custom] A full row + column through a random pivot, then both
 * diagonals through the same pivot as the follow-up. */
function cross() {
  const px = Math.floor(Math.random() * N);
  const py = Math.floor(Math.random() * N);

  const plus = allTiles().filter(({ x, y }) => x === px || y === py);
  const diagonals = allTiles().filter(
    ({ x, y }) => (x !== px || y !== py) && Math.abs(x - px) === Math.abs(y - py)
  );
  return [
    { tiles: plus, step: 0 },
    { tiles: diagonals, step: 1 },
  ];
}

/** [Custom] Two walls sweep inward from opposite sides at once, meeting at
 * the center line last. Survival means stepping into lines that have
 * already resolved. */
function vice() {
  const vertical = Math.random() < 0.5; // vertical walls (columns) or horizontal walls (rows)
  const waves = [];
  for (let i = 0; i <= Math.floor((N - 1) / 2); i++) {
    const lanes = new Set([i, N - 1 - i]);
    const tiles = [];
    for (const lane of lanes) {
      for (let j = 0; j < N; j++) {
        tiles.push(vertical ? { x: lane, y: j } : { x: j, y: lane });
      }
    }
    waves.push({ tiles, step: i });
  }
  return waves;
}

/** [Custom] Volleys of random 3x3 impact zones; the follow-up volley lands
 * half a channel behind the first. */
function meteor() {
  const waves = [];
  for (let v = 0; v < METEOR_VOLLEYS; v++) {
    const seen = new Set();
    const tiles = [];
    for (let m = 0; m < METEOR_IMPACTS_PER_VOLLEY; m++) {
      const cx = Math.floor(Math.random() * N);
      const cy = Math.floor(Math.random() * N);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          const key = `${x},${y}`;
          if (!inBounds(x, y) || seen.has(key)) continue;
          seen.add(key);
          tiles.push({ x, y });
        }
      }
    }
    waves.push({ tiles, step: v });
  }
  return waves;
}

/** [Custom] A radial arm rotates around the board center like a clock
 * hand, forcing players to circle around ahead of (or behind) it rather
 * than just stepping straight in from an edge. */
function spiral() {
  const clockwise = Math.random() < 0.5 ? 1 : -1;
  const startAngle = Math.random() * Math.PI * 2;
  const stepsPerRotation = 8;
  const totalSteps = Math.round(stepsPerRotation * 1.25); // just over one full rotation
  const angleStep = (Math.PI * 2) / stepsPerRotation;
  const halfWidth = angleStep * 0.6; // slight overlap so the arm reads as continuous

  const waves = [];
  for (let s = 0; s < totalSteps; s++) {
    const angle = startAngle + clockwise * s * angleStep;
    const tiles = allTiles().filter(({ x, y }) => {
      if (x === CENTER && y === CENTER) return false;
      const rawDiff = Math.atan2(y - CENTER, x - CENTER) - angle;
      const diff = Math.atan2(Math.sin(rawDiff), Math.cos(rawDiff)); // normalize to [-pi, pi]
      return Math.abs(diff) <= halfWidth;
    });
    waves.push({ tiles, step: s });
  }
  return waves;
}

/** [Custom] Two beams sweep in from adjacent (perpendicular) sides at
 * once, together tracing a growing L that crosses near the middle. The
 * corner opposite their shared edge stays safe until the mechanic ends. */
function mirror() {
  const corners = [
    ['left', 'top'],
    ['left', 'bottom'],
    ['right', 'top'],
    ['right', 'bottom'],
  ];
  const [sideA, sideB] = pick(corners);

  const waves = [];
  for (let i = 0; i < N - 1; i++) {
    const seen = new Set();
    const tiles = [];
    for (const t of [...lineTiles(sideA, i), ...lineTiles(sideB, i)]) {
      const key = `${t.x},${t.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tiles.push(t);
    }
    waves.push({ tiles, step: i });
  }
  return waves;
}

/** [Custom] A few safe pockets shrink over two waves; nearly the whole
 * board is hit each time except whichever pocket tiles are still safe. */
function fracture() {
  const lo = 1;
  const hi = N - 2;
  const layouts = [
    [{ x: lo, y: lo }, { x: hi, y: lo }, { x: CENTER, y: hi }],
    [{ x: lo, y: hi }, { x: hi, y: hi }, { x: CENTER, y: lo }],
    [{ x: lo, y: CENTER }, { x: hi, y: CENTER }, { x: CENTER, y: CENTER }],
  ];
  const centers = pick(layouts);

  function safeSet(radius) {
    const safe = new Set();
    for (const c of centers) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const x = c.x + dx;
          const y = c.y + dy;
          if (inBounds(x, y)) safe.add(`${x},${y}`);
        }
      }
    }
    return safe;
  }

  const waves = [];
  [1, 0].forEach((radius, step) => {
    const safe = safeSet(radius);
    const tiles = allTiles().filter(({ x, y }) => !safe.has(`${x},${y}`));
    waves.push({ tiles, step });
  });
  return waves;
}

/** Builds a danger/safe wave pair: `safeTiles` is the "stand in the good"
 * zone (rendered green, never damages), `tiles` is everything else on the
 * board (rendered white, damages as normal). Used by every safe-zone
 * pattern below so they only need to describe the safe area. */
function safeZoneWave(safeTiles, step) {
  const safe = new Set(safeTiles.map(({ x, y }) => `${x},${y}`));
  const tiles = allTiles().filter(({ x, y }) => !safe.has(`${x},${y}`));
  return { tiles, safeTiles, step };
}

/** [Custom][Safe zone] A single refuge at the board's center; everywhere
 * else is hit. The simplest "stand in the good" read. */
function sanctuary() {
  const safe = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = CENTER + dx;
      const y = CENTER + dy;
      if (inBounds(x, y)) safe.push({ x, y });
    }
  }
  return [safeZoneWave(safe, 0)];
}

/** [Custom][Safe zone] The four 2x2 corners are safe; the rest of the
 * board is hit. Spreads refuge-seekers to the board's edges. */
function bastion() {
  const safe = [];
  for (const [cx, sx] of [[0, 1], [N - 1, -1]]) {
    for (const [cy, sy] of [[0, 1], [N - 1, -1]]) {
      for (let dy = 0; dy <= 1; dy++) {
        for (let dx = 0; dx <= 1; dx++) {
          const x = cx + dx * sx;
          const y = cy + dy * sy;
          if (inBounds(x, y)) safe.push({ x, y });
        }
      }
    }
  }
  return [safeZoneWave(safe, 0)];
}

/** [Custom][Safe zone] A quadrant refuge appears, then relocates to a
 * different quadrant for the follow-up wave — players who camp the first
 * safe zone get caught by the second. */
function refuge() {
  const half = Math.ceil(N / 2);
  const quadrants = [
    { x0: 0, y0: 0 },
    { x0: N - half, y0: 0 },
    { x0: 0, y0: N - half },
    { x0: N - half, y0: N - half },
  ];
  const [a, b] = [...quadrants].sort(() => Math.random() - 0.5).slice(0, 2);

  const quadrantTiles = ({ x0, y0 }) => {
    const tiles = [];
    for (let dy = 0; dy < half; dy++) {
      for (let dx = 0; dx < half; dx++) {
        const x = x0 + dx;
        const y = y0 + dy;
        if (inBounds(x, y)) tiles.push({ x, y });
      }
    }
    return tiles;
  };

  return [safeZoneWave(quadrantTiles(a), 0), safeZoneWave(quadrantTiles(b), 1)];
}

/** [Custom][Safe zone] A single row or column is safe; the rest of the
 * board is hit. Funnels everyone into one lane. */
function causeway() {
  const vertical = Math.random() < 0.5;
  const lane = Math.floor(Math.random() * N);
  const safe = vertical ? lineTiles('left', lane) : lineTiles('top', lane);
  return [safeZoneWave(safe, 0)];
}

/** [Custom][Safe zone] A wedge of safety rotates around the center like a
 * lighthouse beam; almost the whole board is hit each step except
 * whichever wedge the beam currently covers. */
function eclipse() {
  const clockwise = Math.random() < 0.5 ? 1 : -1;
  const startAngle = Math.random() * Math.PI * 2;
  const totalSteps = 6;
  const angleStep = (Math.PI * 2) / totalSteps;
  const halfWidth = angleStep * 0.75; // wide enough to be a fair refuge amid full-board danger

  const waves = [];
  for (let s = 0; s < totalSteps; s++) {
    const angle = startAngle + clockwise * s * angleStep;
    const safe = allTiles().filter(({ x, y }) => {
      if (x === CENTER && y === CENTER) return true; // center always a small anchor refuge
      const rawDiff = Math.atan2(y - CENTER, x - CENTER) - angle;
      const diff = Math.atan2(Math.sin(rawDiff), Math.cos(rawDiff));
      return Math.abs(diff) <= halfWidth;
    });
    waves.push(safeZoneWave(safe, s));
  }
  return waves;
}

export const PATTERNS = [
  { name: 'Beam', build: beam },
  { name: 'Ring', build: ring },
  { name: 'Cone', build: cone },
  { name: 'Earthquake', build: earthquake },
  { name: 'Defamation', build: defamation },
  { name: 'Checkerboard', build: checkerboard },
  { name: 'Cross', build: cross },
  { name: 'Vice', build: vice },
  { name: 'Meteor', build: meteor },
  { name: 'Spiral', build: spiral },
  { name: 'Mirror', build: mirror },
  { name: 'Fracture', build: fracture },
  { name: 'Sanctuary', build: sanctuary },
  { name: 'Bastion', build: bastion },
  { name: 'Refuge', build: refuge },
  { name: 'Causeway', build: causeway },
  { name: 'Eclipse', build: eclipse },
];

/**
 * Picks a random pattern (never the same one twice in a row) and converts
 * its step-based waves into absolute warn/resolve timestamps.
 *
 * @param {number} now
 * @param {number} channelMs current (scaled) channel duration
 * @param {{players: Array<{x:number,y:number}>, excludeName?: string|null}} ctx
 */
export function buildAttack(now, channelMs, { players, excludeName = null }) {
  const halfMs = channelMs / 2;
  const pool = PATTERNS.filter((p) => p.name !== excludeName);
  const pattern = pick(pool);

  const waves = pattern
    .build(players)
    .filter((w) => w.tiles.length > 0)
    .map((w) => ({
      tiles: w.tiles,
      ...(w.safeTiles ? { safeTiles: w.safeTiles } : {}),
      warnAt: now + w.step * halfMs,
      resolveAt: now + w.step * halfMs + channelMs,
    }))
    .sort((a, b) => a.resolveAt - b.resolveAt);

  return { name: pattern.name, waves };
}
