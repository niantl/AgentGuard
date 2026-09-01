import { Pool, type PoolClient, type PoolConfig } from "pg";

/**
 * Postgres connection management for AgentGuard.
 *
 * ## Why a pool, and why the reserve step still holds one client
 *
 * The reserve step is a single transaction bracketing one `SELECT ... FOR UPDATE`.
 * That only works if every statement in it runs on the *same* connection: a `BEGIN`
 * issued on one pooled connection and an `UPDATE` issued on another are two separate
 * transactions, and the row lock taken by the first would not protect the second.
 * `withTransaction` below checks a single client out of the pool and hands that one
 * client to the callback, so the transaction cannot be accidentally split.
 *
 * ## Fail closed
 *
 * `assertReachable` is called at boot. If the database is unreachable, AgentGuard
 * refuses to start rather than starting with an empty ledger — an engine that
 * believes nothing has been spent yet is far more dangerous than one that is down.
 */

export const DEFAULT_DATABASE_URL = "postgres://agentguard:agentguard@127.0.0.1:5434/agentguard";

export function resolveDatabaseUrl(): string {
  return process.env.AGENTGUARD_DATABASE_URL ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
}

export interface CreatePoolOptions {
  connectionString?: string;
  max?: number;
  /** Milliseconds a caller waits for a free connection before giving up. */
  connectionTimeoutMillis?: number;
  /**
   * Milliseconds a transaction may wait on a row lock before Postgres aborts it.
   * Bounded on purpose: a deadlock or a wedged transaction must surface as a failed
   * proposal, never as a request that hangs forever holding budget.
   */
  lockTimeoutMillis?: number;
  statementTimeoutMillis?: number;
}

export function createPool(options: CreatePoolOptions = {}): Pool {
  const lockTimeout = options.lockTimeoutMillis ?? 5_000;
  const statementTimeout = options.statementTimeoutMillis ?? 15_000;

  const config: PoolConfig = {
    connectionString: options.connectionString ?? resolveDatabaseUrl(),
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    // Applied per-connection by Postgres itself, so it covers every statement on
    // every client the pool hands out, including ones taken by tests.
    options: `-c lock_timeout=${lockTimeout} -c statement_timeout=${statementTimeout} -c idle_in_transaction_session_timeout=30000`,
  };

  const pool = new Pool(config);

  // An idle client erroring out (server restart, network drop) emits on the pool. Left
  // unhandled this is an uncaught exception that takes the process down.
  pool.on("error", (error) => {
    console.error("[agentguard] idle Postgres client error:", error.message);
  });

  return pool;
}

/** Throws if the database is not reachable. Called at boot; never swallowed. */
export async function assertReachable(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
  } finally {
    client.release();
  }
}

/**
 * Run `body` inside one transaction on one dedicated connection.
 *
 * The client is checked out before `BEGIN` and released after `COMMIT`/`ROLLBACK`, so
 * every statement the callback issues is guaranteed to be on the connection that
 * holds the transaction's locks. Any throw rolls back.
 */
export async function withTransaction<T>(
  pool: Pool,
  body: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await body(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The connection is already broken; releasing it with an error below discards it
      // from the pool rather than handing a poisoned client to the next caller.
    }
    throw error;
  } finally {
    client.release();
  }
}
