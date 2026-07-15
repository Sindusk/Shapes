import { GRID_SIZE, STARTING_LIVES } from './config.js';

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
    /** @type {Map<string, {id: string, x: number, y: number, shape: string, color: number, lives: number}>} */
    this.players = new Map();
    this.dirty = false; // set when state changes; the loop broadcasts on dirty ticks
  }

  isOccupied(x, y) {
    for (const p of this.players.values()) {
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
    const tile = this.findFreeTile();
    if (!tile) return null; // grid is full
    const player = {
      id,
      x: tile.x,
      y: tile.y,
      shape: SHAPES[Math.floor(Math.random() * SHAPES.length)],
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      lives: STARTING_LIVES,
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
    if (!player || !dir) return false;

    const nx = player.x + dir.dx;
    const ny = player.y + dir.dy;
    if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) return false;
    if (this.isOccupied(nx, ny)) return false;

    player.x = nx;
    player.y = ny;
    this.dirty = true;
    return true;
  }

  snapshot() {
    return {
      gridSize: GRID_SIZE,
      players: [...this.players.values()],
    };
  }
}
