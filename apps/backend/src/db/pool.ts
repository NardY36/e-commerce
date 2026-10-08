import pg from "pg";
import { env } from "../env.js";

/**
 * A single shared connection pool for the whole process. In production on
 * Supabase this same `DATABASE_URL` points at the managed Postgres — no code
 * change, which is why we lean on plain `pg` rather than a heavier ORM.
 */
export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
});

export type Queryable = Pick<pg.Pool, "query">;

pool.on("error", (err) => {
  // A pooled client dropped (e.g. DB restarted). Log and let pg re-create it.
  console.error(JSON.stringify({ level: "error", msg: "pg pool error", err: String(err) }));
});
