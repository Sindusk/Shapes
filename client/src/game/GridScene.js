import Phaser from 'phaser';
import { socket } from '../socket.js';
import Effects from './effects.js';

const GRID_SIZE = 7;
const TILE = 60;
const GAP = 4;
const BOARD = GRID_SIZE * TILE + (GRID_SIZE - 1) * GAP;
const MOVE_COOLDOWN_MS = 150; // client-side throttle; the server still validates every move
const BOSS_ZONE_HEIGHT = 160; // reserved space above the grid for the boss + stacked cast bars (attacks can overlap)
const SIDE_MARGIN = 26; // total horizontal breathing room around the board
const BOTTOM_MARGIN = 16;

// Exported so PhaserGame.jsx can size the canvas to exactly fit the board —
// keeping these in one place after BOSS_ZONE_HEIGHT grew (for stacked cast
// bars) let the canvas cut the board off at the bottom.
export const CANVAS_WIDTH = BOARD + SIDE_MARGIN;
export const CANVAS_HEIGHT = BOSS_ZONE_HEIGHT + BOARD + BOTTOM_MARGIN;

// Rotation (radians) applied so the top of each shape faces the player's
// last-moved direction. Shapes are drawn pointing up by default (facing 'up' = 0).
const FACING_ROTATION = { up: 0, right: Math.PI / 2, down: Math.PI, left: -Math.PI / 2 };
const GOLD = 0xffd700;

export default class GridScene extends Phaser.Scene {
  constructor() {
    super('GridScene');
    this.myId = null;
    this.sprites = new Map(); // player id -> { container, ring, radius }
    this.playerData = new Map(); // player id -> latest snapshot player object
    this.lastMoveAt = 0;
    // One entry per pending boss wave (flattened across every concurrent
    // attack): { warnAt, resolveAt, graphics: [] }. Graphics are created on
    // broadcast but shown/hidden per frame from the wave's own timestamps,
    // so follow-up warnings appear on schedule without needing another
    // broadcast.
    this.waveGlow = [];
    // Wave impact effects fire client-side the moment a wave's resolveAt
    // passes (or the wave vanishes from a snapshot because the server
    // resolved it first — clock offset jitter can put us slightly behind).
    // Keyed by a per-wave signature so each wave erupts exactly once even
    // though waveGlow is rebuilt wholesale on every broadcast.
    this.firedWaves = new Map(); // wave key -> resolveAt (for pruning)
    this.waveEmberEmitters = new Map(); // wave key -> ember particle emitter
    this.eggPos = null; // last known egg tile, for egg-hit impact effects
    // One entry per concurrent attack's cast bar: { name, channelStartAt,
    // channelEndAt, bg, fill, text }. Attacks can overlap, so more than one
    // bar can be visible at once, stacked vertically.
    this.attackBars = [];
    this.boss = { state: 'idle', attacks: [], enraged: false };
    this.eggSprite = null;
    this.clockOffset = 0; // serverTime - Date.now(), so we can animate off server timestamps
  }

  create() {
    this.originX = (this.scale.width - BOARD) / 2;
    this.originY = BOSS_ZONE_HEIGHT;

    this.drawGrid();
    this.drawBoss();
    this.fx = new Effects(this);

    this.keys = this.input.keyboard.addKeys({
      up: Phaser.Input.Keyboard.KeyCodes.UP,
      down: Phaser.Input.Keyboard.KeyCodes.DOWN,
      left: Phaser.Input.Keyboard.KeyCodes.LEFT,
      right: Phaser.Input.Keyboard.KeyCodes.RIGHT,
      w: Phaser.Input.Keyboard.KeyCodes.W,
      s: Phaser.Input.Keyboard.KeyCodes.S,
      a: Phaser.Input.Keyboard.KeyCodes.A,
      d: Phaser.Input.Keyboard.KeyCodes.D,
    });

    this.stunText = this.add
      .text(0, 0, 'STUNNED', {
        fontFamily: 'sans-serif',
        fontSize: '32px',
        fontStyle: 'bold',
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 4,
      })
      .setOrigin(0.5)
      .setDepth(10)
      .setVisible(false);
    this.stunText.setPosition(this.originX + BOARD / 2, this.originY + BOARD / 2);

    this.onAbilityKey = (slot) => socket.emit('ability', slot);
    this.input.keyboard.on('keydown-ONE', () => this.onAbilityKey(1));
    this.input.keyboard.on('keydown-TWO', () => this.onAbilityKey(2));
    this.input.keyboard.on('keydown-THREE', () => this.onAbilityKey(3));
    this.input.keyboard.on('keydown-FOUR', () => this.onAbilityKey(4));

    this.onWelcome = ({ id, state }) => {
      this.myId = id;
      this.applyState(state);
    };
    this.onState = (state) => this.applyState(state);

    socket.on('welcome', this.onWelcome);
    socket.on('state', this.onState);
    socket.emit('ready');

    this.events.on(Phaser.Scenes.Events.SHUTDOWN, () => {
      socket.off('welcome', this.onWelcome);
      socket.off('state', this.onState);
      this.input.keyboard.off('keydown-ONE');
      this.input.keyboard.off('keydown-TWO');
      this.input.keyboard.off('keydown-THREE');
      this.input.keyboard.off('keydown-FOUR');
    });
  }

