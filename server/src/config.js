export const GRID_SIZE = 9;
export const TICK_RATE = 30; // ticks per second
export const STARTING_LIVES = 3;

// Match flow: the first connected player starts a countdown; anyone who
// connects before it elapses joins the same match, anyone after is benched
// until the match concludes.
export const MATCH_COUNTDOWN_MS = 15000;
export const MAX_MATCH_LENGTH_MS = 8 * 60 * 1000;

// Boss cast/channel timing scale with match progress (elapsed / MAX_MATCH_LENGTH_MS):
// castInterval = lerp(BOSS_CAST_INTERVAL_START, BOSS_CAST_INTERVAL_END, progress^2)
// channelTime  = lerp(BOSS_CHANNEL_START, BOSS_CHANNEL_END, progress^2)
export const BOSS_CAST_INTERVAL_START = 7.0;
export const BOSS_CAST_INTERVAL_END = 2.0;
export const BOSS_CHANNEL_START = 5.0;
export const BOSS_CHANNEL_END = 0.5;

// Boss tile-count-per-attack is a uniform random fraction of the board; the
// [min, max] range widens and shifts upward as the match progresses.
export const BOSS_TILE_MIN_FRACTION_START = 1 / 4;
export const BOSS_TILE_MAX_FRACTION_START = 1 / 2;
export const BOSS_TILE_MIN_FRACTION_END = 3 / 4;
export const BOSS_TILE_MAX_FRACTION_END = 7 / 8;

// Past MAX_MATCH_LENGTH_MS the boss enrages: every attack hits the whole
// board, and the match is forced to end after this many enraged attacks.
export const ENRAGE_CAST_INTERVAL_MS = 1000;
export const ENRAGE_CHANNEL_DURATION_MS = 500;
export const ENRAGE_ATTACKS_TO_END_MATCH = 3;

// Port is set via .env at the repo root (see PORTS.md before changing).
export const PORT = process.env.PORT ?? 3002;
