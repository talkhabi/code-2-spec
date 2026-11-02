import type { Project } from '../project.js';
import { computeClusters, saveClusters } from '../graph/partition.js';
import { computeCoverage } from '../graph/coverage.js';
import { analyzePrompt, gapfillPrompt, partitionPrompt, synthesizePrompt } from '../ai/prompts.js';
import { ensureTask, executeTask, mapLimit, setTask, type AgentRunner } from '../ai/runner.js';
import { clearPhaseItems, deleteItemTree, listItems, listPhases, phaseOfFile, setPhaseAnalysis, setPhaseStatus } from '../specs/store.js';
import { renderAll } from '../render/render.js';

export interface StageOptions {
  runner: AgentRunner;
  force?: boolean;
  autoApprove?: boolean;
  phases?: string[];
  signal?: AbortSignal;
}

export async function runPartition(project: Project, opts: StageOptions) {
  project.setStage('partition', 'running');
  const clusters = computeClusters(project);
  saveClusters(project, clusters);
  project.log('info', `Computed ${clusters.length} clusters from the code graph`, 'partition');
  const taskId = 'partition';
  ensureTask(project, taskId, 'partition');
  if (opts.force) setTask(project, taskId, { status: 'pending' });
  try {
    await executeTask(project, opts.runner, taskId, 'partition', partitionPrompt(project), { signal: opts.signal });
  } catch (err) {
    project.setStage('partition', 'failed', {}, (err as Error).message);
    throw err;
  }
  const phases = listPhases(project);
  if (opts.autoApprove) phases.forEach((p) => setPhaseStatus(project, p.id, 'approved'));
  project.log('info', `Proposed ${phases.length} phases: ${phases.map((p) => p.name).join(', ')}`, 'partition');
  project.setStage('partition', opts.autoApprove ? 'done' : 'awaiting_review', { clusters: clusters.length, phases: phases.length });
  renderAll(project);
}

export async function runAnalyze(project: Project, opts: StageOptions) {
  const all = listPhases(project);
  if (!all.length) throw new Error('No phases yet. Run the partition stage first.');
  if (opts.autoApprove) all.filter((p) => p.status === 'pending').forEach((p) => setPhaseStatus(project, p.id, 'approved'));
  const selected = listPhases(project).filter((p) =>
    p.status === 'approved' && (opts.phases?.length ? opts.phases.some((s) => s === p.id || s === p.slug) : opts.force || p.analysis_status !== 'done'));
  const pending = listPhases(project).filter((p) => p.status === 'pending').length;
  if (!selected.length) {
    project.log('warn', pending ? `${pending} phases await review. Approve phases in the dashboard or pass --yes.` : 'Nothing to analyse.', 'analyze');
    return;
  }
  project.setStage('analyze', 'running', { total: selected.length });
  if (project.stageStatus('partition').status === 'awaiting_review' && !pending) project.setStage('partition', 'done');
  const results = await mapLimit(selected, project.config.concurrency, async (phase) => {
    const taskId = `analyze:${phase.id}`;
    ensureTask(project, taskId, 'analyze', phase.id);
    clearPhaseItems(project, phase.id);
    setPhaseAnalysis(project, phase.id, 'running');
    project.log('info', `Analysing phase "${phase.name}" (${phase.files.length} files)`, 'analyze', taskId);
    try {
      await executeTask(project, opts.runner, taskId, 'analyze', analyzePrompt(project, phase.id), { phaseId: phase.id, signal: opts.signal });
      setPhaseAnalysis(project, phase.id, 'done');
      renderAll(project);
    } catch (err) {
      setPhaseAnalysis(project, phase.id, 'failed');
      throw err;
    }
  });
  const failed = results.filter((r) => r.status === 'rejected').length;
  const remainingReview = listPhases(project).some((p) => p.status === 'pending');
  project.setStage('analyze', failed ? 'failed' : remainingReview ? 'awaiting_review' : 'done', { done: selected.length - failed, failed },
    failed ? `${failed} phase(s) failed` : undefined);
  renderAll(project);
}

export async function runGapfill(project: Project, opts: StageOptions & { threshold?: number }) {
  project.setStage('gapfill', 'running');
  const before = computeCoverage(project);
  project.log('info', `Coverage before gap fill: ${before.percent}% (${before.covered}/${before.total} units)`, 'gapfill');
  const phaseMap = phaseOfFile(project);
  const groups = new Map<string, typeof before.uncovered>();
  for (const u of before.uncovered) {
    const key = phaseMap.get(u.file) ?? 'unassigned';
    groups.set(key, [...(groups.get(key) ?? []), u]);
  }
  const doneAnalysis = new Set(listPhases(project).filter((p) => p.analysis_status === 'done').map((p) => p.id));
  const targets = [...groups.entries()].filter(([k]) => k === 'unassigned' || doneAnalysis.has(k));
  const results = await mapLimit(targets, project.config.concurrency, async ([key, units]) => {
    const taskId = `gapfill:${key}`;
    ensureTask(project, taskId, 'gapfill', key);
    if (opts.force) setTask(project, taskId, { status: 'pending' });
    const phaseId = key === 'unassigned' ? undefined : key;
    await executeTask(project, opts.runner, taskId, 'gapfill', gapfillPrompt(project, phaseId, units), { phaseId, signal: opts.signal });
  });
  const after = computeCoverage(project);
  project.setMeta('coverage', JSON.stringify({ percent: after.percent, total: after.total, covered: after.covered }));
  project.log('info', `Coverage after gap fill: ${after.percent}%`, 'gapfill');
  const failed = results.filter((r) => r.status === 'rejected').length;
  project.setStage('gapfill', failed ? 'failed' : 'done', { before: before.percent, after: after.percent });
  renderAll(project);
}

export async function runSynthesize(project: Project, opts: StageOptions) {
  project.setStage('synthesize', 'running');
  // replace previous AI synthesis output (system-level items + relations)
  for (const i of listItems(project, { phaseId: null })) if (i.origin === 'ai' && i.status === 'pending') deleteItemTree(project, i.id);
  project.db.exec("DELETE FROM relations WHERE status = 'pending'");
  const taskId = 'synthesize';
  ensureTask(project, taskId, 'synthesize');
  setTask(project, taskId, { status: 'pending' });
  try {
    await executeTask(project, opts.runner, taskId, 'synthesize', synthesizePrompt(project), { signal: opts.signal });
  } catch (err) {
    project.setStage('synthesize', 'failed', {}, (err as Error).message);
    throw err;
  }
  const relations = (project.db.prepare('SELECT COUNT(*) AS n FROM relations').get() as any).n;
  project.setStage('synthesize', 'done', { relations });
  renderAll(project);
}
