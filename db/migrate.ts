import fs from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { withTransaction } from "@/db/pool";

/**
 * Forward-only SQL migrations.
 *
 * Files in `migrations/` are applied in filename order, each inside its own
 * transaction, and recorded in `schema_migrations`. A file already recorded is
 * skipped, so running this repeatedly is safe and `npm run db:migrate` can be part
 * of ordinary startup.
 *
 * Deliberately minimal: no down-migrations and no checksum enforcement. AgentGuard
 * has a handful of tables and a rollback of a money ledger is not a thing you want to
 * be able to do by running a script.
 */

export const MIGRATIONS_DIR = path.join(process.cwd(), "migrations");

export interface AppliedMigration {
  filename: string;
  skipped: boolean;
}

export async function runMigrations(
  pool: Pool,
  options: { dir?: string; log?: (message: string) => void } = {},
): Promise<AppliedMigration[]> {
  const dir = options.dir ?? MIGRATIONS_DIR;
  const log = options.log ?? (() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const { rows } = await pool.query<{ filename: string }>("SELECT filename FROM schema_migrations");
  const already = new Set(rows.map((row) => row.filename));

  const applied: AppliedMigration[] = [];

  for (const filename of files) {
    if (already.has(filename)) {
      applied.push({ filename, skipped: true });
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, filename), "utf8");
    await withTransaction(pool, async (client) => {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
    });
    log(`applied ${filename}`);
    applied.push({ filename, skipped: false });
  }

  return applied;
}

/**
 * Wipe every AgentGuard table without dropping the schema.
 *
 * Used by the dashboard reset button and by tests. `TRUNCATE` rather than `DROP` so a
 * reset never leaves the process running against a schema that no longer exists.
 */
export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      authorization_policies,
      idempotency_records,
      rate_limit_counters,
      consumed_approval_tokens,
      reservations
  `);
}
