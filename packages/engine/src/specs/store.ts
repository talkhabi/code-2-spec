import { randomBytes } from 'node:crypto';
import { json, now, tx } from '../db/db.js';
import type { Project } from '../project.js';
import type { Evidence, Feature } from '../ai/schemas.js';

export type ItemType =
  | 'feature' | 'journey' | 'flow' | 'rule' | 'screen' | 'entity' | 'api' | 'tech_note' | 'glossary' | 'system_journey';

export interface Item {
  id: string;
  phase_id: string | null;
  parent_id: string | null;
  type: ItemType;
  slug: string;
  title: string;
  summary: string | null;
  data: Record<string, any>;
  status: 'pending' | 'approved' | 'rejected' | 'edited';
  confidence: number | null;
  origin: string;
  created_at: string;
  updated_at: string;
}

export interface Phase {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  files: string[];
  entry_points: string[];
  order_idx: number;
  status: 'pending' | 'approved' | 'rejected';
  analysis_status: 'pending' | 'running' | 'done' | 'failed';
}

export function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'item';
}

export function newId(prefix: string) {
  return `${prefix}_${randomBytes(5).toString('hex')}`;
}

// ---------- phases ----------

export function listPhases(project: Project): Phase[] {
  return (project.db.prepare('SELECT * FROM phases ORDER BY order_idx').all() as any[]).map(rowToPhase);
}

export function getPhase(project: Project, idOrSlug: string): Phase | undefined {
  const row = project.db.prepare('SELECT * FROM phases WHERE id = ? OR slug = ?').get(idOrSlug, idOrSlug);
  return row ? rowToPhase(row) : undefined;
}

function rowToPhase(r: any): Phase {
  return { ...r, files: json(r.files, []), entry_points: json(r.entry_points, []) };
}

export function upsertPhase(project: Project, p: Omit<Phase, 'id' | 'slug' | 'analysis_status' | 'status'> & Partial<Phase>) {
  const id = p.id ?? newId('ph');
  let slug = p.slug ?? slugify(p.name);
  const clash = project.db.prepare('SELECT id FROM phases WHERE slug = ? AND id != ?').get(slug, id);
  if (clash) slug = `${slug}-${id.slice(-4)}`;
  project.db.prepare(`
    INSERT INTO phases (id, slug, name, description, files, entry_points, order_idx, status, analysis_status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET slug = excluded.slug, name = excluded.name, description = excluded.description,
      files = excluded.files, entry_points = excluded.entry_points, order_idx = excluded.order_idx, status = excluded.status
  `).run(id, slug, p.name, p.description ?? null, JSON.stringify(p.files), JSON.stringify(p.entry_points ?? []), p.order_idx,
    p.status ?? 'pending', p.analysis_status ?? 'pending', now());
  return id;
}

export function setPhaseStatus(project: Project, id: string, status: Phase['status']) {
  project.db.prepare('UPDATE phases SET status = ? WHERE id = ?').run(status, id);
}

export function setPhaseAnalysis(project: Project, id: string, status: Phase['analysis_status']) {
  project.db.prepare('UPDATE phases SET analysis_status = ? WHERE id = ?').run(status, id);
}

/** Merge several phases into the first one. */
export function mergePhases(project: Project, ids: string[], name?: string) {
  const phases = ids.map((id) => getPhase(project, id)).filter((p): p is Phase => !!p);
  if (phases.length < 2) throw new Error('Need at least two phases to merge');
  const [target, ...rest] = phases;
  tx(project.db, () => {
    const files = [...new Set(phases.flatMap((p) => p.files))];
    const entry = [...new Set(phases.flatMap((p) => p.entry_points))];
    upsertPhase(project, { ...target, name: name ?? target.name, files, entry_points: entry, description: phases.map((p) => p.description).filter(Boolean).join(' ') });
    for (const p of rest) {
      project.db.prepare('UPDATE items SET phase_id = ? WHERE phase_id = ?').run(target.id, p.id);
      project.db.prepare('DELETE FROM phases WHERE id = ?').run(p.id);
    }
  });
  return target.id;
}