  update(time) {
    const now = Date.now() + this.clockOffset;
    this.renderBossFrame(now);
    this.renderPlayerFrame(now);

    if (time - this.lastMoveAt < MOVE_COOLDOWN_MS) return;

    let direction = null;
    if (this.keys.up.isDown || this.keys.w.isDown) direction = 'up';
    else if (this.keys.down.isDown || this.keys.s.isDown) direction = 'down';
    else if (this.keys.left.isDown || this.keys.a.isDown) direction = 'left';
    else if (this.keys.right.isDown || this.keys.d.isDown) direction = 'right';

    if (direction) {
      socket.emit('move', direction);
      this.lastMoveAt = time;
    }
  }

  tileCenter(x, y) {
    return {
      px: this.originX + x * (TILE + GAP) + TILE / 2,
      py: this.originY + y * (TILE + GAP) + TILE / 2,
    };
  }

  drawBoss() {
    const centerX = this.originX + BOARD / 2;
    const bossY = 34;
    this.bossCenter = { x: centerX, y: bossY }; // laser target for ability 1
    const g = this.add.graphics();
    g.fillStyle(0x8e2de2, 1);
    g.fillTriangle(centerX, bossY - 26, centerX - 30, bossY + 20, centerX + 30, bossY + 20);
    g.lineStyle(2, 0xffffff, 0.6);
    g.strokeTriangle(centerX, bossY - 26, centerX - 30, bossY + 20, centerX + 30, bossY + 20);

    // Bar geometry; actual bar/text objects are created per concurrent
    // attack in updateBoss() since more than one can be casting at once.
    this.castBarGeometry = { x: this.originX, y: 70, width: BOARD, height: 12, spacing: 26 };
  }

  /** Creates one cast bar + name label, stacked below the previous one by
   * `spacing` px so overlapping attacks each get their own row. */
  createAttackBar(index) {
    const { x, y, width, height, spacing } = this.castBarGeometry;
    const barY = y + index * spacing;

    const bg = this.add.graphics();
    bg.fillStyle(0x1a1a2e, 1);
    bg.fillRoundedRect(x, barY, width, height, 4);

    const fill = this.add.graphics();

    const text = this.add
      .text(x + width / 2, barY - 10, '', {
        fontFamily: 'sans-serif',
        fontSize: '16px',
        fontStyle: 'bold',
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 3,
      })
      .setOrigin(0.5, 1);

    return { x, y: barY, width, height, bg, fill, text };
  }

