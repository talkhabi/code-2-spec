import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, normalize } from 'node:path';
import fg from 'fast-glob';
import { adapterFor, type FileAnalysis } from '../adapters/index.js';
import { tx } from '../db/db.js';
import type { Project } from '../project.js';
import { getProfile } from './detect.js';

const RESOLVE_EXT = ['', '.ts', '.tsx', '.js', '.jsx', '.vue', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.vue'];
const MAX_FILE_BYTES = 1_000_000;

export function classifyFile(path: string): string {
  const p = path.toLowerCase();
  if (/(^|\/)(__tests__|tests?|spec|e2e|cypress)\/|\.(test|spec|cy)\.[jt]sx?$/.test(p)) return 'test';
  if (/(^|\/)(\.?[\w-]+\.config|vite|webpack|babel|jest|vitest|eslint|nuxt|next|tailwind|postcss)\.?[\w.]*\.(js|ts|cjs|mjs)$/.test(p)) return 'config';
  if (/(^|\/)(router|routes?)(\/|\.|$)/.test(p)) return 'router';
  if (/(^|\/)(views|pages|screens|routes)\//.test(p)) return 'page';
  if (/(^|\/)(stores?|vuex|redux|slices?|state)\//.test(p) || /store\.[jt]s$/.test(p)) return 'store';
  if (/(^|\/)(api|services?|repositories|clients?|http)\//.test(p)) return 'service';
  if (/(^|\/)(controllers?|handlers?|middlewares?|server)\//.test(p)) return 'server';
  if (/(^|\/)(models?|entities|schemas?|types|interfaces|dto)\//.test(p)) return 'model';
  if (/(^|\/)(components?|widgets|layouts?)\//.test(p) || p.endsWith('.vue') || p.endsWith('.tsx') || p.endsWith('.jsx')) return 'component';
  if (/(^|\/)(composables|hooks|mixins)\//.test(p)) return 'composable';
  if (/(^|\/)(utils?|helpers?|lib|shared|common)\//.test(p)) return 'util';
  return 'module';
}

/** Nuxt / Next style file-based routing: pages/users/[id].vue -> /users/:id */
function fileRoute(path: string): string | undefined {
  const m = path.match(/(?:^|\/)(?:src\/)?(?:app\/)?pages\/(.+)\.(vue|tsx|jsx|ts|js)$/);
  if (!m) return undefined;
  let route = m[1].replace(/(^|\/)index$/, '').replace(/\[\.\.\.(\w+)\]/g, ':$1*').replace(/\[(\w+)\]/g, ':$1').replace(/_(\w+)/g, ':$1');
  if (route.startsWith('_') || route.includes('/_app') || route.includes('/_document')) return undefined;
  return `/${route}`;
}

export async function runIndex(project: Project) {
  project.setStage('index', 'running');
  const profile = getProfile(project);
  const aliases = profile?.aliases ?? {};
  const fileRouting = (profile?.router ?? []).some((r) => r.endsWith('file-routing'));
  const paths = (await fg(project.config.include, { cwd: project.root, ignore: project.config.exclude })).sort();
  const pathSet = new Set(paths);
  const db = project.db;

  const analyses = new Map<string, FileAnalysis>();
  let failed = 0;
  for (const [i, path] of paths.entries()) {
    const abs = join(project.root, path);
    if (statSync(abs).size > MAX_FILE_BYTES) continue;
    const adapter = adapterFor(path);
    if (!adapter) continue;
    try {
      analyses.set(path, adapter.analyze(path, readFileSync(abs, 'utf8')));
    } catch (err) {
      failed++;
      project.log('warn', `Failed to parse ${path}: ${(err as Error).message.split('\n')[0]}`, 'index');
    }
    if (i % 200 === 0) project.emit({ type: 'log', level: 'debug', message: `Indexed ${i}/${paths.length}`, stage: 'index' });
  }

  const resolve = (from: string, spec: string): string | undefined => {
    let base: string | undefined;
    if (spec.startsWith('.')) base = normalize(join(dirname(from), spec));
    else {
      const alias = Object.keys(aliases).sort((a, b) => b.length - a.length).find((a) => spec === a || spec.startsWith(`${a}/`));
      if (alias) base = normalize(join(aliases[alias], spec.slice(alias.length)));
    }
    if (!base) return undefined;
    base = base.replace(/\\/g, '/').replace(/^\//, '');
    const stripped = base.replace(/\.(js|jsx|mjs)$/, '');
    for (const candidate of [base, stripped]) {
      for (const ext of RESOLVE_EXT) if (pathSet.has(candidate + ext)) return candidate + ext;
    }
    return undefined;
  };

  // component-name -> file, for template/JSX usage edges
  const byComponentName = new Map<string, string[]>();
  for (const path of analyses.keys()) {
    const n = path.split('/').pop()!.replace(/\.(vue|tsx|jsx|ts|js)$/, '');
    if (n === 'index') continue;
    byComponentName.set(n, [...(byComponentName.get(n) ?? []), path]);
  }

  const stats = { files: 0, symbols: 0, edges: 0, routes: 0, httpCalls: 0, stores: 0 };
  tx(db, () => {
    for (const t of ['files', 'symbols', 'edges', 'routes', 'http_calls', 'stores']) db.exec(`DELETE FROM ${t}`);
    const insFile = db.prepare('INSERT INTO files (path, lang, kind, loc, hash) VALUES (?, ?, ?, ?, ?)');
    const ids = new Map<string, number>();
    for (const [path, a] of analyses) {
      const text = readFileSync(join(project.root, path), 'utf8');
      const r = insFile.run(path, a.lang, classifyFile(path), text.split('\n').length, createHash('sha1').update(text).digest('hex'));
      ids.set(path, Number(r.lastInsertRowid));
      stats.files++;
    }
    const insSym = db.prepare('INSERT INTO symbols (file_id, name, kind, start_line, end_line, exported, signature) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insEdge = db.prepare('INSERT OR IGNORE INTO edges (src_file, dst_file, kind) VALUES (?, ?, ?)');
    const insRoute = db.prepare('INSERT INTO routes (file_id, side, method, path, name, handler, target_file_id, line) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const insCall = db.prepare('INSERT INTO http_calls (file_id, method, url, line) VALUES (?, ?, ?, ?)');
    const insStore = db.prepare('INSERT INTO stores (file_id, name, line, actions) VALUES (?, ?, ?, ?)');
    for (const [path, a] of analyses) {
      const id = ids.get(path)!;
      for (const s of a.symbols) {
        insSym.run(id, s.name, s.kind, s.startLine, s.endLine, s.exported ? 1 : 0, s.signature ?? null);
        stats.symbols++;
      }
      for (const spec of new Set(a.imports)) {
        const target = resolve(path, spec);
        if (target && target !== path && ids.has(target)) {
          insEdge.run(id, ids.get(target)!, 'import');
          stats.edges++;
        }
      }
      for (const tag of a.usedComponents) {
        const candidates = byComponentName.get(tag);
        if (candidates?.length === 1 && candidates[0] !== path) insEdge.run(id, ids.get(candidates[0])!, 'uses_component');
      }
      for (const r of a.routes) {
        const target = r.targetSpecifier ? resolve(path, r.targetSpecifier) : undefined;
        const targetId = target ? ids.get(target) : undefined;
        insRoute.run(id, r.side, r.method ?? null, r.path, r.name ?? null, r.handler ?? null, targetId ?? null, r.line);
        if (targetId) insEdge.run(id, targetId, 'route');
        stats.routes++;
      }
      if (fileRouting) {
        const route = fileRoute(path);
        if (route) {
          insRoute.run(id, 'client', null, route, null, null, id, 1);
          stats.routes++;
        }
      }
      for (const c of a.httpCalls) {
        insCall.run(id, c.method ?? null, c.url, c.line);
        stats.httpCalls++;
      }
      for (const s of a.stores) {
        insStore.run(id, s.name, s.line, JSON.stringify(s.actions));
        stats.stores++;
      }
    }
  });

  project.log('info', `Indexed ${stats.files} files, ${stats.symbols} symbols, ${stats.edges} import edges, ${stats.routes} routes, ${stats.httpCalls} HTTP calls, ${stats.stores} stores${failed ? `, ${failed} parse failures` : ''}`, 'index');
  project.setStage('index', 'done', stats);
  return stats;
}

export function fileExists(project: Project, path: string) {
  return existsSync(join(project.root, path));
}
