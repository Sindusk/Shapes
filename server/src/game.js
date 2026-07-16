import {
  GRID_SIZE,
  STARTING_LIVES,
  MATCH_COUNTDOWN_MS,
  MAX_MATCH_LENGTH_MS,
  BOSS_SCALING_RAMP_MS,
  BOSS_CAST_INTERVAL_START,
  BOSS_CAST_INTERVAL_END,
  BOSS_CHANNEL_START,
  BOSS_CHANNEL_END,
  ENRAGE_CAST_INTERVAL_MS,
  ENRAGE_CHANNEL_DURATION_MS,
  ENRAGE_ATTACKS_TO_END_MATCH,
  ABILITY_DAMAGE_COOLDOWN_MS,
  ABILITY_PUSHBACK_COOLDOWN_MS,
  ABILITY_DASH_COOLDOWN_MS,
  ABILITY_INVULN_COOLDOWN_MS,
  PUSHBACK_STUN_MS,
  DASH_TILES,
  INVULN_DURATION_MS,
} from './config.js';
import { buildAttack, allTiles } from './patterns.js';

const SHAPES = ['circle', 'square', 'triangle', 'diamond', 'pentagon', 'star'];
const COLORS = [0xe74c3c, 0x3498db, 0x2ecc71, 0xf1c40f, 0x9b59b6, 0xe67e22, 0x1abc9c, 0xfd79a8];

const DIRECTIONS = {
  up: { dx: 0, dy: -1 },
  down: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
};

const ABILITY_COOLDOWNS = {
  1: ABILITY_DAMAGE_COOLDOWN_MS,
  2: ABILITY_PUSHBACK_COOLDOWN_MS,
  3: ABILITY_DASH_COOLDOWN_MS,
  4: ABILITY_INVULN_COOLDOWN_MS,
};

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/** Fast ease-out: steep early ramp that flattens as it nears 1, reaching
 * exactly 1 at t=1. Used instead of a linear/lerp ramp so difficulty climbs
 * quickly rather than crawling up over the whole match. */
