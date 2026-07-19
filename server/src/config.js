export const GRID_SIZE = 7;
export const TICK_RATE = 30; // ticks per second
export const STARTING_LIVES = 3;

// Match flow: the first connected player starts a countdown; anyone who
// connects before it elapses joins the same match, anyone after is benched
// until the match concludes.
export const MATCH_COUNTDOWN_MS = 15000;
export const MAX_MATCH_LENGTH_MS = 5 * 60 * 1000;

// Boss cast interval and channel time ramp from their START values down to
// their END values over BOSS_SCALING_RAMP_MS, via a fast ease-out curve
// (steep early, flattening as it approaches the bound) — not a linear lerp.
// Once elapsed match time reaches the ramp duration, both sit at their END
// value for the remainder of the match (until enrage takes over at
// MAX_MATCH_LENGTH_MS).
export const BOSS_SCALING_RAMP_MS = 3 * 60 * 1000;
export const BOSS_CAST_INTERVAL_START = 5.0;
export const BOSS_CAST_INTERVAL_END = 1.5;
export const BOSS_CHANNEL_START = 3.0;
export const BOSS_CHANNEL_END = 0.7;

// Attack patterns (see patterns.js). The Meteor pattern fires this many
// volleys of random 3x3 impact zones, one volley per half-channel step.
export const METEOR_IMPACTS_PER_VOLLEY = 3;
export const METEOR_VOLLEYS = 2;

// Past MAX_MATCH_LENGTH_MS the boss enrages: every attack hits the whole
// board, and the match is forced to end after this many enraged attacks.
export const ENRAGE_CAST_INTERVAL_MS = 1000;
export const ENRAGE_CHANNEL_DURATION_MS = 500;
export const ENRAGE_ATTACKS_TO_END_MATCH = 3;

// The egg: a pushable NPC that punishes everyone when a wave hits it.
// Currently disabled (spawn is gated on this flag); the push/damage/render
// code is kept intact so it can return later.
export const EGG_ENABLED = false;

// Ability bar: 4 slots bound to keys 1-4. Cooldowns are in ms. Every cast
// also triggers a shared global cooldown; no ability can be cast until it
// has elapsed. Slot 1 (Bolt) has no cooldown of its own — the GCD covers it.
export const GLOBAL_COOLDOWN_MS = 2500;
export const ABILITY_BOLT_COOLDOWN_MS = 0;
export const ABILITY_BARRIER_COOLDOWN_MS = 25000;
export const ABILITY_DASH_COOLDOWN_MS = 10000;
export const ABILITY_INVULN_COOLDOWN_MS = 45000;

// Bolt: a 1x1 line attack that spawns in front of the caster and advances
// one tile every step until it hits a wall; players on its purple tile are
// stunned.
export const BOLT_STEP_MS = 400;
export const BOLT_STUN_MS = 500;

export const BARRIER_DURATION_MS = 6000; // window in which the barrier can absorb one hit
export const DASH_TILES = 3;
export const INVULN_DURATION_MS = 2000;

// Boss HP (Phase 7): scales with the number of players in the match, so a
// solo player and a full room both face roughly the same time-to-kill if
// everyone attacks optimally. Bolt (ability 1) is the only damage source —
// casting it while facing up sends it at the boss instead of along the
// ground. At 1 damage per bolt, gated only by the 2.5s GCD, a single
// perfect attacker fells 80 HP in ~200s (~3.3 minutes), well inside the
// enrage timer; extra players scale total HP so the same math holds.
export const BOSS_HP_PER_PLAYER = 80;
export const BOLT_BOSS_DAMAGE = 1;

// Boss phases (Phase 7): crossing each HP fraction threshold reveals a new
// batch of permanent obstacle tiles on the arena (see OBSTACLE_LAYOUTS in
// game.js). Thresholds are fractions of the match's starting boss HP.
export const BOSS_PHASE_THRESHOLDS = [0.66, 0.33];

// Port is set via .env at the repo root (see PORTS.md before changing).
export const PORT = process.env.PORT ?? 3002;
