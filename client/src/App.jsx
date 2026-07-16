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
  if (match.phase === 'waiting') {
    label = 'Waiting for players…';
  } else if (match.phase === 'countdown') {
    label = 'Match starting in…';
    timer = formatClockMs(Math.max(0, match.countdownEndAt - now));
  } else if (match.phase === 'active') {
    label = `Round ${match.round + 1}${match.enraged ? ' — ENRAGED' : ''}`;
    timer = formatClockMs(Math.max(0, now - match.startedAt));
  }

  return (
    <div style={{ margin: '0 0 8px', textAlign: 'center' }}>
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

const ABILITIES = [
  { slot: 1, icon: '⚔', label: 'Damage', cooldownMs: 2500 },
  { slot: 2, icon: '💨', label: 'Pushback', cooldownMs: 20000 },
  { slot: 3, icon: '⚡', label: 'Dash', cooldownMs: 10000 },
  { slot: 4, icon: '✨', label: 'Invuln', cooldownMs: 45000 },
];

function AbilityBar({ me, now }) {
  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
      {ABILITIES.map(({ slot, icon, label, cooldownMs }) => {
        const readyAt = me?.cooldowns?.[slot] ?? 0;
        const remainingMs = Math.max(0, readyAt - now);
        const fraction = cooldownMs > 0 ? clamp(remainingMs / cooldownMs, 0, 1) : 0;
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
          <div>Attack: {match.attackName ?? '—'}</div>
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
        attackName: state.boss?.name ?? null,
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
        <DebugPanel match={match} now={now} />
      </div>
    </div>
  );
}
