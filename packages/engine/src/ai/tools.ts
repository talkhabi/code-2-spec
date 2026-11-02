import { readFileSync, existsSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { z } from 'zod';
import fg from 'fast-glob';
import type { Project } from '../project.js';
import { getProfile } from '../stages/detect.js';
import {
  addEvidence, addRelation, getItem, getPhase, insertItem, listItems, listPhases, saveFeature, upsertPhase, getEvidence, type Item,
} from '../specs/store.js';
import { loadClusters } from '../graph/partition.js';
import {
  ApiContractSchema, EntitySchema, EvidenceSchema, FeatureSchema, PhaseInputSchema, RelationSchema, SystemJourneySchema, TechNoteSchema,
} from './schemas.js';

export interface TaskContext {
  project: Project;
  taskId: string;
  stage: string;
  phaseId?: string;
  /** Names of submit tools the agent has called — stages use this to check completion. */
  submitted: Map<string, number>;
}

export interface ToolDef {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  handler: (args: any, ctx: TaskContext) => unknown | Promise<unknown>;
}

const MAX_READ_LINES = 400;

/** Files agents must never read: credentials and local secrets. */
const SECRET_FILE = /(^|\/)(\.env(\..*)?|\.npmrc|\.yarnrc(\.yml)?|\.netrc|id_[a-z0-9]+|.*\.(pem|key|p12|pfx|keystore|jks)|credentials(\.json)?|secrets?\.[a-z]+)$/i;

/** Translation files: UI texts often live here instead of in components. */
export const I18N_GLOBS = ['**/{locales,locale,localization,localizations,i18n,lang,langs,translations}/**/*.json', '**/{en,en-US,en-GB,en_US}.json'];

export function isSecretPath(path: string) {
  return SECRET_FILE.test(path);
}

function safePath(project: Project, path: string) {
  const p = normalize(path).replace(/^(\.\.(\/|\\|$))+/, '').replace(/^\//, '');
  if (p.startsWith('.code2spec') || p.startsWith('.git/')) throw new Error(`Access to ${p} is not allowed`);
  if (isSecretPath(p)) throw new Error(`${p} may contain secrets and cannot be read`);
  return p;
}

function i18nFiles(project: Project): string[] {
  const all = fg.sync(I18N_GLOBS, { cwd: project.root, ignore: project.config.exclude }).filter((f) => !isSecretPath(f)).sort();
  // prefer English only, so searches are not flooded by every translation
  const english = all.filter((f) => /(^|\/)en([-_][a-z]{2})?(\/|\.json$)/i.test(f));
  return english.length ? english : all;
}

function fileRow(project: Project, path: string) {
  return project.db.prepare('SELECT id, path, kind, lang, loc FROM files WHERE path = ?').get(path) as { id: number; path: string; kind: string; lang: string; loc: number } | undefined;
}

function compactItem(project: Project, i: Item, withEvidence = false) {
  return {
    id: i.id, type: i.type, title: i.title, summary: i.summary, status: i.status, phase: i.phase_id, parent: i.parent_id,
    ...(i.type === 'journey' ? { variant: i.data.variant, actor: i.data.actor } : {}),
    ...(withEvidence ? { evidence: getEvidence(project, i.id) } : {}),
  };
}

// ---------------- read-only graph tools ----------------

export const graphTools: ToolDef[] = [
  {
    name: 'project_overview',
    description: 'Detected stack, file counts by kind, routes/endpoints/stores counts, and phases. Call first.',
    shape: {},
    handler: (_a, { project }) => ({
      name: project.config.name,
      profile: getProfile(project),
      filesByKind: project.db.prepare('SELECT kind, COUNT(*) AS n FROM files GROUP BY kind').all(),
      counts: {
        routes: (project.db.prepare('SELECT COUNT(*) AS n FROM routes').get() as any).n,
        httpCalls: (project.db.prepare('SELECT COUNT(*) AS n FROM http_calls').get() as any).n,
        stores: (project.db.prepare('SELECT COUNT(*) AS n FROM stores').get() as any).n,
      },
      phases: listPhases(project).map((p) => ({ id: p.id, name: p.name, files: p.files.length, status: p.status })),
    }),
  },
  {
    name: 'list_files',
    description: 'List indexed files, optionally filtered by phase id, kind (page, component, store, service, server, router, model, util, module) or path substring.',
    shape: { phase: z.string().optional(), kind: z.string().optional(), contains: z.string().optional(), limit: z.number().int().optional() },
    handler: ({ phase, kind, contains, limit }, { project }) => {
      let rows = project.db.prepare('SELECT path, kind, loc FROM files ORDER BY path').all() as { path: string; kind: string; loc: number }[];
      if (phase) {
        const p = getPhase(project, phase);
        const set = new Set(p?.files ?? []);
        rows = rows.filter((r) => set.has(r.path));
      }
      if (kind) rows = rows.filter((r) => r.kind === kind);
      if (contains) rows = rows.filter((r) => r.path.toLowerCase().includes(contains.toLowerCase()));
      return rows.slice(0, limit ?? 300);
    },
  },
  {
    name: 'file_outline',
    description: 'Outline of a file: symbols (with line ranges), routes, HTTP calls, stores, imports and importers. Cheaper than reading the file.',
    shape: { path: z.string() },
    handler: ({ path }, { project }) => {
      const f = fileRow(project, safePath(project, path));
      if (!f) return { error: `File not indexed: ${path}` };
      const q = (sql: string) => project.db.prepare(sql).all(f.id);
      return {
        ...f,
        symbols: q('SELECT name, kind, start_line, end_line, exported, signature FROM symbols WHERE file_id = ? ORDER BY start_line'),
        routes: q('SELECT side, method, path, name, line FROM routes WHERE file_id = ?'),
        httpCalls: q('SELECT method, url, line FROM http_calls WHERE file_id = ?'),
        stores: q('SELECT name, actions, line FROM stores WHERE file_id = ?'),
        imports: q('SELECT f.path, e.kind FROM edges e JOIN files f ON f.id = e.dst_file WHERE e.src_file = ?'),
        importedBy: q('SELECT f.path, e.kind FROM edges e JOIN files f ON f.id = e.src_file WHERE e.dst_file = ?'),
      };
    },
  },
  {
    name: 'read_file',
    description: `Read a project file with line numbers (max ${MAX_READ_LINES} lines per call; use start/end for large files).`,
    shape: { path: z.string(), start: z.number().int().optional(), end: z.number().int().optional() },
    handler: ({ path, start, end }, { project }) => {
      const p = safePath(project, path);
      const abs = join(project.root, p);
      if (!existsSync(abs)) return { error: `No such file: ${p}` };
      const lines = readFileSync(abs, 'utf8').split('\n');
      const s = Math.max(1, start ?? 1);
      const e = Math.min(lines.length, end ?? s + MAX_READ_LINES - 1, s + MAX_READ_LINES - 1);
      const body = lines.slice(s - 1, e).map((l, i) => `${String(s + i).padStart(5)}  ${l}`).join('\n');
      return `${p} (lines ${s}-${e} of ${lines.length})\n${body}`;
    },
  },
  {
    name: 'search_code',
    description: 'Regex search across indexed source files and translation (i18n) JSON files. Use it to resolve i18n keys like t(\'auth.login.error\') to the real English UI text. Returns file:line matches (max 100).',
    shape: { pattern: z.string(), pathContains: z.string().optional(), i18nOnly: z.boolean().optional().describe('Only search translation files') },
    handler: ({ pattern, pathContains, i18nOnly }, { project }) => {
      const re = new RegExp(pattern, 'i');
      const indexed = i18nOnly ? [] : (project.db.prepare('SELECT path FROM files').all() as { path: string }[]).map((f) => f.path);
      const files = [...indexed, ...i18nFiles(project)].filter((f) => !pathContains || f.includes(pathContains));
      const out: string[] = [];
      for (const f of files) {
        const lines = readFileSync(join(project.root, f), 'utf8').split('\n');
        lines.forEach((l, i) => { if (out.length < 100 && re.test(l)) out.push(`${f}:${i + 1}: ${l.trim().slice(0, 160)}`); });
        if (out.length >= 100) break;
      }
      return out.length ? out.join('\n') : 'No matches';
    },
  },
  {
    name: 'search_symbols',
    description: 'Find functions/components/handlers/stores by name substring.',
    shape: { query: z.string(), kind: z.string().optional() },
    handler: ({ query, kind }, { project }) => project.db.prepare(`
      SELECT s.name, s.kind, f.path, s.start_line, s.end_line FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE s.name LIKE ? ${kind ? 'AND s.kind = ?' : ''} LIMIT 100
    `).all(`%${query}%`, ...(kind ? [kind] : [])),
  },
  {
    name: 'list_routes',
    description: 'Client routes (pages) and server endpoints with the file that defines them and the target component/handler file.',
    shape: { side: z.enum(['client', 'server']).optional(), contains: z.string().optional() },
    handler: ({ side, contains }, { project }) => (project.db.prepare(`
      SELECT r.side, r.method, r.path, r.name, r.handler, f.path AS file, r.line, t.path AS target FROM routes r
      JOIN files f ON f.id = r.file_id LEFT JOIN files t ON t.id = r.target_file_id ORDER BY r.side, r.path
    `).all() as any[]).filter((r) => (!side || r.side === side) && (!contains || r.path.includes(contains))),
  },
  {
    name: 'list_http_calls',
    description: 'Client-side HTTP calls (axios/fetch/etc) with URL, method and location.',
    shape: { contains: z.string().optional() },
    handler: ({ contains }, { project }) => (project.db.prepare(`
      SELECT h.method, h.url, f.path AS file, h.line FROM http_calls h JOIN files f ON f.id = h.file_id ORDER BY h.url
    `).all() as any[]).filter((r) => !contains || r.url.includes(contains)),
  },
  {
    name: 'list_stores',
    description: 'State stores (pinia/vuex/redux) with their actions.',
    shape: {},
    handler: (_a, { project }) => project.db.prepare('SELECT s.name, s.actions, f.path AS file, s.line FROM stores s JOIN files f ON f.id = s.file_id').all(),
  },
  {
    name: 'graph_neighbors',
    description: 'Files connected to a file through imports, routes or component usage (both directions), up to depth 2.',
    shape: { path: z.string(), depth: z.number().int().min(1).max(2).optional() },
    handler: ({ path, depth }, { project }) => {
      const start = fileRow(project, safePath(project, path));
      if (!start) return { error: `File not indexed: ${path}` };
      const seen = new Map<number, number>([[start.id, 0]]);
      let frontier = [start.id];
      for (let d = 1; d <= (depth ?? 1); d++) {
        const next: number[] = [];
        for (const id of frontier) {
          const rows = project.db.prepare('SELECT dst_file AS n FROM edges WHERE src_file = ? UNION SELECT src_file AS n FROM edges WHERE dst_file = ?').all(id, id) as { n: number }[];
          for (const r of rows) if (!seen.has(r.n)) { seen.set(r.n, d); next.push(r.n); }
        }
        frontier = next;
      }
      seen.delete(start.id);
      return [...seen.entries()].map(([id, d]) => ({ ...(project.db.prepare('SELECT path, kind FROM files WHERE id = ?').get(id) as object), depth: d }));
    },
  },
  {
    name: 'list_spec_items',
    description: 'List already-documented spec items (features, journeys, rules, entities, apis...), optionally by phase id / type / parent.',
    shape: { phase: z.string().optional(), type: z.string().optional(), parent: z.string().optional() },
    handler: ({ phase, type, parent }, { project }) =>
      listItems(project, { phaseId: phase, type: type as any, parentId: parent }).filter((i) => i.status !== 'rejected').map((i) => compactItem(project, i)),
  },
  {
    name: 'get_spec_item',
    description: 'Full content of a spec item including evidence.',
    shape: { id: z.string() },
    handler: ({ id }, { project }) => {
      const i = getItem(project, id);
      return i ? { ...compactItem(project, i, true), data: i.data } : { error: `Unknown item ${id}` };
    },
  },
];

// ---------------- submit tools ----------------

function mark(ctx: TaskContext, name: string) {
  ctx.submitted.set(name, (ctx.submitted.get(name) ?? 0) + 1);
}

function checkEvidence(project: Project, evidence: { file: string }[]): string[] {
  return evidence.filter((e) => !fileRow(project, safePath(project, e.file))).map((e) => e.file);
}

export const submitTools: Record<string, ToolDef> = {
  submit_phases: {
    name: 'submit_phases',
    description: 'Submit the final list of phases (bounded contexts). Every cluster id must be assigned to exactly one phase.',
    shape: { phases: z.array(PhaseInputSchema).min(1) },
    handler: ({ phases }, ctx) => {
      const { project } = ctx;
      const clusters = loadClusters(project);
      const byId = new Map(clusters.map((c) => [c.id, c]));
      const assigned = new Map<number, string>();
      const problems: string[] = [];
      for (const p of phases) for (const c of p.clusters) {
        if (!byId.has(c)) problems.push(`Unknown cluster ${c}`);
        else if (assigned.has(c)) problems.push(`Cluster ${c} assigned to both "${assigned.get(c)}" and "${p.name}"`);
        else assigned.set(c, p.name);
      }
      const missing = clusters.filter((c) => !assigned.has(c.id)).map((c) => c.id);
      if (missing.length) problems.push(`Unassigned clusters: ${missing.join(', ')}. Assign every cluster (use a "Shared infrastructure" phase if needed).`);
      if (problems.length) return { ok: false, problems };

      const moved = new Map<string, string>();
      phases.forEach((p: any) => (p.extraFiles ?? []).forEach((f: string) => moved.set(f, p.name)));
      project.db.exec("DELETE FROM phases WHERE id NOT IN (SELECT DISTINCT phase_id FROM items WHERE phase_id IS NOT NULL)");
      phases.forEach((p: any, idx: number) => {
        const files = new Set<string>(p.clusters.flatMap((c: number) => byId.get(c)!.files));
        for (const [f, owner] of moved) { if (owner === p.name) files.add(f); else files.delete(f); }
        upsertPhase(project, { name: p.name, description: p.description, files: [...files].sort(), entry_points: p.entryPoints, order_idx: idx });
      });
      mark(ctx, 'submit_phases');
      return { ok: true, phases: phases.length };
    },
  },
  submit_feature: {
    name: 'submit_feature',
    description: 'Submit ONE feature with all its journeys (happy, alternate, error, edge), flows, business rules and screens. Call once per feature.',
    shape: { feature: FeatureSchema },
    handler: ({ feature }, ctx) => {
      const evidence = [...feature.evidence, ...feature.journeys.flatMap((j: any) => j.evidence), ...feature.rules.flatMap((r: any) => r.evidence)];
      const bad = checkEvidence(ctx.project, evidence);
      if (bad.length) return { ok: false, problems: [`Evidence references unknown files: ${[...new Set(bad)].join(', ')}. Use project-relative paths from list_files.`] };
      const id = saveFeature(ctx.project, ctx.phaseId ?? null, feature);
      mark(ctx, 'submit_feature');
      ctx.project.log('info', `Feature "${feature.title}" with ${feature.journeys.length} journeys`, ctx.stage, ctx.taskId);
      return { ok: true, featureId: id, journeys: feature.journeys.length };
    },
  },
  submit_domain: {
    name: 'submit_domain',
    description: 'Submit domain entities and API contracts discovered in this phase.',
    shape: { entities: z.array(EntitySchema).default([]), apis: z.array(ApiContractSchema).default([]) },
    handler: ({ entities, apis }, ctx) => {
      const { project, phaseId } = ctx;
      for (const e of entities) {
        const { evidence, name, description, ...data } = e;
        insertItem(project, { type: 'entity', title: name, summary: description, phaseId, data, evidence });
      }
      for (const a of apis) {
        const { evidence, description, ...data } = a;
        insertItem(project, { type: 'api', title: `${a.method.toUpperCase()} ${a.path}`, summary: description, phaseId, data, evidence });
      }
      mark(ctx, 'submit_domain');
      return { ok: true, entities: entities.length, apis: apis.length };
    },
  },
  submit_tech_notes: {
    name: 'submit_tech_notes',
    description: 'Submit cross-cutting technical behaviour (auth/token handling, interceptors, caching, i18n, config, bootstrapping) that is not a user journey but must be preserved.',
    shape: { notes: z.array(TechNoteSchema).min(1) },
    handler: ({ notes }, ctx) => {
      for (const n of notes) insertItem(ctx.project, { type: 'tech_note', title: n.title, summary: n.note, phaseId: ctx.phaseId, data: {}, evidence: n.evidence });
      mark(ctx, 'submit_tech_notes');
      return { ok: true, notes: notes.length };
    },
  },
  attach_evidence: {
    name: 'attach_evidence',
    description: 'Attach additional code evidence to an existing spec item (when uncovered code belongs to something already documented).',
    shape: { itemId: z.string(), evidence: z.array(EvidenceSchema).min(1) },
    handler: ({ itemId, evidence }, ctx) => {
      if (!getItem(ctx.project, itemId)) return { ok: false, problems: [`Unknown item ${itemId}`] };
      addEvidence(ctx.project, itemId, evidence);
      mark(ctx, 'attach_evidence');
      return { ok: true };
    },
  },
  submit_synthesis: {
    name: 'submit_synthesis',
    description: 'Submit cross-phase results: relations between items, end-to-end system journeys spanning phases, a glossary and a unified domain model.',
    shape: {
      relations: z.array(RelationSchema).default([]),
      systemJourneys: z.array(SystemJourneySchema).default([]),
      glossary: z.array(z.object({ term: z.string(), definition: z.string() })).default([]),
      domainModel: z.array(EntitySchema.omit({ evidence: true }).extend({ sources: z.array(z.string()).default([]).describe('Entity item ids merged into this') })).default([]),
    },
    handler: ({ relations, systemJourneys, glossary, domainModel }, ctx) => {
      const { project } = ctx;
      const problems: string[] = [];
      for (const r of relations) {
        if (!getItem(project, r.from) || !getItem(project, r.to)) problems.push(`Relation ${r.from} -> ${r.to}: unknown item id`);
        else addRelation(project, r);
      }
      for (const j of systemJourneys) {
        const unknown = j.steps.filter((s: any) => !getItem(project, s.journeyId));
        if (unknown.length) { problems.push(`System journey "${j.title}": unknown journey ids ${unknown.map((s: any) => s.journeyId).join(', ')}`); continue; }
        insertItem(project, { type: 'system_journey', title: j.title, summary: j.summary, phaseId: null, data: { actor: j.actor, steps: j.steps } });
      }
      for (const g of glossary) insertItem(project, { type: 'glossary', title: g.term, summary: g.definition, phaseId: null, data: {} });
      for (const e of domainModel) {
        const { name, description, sources, ...data } = e;
        const evidence = (sources as string[]).flatMap((s) => getEvidence(project, s));
        insertItem(project, { type: 'entity', title: name, summary: description, phaseId: null, data: { ...data, sources }, evidence });
      }
      mark(ctx, 'submit_synthesis');
      return problems.length ? { ok: true, warnings: problems } : { ok: true };
    },
  },
  complete_task: {
    name: 'complete_task',
    description: 'Call when you have submitted everything for this task. Include a short summary and anything a human reviewer should know.',
    shape: { summary: z.string(), reviewerNotes: z.array(z.string()).default([]) },
    handler: ({ summary, reviewerNotes }, ctx) => {
      mark(ctx, 'complete_task');
      ctx.project.log('info', `Agent summary: ${summary}${reviewerNotes.length ? ` | Notes: ${reviewerNotes.join('; ')}` : ''}`, ctx.stage, ctx.taskId);
      if (ctx.phaseId) ctx.project.setMeta(`notes:${ctx.taskId}`, JSON.stringify({ summary, reviewerNotes }));
      return { ok: true };
    },
  },
};

/** Run a tool handler with zod validation, turning errors into messages the agent can act on. */
export async function invokeTool(def: ToolDef, rawArgs: unknown, ctx: TaskContext): Promise<string> {
  const parsed = z.object(def.shape).safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return JSON.stringify({ ok: false, problems: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  }
  try {
    const result = await def.handler(parsed.data, ctx);
    return typeof result === 'string' ? result : JSON.stringify(result, null, 1);
  } catch (err) {
    return JSON.stringify({ ok: false, error: (err as Error).message });
  }
}
