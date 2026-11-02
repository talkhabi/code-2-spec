import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { listRegistry, Project, findProjectRoot } from './project.js';
import { projectSummary } from './summary.js';
import { runStage, scan } from './pipeline.js';
import { graphTools, invokeTool, submitTools, type TaskContext } from './ai/tools.js';
import { analyzePrompt, gapfillPrompt, partitionPrompt, synthesizePrompt, type TaskPrompt } from './ai/prompts.js';
import { ensureTask, getTask, listTasks, setTask } from './ai/runner.js';
import { computeClusters, saveClusters } from './graph/partition.js';
import { computeCoverage } from './graph/coverage.js';
import {
  clearPhaseItems, deleteItemTree, getItem, listItems, listPhases, phaseOfFile, setPhaseAnalysis, setPhaseStatus, setReview, getPhase,
} from './specs/store.js';
import { renderAll } from './render/render.js';
import { startServer } from './server/server.js';
import { now } from './db/db.js';

/**
 * MCP server for "Claude Code mode": Claude Code itself is the analysing agent.
 * Workflow: init_project → next_task(stage) → explore with graph tools → submit_* (with task_id) → complete_task → next_task …
 */
const server = new McpServer(
  { name: 'code2spec', version: '0.2.1' },
  {
    instructions: `code2spec reverse-engineers legacy codebases into implementation-neutral specs (features, journeys, rules, Gherkin, Playwright).
Pipeline: init_project (detect+index, no AI) → next_task stage=partition → human approves phases (approve_phases or dashboard) → next_task stage=analyze (one task per phase) → next_task stage=gapfill → next_task stage=synthesize → export.
Each task returns instructions; follow them, explore with the graph tools, submit results with the submit tools passing task_id, and finish with complete_task. Then ask for the next task.`,
  },
);

const projects = new Map<string, Project>();
const contexts = new Map<string, TaskContext>();
const prompts = new Map<string, TaskPrompt>();

/** The project open in Claude Code (Claude Code sets CLAUDE_PROJECT_DIR for plugin MCP servers). */
const currentDir = () => process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

function open(ref?: string): Project {
  const key = ref ?? currentDir();
  const cached = projects.get(key);
  if (cached) return cached;
  const entry = listRegistry().find((e) => e.id === key || e.name === key);
  const root = entry?.root ?? findProjectRoot(key);
  if (!root) throw new Error(`Unknown project "${key}". Call init_project with the project path first, or list_projects.`);
  const p = Project.open(root);
  projects.set(key, p);
  return p;
}

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }] });
const projectArg = { project: z.string().optional().describe('Project id, name or path (default: the project open in Claude Code)') };

server.registerTool('list_projects', { description: 'List projects registered with code2spec and their status.', inputSchema: {} }, async () =>
  text(listRegistry().map((e) => {
    try { return projectSummary(open(e.id)); } catch (err) { return { ...e, error: (err as Error).message }; }
  })));

server.registerTool('init_project', {
  description: 'Register a codebase and run the deterministic scan (stack detection + code graph). No AI cost. Re-running it on a scanned project refreshes the graph and keeps all specs.',
  inputSchema: { path: z.string().optional().describe('Absolute path (default: the project open in Claude Code)'), name: z.string().optional() },
}, async ({ path, name }) => {
  const p = Project.init(path ?? currentDir(), { name });
  projects.set(p.config.id, p);
  projects.set(p.root, p);
  await scan(p);
  return text(projectSummary(p));
});

server.registerTool('project_status', { description: 'Pipeline status, counts, coverage and cost.', inputSchema: projectArg }, async ({ project }) =>
  text({ ...projectSummary(open(project)), tasks: listTasks(open(project)).map((t) => ({ id: t.id, status: t.status, error: t.error })) }));

server.registerTool('next_task', {
  description: 'Get the next AI task for a stage (partition | analyze | gapfill | synthesize). Returns task_id and instructions to follow.',
  inputSchema: { ...projectArg, stage: z.enum(['partition', 'analyze', 'gapfill', 'synthesize']) },
}, async ({ project, stage }) => {
  const p = open(project);
  const task = prepareNext(p, stage);
  if (!task) return text({ done: true, message: doneMessage(p, stage) });
  return text(`TASK ${task.taskId} (stage ${stage})\n\nPass task_id="${task.taskId}" to every submit_* tool and to complete_task.\nAvailable submit tools: ${task.prompt.tools.join(', ')}. Required: ${task.prompt.required.join(', ')}.\n\n=== GUIDELINES ===\n${task.prompt.system}\n\n=== TASK ===\n${task.prompt.prompt}`);
});

