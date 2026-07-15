import { useEffect, useState } from 'react';
import { socket } from './socket.js';
import PhaserGame from './PhaserGame.jsx';

export default function App() {
  const [status, setStatus] = useState('connecting');

  useEffect(() => {
    const onConnect = () => setStatus('connected');
    const onDisconnect = () => setStatus('disconnected');
    const onGameFull = () => setStatus('full');

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('gameFull', onGameFull);
    socket.connect();

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('gameFull', onGameFull);
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
      <PhaserGame />
    </div>
  );
}
