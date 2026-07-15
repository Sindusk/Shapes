import Phaser from 'phaser';
import { socket } from '../socket.js';

const GRID_SIZE = 5;
const TILE = 90;
const GAP = 4;
const BOARD = GRID_SIZE * TILE + (GRID_SIZE - 1) * GAP;
const MOVE_COOLDOWN_MS = 150; // client-side throttle; the server still validates every move

export default class GridScene extends Phaser.Scene {
  constructor() {
    super('GridScene');
    this.myId = null;
    this.sprites = new Map(); // player id -> Phaser.GameObjects.Graphics
    this.lastMoveAt = 0;
  }

  create() {
    this.originX = (this.scale.width - BOARD) / 2;
    this.originY = (this.scale.height - BOARD) / 2;

    this.drawGrid();

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

    this.onWelcome = ({ id, state }) => {
      this.myId = id;
      this.applyState(state);
    };
    this.onState = (state) => this.applyState(state);

    socket.on('welcome', this.onWelcome);
    socket.on('state', this.onState);

    this.events.on(Phaser.Scenes.Events.SHUTDOWN, () => {
      socket.off('welcome', this.onWelcome);
      socket.off('state', this.onState);
    });
  }

  update(time) {
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
    const seen = new Set();

    for (const player of state.players) {
      seen.add(player.id);
      const { px, py } = this.tileCenter(player.x, player.y);
      let sprite = this.sprites.get(player.id);

      if (!sprite) {
        sprite = this.createShape(player);
        sprite.setPosition(px, py);
        this.sprites.set(player.id, sprite);
      } else if (sprite.x !== px || sprite.y !== py) {
        this.tweens.add({ targets: sprite, x: px, y: py, duration: 100, ease: 'Power2' });
      }
    }

    // Remove sprites for players that left.
    for (const [id, sprite] of this.sprites) {
      if (!seen.has(id)) {
        sprite.destroy();
        this.sprites.delete(id);
      }
    }
  }

  createShape(player) {
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

    // Outline the local player's shape so they can find themselves.
    if (player.id === this.myId) {
      g.lineStyle(3, 0xffffff, 1);
      g.strokeCircle(0, 0, r + 8);
    }
    return g;
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
