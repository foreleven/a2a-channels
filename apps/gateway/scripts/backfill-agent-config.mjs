import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const dbPath =
  process.env.DB_PATH ?? path.join(process.cwd(), "db/agent-relay.db");

if (!fs.existsSync(dbPath)) {
  process.exit(0);
}

const db = new Database(dbPath);

try {
  if (needsMigration(db)) {
    backfillAndDropLegacyUrl(db);
    console.log(
      "[db] migrated Agent.url into Agent.config and dropped url column",
    );
  }
} finally {
  db.close();
}

function needsMigration(db) {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get("agents");
  if (!table) return false;

  return getColumnNames(db).has("url");
}

function backfillAndDropLegacyUrl(db) {
  const names = getColumnNames(db);
  if (!names.has("config")) {
    db.exec(
      'ALTER TABLE "agents" ADD COLUMN "config" TEXT NOT NULL DEFAULT \'{}\'',
    );
  }

  const rows = db
    .prepare('SELECT id, url, protocol, config FROM "agents"')
    .all();
  const update = db.prepare('UPDATE "agents" SET config = ? WHERE id = ?');

  const migrate = db.transaction(() => {
    for (const row of rows) {
      const url = typeof row.url === "string" ? row.url.trim() : "";
      if (!url) continue;

      const config = parseConfig(row.config);
      if (hasConfiguredTarget(config)) continue;

      const protocol = row.protocol === "acp" ? "acp" : "a2a";
      const nextConfig =
        protocol === "acp" ? { transport: "rest", url } : { url };
      update.run(JSON.stringify(nextConfig), row.id);
    }

    db.exec('ALTER TABLE "agents" DROP COLUMN "url"');
  });

  migrate();
}

function getColumnNames(db) {
  return new Set(
    db.prepare('PRAGMA table_info("agents")').all().map((column) => column.name),
  );
}

function parseConfig(value) {
  try {
    const parsed = JSON.parse(typeof value === "string" ? value : "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function hasConfiguredTarget(config) {
  if (config.transport === "stdio") {
    return typeof config.command === "string" && config.command.trim() !== "";
  }
  if (config.transport === "rest") {
    return typeof config.url === "string" && config.url.trim() !== "";
  }
  return typeof config.url === "string" && config.url.trim() !== "";
}
