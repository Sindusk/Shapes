import { useEffect, useRef, useState } from 'react';
import { socket } from './socket.js';
import PhaserGame from './PhaserGame.jsx';

const SIDEBAR_WIDTH = 180;

// Mirrors server/src/config.js boss timing constants — kept in sync manually
// so this debug readout can animate client-side without extra broadcasts.
const MAX_MATCH_LENGTH_MS = 5 * 60 * 1000;
const BOSS_SCALING_RAMP_MS = 3 * 60 * 1000;
const BOSS_CAST_INTERVAL_START = 5.0;
const BOSS_CAST_INTERVAL_END = 1.5;
const BOSS_CHANNEL_START = 3.0;
const BOSS_CHANNEL_END = 0.7;
const ENRAGE_CAST_INTERVAL_S = 1.0;
const ENRAGE_CHANNEL_DURATION_S = 0.5;

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

// Fast ease-out ramp — mirrors game.js's easeOutCubic, not a linear lerp.
function easeOutCubic(t) {
  return 1 - (1 - t) ** 3;
}

function bossTimings(match, now) {
  if (match.phase !== 'active' || !match.startedAt) return null;
  const progress = clamp((now - match.startedAt) / MAX_MATCH_LENGTH_MS, 0, 1);
  if (match.enraged) {
    return { castInterval: ENRAGE_CAST_INTERVAL_S, channelTime: ENRAGE_CHANNEL_DURATION_S, progress };
  }
  const scaling = easeOutCubic(clamp((now - match.startedAt) / BOSS_SCALING_RAMP_MS, 0, 1));
  return {
    castInterval: BOSS_CAST_INTERVAL_START - (BOSS_CAST_INTERVAL_START - BOSS_CAST_INTERVAL_END) * scaling,
    channelTime: BOSS_CHANNEL_START - (BOSS_CHANNEL_START - BOSS_CHANNEL_END) * scaling,
    progress,
  };
}

function colorToCss(color) {
  return `#${color.toString(16).padStart(6, '0')}`;
}

