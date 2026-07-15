#!/usr/bin/env bash
# Deploys Shapes on the server: installs deps, builds the client, and
# (re)starts the server process. Assumes files are already in place on
# this box (deployed manually) — this script does not touch git.
#
# Prefers pm2 for process management (clean restart, auto-restart on crash,
# survives SSH disconnects). Falls back to a plain nohup + pidfile if pm2
# isn't installed on this box.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

if [ ! -f .env ]; then
  echo "ERROR: .env not found in repo root. Copy .env.example and fill in real values first." >&2
  exit 1
fi

echo "==> Installing dependencies"
npm ci

echo "==> Building client"
npm run build

if command -v pm2 >/dev/null 2>&1; then
  echo "==> Starting/reloading via pm2"
  pm2 startOrReload ecosystem.config.cjs
  pm2 save
else
  echo "==> pm2 not found, falling back to nohup"
  PIDFILE="shapes-server.pid"

  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "Stopping existing server (pid $(cat "$PIDFILE"))"
    kill "$(cat "$PIDFILE")"
    sleep 1
  fi

  nohup npm start --workspace server >> shapes-server.log 2>&1 &
  echo $! > "$PIDFILE"
  echo "Started server (pid $(cat "$PIDFILE")), logs at shapes-server.log"
fi

echo "==> Deploy complete"