function prepareNext(p: Project, stage: string): { taskId: string; prompt: TaskPrompt } | undefined {
  const start = (taskId: string, target: string | undefined, prompt: TaskPrompt, phaseId?: string) => {
    ensureTask(p, taskId, stage, target);
    setTask(p, taskId, { status: 'running', started_at: now(), attempts: (getTask(p, taskId)?.attempts ?? 0) + 1 });
    contexts.set(taskId, { project: p, taskId, stage, phaseId, submitted: new Map() });
    prompts.set(taskId, prompt);
    if (p.stageStatus(stage as any).status !== 'running') p.setStage(stage as any, 'running');
    return { taskId, prompt };
  };
  if (stage === 'partition') {
    if (getTask(p, 'partition')?.status === 'done') return undefined;
    saveClusters(p, computeClusters(p));
    return start('partition', undefined, partitionPrompt(p));
  }
  if (stage === 'analyze') {
    const phase = listPhases(p).find((ph) => ph.status === 'approved' && ph.analysis_status !== 'done' && getTask(p, `analyze:${ph.id}`)?.status !== 'running');
    if (!phase) return undefined;
    clearPhaseItems(p, phase.id);
    setPhaseAnalysis(p, phase.id, 'running');
    return start(`analyze:${phase.id}`, phase.id, analyzePrompt(p, phase.id), phase.id);
  }
  if (stage === 'gapfill') {
    const cov = computeCoverage(p);
    const map = phaseOfFile(p);
    const groups = new Map<string, typeof cov.uncovered>();
    for (const u of cov.uncovered) groups.set(map.get(u.file) ?? 'unassigned', [...(groups.get(map.get(u.file) ?? 'unassigned') ?? []), u]);
    const next = [...groups.entries()].find(([k]) => !['done', 'running'].includes(getTask(p, `gapfill:${k}`)?.status ?? ''));
    if (!next) return undefined;
    const phaseId = next[0] === 'unassigned' ? undefined : next[0];
    return start(`gapfill:${next[0]}`, next[0], gapfillPrompt(p, phaseId, next[1]), phaseId);
  }
  if (stage === 'synthesize') {
    if (getTask(p, 'synthesize')?.status === 'done') return undefined;
    for (const i of listItems(p, { phaseId: null })) if (i.origin === 'ai' && i.status === 'pending') deleteItemTree(p, i.id);
    p.db.exec("DELETE FROM relations WHERE status = 'pending'");
    return start('synthesize', undefined, synthesizePrompt(p));
  }
  return undefined;
}

function doneMessage(p: Project, stage: string) {
  if (stage === 'analyze') {
    const pending = listPhases(p).filter((ph) => ph.status === 'pending').length;
    return pending ? `No approved phases left to analyse; ${pending} phase(s) still await human approval.` : 'All approved phases are analysed. Next: gapfill.';
  }
  return `Stage ${stage} has no remaining tasks.`;
}

function ctxFor(taskId: string): TaskContext {
  const ctx = contexts.get(taskId);
  if (ctx) return ctx;
  throw new Error(`Unknown or expired task_id ${taskId}. Call next_task again.`);
}

for (const def of graphTools) {
  server.registerTool(def.name, { description: def.description, inputSchema: { ...projectArg, ...def.shape } }, async (args: any) => {
    const { project, ...rest } = args;
    const p = open(project);
    return text(await invokeTool(def, rest, { project: p, taskId: 'mcp', stage: 'mcp', submitted: new Map() }));
  });
}

for (const def of Object.values(submitTools)) {
  server.registerTool(def.name, {
    description: `${def.description} Requires task_id from next_task.`,
    inputSchema: { task_id: z.string(), ...def.shape },
  }, async (args: any) => {
    const { task_id, ...rest } = args;
    const ctx = ctxFor(task_id);
    const allowed = prompts.get(task_id)?.tools ?? [];
    if (!allowed.includes(def.name)) return text({ ok: false, error: `${def.name} is not part of task ${task_id}. Allowed: ${allowed.join(', ')}` });
    const result = await invokeTool(def, rest, ctx);
    if (def.name === 'complete_task') return text(finishTask(ctx));
    return text(result);
  });
}

