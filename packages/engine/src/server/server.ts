import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listRegistry, Project, STAGES, type Stage } from '../project.js';
import { projectSummary } from '../summary.js';
import { runAll, runStage, scan } from '../pipeline.js';
import { listTasks, type AgentRunner } from '../ai/runner.js';
import {
  getEvidence, getItem, getPhase, listItems, listPhases, listRelations, listReviews, mergePhases, setPhaseStatus, setReview, splitPhase,
  updateItem, upsertPhase, type Item,
} from '../specs/store.js';
import { computeCoverage } from '../graph/coverage.js';
import { loadClusters } from '../graph/partition.js';
import { renderAll, renderGherkin, renderPlaywright } from '../render/render.js';
import { runExport } from '../stages/export.js';

interface Job { stage: string; controller: AbortController; startedAt: string }

export interface ServerOptions { port?: number; host?: string; runner?: AgentRunner; dashboardDir?: string }

function findDashboard(explicit?: string) {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [explicit, process.env.CODE2SPEC_DASHBOARD_DIR, join(here, '../../dashboard/dist'), join(here, '../../../dashboard/dist'), join(here, 'dashboard')];
  return candidates.find((c) => c && existsSync(join(c, 'index.html')));
}

export async function startServer(opts: ServerOptions = {}) {
  const app = Fastify({ logger: false });
  const projects = new Map<string, Project>();
  const jobs = new Map<string, Job>();

  const open = (id: string) => {
    let p = projects.get(id);
    if (!p) {
      p = Project.openById(id);
      projects.set(p.config.id, p);
    }
    return p;
  };

  const startJob = (project: Project, stage: string, fn: (signal: AbortSignal) => Promise<unknown>) => {
    if (jobs.has(project.config.id)) throw Object.assign(new Error(`A job is already running: ${jobs.get(project.config.id)!.stage}`), { statusCode: 409 });
    const controller = new AbortController();
    jobs.set(project.config.id, { stage, controller, startedAt: new Date().toISOString() });
    fn(controller.signal)
      .catch((err) => project.log('error', `${stage} failed: ${(err as Error).message}`, stage))
      .finally(() => jobs.delete(project.config.id));
  };

  app.setErrorHandler((err: any, _req, reply) => {
    reply.status(err.statusCode ?? 500).send({ error: err.message });
  });

  // ---------- projects ----------
  app.get('/api/projects', async () => listRegistry().map((e) => {
    try {
      return { ...projectSummary(open(e.id)), job: jobs.get(e.id)?.stage ?? null };
    } catch (err) {
      return { id: e.id, name: e.name, root: e.root, error: (err as Error).message };
    }
  }));

  app.post<{ Body: { root: string; name?: string } }>('/api/projects', async (req) => {
    const root = resolve(req.body.root);
    if (!existsSync(root)) throw Object.assign(new Error(`Path does not exist: ${root}`), { statusCode: 400 });
    const project = Project.init(root, { name: req.body.name });
    projects.set(project.config.id, project);
    startJob(project, 'scan', () => scan(project));
    return projectSummary(project);
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (req) => {
    const p = open(req.params.id);
    return { ...projectSummary(p), job: jobs.get(p.config.id) ?? null, config: p.config };
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; model?: string; concurrency?: number; exclude?: string[] } }>('/api/projects/:id', async (req) => {
    const p = open(req.params.id);
    Object.assign(p.config, Object.fromEntries(Object.entries(req.body).filter(([, v]) => v !== undefined)));
    p.saveConfig();
    return p.config;
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string; stage?: string; limit?: string; level?: string } }>('/api/projects/:id/logs', async (req) => {
    const p = open(req.params.id);
    const { after, stage, limit, level } = req.query;
    const where = ['id > ?'];
    const args: any[] = [Number(after ?? 0)];
    if (stage) { where.push('stage = ?'); args.push(stage); }
    if (level !== 'debug') where.push("level != 'debug'");
    return p.db.prepare(`SELECT * FROM (SELECT * FROM logs WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?) ORDER BY id`).all(...args, Number(limit ?? 300));
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/tasks', async (req) => listTasks(open(req.params.id)));

  app.post<{ Params: { id: string; stage: string }; Body: { force?: boolean; autoApprove?: boolean; phases?: string[]; baseUrl?: string } }>(
    '/api/projects/:id/stages/:stage/run', async (req) => {
      const p = open(req.params.id);
      const stage = req.params.stage;
      if (stage === 'all') startJob(p, 'all', (signal) => runAll(p, { ...req.body, runner: opts.runner, signal }));
      else if (stage === 'scan') startJob(p, 'scan', () => scan(p));
      else if ((STAGES as readonly string[]).includes(stage)) startJob(p, stage, (signal) => runStage(p, stage as Stage, { ...req.body, runner: opts.runner, signal }));
      else throw Object.assign(new Error(`Unknown stage ${stage}`), { statusCode: 400 });
      return { started: stage };
    });

  app.post<{ Params: { id: string } }>('/api/projects/:id/cancel', async (req) => {
    const job = jobs.get(req.params.id) ?? jobs.get(open(req.params.id).config.id);
    job?.controller.abort();
    return { cancelled: !!job };
  });

  // ---------- phases ----------
  app.get<{ Params: { id: string } }>('/api/projects/:id/phases', async (req) => {
    const p = open(req.params.id);
    const items = listItems(p);
    return listPhases(p).map((ph) => {
      const mine = items.filter((i) => i.phase_id === ph.id);
      return {
        ...ph,
        counts: {
          features: mine.filter((i) => i.type === 'feature').length,
          journeys: mine.filter((i) => i.type === 'journey').length,
          pending: mine.filter((i) => i.status === 'pending').length,
        },
      };
    });
  });

  app.patch<{ Params: { id: string; phaseId: string }; Body: { status?: 'pending' | 'approved' | 'rejected'; name?: string; description?: string; files?: string[] } }>(
    '/api/projects/:id/phases/:phaseId', async (req) => {
      const p = open(req.params.id);
      const ph = getPhase(p, req.params.phaseId);
      if (!ph) throw Object.assign(new Error('Unknown phase'), { statusCode: 404 });
      const { status, ...rest } = req.body;
      if (Object.keys(rest).length) upsertPhase(p, { ...ph, ...rest });
      if (status) setPhaseStatus(p, ph.id, status);
      if (!listPhases(p).some((x) => x.status === 'pending') && p.stageStatus('partition').status === 'awaiting_review') p.setStage('partition', 'done');
      return getPhase(p, ph.id);
    });

  app.post<{ Params: { id: string }; Body: { status: 'approved' | 'rejected' } }>('/api/projects/:id/phases/approve-all', async (req) => {
    const p = open(req.params.id);
    for (const ph of listPhases(p)) if (ph.status === 'pending') setPhaseStatus(p, ph.id, req.body.status ?? 'approved');
    if (p.stageStatus('partition').status === 'awaiting_review') p.setStage('partition', 'done');
    return listPhases(p);
  });

  app.post<{ Params: { id: string }; Body: { ids: string[]; name?: string } }>('/api/projects/:id/phases/merge', async (req) => {
    const p = open(req.params.id);
    return { id: mergePhases(p, req.body.ids, req.body.name) };
  });

  app.post<{ Params: { id: string; phaseId: string }; Body: { name: string; files: string[] } }>('/api/projects/:id/phases/:phaseId/split', async (req) => {
    const p = open(req.params.id);
    return { id: splitPhase(p, req.params.phaseId, req.body.name, req.body.files) };
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/clusters', async (req) => loadClusters(open(req.params.id)));

  // ---------- items ----------
  app.get<{ Params: { id: string }; Querystring: { phase?: string; type?: string; parent?: string; status?: string } }>('/api/projects/:id/items', async (req) => {
    const p = open(req.params.id);
    const { phase, type, parent, status } = req.query;
    return listItems(p, { phaseId: phase === 'system' ? null : phase, type: type as Item['type'], parentId: parent, status });
  });

  app.get<{ Params: { id: string; itemId: string } }>('/api/projects/:id/items/:itemId', async (req) => {
    const p = open(req.params.id);
    const item = getItem(p, req.params.itemId);
    if (!item) throw Object.assign(new Error('Unknown item'), { statusCode: 404 });
    const children = listItems(p, { parentId: item.id });
    const relations = listRelations(p).filter((r) => r.from_id === item.id || r.to_id === item.id);
    const extra: Record<string, string> = {};
    if (item.type === 'feature') {
      const journeys = children.filter((c) => c.type === 'journey' && c.status !== 'rejected');
      extra.gherkin = renderGherkin(item, journeys);
      extra.playwright = renderPlaywright(item, journeys);
    } else if (item.type === 'journey') {
      extra.gherkin = renderGherkin({ ...item, title: item.title, summary: item.summary }, [item]);
    }
    return {
      ...item, evidence: getEvidence(p, item.id), children, reviews: listReviews(p, item.id), relations,
      parent: item.parent_id ? getItem(p, item.parent_id) : null, ...extra,
    };
  });

  app.patch<{ Params: { id: string; itemId: string }; Body: { title?: string; summary?: string; data?: object; comment?: string } }>(
    '/api/projects/:id/items/:itemId', async (req) => {
      const p = open(req.params.id);
      const { comment, ...patch } = req.body;
      updateItem(p, req.params.itemId, { ...patch, status: 'edited' });
      setReview(p, req.params.itemId, 'edited', comment);
      renderAll(p);
      return getItem(p, req.params.itemId);
    });

  app.post<{ Params: { id: string }; Body: { ids: string[]; status: Item['status']; comment?: string; cascade?: boolean } }>(
    '/api/projects/:id/review', async (req) => {
      const p = open(req.params.id);
      const ids = new Set(req.body.ids);
      if (req.body.cascade) for (const id of req.body.ids) listItems(p, { parentId: id }).forEach((c) => ids.add(c.id));
      for (const id of ids) setReview(p, id, req.body.status, req.body.comment);
      renderAll(p);
      return { updated: ids.size };
    });

  app.get<{ Params: { id: string } }>('/api/projects/:id/relations', async (req) => listRelations(open(req.params.id)));
  app.get<{ Params: { id: string } }>('/api/projects/:id/coverage', async (req) => computeCoverage(open(req.params.id)));

  app.get<{ Params: { id: string }; Querystring: { path: string; start?: string; end?: string } }>('/api/projects/:id/code', async (req) => {
    const p = open(req.params.id);
    const rel = req.query.path.replace(/^(\.\.\/)+/, '');
    const abs = resolve(p.root, rel);
    if (!abs.startsWith(p.root) || !existsSync(abs)) throw Object.assign(new Error('File not found'), { statusCode: 404 });
    const lines = readFileSync(abs, 'utf8').split('\n');
    const start = Math.max(1, Number(req.query.start ?? 1) - 3);
    const end = Math.min(lines.length, Number(req.query.end ?? req.query.start ?? lines.length) + 3);
    return { path: rel, start, end, total: lines.length, lines: lines.slice(start - 1, end) };
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/export', async (req) => ({ outDir: runExport(open(req.params.id)) }));

  // ---------- dashboard ----------
  const dashboardDir = findDashboard(opts.dashboardDir);
  if (dashboardDir) {
    await app.register(fastifyStatic, { root: dashboardDir });
    app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api/') ? reply.status(404).send({ error: 'Not found' }) : reply.sendFile('index.html')));
  } else {
    app.get('/', async () => ({ message: 'code2spec API is running. Dashboard build not found — run `pnpm --filter @code2spec/dashboard build`.' }));
  }

  const port = opts.port ?? 4600;
  await app.listen({ port, host: opts.host ?? '127.0.0.1' });
  return { app, url: `http://${opts.host ?? '127.0.0.1'}:${port}`, dashboard: !!dashboardDir };
}
