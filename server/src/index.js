import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { Game } from './game.js';
import { PORT, TICK_RATE } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    // In dev the Vite client runs on another port; in production the
    // client is served from this same server (shapes.consistencykings.com).
    origin: process.env.NODE_ENV === 'production' ? false : '*',
  },
});

const game = new Game();

app.get('/health', (_req, res) => res.json({ ok: true, players: game.players.size }));

// Serve the built client (run `npm run build` first) for production.
app.use(express.static(clientDist));

io.on('connection', (socket) => {
  // The client requests its initial snapshot once its listener is ready,
  // rather than us pushing it immediately — on a fast/local connection the
  // push can otherwise arrive before the client has finished booting its
  // renderer and race past a not-yet-registered listener.
  socket.on('ready', () => {
    let player = game.players.get(socket.id);
    if (!player) {
      player = game.addPlayer(socket.id);
      if (!player) {
        socket.emit('gameFull');
        socket.disconnect(true);
        return;
      }
      console.log(`player connected: ${socket.id} at (${player.x}, ${player.y})`);
    }
    socket.emit('welcome', { id: player.id, state: game.snapshot() });
  });

  socket.on('move', (direction) => {
    game.tryMove(socket.id, direction);
  });

  socket.on('disconnect', () => {
    console.log(`player disconnected: ${socket.id}`);
    game.removePlayer(socket.id);
  });
});

// Game loop: 30 ticks/second. Broadcasts state only on ticks where it changed.
setInterval(() => {
  game.update(Date.now());
  if (game.dirty) {
    game.dirty = false;
    io.emit('state', game.snapshot());
  }
}, 1000 / TICK_RATE);

httpServer.listen(PORT, () => {
  console.log(`Shapes server listening on http://localhost:${PORT}`);
});
