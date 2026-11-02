import type { Project } from '../project.js';
import { phaseOfFile } from '../specs/store.js';

export interface CoverageUnit {
  kind: 'file' | 'symbol' | 'route' | 'http_call' | 'store';
  file: string;
  name: string;
  line?: number;
  endLine?: number;
  covered: boolean;
}

export interface CoverageReport {
  total: number;
  covered: number;
  percent: number;
  byKind: Record<string, { total: number; covered: number }>;
  byPhase: Record<string, { total: number; covered: number }>;
  files: { file: string; phaseId?: string; total: number; covered: number }[];
  uncovered: CoverageUnit[];
}

const SYMBOL_KINDS = "('function','class','method','component','store','composable','handler')";

/**
 * Coverage = share of meaningful code units (files, symbols, routes, HTTP calls, stores) that are referenced
 * by at least one evidence entry of a non-rejected spec item. Evidence without line numbers covers the whole file.
 */
export function computeCoverage(project: Project): CoverageReport {
  const db = project.db;
  const evidence = db.prepare(`
    SELECT e.file, e.start_line, e.end_line FROM evidence e JOIN items i ON i.id = e.item_id WHERE i.status != 'rejected'
  `).all() as { file: string; start_line: number | null; end_line: number | null }[];
  const byFile = new Map<string, { s?: number; e?: number }[]>();
  for (const ev of evidence) byFile.set(ev.file, [...(byFile.get(ev.file) ?? []), { s: ev.start_line ?? undefined, e: ev.end_line ?? undefined }]);

  const isCovered = (file: string, line?: number, endLine?: number) => {
    const ranges = byFile.get(file);
    if (!ranges) return false;
    if (line === undefined) return true;
    const end = endLine ?? line;
    return ranges.some((r) => r.s === undefined || (r.s <= end && (r.e ?? r.s) >= line));
  };

  const units: CoverageUnit[] = [];
  const files = db.prepare("SELECT id, path FROM files WHERE kind NOT IN ('test', 'config')").all() as { id: number; path: string }[];
  const fileIds = new Map(files.map((f) => [f.id, f.path]));
  for (const f of files) units.push({ kind: 'file', file: f.path, name: f.path, covered: byFile.has(f.path) });
  for (const s of db.prepare(`SELECT file_id, name, start_line, end_line FROM symbols WHERE kind IN ${SYMBOL_KINDS}`).all() as any[]) {
    const file = fileIds.get(s.file_id);
    if (file) units.push({ kind: 'symbol', file, name: s.name, line: s.start_line, endLine: s.end_line, covered: isCovered(file, s.start_line, s.end_line) });
  }
  for (const r of db.prepare('SELECT file_id, method, path, line FROM routes').all() as any[]) {
    const file = fileIds.get(r.file_id);
    if (file) units.push({ kind: 'route', file, name: `${r.method ?? 'PAGE'} ${r.path}`, line: r.line, covered: isCovered(file, r.line) });
  }
  for (const c of db.prepare('SELECT file_id, method, url, line FROM http_calls').all() as any[]) {
    const file = fileIds.get(c.file_id);
    if (file) units.push({ kind: 'http_call', file, name: `${c.method ?? ''} ${c.url}`.trim(), line: c.line, covered: isCovered(file, c.line) });
  }
  for (const s of db.prepare('SELECT file_id, name, line FROM stores').all() as any[]) {
    const file = fileIds.get(s.file_id);
    if (file) units.push({ kind: 'store', file, name: s.name, line: s.line, covered: isCovered(file, s.line) });
  }

  const phaseMap = phaseOfFile(project);
  const byKind: CoverageReport['byKind'] = {};
  const byPhase: CoverageReport['byPhase'] = {};
  const perFile = new Map<string, { total: number; covered: number }>();
  for (const u of units) {
    const k = (byKind[u.kind] ??= { total: 0, covered: 0 });
    k.total++;
    const phase = phaseMap.get(u.file) ?? 'unassigned';
    const p = (byPhase[phase] ??= { total: 0, covered: 0 });
    p.total++;
    const f = perFile.get(u.file) ?? { total: 0, covered: 0 };
    f.total++;
    if (u.covered) { k.covered++; p.covered++; f.covered++; }
    perFile.set(u.file, f);
  }
  const covered = units.filter((u) => u.covered).length;
  return {
    total: units.length,
    covered,
    percent: units.length ? Math.round((covered / units.length) * 1000) / 10 : 0,
    byKind,
    byPhase,
    files: [...perFile.entries()].map(([file, v]) => ({ file, phaseId: phaseMap.get(file), ...v })).sort((a, b) => a.covered / a.total - b.covered / b.total),
    uncovered: units.filter((u) => !u.covered),
  };
}
