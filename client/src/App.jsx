import { useEffect, useState } from 'react';
import { socket } from './socket.js';
import PhaserGame from './PhaserGame.jsx';

function colorToCss(color) {
  return `#${color.toString(16).padStart(6, '0')}`;
}

function LivesPanel({ players, myId }) {
  return (
    <div style={{ width: 160, paddingTop: 24 }}>
      <h2 style={{ fontSize: 14, color: '#aaa', margin: '0 0 8px', textTransform: 'uppercase' }}>
        Players
      </h2>
      {players.map((p) => (
        <div
          key={p.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '4px 0',
            opacity: p.eliminated ? 0.4 : 1,
          }}
        >
          <span
            style={{
              width: 12,
              height: 12,
              borderRadius: '50%',
              background: colorToCss(p.color),
              outline: p.id === myId ? '2px solid #fff' : 'none',
            }}
          />
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            {p.eliminated ? 'eliminated' : '❤'.repeat(p.lives)}
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

  useEffect(() => {
    const onConnect = () => setStatus('connected');
    const onDisconnect = () => setStatus('disconnected');
    const onGameFull = () => setStatus('full');
    const onWelcome = ({ id, state }) => {
      setMyId(id);
      setPlayers(state.players);
    };
    const onState = (state) => setPlayers(state.players);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('gameFull', onGameFull);
    socket.on('welcome', onWelcome);
    socket.on('state', onState);
    socket.connect();

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('gameFull', onGameFull);
      socket.off('welcome', onWelcome);
      socket.off('state', onState);
      socket.disconnect();
    };
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 24 }}>
      <h1 style={{ margin: '0 0 8px' }}>Shapes</h1>
      <p style={{ margin: '0 0 16px', color: '#aaa' }}>
        {status === 'connected' && 'Move with WASD or arrow keys'}
        {status === 'connecting' && 'Connecting…'}
        {status === 'disconnected' && 'Disconnected from server'}
        {status === 'full' && 'The grid is full — try again later'}
      </p>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
        <LivesPanel players={players} myId={myId} />
        <PhaserGame />
      </div>
    </div>
  );
}
