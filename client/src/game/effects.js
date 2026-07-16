import Phaser from 'phaser';

// Phase 6 palette: player abilities stay blue/gold, boss damage stays
// red/brown, so the color of an effect immediately says friend or foe.
export const FX = {
  BLUE: 0x3498db,
  PALE_BLUE: 0xa8d8ff,
  GOLD: 0xffd700,
  PALE_GOLD: 0xffe9a0,
  RED: 0xe74c3c,
  EMBER: 0xff6b35,
  BROWN: 0x8b5a2b,
  SHELL: 0xfff3d6,
};

/**
 * All particle/flash effects for GridScene. The scene owns the state
 * (snapshots, timestamps) and decides *when* an effect fires; this class
 * only knows *how* each one looks. Every burst effect shares one
 * long-lived emitter per palette (created once here, `explode()`d on
 * demand) so spamming abilities doesn't allocate new emitters.
 */
export default class Effects {
  constructor(scene) {
    this.scene = scene;

    // Single white dot texture, tinted per effect. Generated from graphics
    // so the game keeps needing no image assets.
    if (!scene.textures.exists('fx-dot')) {
      const g = scene.make.graphics({ add: false });
      g.fillStyle(0xffffff, 1);
      g.fillCircle(4, 4, 4);
      g.generateTexture('fx-dot', 8, 8);
      g.destroy();
    }

    const burst = (tint, overrides = {}) =>
      scene.add
        .particles(0, 0, 'fx-dot', {
          speed: { min: 40, max: 160 },
          angle: { min: 0, max: 360 },
          lifespan: { min: 200, max: 500 },
          scale: { start: 0.9, end: 0 },
          tint,
          blendMode: 'ADD',
          emitting: false,
          ...overrides,
        })
        .setDepth(2);

    // Boss damage eruptions (also reused for player-hit bursts).
    this.impactEmitter = burst([FX.RED, FX.EMBER, FX.BROWN]);
    // Ability 1 laser sparks.
    this.sparkEmitter = burst([FX.BLUE, FX.PALE_BLUE], { speed: { min: 60, max: 180 } });
    // Ability 2 wind gust (drifts outward slower, lives longer).
    this.gustEmitter = burst([FX.PALE_BLUE, 0xffffff], {
      speed: { min: 70, max: 150 },
      lifespan: { min: 300, max: 550 },
      scale: { start: 0.7, end: 0 },
      alpha: { start: 0.9, end: 0 },
    });
    // Ability 4 invulnerability burst.
    this.goldEmitter = burst([FX.GOLD, FX.PALE_GOLD]);
    // Egg-hit shell fragments.
    this.shellEmitter = burst([FX.SHELL, FX.BROWN], { speed: { min: 60, max: 200 } });
  }

  /** Expanding circle outline that fades out — the building block for the
   * gust, dash ripple, and invulnerability effects. */
  ring(x, y, color, { radius = 34, duration = 300, width = 3, delay = 0 } = {}) {
    const g = this.scene.add.graphics().setDepth(2);
    g.lineStyle(width, color, 1);
    g.strokeCircle(0, 0, radius);
    g.setPosition(x, y).setScale(0.25).setAlpha(0);
    this.scene.tweens.add({
      targets: g,
      scaleX: 1,
      scaleY: 1,
      alpha: { from: 0.9, to: 0 },
      duration,
      delay,
      ease: 'Cubic.Out',
      onComplete: () => g.destroy(),
    });
  }

  /** Ability 1: a thin blue laser from the caster to the boss, with spark
   * bursts at the muzzle and the point of impact. */
  laser(x1, y1, x2, y2) {
    const g = this.scene.add.graphics().setDepth(2).setBlendMode(Phaser.BlendModes.ADD);
    g.lineStyle(7, FX.BLUE, 0.3);
    g.lineBetween(x1, y1, x2, y2);
    g.lineStyle(2, FX.PALE_BLUE, 1);
    g.lineBetween(x1, y1, x2, y2);
    this.scene.tweens.add({ targets: g, alpha: 0, duration: 200, onComplete: () => g.destroy() });
    this.sparkEmitter.explode(4, x1, y1);
    this.sparkEmitter.explode(12, x2, y2);
  }

  /** Ability 2: a gust of wind around the caster — a radial particle burst
   * plus two expanding rings. */
  gust(x, y) {
    this.gustEmitter.explode(26, x, y);
    this.ring(x, y, FX.PALE_BLUE, { radius: 40, duration: 320 });
    this.ring(x, y, 0xffffff, { radius: 56, duration: 380, width: 2, delay: 70 });
  }

