import Database from "better-sqlite3";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
export type Db = Database.Database;
export function migrate(
  db: Db,
  directory = fileURLToPath(new URL("./migrations/", import.meta.url)),
) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  for (const name of readdirSync(directory)
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    if (db.prepare("SELECT 1 FROM migrations WHERE name=?").get(name)) continue;
    db.transaction(() => {
      db.exec(readFileSync(join(directory, name), "utf8"));
      db.prepare("INSERT INTO migrations VALUES (?,?)").run(name, Date.now());
    })();
  }
}
export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}
