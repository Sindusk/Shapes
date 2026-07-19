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
  GLOBAL_COOLDOWN_MS,
  ABILITY_BOLT_COOLDOWN_MS,
  ABILITY_BARRIER_COOLDOWN_MS,
  ABILITY_DASH_COOLDOWN_MS,
  ABILITY_INVULN_COOLDOWN_MS,
  BOLT_STEP_MS,
  BOLT_STUN_MS,
  BARRIER_DURATION_MS,
  DASH_TILES,
  INVULN_DURATION_MS,
  EGG_ENABLED,
  BOSS_HP_PER_PLAYER,
  BOLT_BOSS_DAMAGE,
  BOSS_PHASE_THRESHOLDS,
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

const CENTER = Math.floor(GRID_SIZE / 2);

// Obstacle tiles revealed on entering each boss phase (index 0 -> phase 2,
// index 1 -> phase 3, ...), cumulative and permanent for the rest of the
// match. Defined relative to GRID_SIZE/CENTER so they scale if the grid
// size ever changes. A tile occupied by a player at reveal time is simply
// skipped rather than relocated.
const OBSTACLE_LAYOUTS = [
  [
    { x: 1, y: 1 },
    { x: GRID_SIZE - 2, y: 1 },
    { x: 1, y: GRID_SIZE - 2 },
    { x: GRID_SIZE - 2, y: GRID_SIZE - 2 },
  ],
  [
    { x: 1, y: CENTER },
    { x: GRID_SIZE - 2, y: CENTER },
  ],
];