  /** Ability 3: Flash-style ripple — expanding rings staggered along each
   * tile of the dash path, plus a small burst at the launch point. */
  dashRipple(points) {
    if (points.length > 0) this.sparkEmitter.explode(8, points[0].px, points[0].py);
    points.forEach((p, i) => {
      this.ring(p.px, p.py, FX.BLUE, { radius: 26, duration: 260, width: 2, delay: i * 45 });
    });
  }

  /** Ability 4: golden burst on cast; the sustained radiance is a separate
   * follow emitter (attachAura/releaseAura) driven by invulnerableUntil. */
  invulnBurst(x, y) {
    this.goldEmitter.explode(18, x, y);
    this.ring(x, y, FX.GOLD, { radius: 34, duration: 350 });
  }

  /** Gentle golden sparkle that follows a player's container while they're
   * invulnerable. Caller keeps the returned emitter and must releaseAura()
   * it when the invulnerability ends (or the sprite is destroyed). */
  attachAura(container, radius) {
    const emitter = this.scene.add
      .particles(0, 0, 'fx-dot', {
        speed: { min: 8, max: 25 },
        angle: { min: 0, max: 360 },
        lifespan: 650,
        scale: { start: 0.5, end: 0 },
        alpha: { start: 0.9, end: 0 },
        tint: [FX.GOLD, FX.PALE_GOLD],
        frequency: 40,
        blendMode: 'ADD',
        emitZone: { type: 'random', source: new Phaser.Geom.Circle(0, 0, radius) },
      })
      .setDepth(2);
    emitter.startFollow(container);
    return emitter;
  }

  releaseAura(emitter) {
    emitter.stop();
    // Let the in-flight particles finish their lifespan before tearing down.
    this.scene.time.delayedCall(700, () => emitter.destroy());
  }

  /** Rising red embers scattered across a warned wave's tiles while its
   * glow is active. One emitter covers the whole wave no matter how many
   * tiles it has (the emit zone picks a random tile per particle); the
   * caller destroys it when the wave resolves or vanishes. */
  embers(pxTiles, tileSize) {
    const half = tileSize / 2 - 4;
    return this.scene.add
      .particles(0, 0, 'fx-dot', {
        speedY: { min: -30, max: -12 },
        speedX: { min: -8, max: 8 },
        lifespan: { min: 500, max: 900 },
        scale: { start: 0.55, end: 0 },
        alpha: { start: 0.85, end: 0 },
        tint: [FX.RED, FX.EMBER],
        // More tiles -> proportionally more embers, capped so enrage
        // (every tile) stays cheap.
        frequency: Phaser.Math.Clamp(240 / pxTiles.length, 12, 120),
        blendMode: 'ADD',
        emitZone: {
          type: 'random',
          source: {
            getRandomPoint: (vec) => {
              const t = pxTiles[Math.floor(Math.random() * pxTiles.length)];
              vec.x = t.px + Phaser.Math.Between(-half, half);
              vec.y = t.py + Phaser.Math.Between(-half, half);
            },
          },
        },
      })
      .setDepth(0.6);
  }

  /** A wave lands: eruption burst + brief red flash on every hit tile, and
   * a small camera shake scaled (and capped) by how much of the board blew
   * up. */
  waveImpact(pxTiles, tileSize) {
    this.scene.cameras.main.shake(
      130,
      Phaser.Math.Clamp(0.0015 + pxTiles.length * 0.0001, 0.002, 0.006)
    );
    for (const t of pxTiles) {
      this.impactEmitter.explode(5, t.px, t.py);
      const g = this.scene.add.graphics().setDepth(0.6);
      g.fillStyle(FX.RED, 0.45);
      g.fillRoundedRect(t.px - tileSize / 2, t.py - tileSize / 2, tileSize, tileSize, 8);
      this.scene.tweens.add({ targets: g, alpha: 0, duration: 240, onComplete: () => g.destroy() });
    }
  }

  /** A player lost a life on this tile. */
  playerHit(x, y) {
    this.impactEmitter.explode(14, x, y);
    this.ring(x, y, FX.RED, { radius: 30, duration: 280 });
  }

  /** The egg was struck — everyone paid for it, so make it read loudly:
   * shell fragments plus a bigger eruption. */
  eggHit(x, y) {
    this.shellEmitter.explode(18, x, y);
    this.impactEmitter.explode(12, x, y);
    this.ring(x, y, FX.SHELL, { radius: 44, duration: 400 });
  }
}