function finishTask(ctx: TaskContext) {
  const { project: p, taskId, stage } = ctx;
  const required = prompts.get(taskId)?.required ?? [];
  const missing = required.filter((r) => r !== 'complete_task' && !ctx.submitted.has(r));
  if (missing.length) return { ok: false, error: `Task not complete: call ${missing.join(', ')} first.` };
  setTask(p, taskId, { status: 'done', finished_at: now() });
  contexts.delete(taskId);
  if (stage === 'partition') p.setStage('partition', 'awaiting_review', { phases: listPhases(p).length });
  if (stage === 'analyze' && ctx.phaseId) {
    setPhaseAnalysis(p, ctx.phaseId, 'done');
    if (!listPhases(p).some((ph) => ph.status === 'approved' && ph.analysis_status !== 'done')) p.setStage('analyze', 'done');
  }
  if (stage === 'gapfill') {
    const c = computeCoverage(p);
    p.setMeta('coverage', JSON.stringify({ percent: c.percent, total: c.total, covered: c.covered }));
    if (!listTasks(p, 'gapfill').some((t) => t.status === 'running')) p.setStage('gapfill', 'done', { after: c.percent });
  }
  if (stage === 'synthesize') p.setStage('synthesize', 'done');
  renderAll(p);
  return { ok: true, next: stage === 'partition' ? 'Ask the human to review phases (dashboard or approve_phases), then next_task stage=analyze.' : `Call next_task stage=${stage} for more work.` };
}

server.registerTool('approve_phases', {
  description: 'Approve (or reject) phases after human review. Only call when the user has confirmed.',
  inputSchema: { ...projectArg, ids: z.array(z.string()).optional().describe('Phase ids/slugs; omit to approve all pending'), status: z.enum(['approved', 'rejected']).default('approved') },
}, async ({ project, ids, status }) => {
  const p = open(project);
  const targets = ids?.length ? ids.map((id) => getPhase(p, id)).filter((x) => !!x) : listPhases(p).filter((x) => x.status === 'pending');
  targets.forEach((ph) => setPhaseStatus(p, ph!.id, status));
  if (!listPhases(p).some((x) => x.status === 'pending') && p.stageStatus('partition').status === 'awaiting_review') p.setStage('partition', 'done');
  return text(listPhases(p).map((ph) => ({ id: ph.id, name: ph.name, status: ph.status })));
});

server.registerTool('set_review', {
  description: 'Set review status of spec items (approved / rejected / pending).',
  inputSchema: { ...projectArg, ids: z.array(z.string()), status: z.enum(['approved', 'rejected', 'pending']), comment: z.string().optional() },
}, async ({ project, ids, status, comment }) => {
  const p = open(project);
  for (const id of ids) if (getItem(p, id)) setReview(p, id, status, comment, 'claude-code');
  renderAll(p);
  return text({ ok: true });
});

server.registerTool('get_coverage', { description: 'Coverage of code units by spec evidence.', inputSchema: projectArg }, async ({ project }) => {
  const c = computeCoverage(open(project));
  return text({ ...c, uncovered: c.uncovered.slice(0, 200), files: c.files.slice(0, 50) });
});

server.registerTool('export_pack', { description: 'Write the rebuild pack (.code2spec/export) and return its path.', inputSchema: projectArg }, async ({ project }) =>
  text({ outDir: await runStage(open(project), 'export') }));

let dashboard: Promise<string> | undefined;
server.registerTool('open_dashboard', {
  description: 'Start the code2spec dashboard (review phases, journeys, relations, coverage) and return its URL. Safe to call repeatedly.',
  inputSchema: { port: z.number().int().optional() },
}, async ({ port }) => {
  const p = port ?? Number(process.env.CODE2SPEC_PORT ?? 4600);
  dashboard ??= startServer({ port: p }).then((s) => s.url).catch((err) => {
    dashboard = undefined;
    // already running (e.g. `code2spec serve` or another Claude Code session) — reuse it
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') return `http://127.0.0.1:${p}`;
    throw err;
  });
  const url = await dashboard;
  const id = (() => { try { return open().config.id; } catch { return undefined; } })();
  return text({ url: id ? `${url}/p/${id}` : url, note: 'Open this link in a browser. It stays up while this Claude Code session runs.' });
});

await server.connect(new StdioServerTransport());
