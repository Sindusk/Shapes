import {
  GRID_SIZE,
  STARTING_LIVES,
  MATCH_COUNTDOWN_MS,
  MAX_MATCH_LENGTH_MS,
  BOSS_CAST_INTERVAL_START,
  BOSS_CAST_INTERVAL_END,
  BOSS_CHANNEL_START,
  BOSS_CHANNEL_END,
  BOSS_TILE_MIN_FRACTION_START,
  BOSS_TILE_MAX_FRACTION_START,
  BOSS_TILE_MIN_FRACTION_END,
  BOSS_TILE_MAX_FRACTION_END,
  ENRAGE_CAST_INTERVAL_MS,
  ENRAGE_CHANNEL_DURATION_MS,
  ENRAGE_ATTACKS_TO_END_MATCH,
} from './config.js';

const SHAPES = ['circle', 'square', 'triangle', 'diamond', 'pentagon', 'star'];
const COLORS = [0xe74c3c, 0x3498db, 0x2ecc71, 0xf1c40f, 0x9b59b6, 0xe67e22, 0x1abc9c, 0xfd79a8];

const DIRECTIONS = {
  up: { dx: 0, dy: -1 },
  down: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
};

const TOTAL_TILES = GRID_SIZE * GRID_SIZE;

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export class Game {
  constructor() {
    /**
     * @type {Map<string, {id: string, x: number|null, y: number|null, shape: string,
     *   color: number, lives: number, eliminated: boolean, benched: boolean,
     *   eliminatedAt: number|null, aliveMs: number|null}>}
     */
    this.players = new Map();
    this.dirty = false; // set only on real state changes; the loop broadcasts on dirty ticks

    // channelStartAt/channelEndAt are absolute timestamps so the client can
    // animate the cast bar and glow-tile blink itself, without needing a
    // broadcast every tick.
    this.boss = { state: 'idle', tiles: [], enraged: false, channelStartAt: 0, channelEndAt: 0 };
    this.nextChannelAt = 0;

    // phase: 'waiting' (no active match, boss paused) | 'countdown' (match
    // forming) | 'active' (rounds happening)
    this.match = {
      phase: 'waiting',
      countdownEndAt: null,
      startedAt: null,
      round: 0,
      enrageAttacks: 0,
    };
  }

  isOccupied(x, y) {
    for (const p of this.players.values()) {
      if (p.eliminated || p.benched) continue;
      if (p.x === x && p.y === y) return true;
    }
    return false;
  }

  findFreeTile() {
    const free = [];
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        if (!this.isOccupied(x, y)) free.push({ x, y });
      }
    }
    if (free.length === 0) return null;
    return free[Math.floor(Math.random() * free.length)];
  }

  addPlayer(id) {
    const now = Date.now();
    const benched = this.match.phase === 'active';
    const tile = benched ? null : this.findFreeTile();
    if (!benched && !tile) return null; // grid is full

    const player = {
      id,
      x: tile ? tile.x : null,
      y: tile ? tile.y : null,
      shape: SHAPES[Math.floor(Math.random() * SHAPES.length)],
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      lives: STARTING_LIVES,
      eliminated: false,
      benched,
      eliminatedAt: null,
      aliveMs: null,
    };
    this.players.set(id, player);

    if (!benched && this.match.phase === 'waiting') {
      this.match.phase = 'countdown';
      this.match.countdownEndAt = now + MATCH_COUNTDOWN_MS;
    }

    this.dirty = true;
    return player;
  }

  removePlayer(id) {
    if (this.players.delete(id)) this.dirty = true;
  }

  /** Server-authoritative move: validates direction, bounds, and collision. */
  tryMove(id, direction) {
    const player = this.players.get(id);
    const dir = DIRECTIONS[direction];
    if (!player || player.eliminated || player.benched || !dir) return false;

    const nx = player.x + dir.dx;
    const ny = player.y + dir.dy;
    if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) return false;
    if (this.isOccupied(nx, ny)) return false;

    player.x = nx;
    player.y = ny;
    this.dirty = true;
    return true;
  }

  pickGlowTiles(count) {
    const all = [];
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) all.push({ x, y });
    }
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    return all.slice(0, count);
  }

  matchProgress(now) {
    if (!this.match.startedAt) return 0;
    return clamp((now - this.match.startedAt) / MAX_MATCH_LENGTH_MS, 0, 1);
  }

  isEnraged(now) {
    return !!this.match.startedAt && now - this.match.startedAt >= MAX_MATCH_LENGTH_MS;
  }

  /** Random tile count for one attack: a uniform roll inside a [min, max]
   * fraction-of-board range that widens and shifts upward with progress. */
  rollTileCount(progress) {
    const minFraction = lerp(BOSS_TILE_MIN_FRACTION_START, BOSS_TILE_MIN_FRACTION_END, progress);
    const maxFraction = lerp(BOSS_TILE_MAX_FRACTION_START, BOSS_TILE_MAX_FRACTION_END, progress);
    const fraction = minFraction + Math.random() * (maxFraction - minFraction);
    return clamp(Math.round(TOTAL_TILES * fraction), 1, TOTAL_TILES);
  }

  /**
   * Starts a channel. Cast interval and channel duration are computed
   * independently from the match progress at this moment: the next cast is
   * scheduled `castInterval` after *this* cast's start, regardless of how
   * long this channel takes to resolve.
   */
  startChannel(now) {
    const enraged = this.isEnraged(now);
    const progress = this.matchProgress(now);
    this.boss.enraged = enraged;

    const tileCount = enraged ? TOTAL_TILES : this.rollTileCount(progress);
    const channelDurationMs = enraged
      ? ENRAGE_CHANNEL_DURATION_MS
      : lerp(BOSS_CHANNEL_START, BOSS_CHANNEL_END, progress ** 2) * 1000;
    const castIntervalMs = enraged
      ? ENRAGE_CAST_INTERVAL_MS
      : lerp(BOSS_CAST_INTERVAL_START, BOSS_CAST_INTERVAL_END, progress ** 2) * 1000;

    this.boss.state = 'channeling';
    this.boss.tiles = this.pickGlowTiles(tileCount);
    this.boss.channelStartAt = now;
    this.boss.channelEndAt = now + channelDurationMs;
    this.nextChannelAt = now + castIntervalMs;
    this.dirty = true;
  }

  resolveChannel(now) {
    for (const player of this.players.values()) {
      if (player.eliminated || player.benched) continue;
      const hit = this.boss.tiles.some((t) => t.x === player.x && t.y === player.y);
      if (!hit) continue;
      player.lives -= 1;
      if (player.lives <= 0) {
        player.lives = 0;
        this.eliminate(player, now);
      }
    }

    this.match.round += 1;
    if (this.boss.enraged) this.match.enrageAttacks += 1;

    this.boss.state = 'idle';
    this.boss.tiles = [];
    this.dirty = true;

    // nextChannelAt was already scheduled in startChannel, independent of
    // channel duration; if it has already passed (channel ran long), the
    // idle branch in update() will fire the next cast on the very next tick.
    this.checkMatchEnd(now);
  }

  eliminate(player, now) {
    player.eliminated = true;
    player.eliminatedAt = now;
    player.aliveMs = this.match.startedAt ? now - this.match.startedAt : 0;
  }

  checkMatchEnd(now) {
    const roster = [...this.players.values()].filter((p) => !p.benched);
    const allEliminated = roster.length > 0 && roster.every((p) => p.eliminated);
    const forcedByEnrage = this.boss.enraged && this.match.enrageAttacks >= ENRAGE_ATTACKS_TO_END_MATCH;

    if (!allEliminated && !forcedByEnrage) return;

    if (forcedByEnrage) {
      for (const p of roster) {
        if (!p.eliminated) {
          p.lives = 0;
          this.eliminate(p, now);
        }
      }
    }

    this.endMatch(now);
  }

  endMatch(now) {
    this.boss.state = 'idle';
    this.boss.tiles = [];
    this.boss.enraged = false;
    this.match.round = 0;
    this.match.enrageAttacks = 0;
    this.match.startedAt = null;

    // Everyone still connected (eliminated or benched) rolls into a fresh
    // roster for the next match.
    for (const player of this.players.values()) {
      player.lives = STARTING_LIVES;
      player.eliminated = false;
      player.eliminatedAt = null;
      player.aliveMs = null;
      player.benched = false;
      player.x = null;
      player.y = null;
    }
    for (const player of this.players.values()) {
      const tile = this.findFreeTile();
      player.x = tile ? tile.x : null;
      player.y = tile ? tile.y : null;
    }

    if (this.players.size > 0) {
      this.match.phase = 'countdown';
      this.match.countdownEndAt = now + MATCH_COUNTDOWN_MS;
    } else {
      this.match.phase = 'waiting';
      this.match.countdownEndAt = null;
    }
    this.dirty = true;
  }

  startMatch(now) {
    this.match.phase = 'active';
    this.match.startedAt = now;
    this.match.round = 0;
    this.match.enrageAttacks = 0;
    this.boss.state = 'idle';
    this.boss.enraged = false;
    this.nextChannelAt = now + BOSS_CAST_INTERVAL_START * 1000;
    this.dirty = true;
  }

  /**
   * Advances match/boss state. Call once per server tick. Only marks
   * `dirty` on actual state transitions (join/leave/move/phase/cast
   * changes) — timers animate client-side from the timestamps in the
   * snapshot, so we don't need to broadcast every tick just to keep a
   * clock moving.
   */
  update(now) {
    if (this.players.size === 0) {
      if (this.match.phase !== 'waiting') {
        this.match.phase = 'waiting';
        this.match.countdownEndAt = null;
        this.match.startedAt = null;
        this.boss.state = 'idle';
        this.boss.tiles = [];
        this.dirty = true;
      }
      return;
    }

    if (this.match.phase === 'waiting') return;

    if (this.match.phase === 'countdown') {
      if (now >= this.match.countdownEndAt) this.startMatch(now);
      return;
    }

    // active
    if (this.boss.state === 'idle') {
      if (now >= this.nextChannelAt) this.startChannel(now);
      return;
    }

    if (now >= this.boss.channelEndAt) this.resolveChannel(now);
  }

  snapshot() {
    return {
      gridSize: GRID_SIZE,
      serverTime: Date.now(),
      players: [...this.players.values()],
      boss: this.boss,
      match: this.match,
    };
  }
}