/** Split files out of a phase into a new phase. */
export function splitPhase(project: Project, id: string, name: string, files: string[]) {
  const phase = getPhase(project, id);
  if (!phase) throw new Error(`Unknown phase ${id}`);
  const moving = new Set(files);
  return tx(project.db, () => {
    upsertPhase(project, { ...phase, files: phase.files.filter((f) => !moving.has(f)) });
    return upsertPhase(project, { name, description: `Split from ${phase.name}`, files: [...moving], entry_points: [], order_idx: phase.order_idx + 1 });
  });
}

export function phaseOfFile(project: Project): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of listPhases(project)) for (const f of p.files) map.set(f, p.id);
  return map;
}

// ---------- items ----------

export function listItems(project: Project, filter: { phaseId?: string | null; type?: ItemType; parentId?: string; status?: string } = {}): Item[] {
  const where: string[] = [];
  const args: any[] = [];
  if (filter.phaseId !== undefined) {
    if (filter.phaseId === null) where.push('phase_id IS NULL');
    else { where.push('phase_id = ?'); args.push(filter.phaseId); }
  }
  if (filter.type) { where.push('type = ?'); args.push(filter.type); }
  if (filter.parentId) { where.push('parent_id = ?'); args.push(filter.parentId); }
  if (filter.status) { where.push('status = ?'); args.push(filter.status); }
  const sql = `SELECT * FROM items ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, rowid`;
  return (project.db.prepare(sql).all(...args) as any[]).map(rowToItem);
}

export function getItem(project: Project, id: string): Item | undefined {
  const row = project.db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  return row ? rowToItem(row) : undefined;
}

function rowToItem(r: any): Item {
  return { ...r, data: json(r.data, {}) };
}