const ABILITY_COOLDOWNS = {
  1: ABILITY_BOLT_COOLDOWN_MS,
  2: ABILITY_BARRIER_COOLDOWN_MS,
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
      // Phase 7: hp/maxHp scale with player count at match start (see
      // startMatch). phase starts at 1 and only increases; phaseChangedAt
      // is bumped on every transition purely so the client can trigger a
      // one-shot "PHASE n" banner off a timestamp change.
      hp: 0,
      maxHp: 0,
      phase: 1,
      phaseChangedAt: 0,
    };
    this.nextChannelAt = 0;
    this.lastAttackName = null;

    // Permanent-for-the-match obstacle tiles revealed by phase transitions
    // (see OBSTACLE_LAYOUTS). Blocks movement/dashing and is excluded from
    // boss attack tiles.
    this.obstacles = []; // [{x, y}]

    // The egg: a pushable NPC that spawns at match start. If a boss wave
    // hits its tile, every living player loses a life.
    this.egg = null; // {x, y} | null

    // Bolt projectiles (ability 1). Each has its full path precomputed at
    // cast time as segments with absolute active windows — the client
    // animates the purple tile entirely from these timestamps; the server
    // applies the stun in updateProjectiles(). hitIds ensures one bolt
    // stuns a given player at most once.
    this.projectiles = []; // { segments: [{x, y, activeFrom, activeTo}], hitIds: Set }

    // phase: 'waiting' (no active match, boss paused) | 'countdown' (match
    // forming) | 'active' (rounds happening)
    this.match = {
      phase: 'waiting',
      countdownEndAt: null,
      startedAt: null,
      round: 0,
      enrageAttacks: 0,
      lastResult: null, // 'win' | 'loss' | null — set by endMatch, cleared by the next startMatch
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

  isObstacle(x, y) {
    return this.obstacles.some((o) => o.x === x && o.y === y);
  }

  findFreeTile() {
    const free = [];
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        if (!this.isOccupied(x, y) && !this.isEggAt(x, y) && !this.isObstacle(x, y)) free.push({ x, y });
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
      gcdUntil: 0, // shared global cooldown across all slots
      stunnedUntil: 0,
      invulnerableUntil: 0,
      barrierUntil: 0, // barrier absorbs one hit while this is in the future
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
    if (this.isOccupied(nx, ny) || this.isObstacle(nx, ny)) return false;

    if (this.isEggAt(nx, ny)) {
      // Moving into the egg pushes it one tile further along; if that tile
      // is a wall or another player, the egg swaps places with the mover.
      const ex = nx + dir.dx;
      const ey = ny + dir.dy;
      const pushBlocked =
        ex < 0 ||
        ex >= GRID_SIZE ||
        ey < 0 ||
        ey >= GRID_SIZE ||
        this.isOccupied(ex, ey) ||
        this.isObstacle(ex, ey);
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

  /** Server-authoritative ability use: validates the caster, global +
   * per-slot cooldowns, and stun state, then dispatches to the per-slot
   * handler. Every successful cast triggers the shared global cooldown. */
  tryAbility(id, slot, now = Date.now()) {
    const player = this.players.get(id);
    const cooldownMs = ABILITY_COOLDOWNS[slot];
    if (!player || player.eliminated || player.benched || cooldownMs === undefined) return false;
    if (player.stunnedUntil > now) return false;
    if (player.gcdUntil > now) return false;
    if (player.cooldowns[slot] > now) return false;

    // Bolt can fail (caster facing a wall) — only commit cooldowns on success.
    if (slot === 1 && !this.abilityBolt(player, now)) return false;

    player.cooldowns[slot] = now + cooldownMs;
    player.gcdUntil = now + GLOBAL_COOLDOWN_MS;

    switch (slot) {
      case 2:
        player.barrierUntil = now + BARRIER_DURATION_MS;
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

  /** Bolt (ability 1): a 1x1 attack spawns on the tile in front of the
   * caster and advances one tile every BOLT_STEP_MS until it hits a wall,
   * passing through players. Anyone standing on its active (purple) tile is
   * stunned for BOLT_STUN_MS — at most once per bolt. Fails (no cooldown
   * spent) when the caster is facing a wall. Facing up sends it at the
   * boss instead: it deals BOLT_BOSS_DAMAGE once it reaches the top row
   * (see updateProjectiles), on top of still stunning anyone it passes. */
  abilityBolt(caster, now) {
    const dir = DIRECTIONS[caster.facing];
    if (!dir) return false;

    const segments = [];
    let x = caster.x + dir.dx;
    let y = caster.y + dir.dy;
    for (let i = 0; x >= 0 && x < GRID_SIZE && y >= 0 && y < GRID_SIZE; i++) {
      segments.push({
        x,
        y,
        activeFrom: now + i * BOLT_STEP_MS,
        activeTo: now + (i + 1) * BOLT_STEP_MS,
      });
      x += dir.dx;
      y += dir.dy;
    }
    if (segments.length === 0) return false;

    this.projectiles.push({ segments, hitIds: new Set(), hitsBoss: caster.facing === 'up', bossHit: false });
    return true;
  }

  /** Applies bolt stuns, boss damage, and prunes finished bolts. Runs every
   * tick while players are connected — bolts are castable outside active
   * matches too (boss damage is a no-op then since boss.hp starts at 0). */
  updateProjectiles(now) {
    if (this.projectiles.length === 0) return;

    for (const proj of this.projectiles) {
      const active = proj.segments.find((s) => now >= s.activeFrom && now < s.activeTo);
      if (active) {
        for (const p of this.players.values()) {
          if (p.eliminated || p.benched || proj.hitIds.has(p.id)) continue;
          if (p.x !== active.x || p.y !== active.y) continue;
          proj.hitIds.add(p.id);
          p.stunnedUntil = Math.max(p.stunnedUntil, now + BOLT_STUN_MS);
          this.dirty = true;
        }
      }

      const last = proj.segments[proj.segments.length - 1];
      if (proj.hitsBoss && !proj.bossHit && now >= last.activeTo && this.boss.hp > 0) {
        proj.bossHit = true;
        this.boss.hp = Math.max(0, this.boss.hp - BOLT_BOSS_DAMAGE);
        this.advancePhaseIfNeeded(now);
        this.dirty = true;
        this.checkMatchEnd(now);
      }
    }

    const remaining = this.projectiles.filter(
      (proj) => now < proj.segments[proj.segments.length - 1].activeTo
    );
    if (remaining.length !== this.projectiles.length) {
      this.projectiles = remaining;
      this.dirty = true;
    }
  }

  /** Reveals the next OBSTACLE_LAYOUTS batch whenever boss.hp crosses the
   * next BOSS_PHASE_THRESHOLDS fraction, advancing boss.phase once per
   * crossing (a single big hit could in principle cross more than one
   * threshold at once, so this loops). Tiles already occupied at reveal
   * time are skipped rather than relocated. */
  advancePhaseIfNeeded(now) {
    if (this.boss.maxHp <= 0) return;
    while (
      this.boss.phase - 1 < BOSS_PHASE_THRESHOLDS.length &&
      this.boss.hp / this.boss.maxHp <= BOSS_PHASE_THRESHOLDS[this.boss.phase - 1]
    ) {
      const layout = OBSTACLE_LAYOUTS[this.boss.phase - 1] ?? [];
      for (const tile of layout) {
        if (this.isOccupied(tile.x, tile.y) || this.isObstacle(tile.x, tile.y)) continue;
        this.obstacles.push(tile);
      }
      this.boss.phase += 1;
      this.boss.phaseChangedAt = now;
      this.dirty = true;
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
      if (this.isOccupied(nx, ny) || this.isEggAt(nx, ny) || this.isObstacle(nx, ny)) break;
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

    // Obstacle tiles can never hold a player, so strip them out of both the
    // danger and safe-zone tile lists — nobody can be standing there to be
    // hit, and it avoids drawing a pointless warning on a wall tile.
    if (this.obstacles.length > 0) {
      waves = waves.map((w) => ({
        ...w,
        tiles: w.tiles.filter((t) => !this.isObstacle(t.x, t.y)),
        ...(w.safeTiles ? { safeTiles: w.safeTiles.filter((t) => !this.isObstacle(t.x, t.y)) } : {}),
      }));
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
    // Attacks can overlap, so a tile a safe-zone wave is currently marking
    // green might also be targeted by an unrelated concurrent attack.
    // Compute every tile any active safe-zone wave is protecting right now
    // and honor it across the board, not just within its own attack —
    // otherwise "stand in the green" could still get you hit by something
    // else, which would make the zone unresolvable.
    const protectedTiles = this.activeSafeTiles(now);

    let resolvedAny = false;
    for (const attack of this.boss.attacks) {
      while (attack.waves.length > 0 && now >= attack.waves[0].resolveAt) {
        this.applyWaveDamage(attack.waves.shift(), now, protectedTiles);
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

  /** Every tile currently marked safe by an active safe-zone wave, across
   * every attack in progress — "active" meaning currently telegraphed
   * (warnAt <= now < resolveAt), the same window the client renders the
   * green tile for. */
  activeSafeTiles(now) {
    const safe = new Set();
    for (const attack of this.boss.attacks) {
      for (const wave of attack.waves) {
        if (!wave.safeTiles || now < wave.warnAt || now >= wave.resolveAt) continue;
        for (const t of wave.safeTiles) safe.add(`${t.x},${t.y}`);
      }
    }
    return safe;
  }

  applyWaveDamage(wave, now, protectedTiles = new Set()) {
    const hit = new Set(wave.tiles.map((t) => `${t.x},${t.y}`));

    // The egg takes the hit for everyone: if a wave lands on it, every
    // living player loses a life (individual invulnerability still helps).
    const eggHit = !!this.egg && hit.has(`${this.egg.x},${this.egg.y}`);

    for (const player of this.players.values()) {
      if (player.eliminated || player.benched) continue;
      const posKey = `${player.x},${player.y}`;
      let damage = 0;
      if (hit.has(posKey) && !protectedTiles.has(posKey)) damage += 1;
      if (eggHit) damage += 1;
      if (damage === 0 || player.invulnerableUntil > now) continue;
      if (player.barrierUntil > now) {
        player.barrierUntil = 0; // the barrier absorbs this hit and shatters
        continue;
      }
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
    const bossDefeated = this.boss.maxHp > 0 && this.boss.hp <= 0;
    const roster = [...this.players.values()].filter((p) => !p.benched);
    const allEliminated = roster.length > 0 && roster.every((p) => p.eliminated);
    const forcedByEnrage = this.isEnraged(now) && this.match.enrageAttacks >= ENRAGE_ATTACKS_TO_END_MATCH;

    if (!bossDefeated && !allEliminated && !forcedByEnrage) return;

    if (forcedByEnrage) {
      for (const p of roster) {
        if (!p.eliminated) {
          p.lives = 0;
          this.eliminate(p, now);
        }
      }
    }

    this.endMatch(now, bossDefeated ? 'win' : 'loss');
  }

  endMatch(now, result = 'loss') {
    this.boss.state = 'idle';
    this.boss.attacks = [];
    this.boss.enraged = false;
    this.lastAttackName = null;
    this.egg = null;
    this.projectiles = [];
    this.obstacles = [];
    this.match.round = 0;
    this.match.enrageAttacks = 0;
    this.match.startedAt = null;
    this.match.lastResult = result;

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
      player.gcdUntil = 0;
      player.stunnedUntil = 0;
      player.invulnerableUntil = 0;
      player.barrierUntil = 0;
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
    this.match.lastResult = null;
    this.boss.state = 'idle';
    this.boss.attacks = [];
    this.boss.enraged = false;
    // Every connected player at this point has benched === false (see
    // addPlayer), so players.size is the match's roster size.
    this.boss.maxHp = BOSS_HP_PER_PLAYER * this.players.size;
    this.boss.hp = this.boss.maxHp;
    this.boss.phase = 1;
    this.boss.phaseChangedAt = 0;
    this.obstacles = [];
    this.nextChannelAt = now + BOSS_CAST_INTERVAL_START * 1000;
    // The egg (currently disabled via EGG_ENABLED) spawns on a free tile at
    // match start; all its push/damage handling stays live and null-tolerant.
    this.egg = EGG_ENABLED ? this.findFreeTile() : null;
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
        this.projectiles = [];
        this.obstacles = [];
        this.dirty = true;
      }
      return;
    }

    this.updateProjectiles(now);

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
      obstacles: this.obstacles,
      egg: this.egg,
      // hitIds is server-only bookkeeping (and a Set won't serialize).
      projectiles: this.projectiles.map((p) => ({ segments: p.segments })),
      match: this.match,
    };
  }
}