function formatClock(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatClockMs(ms) {
  const total = Math.max(0, Math.floor(ms));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function sortPlayers(players) {
  const alive = players.filter((p) => !p.eliminated && !p.benched);
  const eliminated = players.filter((p) => p.eliminated);
  const benched = players.filter((p) => p.benched);

  alive.sort((a, b) => b.lives - a.lives);
  // Longest-surviving eliminated players rank higher; those eliminated
  // fastest sink to the bottom of the list.
  eliminated.sort((a, b) => (b.aliveMs ?? 0) - (a.aliveMs ?? 0));

  return [...alive, ...eliminated, ...benched];
}

function BurgerMenu({ user, setUser }) {
  const [open, setOpen] = useState(false);
  const [showLoginForm, setShowLoginForm] = useState(false);
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState(null);

  async function submitLogin(e) {
    e.preventDefault();
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, pin }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Login failed');
        return;
      }
      setUser({ username: data.username, role: data.role });
      setShowLoginForm(false);
      setOpen(false);
      setUsername('');
      setPin('');
    } catch {
      setError('Could not reach the server');
    }
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    setUser(null);
    setOpen(false);
  }

  return (
    <div style={{ position: 'fixed', top: 16, left: 16, zIndex: 20 }}>
      <button
        onClick={() => {
          setOpen((o) => !o);
          setShowLoginForm(false);
          setError(null);
        }}
        style={{
          width: 40,
          height: 40,
          borderRadius: 6,
          border: '1px solid #0f3460',
          background: '#16213e',
          color: '#fff',
          fontSize: 20,
          cursor: 'pointer',
        }}
      >
        ☰
      </button>
      {open && (
        <div
          style={{
            marginTop: 8,
            width: 200,
            background: '#16213e',
            border: '1px solid #0f3460',
            borderRadius: 8,
            padding: 12,
          }}
        >
          {user && (
            <div style={{ marginBottom: 10, paddingBottom: 10, borderBottom: '1px solid #0f3460' }}>
              <div style={{ fontWeight: 'bold' }}>{user.username}</div>
              <div style={{ fontSize: 12, color: '#aaa', textTransform: 'capitalize' }}>{user.role}</div>
            </div>
          )}
          {!user && !showLoginForm && (
            <button
              onClick={() => setShowLoginForm(true)}
              style={{ width: '100%', padding: '6px 0', cursor: 'pointer' }}
            >
              Login
            </button>
          )}
          {!user && showLoginForm && (
            <form onSubmit={submitLogin} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <input
                placeholder="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                maxLength={32}
                style={{ padding: 6 }}
              />
              <input
                placeholder="4-digit PIN"
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                inputMode="numeric"
                style={{ padding: 6 }}
              />
              {error && <div style={{ color: '#e74c3c', fontSize: 12 }}>{error}</div>}
              <button type="submit" style={{ padding: '6px 0', cursor: 'pointer' }}>
                Log in / Register
              </button>
            </form>
          )}
          {user && (
            <button onClick={logout} style={{ width: '100%', padding: '6px 0', cursor: 'pointer' }}>
              Logout
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function MatchStatus({ match, now }) {
  let label = '';
  let timer = null;
  let resultLabel = null;
  if (match.phase === 'waiting') {
    label = 'Waiting for players…';
  } else if (match.phase === 'countdown') {
    label = 'Match starting in…';
    timer = formatClockMs(Math.max(0, match.countdownEndAt - now));
    if (match.lastResult === 'win') resultLabel = { text: 'Boss defeated!', color: '#2ecc71' };
    else if (match.lastResult === 'loss') resultLabel = { text: 'Defeat…', color: '#e74c3c' };
  } else if (match.phase === 'active') {
    // Countdown to the 5-minute enrage, so the objective (survive until
    // enrage) is visible for the whole match.
    label = match.enraged ? `Round ${match.round + 1} — ENRAGED` : `Round ${match.round + 1} — Enrage in`;
    timer = match.enraged ? null : formatClockMs(Math.max(0, match.startedAt + MAX_MATCH_LENGTH_MS - now));
  }

  return (
    <div style={{ margin: '0 0 8px', textAlign: 'center' }}>
      {resultLabel && (
        <p style={{ margin: '0 0 4px', fontWeight: 'bold', color: resultLabel.color }}>{resultLabel.text}</p>
      )}
      <p style={{ margin: 0, color: match.enraged ? '#e74c3c' : '#aaa' }}>{label}</p>
      {timer && (
        <p
          style={{
            margin: '2px 0 0',
            fontWeight: 'bold',
            fontSize: 20,
            fontVariantNumeric: 'tabular-nums',
            color: match.enraged ? '#e74c3c' : '#fff',
          }}
        >
          {timer}
        </p>
      )}
    </div>
  );
}

function LivesPanel({ players, myId }) {
  const ordered = sortPlayers(players);
  return (
    <div style={{ width: SIDEBAR_WIDTH, paddingTop: 24 }}>
      <h2 style={{ fontSize: 14, color: '#aaa', margin: '0 0 8px', textTransform: 'uppercase' }}>
        Players
      </h2>
      {ordered.map((p) => (
        <div
          key={p.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '4px 0',
            opacity: p.eliminated ? 0.4 : p.benched ? 0.6 : 1,
          }}
        >
          <span
            style={{
              width: 12,
              height: 12,
              borderRadius: '50%',
              background: colorToCss(p.color),
              outline: p.id === myId ? '2px solid #fff' : 'none',
              flexShrink: 0,
            }}
          />
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: 70,
            }}
          >
            {p.username}
          </span>
          <span style={{ fontVariantNumeric: 'tabular-nums', marginLeft: 'auto' }}>
            {p.benched
              ? 'benched'
              : p.eliminated
                ? `☠ ${formatClock(p.aliveMs ?? 0)}`
                : '❤'.repeat(p.lives)}
          </span>
        </div>
      ))}
    </div>
  );
}

// Mirrors server/src/config.js GLOBAL_COOLDOWN_MS — every cast locks all
// slots for this long; slot cooldowns of 0 mean "GCD only".
const GLOBAL_COOLDOWN_MS = 2500;

const ABILITIES = [
  {
    slot: 1,
    icon: '☄',
    label: 'Bolt',
    cooldownMs: 0,
    description:
      'Send a bolt down the line in front of you. It advances one tile every 0.4s until it hits a wall, stunning anyone on its purple tile for 0.5s. Face up to send it at the boss instead — it deals damage on arrival.',
  },
  {
    slot: 2,
    icon: '🛡',
    label: 'Barrier',
    cooldownMs: 25000,
    description: 'Shield yourself for 6s. The barrier absorbs the next hit, then shatters.',
  },
  {
    slot: 3,
    icon: '⚡',
    label: 'Dash',
    cooldownMs: 10000,
    description: 'Dash up to 3 tiles in the direction you are facing.',
  },
  {
    slot: 4,
    icon: '✨',
    label: 'Invulnerability',
    cooldownMs: 45000,
    description: 'Become immune to all damage for 2s.',
  },
];

function AbilityBar({ me, now }) {
  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
      {ABILITIES.map(({ slot, icon, label, cooldownMs }) => {
        // A slot is locked by whichever runs longer: its own cooldown or
        // the shared global cooldown. The overlay fraction is computed
        // against the binding timer's full duration so it drains smoothly.
        const slotRemainingMs = Math.max(0, (me?.cooldowns?.[slot] ?? 0) - now);
        const gcdRemainingMs = Math.max(0, (me?.gcdUntil ?? 0) - now);
        const remainingMs = Math.max(slotRemainingMs, gcdRemainingMs);
        const totalMs = slotRemainingMs >= gcdRemainingMs ? cooldownMs : GLOBAL_COOLDOWN_MS;
        const fraction = totalMs > 0 ? clamp(remainingMs / totalMs, 0, 1) : 0;
        return (
          <div
            key={slot}
            title={label}
            style={{
              position: 'relative',
              width: 56,
              height: 56,
              borderRadius: 8,
              background: '#16213e',
              border: '2px solid #0f3460',
              overflow: 'hidden',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 24,
              userSelect: 'none',
            }}
          >
            <span style={{ position: 'absolute', top: 2, left: 4, fontSize: 10, color: '#666' }}>
              {slot}
            </span>
            <span>{icon}</span>
            {fraction > 0 && (
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: `${fraction * 100}%`,
                  background: 'rgba(0,0,0,0.65)',
                }}
              />
            )}
            {remainingMs > 0 && (
              <span
                style={{
                  position: 'absolute',
                  fontSize: 14,
                  fontWeight: 'bold',
                  fontVariantNumeric: 'tabular-nums',
                  textShadow: '0 0 4px #000',
                }}
              >
                {(remainingMs / 1000).toFixed(1)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function AbilitiesPanel() {
  return (
    <div style={{ width: SIDEBAR_WIDTH, paddingTop: 24 }}>
      <h2 style={{ fontSize: 14, color: '#aaa', margin: '0 0 8px', textTransform: 'uppercase' }}>
        Abilities
      </h2>
      {ABILITIES.map(({ slot, icon, label, cooldownMs, description }) => (
        <div key={slot} style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span style={{ color: '#666', fontSize: 12 }}>[{slot}]</span>
            <span style={{ fontWeight: 'bold' }}>
              {icon} {label}
            </span>
            <span style={{ marginLeft: 'auto', color: '#666', fontSize: 12 }}>
              {cooldownMs > 0 ? `${cooldownMs / 1000}s` : 'GCD'}
            </span>
          </div>
          <div style={{ color: '#aaa', fontSize: 12, lineHeight: 1.4 }}>{description}</div>
        </div>
      ))}
      <div style={{ color: '#666', fontSize: 11, lineHeight: 1.4 }}>
        Casting any ability triggers a shared {GLOBAL_COOLDOWN_MS / 1000}s global cooldown.
      </div>
    </div>
  );
}

function TileLegend() {
  const swatch = (color) => (
    <span
      style={{
        display: 'inline-block',
        width: 14,
        height: 14,
        borderRadius: 3,
        background: color,
        flexShrink: 0,
      }}
    />
  );
  return (
    <div style={{ width: SIDEBAR_WIDTH, paddingTop: 16 }}>
      <h2 style={{ fontSize: 14, color: '#aaa', margin: '0 0 8px', textTransform: 'uppercase' }}>
        Tile Guide
      </h2>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 12 }}>
        {swatch('#ffffff')}
        <span style={{ color: '#aaa' }}>Damage incoming — stay out</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
        {swatch('#2ecc71')}
        <span style={{ color: '#aaa' }}>Safety zone — stay inside</span>
      </div>
    </div>
  );
}

function DebugPanel({ match, now }) {
  const timings = bossTimings(match, now);
  return (
    <div style={{ width: SIDEBAR_WIDTH, paddingTop: 24 }}>
      <h2 style={{ fontSize: 14, color: '#aaa', margin: '0 0 8px', textTransform: 'uppercase' }}>
        Debug
      </h2>
      {timings ? (
        <div style={{ fontVariantNumeric: 'tabular-nums', lineHeight: 1.6 }}>
          <div>Cast Interval: {timings.castInterval.toFixed(2)}s</div>
          <div>Channel Time: {timings.channelTime.toFixed(2)}s</div>
          <div>Attack: {match.attackNames?.length ? match.attackNames.join(' + ') : '—'}</div>
          <div>Boss HP: {match.bossHp}/{match.bossMaxHp} (phase {match.bossPhase})</div>
          <div style={{ color: '#666', fontSize: 12, marginTop: 4 }}>
            progress: {(timings.progress * 100).toFixed(1)}%
          </div>
        </div>
      ) : (
        <div style={{ color: '#666' }}>—</div>
      )}
    </div>
  );
}

export default function App() {
  const [status, setStatus] = useState('connecting');
  const [myId, setMyId] = useState(null);
  const [players, setPlayers] = useState([]);
  const [match, setMatch] = useState({ phase: 'waiting', round: 0, startedAt: null, countdownEndAt: null });
  const [benchedNotice, setBenchedNotice] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [user, setUser] = useState(null);
  const clockOffsetRef = useRef(0); // serverTime - Date.now()

  useEffect(() => {
    fetch('/api/auth/me')
      .then((res) => res.json())
      .then((data) => setUser(data.user))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const onConnect = () => setStatus('connected');
    const onDisconnect = () => setStatus('disconnected');
    const onGameFull = () => setStatus('full');
    const onBenched = ({ message }) => setBenchedNotice(message);
    const applySnapshot = (state) => {
      if (typeof state.serverTime === 'number') clockOffsetRef.current = state.serverTime - Date.now();
      setPlayers(state.players);
      setMatch({
        ...state.match,
        enraged: state.boss?.enraged ?? false,
        // Attacks can overlap; show every concurrent attack's name.
        attackNames: (state.boss?.attacks ?? []).map((a) => a.name),
        bossHp: state.boss?.hp ?? 0,
        bossMaxHp: state.boss?.maxHp ?? 0,
        bossPhase: state.boss?.phase ?? 1,
      });
    };
    const onWelcome = ({ id, state }) => {
      setMyId(id);
      applySnapshot(state);
    };
    const onState = (state) => applySnapshot(state);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('gameFull', onGameFull);
    socket.on('benched', onBenched);
    socket.on('welcome', onWelcome);
    socket.on('state', onState);
    socket.connect();

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('gameFull', onGameFull);
      socket.off('benched', onBenched);
      socket.off('welcome', onWelcome);
      socket.off('state', onState);
      socket.disconnect();
    };
  }, []);

  // Timers animate off server timestamps (+ clock offset) rather than
  // waiting on a broadcast every tick, so the display never stalls between
  // boss casts and can show live milliseconds.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() + clockOffsetRef.current), 40);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!benchedNotice) return;
    if (match.phase !== 'active') setBenchedNotice(null);
  }, [match.phase, benchedNotice]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 24 }}>
      <BurgerMenu user={user} setUser={setUser} />
      <h1 style={{ margin: '0 0 8px' }}>Shapes</h1>
      <p style={{ margin: '0 0 8px', color: '#aaa' }}>
        {status === 'connected' && 'Move with WASD or arrow keys'}
        {status === 'connecting' && 'Connecting…'}
        {status === 'disconnected' && 'Disconnected from server'}
        {status === 'full' && 'The grid is full — try again later'}
      </p>
      {status === 'connected' && <MatchStatus match={match} now={now} />}
      {benchedNotice && (
        <p style={{ margin: '0 0 8px', color: '#f1c40f' }}>{benchedNotice}</p>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: `${SIDEBAR_WIDTH}px auto ${SIDEBAR_WIDTH}px`, gap: 16 }}>
        <LivesPanel players={players} myId={myId} />
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <PhaserGame />
          <AbilityBar me={players.find((p) => p.id === myId)} now={now} />
        </div>
        <div>
          <AbilitiesPanel />
          <TileLegend />
          <DebugPanel match={match} now={now} />
        </div>
      </div>
    </div>
  );
}
