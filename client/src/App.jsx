import { useEffect, useRef, useState } from 'react';
import { socket } from './socket.js';
import PhaserGame from './PhaserGame.jsx';

const SIDEBAR_WIDTH = 180;

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
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
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

export default function App() {
  const [status, setStatus] = useState('connecting');
  const [myId, setMyId] = useState(null);
  const [players, setPlayers] = useState([]);
  const [match, setMatch] = useState({ phase: 'waiting', round: 0, startedAt: null, countdownEndAt: null });
  const [benchedNotice, setBenchedNotice] = useState(null);
  const [now, setNow] = useState(Date.now());
  const clockOffsetRef = useRef(0); // serverTime - Date.now()

  useEffect(() => {
    const onConnect = () => setStatus('connected');
    const onDisconnect = () => setStatus('disconnected');
    const onGameFull = () => setStatus('full');
    const onBenched = ({ message }) => setBenchedNotice(message);
    const applySnapshot = (state) => {
      if (typeof state.serverTime === 'number') clockOffsetRef.current = state.serverTime - Date.now();
      setPlayers(state.players);
      setMatch({ ...state.match, enraged: state.boss?.enraged ?? false });
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
        <PhaserGame />
        <div />
      </div>
    </div>
  );
}
