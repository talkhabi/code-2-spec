import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { Project } from '../project.js';
import { tx } from '../db/db.js';

// graphology ships CommonJS; load via require to avoid ESM default-export interop differences
const require = createRequire(import.meta.url);
const Graph: new (opts: object) => any = require('graphology');
const louvain: (g: any, opts: Record<string, unknown>) => Record<string, number> = require('graphology-communities-louvain');

export interface Cluster {
  id: number;
  label: string;
  files: string[];
}

/** Deterministic seeded PRNG so partitions are stable between runs. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Cluster source files into candidate modules: import/route/component edges plus weak
 * same-directory affinity, then Louvain community detection. Hub files (imported by a large share
 * of the codebase, e.g. http clients, utils) are down-weighted so they don't glue everything together.
 */
export function computeClusters(project: Project): Cluster[] {
  const files = project.db.prepare("SELECT id, path, kind FROM files WHERE kind NOT IN ('test', 'config')").all() as { id: number; path: string; kind: string }[];
  const edges = project.db.prepare('SELECT src_file, dst_file, kind FROM edges').all() as { src_file: number; dst_file: number; kind: string }[];
  const byId = new Map(files.map((f) => [f.id, f]));
  const g = new Graph({ type: 'undirected', allowSelfLoops: false });
  for (const f of files) g.addNode(String(f.id));

  const inDegree = new Map<number, number>();
  const outDegree = new Map<number, number>();
  for (const e of edges) {
    inDegree.set(e.dst_file, (inDegree.get(e.dst_file) ?? 0) + 1);
    outDegree.set(e.src_file, (outDegree.get(e.src_file) ?? 0) + 1);
  }
  const hubThreshold = Math.max(5, files.length * 0.15);
  // routers and app shells fan out to everything; their edges say little about feature boundaries
  const isFanOutHub = (id: number) => byId.get(id)?.kind === 'router' || (outDegree.get(id) ?? 0) > hubThreshold * 2;

  const addWeight = (a: number, b: number, w: number) => {
    if (a === b || !byId.has(a) || !byId.has(b)) return;
    const [s, t] = [String(a), String(b)];
    if (g.hasEdge(s, t)) g.updateEdgeAttribute(s, t, 'weight', (x: number) => x + w);
    else g.addEdge(s, t, { weight: w });
  };
  for (const e of edges) {
    const hub = (inDegree.get(e.dst_file) ?? 0) > hubThreshold || isFanOutHub(e.src_file);
    const base = e.kind === 'route' ? 3 : e.kind === 'uses_component' ? 1.5 : 1;
    addWeight(e.src_file, e.dst_file, hub ? base * 0.1 : base);
  }
  const byDir = new Map<string, number[]>();
  for (const f of files) byDir.set(dirname(f.path), [...(byDir.get(dirname(f.path)) ?? []), f.id]);
  for (const ids of byDir.values()) {
    if (ids.length > 40) continue;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) addWeight(ids[i], ids[j], 0.3);
  }

  let communities: Record<string, number> = {};
  if (g.size > 0) communities = louvain(g, { getEdgeWeight: 'weight', rng: mulberry32(42), resolution: 1 });
  const groups = new Map<number, string[]>();
  let isolatedKey = -1;
  for (const f of files) {
    const c = communities[String(f.id)];
    const key = c ?? isolatedKey--;
    groups.set(key, [...(groups.get(key) ?? []), f.path]);
  }

  // isolated singletons: group by top-level directory
  const merged = new Map<string, string[]>();
  const clusters: string[][] = [];
  for (const [key, paths] of groups) {
    if (key < 0 || paths.length === 1) {
      const dir = paths[0].split('/').slice(0, 2).join('/');
      merged.set(dir, [...(merged.get(dir) ?? []), ...paths]);
    } else clusters.push(paths);
  }
  clusters.push(...merged.values());

  return clusters
    .map((paths) => paths.sort())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map((paths, i) => ({ id: i + 1, label: labelFor(paths), files: paths }));
}

function labelFor(paths: string[]): string {
  const counts = new Map<string, number>();
  for (const p of paths) {
    for (const seg of p.split('/').slice(0, -1)) if (!['src', 'app', 'lib', 'views', 'pages', 'components'].includes(seg)) counts.set(seg, (counts.get(seg) ?? 0) + 1);
    const base = p.split('/').pop()!.replace(/\.\w+$/, '').replace(/(View|Page|Store|Service|Controller)$/, '');
    counts.set(base, (counts.get(base) ?? 0) + 0.5);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k).join(' / ') || 'misc';
}

export function saveClusters(project: Project, clusters: Cluster[]) {
  tx(project.db, () => {
    project.db.exec('DELETE FROM clusters');
    const stmt = project.db.prepare('INSERT INTO clusters (id, label, files) VALUES (?, ?, ?)');
    for (const c of clusters) stmt.run(c.id, c.label, JSON.stringify(c.files));
  });
}

export function loadClusters(project: Project): Cluster[] {
  return (project.db.prepare('SELECT * FROM clusters ORDER BY id').all() as any[]).map((r) => ({ id: r.id, label: r.label, files: JSON.parse(r.files) }));
}
