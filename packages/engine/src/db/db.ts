import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);

  -- pipeline state
  CREATE TABLE stage_runs (
    stage TEXT PRIMARY KEY,
    status TEXT NOT NULL,            -- pending | running | done | failed | awaiting_review
    started_at TEXT, finished_at TEXT,
    error TEXT, info TEXT
  );
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    stage TEXT NOT NULL,
    target TEXT,
    status TEXT NOT NULL,            -- pending | running | done | failed
    attempts INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    error TEXT, started_at TEXT, finished_at TEXT
  );
  CREATE TABLE logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL, stage TEXT, task_id TEXT, level TEXT NOT NULL, message TEXT NOT NULL
  );

  -- code graph
  CREATE TABLE files (
    id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, lang TEXT, kind TEXT, loc INTEGER, hash TEXT
  );
  CREATE TABLE symbols (
    id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
    start_line INTEGER, end_line INTEGER, exported INTEGER NOT NULL DEFAULT 0, signature TEXT
  );
  CREATE INDEX symbols_file ON symbols(file_id);
  CREATE INDEX symbols_name ON symbols(name);
  CREATE TABLE edges (
    src_file INTEGER NOT NULL, dst_file INTEGER NOT NULL, kind TEXT NOT NULL,
    PRIMARY KEY (src_file, dst_file, kind)
  );
  CREATE TABLE routes (
    id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL, side TEXT NOT NULL, -- client | server
    method TEXT, path TEXT NOT NULL, name TEXT, handler TEXT, target_file_id INTEGER, line INTEGER
  );
  CREATE TABLE http_calls (
    id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL, method TEXT, url TEXT NOT NULL, line INTEGER
  );
  CREATE TABLE stores (
    id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL, name TEXT NOT NULL, line INTEGER, actions TEXT
  );

  -- partition clusters
  CREATE TABLE clusters (id INTEGER PRIMARY KEY, label TEXT, files TEXT NOT NULL);

  -- specs
  CREATE TABLE phases (
    id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, description TEXT,
    files TEXT NOT NULL,             -- JSON array of file paths
    entry_points TEXT,               -- JSON array
    order_idx INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',          -- review: pending | approved | rejected
    analysis_status TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | failed
    created_at TEXT NOT NULL
  );
  CREATE TABLE items (
    id TEXT PRIMARY KEY,
    phase_id TEXT,                   -- NULL for system-level items
    parent_id TEXT,
    type TEXT NOT NULL,              -- feature | journey | flow | rule | entity | api | screen | glossary | system_journey
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    data TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | edited
    confidence REAL,
    origin TEXT NOT NULL DEFAULT 'ai',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX items_phase ON items(phase_id);
  CREATE INDEX items_parent ON items(parent_id);
  CREATE INDEX items_type ON items(type);
  CREATE TABLE evidence (
    id INTEGER PRIMARY KEY, item_id TEXT NOT NULL, file TEXT NOT NULL,
    start_line INTEGER, end_line INTEGER, symbol TEXT, note TEXT
  );
  CREATE INDEX evidence_item ON evidence(item_id);
  CREATE INDEX evidence_file ON evidence(file);
  CREATE TABLE relations (
    id INTEGER PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL,
    note TEXT, status TEXT NOT NULL DEFAULT 'pending'
  );
  CREATE TABLE reviews (
    id INTEGER PRIMARY KEY, item_id TEXT NOT NULL, status TEXT NOT NULL, comment TEXT,
    author TEXT, ts TEXT NOT NULL
  );
  CREATE TABLE verifications (
    id INTEGER PRIMARY KEY, ts TEXT NOT NULL, base_url TEXT, passed INTEGER, failed INTEGER, report TEXT
  );
  `,
];

export type Db = DatabaseSync;

export function openDb(file: string): Db {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: Db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  while (version < MIGRATIONS.length) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      version++;
      db.prepare('UPDATE schema_version SET version = ?').run(version);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function now() {
  return new Date().toISOString();
}

export function json<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
