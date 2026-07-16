import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { Game } from './game.js';
import { PORT, TICK_RATE } from './config.js';
import { ensureUsersSchema } from './lib/usersDb.js';
import { getSessionUser, readSessionToken } from './lib/auth.js';
import authRouter from './routes/auth.js';

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

app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true, players: game.players.size }));

app.use('/api/auth', authRouter);

// Serve the built client (run `npm run build` first) for production.
app.use(express.static(clientDist));

// Error-handling middleware — must come after all routes. Any error passed
// to next() (via asyncHandler) lands here as a 500 instead of crashing.
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

io.on('connection', (socket) => {
  // The client requests its initial snapshot once its listener is ready,
  // rather than us pushing it immediately — on a fast/local connection the
  // push can otherwise arrive before the client has finished booting its
  // renderer and race past a not-yet-registered listener.
  socket.on('ready', async () => {
    let player = game.players.get(socket.id);
    if (!player) {
      const cookieHeader = socket.handshake.headers.cookie;
      const sessionUser = cookieHeader
        ? await getSessionUser(readSessionToken({ headers: { cookie: cookieHeader } })).catch(() => null)
        : null;

      player = game.addPlayer(socket.id, sessionUser?.username ?? null);
      if (!player) {
        socket.emit('gameFull');
        socket.disconnect(true);
        return;
      }
      console.log(`player connected: ${socket.id} at (${player.x}, ${player.y})`);
      if (player.benched) {
        socket.emit('benched', {
          message: 'A match is already in progress — you have been benched and will join once it concludes.',
        });
      }
    }
    socket.emit('welcome', { id: player.id, state: game.snapshot() });
  });

  socket.on('move', (direction) => {
    game.tryMove(socket.id, direction);
  });

  socket.on('ability', (slot) => {
    game.tryAbility(socket.id, Number(slot));
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

// The shared `users` database lives outside `shapes` (see lib/usersDb.js).
// If it's unreachable, log and keep serving — the rest of the app doesn't
// depend on auth.
ensureUsersSchema().catch((err) => {
  console.error('Could not initialize users database (auth disabled):', err.message);
});

httpServer.listen(PORT, () => {
  console.log(`Shapes server listening on http://localhost:${PORT}`);
});