  /** Called only when a 'state'/'welcome' event arrives — rebuilds the
   * per-wave glow graphics (resolved waves are pruned server-side, so their
   * tiles vanish on the resolve broadcast) and the per-attack cast bars.
   * Continuous animation (bar fill, warning visibility, blink) happens
   * every frame in renderBossFrame(), off the timestamps here, so the
   * visuals don't stall between broadcasts. */
  updateBoss(boss) {
    this.boss = boss;
    const attacks = boss.attacks ?? [];
    const now = Date.now() + this.clockOffset;

    const newKeys = new Set();
    for (const attack of attacks) {
      for (const wave of attack.waves) newKeys.add(this.waveKey(wave));
    }

    // Waves the server resolved before our clock reached their resolveAt
    // vanish from the snapshot without renderBossFrame ever firing their
    // impact — catch those here. (The resolveAt guard skips waves discarded
    // early by a match ending.)
    for (const wave of this.waveGlow) {
      if (!newKeys.has(wave.key) && now >= wave.resolveAt - 250) this.fireWaveImpact(wave);
      for (const g of wave.graphics) g.destroy();
    }
    this.waveGlow = [];

    // Ember emitters for waves that no longer exist (however they ended).
    for (const [key, emitter] of this.waveEmberEmitters) {
      if (!newKeys.has(key)) {
        emitter.destroy();
        this.waveEmberEmitters.delete(key);
      }
    }
    for (const [key, resolveAt] of this.firedWaves) {
      if (resolveAt < now - 30000) this.firedWaves.delete(key);
    }

    for (const attack of attacks) {
      for (const wave of attack.waves) {
        const graphics = [];
        const pxTiles = [];
        for (const tile of wave.tiles) {
          pxTiles.push(this.tileCenter(tile.x, tile.y));
          const g = this.add.graphics();
          g.fillStyle(0xffffff, 1);
          g.fillRoundedRect(
            this.originX + tile.x * (TILE + GAP),
            this.originY + tile.y * (TILE + GAP),
            TILE,
            TILE,
            8
          );
          g.setDepth(0.5);
          g.setVisible(false);
          graphics.push(g);
        }
        this.waveGlow.push({
          key: this.waveKey(wave),
          warnAt: wave.warnAt,
          resolveAt: wave.resolveAt,
          tiles: wave.tiles,
          pxTiles,
          graphics,
        });
      }
    }

    for (const bar of this.attackBars) {
      bar.bg.destroy();
      bar.fill.destroy();
      bar.text.destroy();
    }
    this.attackBars = attacks.map((attack, i) => {
      const bar = this.createAttackBar(i);
      bar.text.setText(attack.name);
      return { ...bar, channelStartAt: attack.channelStartAt, channelEndAt: attack.channelEndAt };
    });
  }

  /** Runs every render frame; animates each concurrent attack's cast bar
   * and name, plus every wave's warning glow, from the boss's absolute
   * timestamps. Follow-up waves become visible only once their own warnAt
   * arrives; a bar disappears once its own attack's first-wave channel
   * ends, even while later waves of the same or other attacks continue. */
  renderBossFrame(now) {
    for (const bar of this.attackBars) {
      const casting = now < bar.channelEndAt;
      bar.bg.setVisible(casting);
      bar.fill.setVisible(casting);
      bar.text.setVisible(casting);
      if (!casting) continue;

      const span = bar.channelEndAt - bar.channelStartAt;
      const progress = span > 0 ? Phaser.Math.Clamp((now - bar.channelStartAt) / span, 0, 1) : 1;
      bar.fill.clear();
      bar.fill.fillStyle(0xe74c3c, 1);
      bar.fill.fillRoundedRect(bar.x, bar.y, bar.width * progress, bar.height, 4);
    }

    if (this.boss.state !== 'attacking') return;

    // Very light, slow blink (lower bound raised ~halfway to the upper
    // bound so it doesn't blend into the board background).
    const blinkAlpha = 0.125 + 0.025 * Math.sin(now / 450);
    for (const wave of this.waveGlow) {
      const active = now >= wave.warnAt && now < wave.resolveAt;
      for (const g of wave.graphics) {
        g.setVisible(active);
        if (active) g.setAlpha(blinkAlpha);
      }
      if (active && !this.waveEmberEmitters.has(wave.key)) {
        this.waveEmberEmitters.set(wave.key, this.fx.embers(wave.pxTiles, TILE));
      }
      if (now >= wave.resolveAt) this.fireWaveImpact(wave);
    }
  }

  /** Stable per-wave signature: resolveAt is millisecond-precise and
   * unique enough combined with the wave's shape. */
  waveKey(wave) {
    const first = wave.tiles[0];
    return `${wave.resolveAt}:${wave.tiles.length}:${first ? `${first.x},${first.y}` : '-'}`;
  }

