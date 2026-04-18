/**
 * SQLite database connection and automatic migration runner.
 *
 * Reads migration SQL files from ./migrations/ in ascending filename order
 * and applies each one inside a transaction if it has not been applied yet.
 */

import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// better-sqlite3 ships CommonJS only, so we must load it via createRequire.
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "migrations");

export type Db = InstanceType<typeof Database>;

export function openDatabase(dbPath: string): Db {
  const db = new Database(dbPath) as Db;

  // WAL mode improves concurrent read performance.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  runMigrations(db);

  return db;
}

function runMigrations(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set<string>(
    (db.prepare("SELECT filename FROM _migrations").all() as { filename: string }[]).map(
      (r) => r.filename,
    ),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)").run(
        file,
        new Date().toISOString(),
      );
    })();

    console.log(`[store-sqlite] applied migration: ${file}`);
  }
}
