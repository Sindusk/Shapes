import { useEffect, useRef } from 'react';
import Phaser from 'phaser';
import GridScene, { CANVAS_WIDTH, CANVAS_HEIGHT } from './game/GridScene.js';

export default function PhaserGame() {
  const containerRef = useRef(null);
  const gameRef = useRef(null);

  useEffect(() => {
    if (gameRef.current) return;

    gameRef.current = new Phaser.Game({
      type: Phaser.AUTO,
      parent: containerRef.current,
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      // Matches index.html's body background so the canvas has no visible
      // edge against the page.
      backgroundColor: '#1a1a2e',
      scene: [GridScene],
    });

    return () => {
      gameRef.current?.destroy(true);
      gameRef.current = null;
    };
  }, []);

  return <div ref={containerRef} />;
}
