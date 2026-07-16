import Phaser from 'phaser';
import { socket } from '../socket.js';

const GRID_SIZE = 7;
const TILE = 60;
const GAP = 4;
const BOARD = GRID_SIZE * TILE + (GRID_SIZE - 1) * GAP;
const MOVE_COOLDOWN_MS = 150; // client-side throttle; the server still validates every move
const BOSS_ZONE_HEIGHT = 120; // reserved space above the grid for the boss + cast bar

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
    this.glowTiles = []; // graphics for currently-highlighted boss tiles
    this.boss = { state: 'idle', tiles: [], enraged: false, channelStartAt: 0, channelEndAt: 0 };
    this.clockOffset = 0; // serverTime - Date.now(), so we can animate off server timestamps
  }

  create() {
    this.originX = (this.scale.width - BOARD) / 2;
    this.originY = BOSS_ZONE_HEIGHT;

    this.drawGrid();
    this.drawBoss();

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
    const g = this.add.graphics();
    g.fillStyle(0x8e2de2, 1);
    g.fillTriangle(centerX, bossY - 26, centerX - 30, bossY + 20, centerX + 30, bossY + 20);
    g.lineStyle(2, 0xffffff, 0.6);
    g.strokeTriangle(centerX, bossY - 26, centerX - 30, bossY + 20, centerX + 30, bossY + 20);

    const barWidth = BOARD;
    const barHeight = 12;
    const barX = this.originX;
    const barY = 70;

    this.castBarBg = this.add.graphics();
    this.castBarBg.fillStyle(0x1a1a2e, 1);
    this.castBarBg.fillRoundedRect(barX, barY, barWidth, barHeight, 4);
    this.castBarBg.setVisible(false);

    this.castBarFill = this.add.graphics();
    this.castBarFill.setVisible(false);
    this.castBar = { x: barX, y: barY, width: barWidth, height: barHeight };
  }

  /** Called only when a 'state'/'welcome' event arrives — rebuilds the glow
   * tile set on channel start/end. Continuous animation (bar fill, blink)
   * happens every frame in renderBossFrame(), off the timestamps here, so
   * the visuals don't stall between broadcasts. */
  updateBoss(boss) {
    this.boss = boss;
    const channeling = boss.state === 'channeling';
    this.castBarBg.setVisible(channeling);
    this.castBarFill.setVisible(channeling);

    for (const g of this.glowTiles) g.destroy();
    this.glowTiles = [];

    if (channeling) {
      for (const tile of boss.tiles) {
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
        this.glowTiles.push(g);
      }
    }
  }

  /** Runs every render frame; animates the cast bar and glow-tile blink
   * from the boss's absolute channelStartAt/channelEndAt timestamps. */
  renderBossFrame(now) {
    if (this.boss.state !== 'channeling') return;

    const { x, y, width, height } = this.castBar;
    const span = this.boss.channelEndAt - this.boss.channelStartAt;
    const progress = span > 0 ? Phaser.Math.Clamp((now - this.boss.channelStartAt) / span, 0, 1) : 1;
    this.castBarFill.clear();
    this.castBarFill.fillStyle(0xe74c3c, 1);
    this.castBarFill.fillRoundedRect(x, y, width * progress, height, 4);

    // Very light, slow blink (lower bound raised ~halfway to the upper
    // bound so it doesn't blend into the board background).
    const blinkAlpha = 0.125 + 0.025 * Math.sin(now / 450);
    for (const g of this.glowTiles) g.setAlpha(blinkAlpha);
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
      this.playerData.set(player.id, player);
      if (player.benched || player.x === null || player.y === null) continue; // not on the board

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
        sprite.container.destroy();
        this.sprites.delete(id);
      }
    }
    for (const id of [...this.playerData.keys()]) {
      if (!state.players.some((p) => p.id === id)) this.playerData.delete(id);
    }

    if (state.boss) this.updateBoss(state.boss);
  }

  /** Runs every render frame; updates the invulnerability ring color/pulse
   * and the local player's stun banner from absolute server timestamps, so
   * they animate smoothly without needing a broadcast on every tick. */
  renderPlayerFrame(now) {
    for (const [id, sprite] of this.sprites) {
      const player = this.playerData.get(id);
      if (!player) continue;
      const invulnerable = player.invulnerableUntil > now;
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
