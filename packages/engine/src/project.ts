import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { type Db, json, now, openDb } from './db/db.js';

export const STAGES = ['detect', 'index', 'partition', 'analyze', 'gapfill', 'synthesize', 'verify', 'export'] as const;
export type Stage = (typeof STAGES)[number];
export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'awaiting_review' | 'skipped';

export interface ProjectConfig {
  id: string;
  name: string;
  root: string;
  include: string[];
  exclude: string[];
  model?: string;
  concurrency: number;
  createdAt: string;
}

const DEFAULT_EXCLUDE = [
  '**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**', '**/coverage/**',
  '**/.nuxt/**', '**/.next/**', '**/.output/**', '**/vendor/**', '**/.code2spec/**', '**/*.min.js',
];

export function code2specHome() {
  return process.env.CODE2SPEC_HOME ?? join(homedir(), '.code2spec');
}

export interface RegistryEntry { id: string; name: string; root: string; addedAt: string }

function registryFile() {
  return join(code2specHome(), 'registry.json');
}

export function listRegistry(): RegistryEntry[] {
  const file = registryFile();
  if (!existsSync(file)) return [];
  return json<RegistryEntry[]>(readFileSync(file, 'utf8'), []).filter((p) => existsSync(join(p.root, '.code2spec', 'config.json')));
}

function saveRegistry(entries: RegistryEntry[]) {
  mkdirSync(code2specHome(), { recursive: true });
  writeFileSync(registryFile(), JSON.stringify(entries, null, 2));
}

function register(root: string, config: ProjectConfig) {
  const entries = listRegistry().filter((e) => e.root !== root && e.id !== config.id);
  entries.push({ id: config.id, name: config.name, root, addedAt: now() });
  saveRegistry(entries);
}

export function workDir(root: string) {
  return join(root, '.code2spec');
}

export function findProjectRoot(start: string): string | undefined {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, '.code2spec', 'config.json'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export class Project {
  readonly db: Db;
  readonly dir: string;
  private listeners = new Set<(e: ProjectEvent) => void>();

  private constructor(readonly root: string, public config: ProjectConfig) {
    this.dir = workDir(root);
    this.db = openDb(join(this.dir, 'index.db'));
  }

  static init(rootPath: string, opts: Partial<ProjectConfig> = {}): Project {
    const root = resolve(rootPath);
    const dir = workDir(root);
    const configFile = join(dir, 'config.json');
    let config: ProjectConfig;
    if (existsSync(configFile)) {
      config = { ...JSON.parse(readFileSync(configFile, 'utf8')), ...stripUndefined(opts) };
    } else {
      config = {
        id: randomUUID(),
        name: opts.name ?? basename(root),
        root,
        include: opts.include ?? ['**/*.{ts,tsx,js,jsx,mjs,cjs,vue}'],
        exclude: [...DEFAULT_EXCLUDE, ...(opts.exclude ?? [])],
        model: opts.model,
        concurrency: opts.concurrency ?? 3,
        createdAt: now(),
      };
    }
    config.root = root;
    mkdirSync(dir, { recursive: true });
    writeFileSync(configFile, JSON.stringify(config, null, 2));
    writeFileSync(join(dir, '.gitignore'), 'index.db*\n');
    register(root, config);
    return new Project(root, config);
  }

  static open(rootPath: string): Project {
    const root = findProjectRoot(rootPath);
    if (!root) throw new Error(`No code2spec project found at ${rootPath}. Run "code2spec init" first.`);
    const config = JSON.parse(readFileSync(join(workDir(root), 'config.json'), 'utf8')) as ProjectConfig;
    // a project scanned elsewhere (other data home, CLI vs plugin) must still show up in the dashboard
    if (!listRegistry().some((e) => e.id === config.id && e.root === root)) register(root, config);
    return new Project(root, config);
  }

  static openById(id: string): Project {
    const entry = listRegistry().find((e) => e.id === id || e.name === id);
    if (!entry) throw Object.assign(new Error(`Unknown project: ${id}. Scan it once (code2spec init <path> or /code2spec:scan) to register it.`), { statusCode: 404 });
    return Project.open(entry.root);
  }

  saveConfig() {
    writeFileSync(join(this.dir, 'config.json'), JSON.stringify(this.config, null, 2));
  }

  path(...parts: string[]) {
    return join(this.dir, ...parts);
  }

  // ---- events & logging ----
  on(listener: (e: ProjectEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(e: ProjectEvent) {
    for (const l of this.listeners) l(e);
  }

  log(level: 'info' | 'warn' | 'error' | 'debug', message: string, stage?: string, taskId?: string) {
    this.db.prepare('INSERT INTO logs (ts, stage, task_id, level, message) VALUES (?, ?, ?, ?, ?)')
      .run(now(), stage ?? null, taskId ?? null, level, message);
    this.emit({ type: 'log', level, message, stage, taskId });
  }

  // ---- stage state ----
  stageStatus(stage: Stage): { status: StageStatus; info: Record<string, unknown>; error?: string } {
    const row = this.db.prepare('SELECT status, info, error FROM stage_runs WHERE stage = ?').get(stage) as
      | { status: StageStatus; info: string; error: string | null }
      | undefined;
    return { status: row?.status ?? 'pending', info: json(row?.info, {}), error: row?.error ?? undefined };
  }

  setStage(stage: Stage, status: StageStatus, info?: Record<string, unknown>, error?: string) {
    const existing = this.stageStatus(stage);
    const mergedInfo = JSON.stringify({ ...existing.info, ...(info ?? {}) });
    const ts = now();
    this.db.prepare(`
      INSERT INTO stage_runs (stage, status, started_at, finished_at, error, info) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(stage) DO UPDATE SET status = excluded.status,
        started_at = CASE WHEN excluded.status = 'running' THEN excluded.started_at ELSE stage_runs.started_at END,
        finished_at = CASE WHEN excluded.status IN ('done','failed','awaiting_review','skipped') THEN excluded.finished_at ELSE NULL END,
        error = excluded.error, info = excluded.info
    `).run(stage, status, ts, ts, error ?? null, mergedInfo);
    this.emit({ type: 'stage', stage, status });
  }

  meta(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string) {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  close() {
    this.db.close();
  }
}

export type ProjectEvent =
  | { type: 'log'; level: string; message: string; stage?: string; taskId?: string }
  | { type: 'stage'; stage: Stage; status: StageStatus };

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
