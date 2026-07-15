// pm2 process definition. Run via `pm2 startOrReload ecosystem.config.cjs` (see deploy.sh).
module.exports = {
  apps: [
    {
      name: 'shapes-server',
      cwd: 'server',
      script: 'src/index.js',
      // Root .env (PORT, DATABASE_URL, etc.) is loaded via Node's native flag
      // rather than a dotenv dependency.
      node_args: '--env-file-if-exists=../.env',
      env: {
        NODE_ENV: 'production',
      },
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
    },
  ],
};
