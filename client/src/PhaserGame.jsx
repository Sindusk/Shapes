import { useEffect, useRef } from 'react';
import Phaser from 'phaser';
import GridScene from './game/GridScene.js';

export default function PhaserGame() {
  const containerRef = useRef(null);
  const gameRef = useRef(null);

  useEffect(() => {
    if (gameRef.current) return;

    gameRef.current = new Phaser.Game({
      type: Phaser.AUTO,
      parent: containerRef.current,
      width: 480,
      height: 480,
      backgroundColor: '#16213e',
      scene: [GridScene],
    });

    return () => {
      gameRef.current?.destroy(true);
      gameRef.current = null;
    };
  }, []);

  return <div ref={containerRef} />;
}
