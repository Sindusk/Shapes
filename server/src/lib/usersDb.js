import pg from 'pg';

/**
 * Connection to the shared `users` database — a separate database from
 * `shapes`, shared by every consistencykings.com app so one account/session
 * works across all of them. Deliberately plain `pg` (no Prisma): no single
 * app should own migrations for a shared schema, so the tables are created
 * idempotently at startup instead. Copied from Stonks' lib/usersDb.js +
 * lib/auth.js, the intended reuse path for this pattern.
 */
export const usersPool = new pg.Pool({
  connectionString: process.env.USERS_DATABASE_URL,
});

export async function ensureUsersSchema() {
  await usersPool.query(`
    CREATE TABLE IF NOT EXISTS app_user (
      id         SERIAL PRIMARY KEY,
      username   TEXT UNIQUE NOT NULL,
      pin_hash   TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS session (
      token        TEXT PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    ALTER TABLE app_user ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';

    DO $$
    BEGIN
      ALTER TABLE app_user ADD CONSTRAINT app_user_role_check
        CHECK (role IN ('user', 'moderator', 'administrator'));
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$;
  `);
}
