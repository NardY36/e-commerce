import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";
import { log } from "../logger.js";

/**
 * Applies schema.sql. It is pure idempotent DDL (CREATE … IF NOT EXISTS) so for a
 * prototype we can safely run it on every boot and as a standalone `pnpm migrate`.
 */
export async function migrate(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = await readFile(join(here, "schema.sql"), "utf8");
  await pool.query(sql);
  log.info("database schema applied");
}

// Allow running directly: `pnpm migrate`
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      log.error("migration failed", { err: String(err) });
      process.exit(1);
    });
}