export function insertItem(project: Project, i: { type: ItemType; title: string; summary?: string; phaseId?: string | null; parentId?: string | null; data?: object; confidence?: number; origin?: string; evidence?: Evidence[] }) {
  const id = newId(i.type.replace('_', '').slice(0, 4));
  const ts = now();
  const base = slugify(i.title);
  let slug = base;
  for (let n = 2; project.db.prepare('SELECT 1 FROM items WHERE slug = ? AND type = ? AND phase_id IS ?').get(slug, i.type, i.phaseId ?? null); n++) slug = `${base}-${n}`;
  project.db.prepare(`
    INSERT INTO items (id, phase_id, parent_id, type, slug, title, summary, data, confidence, origin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, i.phaseId ?? null, i.parentId ?? null, i.type, slug, i.title, i.summary ?? null, JSON.stringify(i.data ?? {}), i.confidence ?? null, i.origin ?? 'ai', ts, ts);
  if (i.evidence?.length) addEvidence(project, id, i.evidence);
  return id;
}

export function updateItem(project: Project, id: string, patch: { title?: string; summary?: string; data?: object; status?: Item['status'] }) {
  const item = getItem(project, id);
  if (!item) throw new Error(`Unknown item ${id}`);
  project.db.prepare('UPDATE items SET title = ?, summary = ?, data = ?, status = ?, updated_at = ? WHERE id = ?').run(
    patch.title ?? item.title, patch.summary ?? item.summary, JSON.stringify(patch.data ?? item.data), patch.status ?? item.status, now(), id,
  );
}

export function deleteItemTree(project: Project, id: string) {
  const children = project.db.prepare('SELECT id FROM items WHERE parent_id = ?').all(id) as { id: string }[];
  for (const c of children) deleteItemTree(project, c.id);
  project.db.prepare('DELETE FROM evidence WHERE item_id = ?').run(id);
  project.db.prepare('DELETE FROM relations WHERE from_id = ? OR to_id = ?').run(id, id);
  project.db.prepare('DELETE FROM reviews WHERE item_id = ?').run(id);
  project.db.prepare('DELETE FROM items WHERE id = ?').run(id);
}

/** Remove AI-generated, not-yet-reviewed items of a phase before re-analysis. Human-touched items are kept. */
export function clearPhaseItems(project: Project, phaseId: string) {
  const items = project.db.prepare("SELECT id FROM items WHERE phase_id = ? AND parent_id IS NULL AND origin = 'ai' AND status = 'pending'").all(phaseId) as { id: string }[];
  tx(project.db, () => items.forEach((i) => deleteItemTree(project, i.id)));
}

export function addEvidence(project: Project, itemId: string, evidence: Evidence[]) {
  const stmt = project.db.prepare('INSERT INTO evidence (item_id, file, start_line, end_line, symbol, note) VALUES (?, ?, ?, ?, ?, ?)');
  for (const e of evidence) {
    stmt.run(itemId, e.file.replace(/^\.?\//, ''), e.startLine ?? null, e.endLine ?? e.startLine ?? null, e.symbol ?? null, e.note ?? null);
  }
}

export function getEvidence(project: Project, itemId: string): Evidence[] {
  return (project.db.prepare('SELECT file, start_line, end_line, symbol, note FROM evidence WHERE item_id = ?').all(itemId) as any[]).map((r) => ({
    file: r.file, startLine: r.start_line ?? undefined, endLine: r.end_line ?? undefined, symbol: r.symbol ?? undefined, note: r.note ?? undefined,
  }));
}

export function setReview(project: Project, itemId: string, status: Item['status'], comment?: string, author = 'human') {
  project.db.prepare('UPDATE items SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), itemId);
  project.db.prepare('INSERT INTO reviews (item_id, status, comment, author, ts) VALUES (?, ?, ?, ?, ?)').run(itemId, status, comment ?? null, author, now());
}

export function listReviews(project: Project, itemId: string) {
  return project.db.prepare('SELECT status, comment, author, ts FROM reviews WHERE item_id = ? ORDER BY ts DESC').all(itemId);
}

/** Persist a whole feature (with journeys, flows, rules, screens) submitted by an agent. */
export function saveFeature(project: Project, phaseId: string | null, f: Feature): string {
  return tx(project.db, () => {
    const featureId = insertItem(project, {
      type: 'feature', title: f.title, summary: f.summary, phaseId, data: { actors: f.actors },
      confidence: avg(f.journeys.map((j) => j.confidence)), evidence: f.evidence,
    });
    for (const j of f.journeys) {
      const { evidence, title, confidence, ...data } = j;
      insertItem(project, { type: 'journey', title, summary: j.goal, phaseId, parentId: featureId, data, confidence, evidence });
    }
    for (const fl of f.flows) {
      const { evidence, title, description, ...data } = fl;
      insertItem(project, { type: 'flow', title, summary: description, phaseId, parentId: featureId, data, evidence });
    }
    for (const r of f.rules) {
      const { evidence, title, ...data } = r;
      insertItem(project, { type: 'rule', title, summary: r.rule, phaseId, parentId: featureId, data, evidence });
    }
    for (const s of f.screens) {
      const { evidence, title, ...data } = s;
      insertItem(project, { type: 'screen', title, summary: s.purpose, phaseId, parentId: featureId, data, evidence });
    }
    return featureId;
  });
}

function avg(nums: number[]) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : undefined;
}

// ---------- relations ----------

export function addRelation(project: Project, r: { from: string; to: string; kind: string; note?: string }) {
  project.db.prepare('INSERT INTO relations (from_id, to_id, kind, note) VALUES (?, ?, ?, ?)').run(r.from, r.to, r.kind, r.note ?? null);
}

export function listRelations(project: Project) {
  return project.db.prepare(`
    SELECT r.id, r.from_id, r.to_id, r.kind, r.note, r.status,
      a.title AS from_title, a.type AS from_type, a.phase_id AS from_phase,
      b.title AS to_title, b.type AS to_type, b.phase_id AS to_phase
    FROM relations r JOIN items a ON a.id = r.from_id JOIN items b ON b.id = r.to_id
  `).all() as any[];
}

export function itemCounts(project: Project) {
  const rows = project.db.prepare('SELECT type, status, COUNT(*) AS n FROM items GROUP BY type, status').all() as { type: string; status: string; n: number }[];
  const out: Record<string, Record<string, number>> = {};
  for (const r of rows) (out[r.type] ??= {})[r.status] = r.n;
  return out;
}
