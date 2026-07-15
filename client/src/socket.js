import { io } from 'socket.io-client';

// In dev, Vite proxies /socket.io to the game server (see vite.config.js).
// In production the client is served by the game server itself, so the
// default same-origin connection works in both cases.
export const socket = io({ autoConnect: false });
