import { now } from '../db/db.js';
import type { Project } from '../project.js';
import type { TaskPrompt } from './prompts.js';
import { graphTools, submitTools, type TaskContext, type ToolDef } from './tools.js';

export interface RunUsage {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AgentRunner {
  readonly name: string;
  /** Run one agent conversation. Tools are already bound to `ctx`; the runner just exposes them to the model. */
  run(task: TaskPrompt, tools: ToolDef[], ctx: TaskContext, signal?: AbortSignal): Promise<RunUsage>;
}

export function toolsFor(task: TaskPrompt): ToolDef[] {
  return [...graphTools, ...task.tools.map((n) => submitTools[n])];
}

export interface TaskRow {
  id: string;
  stage: string;
  target: string | null;
  status: 'pending' | 'running' | 'done' | 'failed';
  attempts: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export function ensureTask(project: Project, id: string, stage: string, target?: string) {
  project.db.prepare("INSERT OR IGNORE INTO tasks (id, stage, target, status) VALUES (?, ?, ?, 'pending')").run(id, stage, target ?? null);
  return getTask(project, id)!;
}

export function getTask(project: Project, id: string): TaskRow | undefined {
  return project.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
}

export function listTasks(project: Project, stage?: string): TaskRow[] {
  return (stage
    ? project.db.prepare('SELECT * FROM tasks WHERE stage = ? ORDER BY rowid').all(stage)
    : project.db.prepare('SELECT * FROM tasks ORDER BY rowid').all()) as unknown as TaskRow[];
}

export function setTask(project: Project, id: string, patch: Partial<TaskRow>) {
  const cur = getTask(project, id);
  if (!cur) return;
  const next = { ...cur, ...patch };
  project.db.prepare(`UPDATE tasks SET status = ?, attempts = ?, cost_usd = ?, input_tokens = ?, output_tokens = ?, error = ?, started_at = ?, finished_at = ? WHERE id = ?`)
    .run(next.status, next.attempts, next.cost_usd, next.input_tokens, next.output_tokens, next.error, next.started_at, next.finished_at, id);
}

/**
 * Execute one AI task with retries: run the agent, then check the required submit tools were called.
 * If not, re-run once with a nudge. Usage is accumulated on the task row.
 */
export async function executeTask(
  project: Project, runner: AgentRunner, taskId: string, stage: string, prompt: TaskPrompt, opts: { phaseId?: string; maxAttempts?: number; signal?: AbortSignal } = {},
): Promise<TaskContext> {
  const ctx: TaskContext = { project, taskId, stage, phaseId: opts.phaseId, submitted: new Map() };
  const maxAttempts = opts.maxAttempts ?? 2;
  setTask(project, taskId, { status: 'running', started_at: now(), error: null });
  let lastError = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const cur = getTask(project, taskId)!;
    setTask(project, taskId, { attempts: cur.attempts + 1 });
    const missing = prompt.required.filter((r) => !ctx.submitted.has(r));
    const p = attempt === 1 ? prompt : {
      ...prompt,
      prompt: `${prompt.prompt}\n\nIMPORTANT: a previous attempt ended without calling ${missing.join(', ')}. ${ctx.submitted.size ? `Already submitted: ${[...ctx.submitted.keys()].join(', ')} — do not resubmit those; ` : ''}complete the task now.`,
    };
    try {
      const usage = await runner.run(p, toolsFor(p), ctx, opts.signal);
      const after = getTask(project, taskId)!;
      setTask(project, taskId, { cost_usd: after.cost_usd + usage.costUsd, input_tokens: after.input_tokens + usage.inputTokens, output_tokens: after.output_tokens + usage.outputTokens });
      const stillMissing = prompt.required.filter((r) => !ctx.submitted.has(r));
      if (!stillMissing.length) {
        setTask(project, taskId, { status: 'done', finished_at: now() });
        return ctx;
      }
      lastError = `Agent finished without calling: ${stillMissing.join(', ')}`;
      project.log('warn', `${lastError} (attempt ${attempt})`, stage, taskId);
    } catch (err) {
      lastError = (err as Error).message;
      project.log('error', `Task failed (attempt ${attempt}): ${lastError}`, stage, taskId);
      if (opts.signal?.aborted) break;
      if (/not logged in|invalid api key|authentication|401/i.test(lastError)) {
        lastError = 'Claude is not authenticated. Set ANTHROPIC_API_KEY or log in once with the `claude` CLI, then retry.';
        project.log('error', lastError, stage, taskId);
        break;
      }
    }
  }
  setTask(project, taskId, { status: 'failed', error: lastError, finished_at: now() });
  throw new Error(`Task ${taskId} failed: ${lastError}`);
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i]) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}
