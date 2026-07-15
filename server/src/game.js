import {
  GRID_SIZE,
  STARTING_LIVES,
  BOSS_CAST_INTERVAL_MS,
  BOSS_CHANNEL_DURATION_MS,
  BOSS_TILE_COUNT,
} from './config.js';

const SHAPES = ['circle', 'square', 'triangle', 'diamond', 'pentagon', 'star'];
const COLORS = [0xe74c3c, 0x3498db, 0x2ecc71, 0xf1c40f, 0x9b59b6, 0xe67e22, 0x1abc9c, 0xfd79a8];

const DIRECTIONS = {
  up: { dx: 0, dy: -1 },
  down: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
};

export class Game {
  constructor() {
    /** @type {Map<string, {id: string, x: number, y: number, shape: string, color: number, lives: number, eliminated: boolean}>} */
    this.players = new Map();
    this.dirty = false; // set when state changes; the loop broadcasts on dirty ticks

    this.boss = { state: 'idle', tiles: [], progress: 0 };
    this.channelStartAt = 0;
    this.channelEndAt = 0;
    this.nextChannelAt = Date.now() + BOSS_CAST_INTERVAL_MS;
  }

  isOccupied(x, y) {
    for (const p of this.players.values()) {
      if (!p.eliminated && p.x === x && p.y === y) return true;
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
    const tile = this.findFreeTile();
    if (!tile) return null; // grid is full
    const player = {
      id,
      x: tile.x,
      y: tile.y,
      shape: SHAPES[Math.floor(Math.random() * SHAPES.length)],
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      lives: STARTING_LIVES,
      eliminated: false,
    };
    this.players.set(id, player);
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
    if (!player || player.eliminated || !dir) return false;

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

  startChannel(now) {
    this.boss.state = 'channeling';
    this.boss.tiles = this.pickGlowTiles(BOSS_TILE_COUNT);
    this.channelStartAt = now;
    this.channelEndAt = now + BOSS_CHANNEL_DURATION_MS;
    this.dirty = true;
  }

  resolveChannel(now) {
    for (const player of this.players.values()) {
      if (player.eliminated) continue;
      const hit = this.boss.tiles.some((t) => t.x === player.x && t.y === player.y);
      if (!hit) continue;
      player.lives -= 1;
      if (player.lives <= 0) {
        player.lives = 0;
        player.eliminated = true;
      }
    }

    this.boss.state = 'idle';
    this.boss.tiles = [];
    this.boss.progress = 0;
    this.nextChannelAt = now + BOSS_CAST_INTERVAL_MS;
    this.dirty = true;
  }

  /** Advances the boss cast cycle. Call once per server tick. */
  update(now) {
    if (this.boss.state === 'idle') {
      if (now >= this.nextChannelAt) this.startChannel(now);
      return;
    }

    if (now >= this.channelEndAt) {
      this.resolveChannel(now);
      return;
    }

    this.boss.progress = (now - this.channelStartAt) / (this.channelEndAt - this.channelStartAt);
    this.dirty = true; // keep the cast bar animating on every tick while channeling
  }

  snapshot() {
    return {
      gridSize: GRID_SIZE,
      players: [...this.players.values()],
      boss: this.boss,
    };
  }
}
