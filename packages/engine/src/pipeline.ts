import type { Project, Stage } from './project.js';
import { runDetect } from './stages/detect.js';
import { runIndex } from './stages/index-code.js';
import { runAnalyze, runGapfill, runPartition, runSynthesize } from './stages/ai-stages.js';
import { runExport, runVerify } from './stages/export.js';
import { ClaudeAgentSdkRunner } from './ai/sdk-runner.js';
import type { AgentRunner } from './ai/runner.js';
import { renderAll } from './render/render.js';

export interface PipelineOptions {
  runner?: AgentRunner;
  force?: boolean;
  /** Skip human review gates (approve phases automatically). */
  autoApprove?: boolean;
  phases?: string[];
  baseUrl?: string;
  signal?: AbortSignal;
}

export async function runStage(project: Project, stage: Stage, opts: PipelineOptions = {}) {
  const runner = opts.runner ?? new ClaudeAgentSdkRunner({ model: project.config.model });
  const common = { runner, force: opts.force, autoApprove: opts.autoApprove, phases: opts.phases, signal: opts.signal };
  try {
    switch (stage) {
      case 'detect': return await runDetect(project);
      case 'index': return await runIndex(project);
      case 'partition': return await runPartition(project, common);
      case 'analyze': return await runAnalyze(project, common);
      case 'gapfill': return await runGapfill(project, common);
      case 'synthesize': return await runSynthesize(project, common);
      case 'verify':
        if (!opts.baseUrl) throw new Error('verify needs --base-url of a running app');
        return await runVerify(project, { baseUrl: opts.baseUrl });
      case 'export': return runExport(project);
    }
  } catch (err) {
    if (project.stageStatus(stage).status === 'running') project.setStage(stage, 'failed', {}, (err as Error).message);
    throw err;
  }
}

/** `scan` = deterministic stages; cheap, no AI. */
export async function scan(project: Project) {
  await runDetect(project);
  const stats = await runIndex(project);
  renderAll(project);
  return stats;
}

/**
 * Run the whole pipeline. Stops at review gates (phase approval) unless autoApprove is set:
 * re-running continues from where it stopped because every stage is idempotent.
 */
export async function runAll(project: Project, opts: PipelineOptions = {}) {
  await scan(project);
  if (!['done', 'awaiting_review'].includes(project.stageStatus('partition').status) || opts.force) await runStage(project, 'partition', opts);
  if (project.stageStatus('partition').status === 'awaiting_review' && !opts.autoApprove) {
    project.log('info', 'Waiting for human review of phases. Approve them in the dashboard (or `code2spec phases approve --all`) and run again.', 'partition');
    return 'awaiting_review' as const;
  }
  await runStage(project, 'analyze', opts);
  await runStage(project, 'gapfill', opts);
  await runStage(project, 'synthesize', opts);
  await runStage(project, 'export', opts);
  return 'done' as const;
}