function easeOutCubic(t) {
  return 1 - (1 - t) ** 3;
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

    // Attacks can overlap: a new cast starts on its own schedule regardless
    // of whether earlier attacks still have waves pending, so several named
    // attacks can be mid-resolution at once. Each entry in `boss.attacks` is
    // an independent named pattern: { name, waves, channelStartAt,
    // channelEndAt, enraged }. Waves carry absolute warnAt/resolveAt
    // timestamps (see patterns.js) — the client animates warnings, cast
    // bars, and blink entirely from these, without needing a broadcast
    // every tick. An attack is removed from the array once all its waves
    // have resolved.
    this.boss = {
      state: 'idle', // 'idle' | 'attacking' (attacking whenever attacks.length > 0)
      attacks: [],
      enraged: false,
    };
    this.nextChannelAt = 0;
    this.lastAttackName = null;

    // The egg: a pushable NPC that spawns at match start. If a boss wave
    // hits its tile, every living player loses a life.
    this.egg = null; // {x, y} | null

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

  isEggAt(x, y) {
    return !!this.egg && this.egg.x === x && this.egg.y === y;
  }

  findFreeTile() {
    const free = [];
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        if (!this.isOccupied(x, y) && !this.isEggAt(x, y)) free.push({ x, y });
      }
    }
    if (free.length === 0) return null;
    return free[Math.floor(Math.random() * free.length)];
  }

  addPlayer(id, username = null) {
    const now = Date.now();
    const benched = this.match.phase === 'active';
    const tile = benched ? null : this.findFreeTile();
    if (!benched && !tile) return null; // grid is full

    const player = {
      id,
      username: username ?? `Player ${id.slice(0, 4)}`,
      x: tile ? tile.x : null,
      y: tile ? tile.y : null,
      shape: SHAPES[Math.floor(Math.random() * SHAPES.length)],
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      lives: STARTING_LIVES,
      eliminated: false,
      benched,
      eliminatedAt: null,
      aliveMs: null,
      facing: 'down',
      cooldowns: { 1: 0, 2: 0, 3: 0, 4: 0 }, // slot -> timestamp when usable again
      stunnedUntil: 0,
      invulnerableUntil: 0,
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
  tryMove(id, direction, now = Date.now()) {
    const player = this.players.get(id);
    const dir = DIRECTIONS[direction];
    if (!player || player.eliminated || player.benched || !dir) return false;
    if (player.stunnedUntil > now) return false;

    if (player.facing !== direction) {
      player.facing = direction;
      this.dirty = true;
    }

    const nx = player.x + dir.dx;
    const ny = player.y + dir.dy;
    if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) return false;
    if (this.isOccupied(nx, ny)) return false;

    if (this.isEggAt(nx, ny)) {
      // Moving into the egg pushes it one tile further along; if that tile
      // is a wall or another player, the egg swaps places with the mover.
      const ex = nx + dir.dx;
      const ey = ny + dir.dy;
      const pushBlocked =
        ex < 0 || ex >= GRID_SIZE || ey < 0 || ey >= GRID_SIZE || this.isOccupied(ex, ey);
      if (pushBlocked) {
        this.egg.x = player.x;
        this.egg.y = player.y;
      } else {
        this.egg.x = ex;
        this.egg.y = ey;
      }
    }

    player.x = nx;
    player.y = ny;
    this.dirty = true;
    return true;
  }

  /** Server-authoritative ability use: validates the caster, cooldown, and
   * stun state, then dispatches to the per-slot handler. */
  tryAbility(id, slot, now = Date.now()) {
    const player = this.players.get(id);
    const cooldownMs = ABILITY_COOLDOWNS[slot];
    if (!player || player.eliminated || player.benched || !cooldownMs) return false;
    if (player.stunnedUntil > now) return false;
    if (player.cooldowns[slot] > now) return false;

    player.cooldowns[slot] = now + cooldownMs;

    switch (slot) {
      case 1:
        break; // damage: placeholder, no effect yet
      case 2:
        this.abilityPushback(player, now);
        break;
      case 3:
        this.abilityDash(player, now);
        break;
      case 4:
        player.invulnerableUntil = now + INVULN_DURATION_MS;
        break;
    }

    this.dirty = true;
    return true;
  }

  /** Pushes every other active player 1 tile away from the caster (including
   * diagonally, based on their relative position). A push that can't land
   * in-bounds or on a free tile stuns the target instead. */
  abilityPushback(caster, now) {
    const targets = [...this.players.values()].filter(
      (p) => p !== caster && !p.eliminated && !p.benched
    );

    const claimed = new Set([`${caster.x},${caster.y}`]);
    const moves = [];

    for (const p of targets) {
      const ddx = Math.sign(p.x - caster.x);
      const ddy = Math.sign(p.y - caster.y);
      const nx = p.x + ddx;
      const ny = p.y + ddy;
      const inBounds = nx >= 0 && nx < GRID_SIZE && ny >= 0 && ny < GRID_SIZE;
      const key = `${nx},${ny}`;

      if (!inBounds || claimed.has(key) || this.isEggAt(nx, ny)) {
        p.stunnedUntil = now + PUSHBACK_STUN_MS;
        continue;
      }
      claimed.add(key);
      moves.push({ p, nx, ny });
    }

    for (const { p, nx, ny } of moves) {
      p.x = nx;
      p.y = ny;
    }
  }

  /** Moves the caster up to DASH_TILES in their facing direction, stopping
   * at the first wall or occupied tile. */
  abilityDash(caster, now) {
    const dir = DIRECTIONS[caster.facing];
    if (!dir) return;

    for (let i = 0; i < DASH_TILES; i++) {
      const nx = caster.x + dir.dx;
      const ny = caster.y + dir.dy;
      if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) break;
      if (this.isOccupied(nx, ny) || this.isEggAt(nx, ny)) break;
      caster.x = nx;
      caster.y = ny;
    }
  }

  matchProgress(now) {
    if (!this.match.startedAt) return 0;
    return clamp((now - this.match.startedAt) / MAX_MATCH_LENGTH_MS, 0, 1);
  }

  isEnraged(now) {
    return !!this.match.startedAt && now - this.match.startedAt >= MAX_MATCH_LENGTH_MS;
  }

  /** 0 at match start, 1 once BOSS_SCALING_RAMP_MS has elapsed (then holds
   * at 1 for the rest of the match, until enrage). */
  scalingFactor(now) {
    if (!this.match.startedAt) return 0;
    const t = clamp((now - this.match.startedAt) / BOSS_SCALING_RAMP_MS, 0, 1);
    return easeOutCubic(t);
  }

  /**
   * Starts an attack (a named pattern of one or more waves) and adds it
   * alongside any attacks already in progress. Cast interval and channel
   * duration are computed from the match progress at this moment; the next
   * cast is scheduled `castInterval` after *this* cast's start regardless
   * of how long this or any other attack takes to fully resolve — attacks
   * are allowed to overlap, stacking their glow tiles for extra chaos.
   */
  startAttack(now) {
    const enraged = this.isEnraged(now);

    const scaling = this.scalingFactor(now);
    const channelDurationMs = enraged
      ? ENRAGE_CHANNEL_DURATION_MS
      : (BOSS_CHANNEL_START - (BOSS_CHANNEL_START - BOSS_CHANNEL_END) * scaling) * 1000;
    const castIntervalMs = enraged
      ? ENRAGE_CAST_INTERVAL_MS
      : (BOSS_CAST_INTERVAL_START - (BOSS_CAST_INTERVAL_START - BOSS_CAST_INTERVAL_END) * scaling) * 1000;

    let name, waves;
    if (enraged) {
      name = 'Enrage';
      waves = [{ tiles: allTiles(), warnAt: now, resolveAt: now + channelDurationMs }];
    } else {
      const alive = [...this.players.values()].filter((p) => !p.eliminated && !p.benched);
      const attack = buildAttack(now, channelDurationMs, {
        players: alive,
        excludeName: this.lastAttackName,
      });
      name = attack.name;
      waves = attack.waves;
      this.lastAttackName = name;
    }

    this.boss.attacks.push({
      name,
      waves,
      channelStartAt: now,
      channelEndAt: waves[0]?.resolveAt ?? now + channelDurationMs,
      enraged,
    });
    this.boss.state = 'attacking';
    this.boss.enraged = this.boss.attacks.some((a) => a.enraged);
    this.nextChannelAt = now + castIntervalMs;
    this.dirty = true;
  }

  /** Resolves every wave whose time has come, across every attack in
   * progress (each attack's waves are sorted by resolveAt). Once an
   * attack's waves are all gone it's dropped from `boss.attacks`; once no
   * attacks remain the boss goes idle. */
  resolveWaves(now) {
    let resolvedAny = false;
    for (const attack of this.boss.attacks) {
      while (attack.waves.length > 0 && now >= attack.waves[0].resolveAt) {
        this.applyWaveDamage(attack.waves.shift(), now);
        resolvedAny = true;
      }
    }
    if (!resolvedAny) return;

    const finished = this.boss.attacks.filter((a) => a.waves.length === 0);
    if (finished.length > 0) {
      this.boss.attacks = this.boss.attacks.filter((a) => a.waves.length > 0);
      this.match.round += finished.length;
      this.match.enrageAttacks += finished.filter((a) => a.enraged).length;
      this.boss.state = this.boss.attacks.length === 0 ? 'idle' : 'attacking';
      this.boss.enraged = this.boss.attacks.some((a) => a.enraged);
      // nextChannelAt was already scheduled independently in startAttack;
      // if it has already passed, the next cast fires on the very next
      // tick regardless of whether attacks just finished here.
    }

    this.dirty = true;
    this.checkMatchEnd(now);
  }

  applyWaveDamage(wave, now) {
    const hit = new Set(wave.tiles.map((t) => `${t.x},${t.y}`));

    // The egg takes the hit for everyone: if a wave lands on it, every
    // living player loses a life (individual invulnerability still helps).
    const eggHit = !!this.egg && hit.has(`${this.egg.x},${this.egg.y}`);

    for (const player of this.players.values()) {
      if (player.eliminated || player.benched) continue;
      let damage = 0;
      if (hit.has(`${player.x},${player.y}`)) damage += 1;
      if (eggHit) damage += 1;
      if (damage === 0 || player.invulnerableUntil > now) continue;
      player.lives -= damage;
      if (player.lives <= 0) {
        player.lives = 0;
        this.eliminate(player, now);
      }
    }
  }

  eliminate(player, now) {
    player.eliminated = true;
    player.eliminatedAt = now;
    player.aliveMs = this.match.startedAt ? now - this.match.startedAt : 0;
  }

  checkMatchEnd(now) {
    const roster = [...this.players.values()].filter((p) => !p.benched);
    const allEliminated = roster.length > 0 && roster.every((p) => p.eliminated);
    const forcedByEnrage = this.isEnraged(now) && this.match.enrageAttacks >= ENRAGE_ATTACKS_TO_END_MATCH;

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
    this.boss.attacks = [];
    this.boss.enraged = false;
    this.lastAttackName = null;
    this.egg = null;
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
      player.facing = 'down';
      player.cooldowns = { 1: 0, 2: 0, 3: 0, 4: 0 };
      player.stunnedUntil = 0;
      player.invulnerableUntil = 0;
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
    this.boss.attacks = [];
    this.boss.enraged = false;
    this.nextChannelAt = now + BOSS_CAST_INTERVAL_START * 1000;
    this.egg = this.findFreeTile(); // the egg spawns on a free tile at match start
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
        this.boss.attacks = [];
        this.lastAttackName = null;
        this.egg = null;
        this.dirty = true;
      }
      return;
    }

    if (this.match.phase === 'waiting') return;

    if (this.match.phase === 'countdown') {
      if (now >= this.match.countdownEndAt) this.startMatch(now);
      return;
    }

    // active — a new cast can start even while earlier attacks are still
    // resolving, so attacks are allowed to overlap.
    if (now >= this.nextChannelAt) this.startAttack(now);
    this.resolveWaves(now);
  }

  snapshot() {
    return {
      gridSize: GRID_SIZE,
      serverTime: Date.now(),
      players: [...this.players.values()],
      boss: this.boss,
      egg: this.egg,
      match: this.match,
    };
  }
}