  /** Fires the red/brown eruption (plus egg-crack effect if the egg stood
   * in the wave) exactly once per wave, and retires its ember emitter. */
  fireWaveImpact(wave) {
    if (this.firedWaves.has(wave.key)) return;
    this.firedWaves.set(wave.key, wave.resolveAt);

    const embers = this.waveEmberEmitters.get(wave.key);
    if (embers) {
      embers.destroy();
      this.waveEmberEmitters.delete(wave.key);
    }

    this.fx.waveImpact(wave.pxTiles, TILE);
    if (this.eggPos && wave.tiles.some((t) => t.x === this.eggPos.x && t.y === this.eggPos.y)) {
      const { px, py } = this.tileCenter(this.eggPos.x, this.eggPos.y);
      this.fx.eggHit(px, py);
    }
  }

  drawGrid() {
    const g = this.add.graphics();
    g.fillStyle(0x0f3460, 1);
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        g.fillRoundedRect(
          this.originX + x * (TILE + GAP),
          this.originY + y * (TILE + GAP),
          TILE,
          TILE,
          8
        );
      }
    }
  }

  applyState(state) {
    // Guards against a stray event reaching a scene that's already been torn
    // down (e.g. React dev-mode's double-mount briefly creates and destroys
    // a scene while its socket listeners are still deregistering).
    if (!this.sys || !this.sys.displayList) return;

    if (typeof state.serverTime === 'number') this.clockOffset = state.serverTime - Date.now();

    const seen = new Set();

    for (const player of state.players) {
      const prev = this.playerData.get(player.id);
      this.playerData.set(player.id, player);
      if (player.benched || player.x === null || player.y === null) continue; // not on the board

      if (prev && !prev.benched && prev.x !== null) {
        this.detectAbilityEffects(prev, player);
        if (player.lives < prev.lives) {
          const { px, py } = this.tileCenter(player.x, player.y);
          this.fx.playerHit(px, py);
        }
      }

      seen.add(player.id);
      const { px, py } = this.tileCenter(player.x, player.y);
      let sprite = this.sprites.get(player.id);

      if (!sprite) {
        sprite = this.createShape(player);
        sprite.container.setPosition(px, py);
        sprite.container.setDepth(1);
        this.sprites.set(player.id, sprite);
      } else if (sprite.container.x !== px || sprite.container.y !== py) {
        this.tweens.add({ targets: sprite.container, x: px, y: py, duration: 100, ease: 'Power2' });
      }
      sprite.container.setAlpha(player.eliminated ? 0.25 : 1);

      const targetRotation = FACING_ROTATION[player.facing] ?? 0;
      if (sprite.container.rotation !== targetRotation) {
        this.tweens.add({
          targets: sprite.container,
          rotation: targetRotation,
          duration: 100,
          ease: 'Power2',
        });
      }
    }

    // Remove sprites for players that left.
    for (const [id, sprite] of this.sprites) {
      if (!seen.has(id)) {
        if (sprite.aura) sprite.aura.destroy(); // follow target is going away
        sprite.container.destroy();
        this.sprites.delete(id);
      }
    }
    for (const id of [...this.playerData.keys()]) {
      if (!state.players.some((p) => p.id === id)) this.playerData.delete(id);
    }

    if (state.boss) this.updateBoss(state.boss);
    this.updateEgg(state.egg ?? null);
  }

  /** The server broadcasts every validated ability use (setting its
   * cooldown marks the game dirty), so a slot's cooldown timestamp rising
   * between two snapshots is a reliable "this player just used this
   * ability" signal — no extra socket event needed. Cooldowns only ever
   * move up on use (match resets drop them to 0, which doesn't trigger). */
  detectAbilityEffects(prev, player) {
    const used = (slot) => (player.cooldowns?.[slot] ?? 0) > (prev.cooldowns?.[slot] ?? 0);
    const { px, py } = this.tileCenter(player.x, player.y);

    if (used(1)) this.fx.laser(px, py, this.bossCenter.x, this.bossCenter.y);
    if (used(2)) this.fx.gust(px, py);
    if (used(3)) {
      // Ripple along every tile of the dash path, old position to new.
      const dx = Math.sign(player.x - prev.x);
      const dy = Math.sign(player.y - prev.y);
      const points = [this.tileCenter(prev.x, prev.y)];
      let { x, y } = prev;
      while ((x !== player.x || y !== player.y) && points.length < GRID_SIZE) {
        x += dx;
        y += dy;
        points.push(this.tileCenter(x, y));
      }
      this.fx.dashRipple(points);
    }
    if (used(4)) this.fx.invulnBurst(px, py);
  }

  /** Creates/moves/removes the egg sprite to match the snapshot. Pushes
   * animate with the same short tween as player movement. */
  updateEgg(egg) {
    this.eggPos = egg;
    if (!egg) {
      if (this.eggSprite) {
        this.eggSprite.destroy();
        this.eggSprite = null;
      }
      return;
    }

    const { px, py } = this.tileCenter(egg.x, egg.y);
    if (!this.eggSprite) {
      const g = this.add.graphics();
      g.fillStyle(0xfff3d6, 1);
      g.fillEllipse(0, 2, TILE * 0.42, TILE * 0.56);
      g.lineStyle(2, 0xd4b483, 1);
      g.strokeEllipse(0, 2, TILE * 0.42, TILE * 0.56);
      g.fillStyle(0xd4b483, 0.5); // speckles
      g.fillCircle(-4, -4, 2);
      g.fillCircle(5, 3, 2);
      g.fillCircle(-2, 8, 1.5);
      this.eggSprite = this.add.container(px, py, [g]);
      this.eggSprite.setDepth(1);
    } else if (this.eggSprite.x !== px || this.eggSprite.y !== py) {
      this.tweens.add({ targets: this.eggSprite, x: px, y: py, duration: 100, ease: 'Power2' });
    }
  }

  /** Runs every render frame; updates the invulnerability ring color/pulse
   * and the local player's stun banner from absolute server timestamps, so
   * they animate smoothly without needing a broadcast on every tick. */
  renderPlayerFrame(now) {
    for (const [id, sprite] of this.sprites) {
      const player = this.playerData.get(id);
      if (!player) continue;
      const invulnerable = player.invulnerableUntil > now;

      // Golden radiance while invulnerable: a follow emitter attached for
      // exactly as long as invulnerableUntil says, same timestamp-driven
      // pattern as the ring color below.
      if (invulnerable && !sprite.aura) {
        sprite.aura = this.fx.attachAura(sprite.container, sprite.radius + 10);
      } else if (!invulnerable && sprite.aura) {
        this.fx.releaseAura(sprite.aura);
        sprite.aura = null;
      }

      const isSelf = id === this.myId;
      sprite.ring.clear();
      sprite.ring.lineStyle(
        isSelf ? 3 : 1.5,
        invulnerable ? GOLD : 0xffffff,
        invulnerable ? 1 : isSelf ? 1 : 0.35
      );
      sprite.ring.strokeCircle(0, 0, sprite.radius + 8);
    }

    const me = this.myId ? this.playerData.get(this.myId) : null;
    this.stunText.setVisible(!!me && me.stunnedUntil > now);
  }

  createShape(player) {
    const container = this.add.container(0, 0);
    const g = this.add.graphics();
    const r = TILE * 0.32;
    g.fillStyle(player.color, 1);

    switch (player.shape) {
      case 'square':
        g.fillRect(-r, -r, r * 2, r * 2);
        break;
      case 'triangle':
        g.fillTriangle(0, -r, -r, r, r, r);
        break;
      case 'diamond':
        g.fillPoints(
          [
            { x: 0, y: -r },
            { x: r, y: 0 },
            { x: 0, y: r },
            { x: -r, y: 0 },
          ],
          true
        );
        break;
      case 'pentagon':
      case 'star':
        g.fillPoints(this.polygonPoints(player.shape === 'star' ? 10 : 5, r), true);
        break;
      default:
        g.fillCircle(0, 0, r);
    }

    // Small facing marker at the shape's "top" (pre-rotation), so even
    // symmetric shapes like circles clearly show which way they're facing.
    g.fillStyle(0xffffff, 0.9);
    g.fillTriangle(-5, -r - 2, 5, -r - 2, 0, -r - 12);

    const ring = this.add.graphics();
    ring.lineStyle(player.id === this.myId ? 3 : 1.5, 0xffffff, player.id === this.myId ? 1 : 0.35);
    ring.strokeCircle(0, 0, r + 8);

    container.add([g, ring]);
    return { container, ring, radius: r };
  }

  polygonPoints(count, r) {
    const points = [];
    for (let i = 0; i < count; i++) {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / count;
      const radius = count === 10 && i % 2 === 1 ? r * 0.45 : r; // star: alternate inner points
      points.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    }
    return points;
  }
}
