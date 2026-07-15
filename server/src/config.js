export const GRID_SIZE = 5;
export const TICK_RATE = 30; // ticks per second
export const STARTING_LIVES = 3;

// Boss channel cycle: idle for BOSS_CAST_INTERVAL_MS, then channels for
// BOSS_CHANNEL_DURATION_MS with BOSS_TILE_COUNT glowing tiles selected.
export const BOSS_CAST_INTERVAL_MS = 5000;
export const BOSS_CHANNEL_DURATION_MS = 2000;
export const BOSS_TILE_COUNT = 5;
// Port is set via .env at the repo root (see PORTS.md before changing).
export const PORT = process.env.PORT ?? 3002;
