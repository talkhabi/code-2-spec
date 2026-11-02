import { STAGES, type Project } from './project.js';
import { itemCounts, listPhases } from './specs/store.js';
import { getProfile } from './stages/detect.js';
import { listTasks } from './ai/runner.js';
import { json } from './db/db.js';

/**
 * Rough AI cost of a full run at API prices with the default model, calibrated on real runs
 * (~$1.2 per 1,000 lines analysed, plus ~25% for partition, gap fill and synthesis). UI-heavy code varies ±30%.
 */
export function estimateCost(project: Project) {
  const loc = (project.db.prepare("SELECT COALESCE(SUM(loc), 0) AS n FROM files WHERE kind NOT IN ('test', 'config')").get() as { n: number }).n;
  const base = (loc / 1000) * 1.2 * 1.25 + 3;
  return { linesOfCode: loc, usdLow: Math.round(base * 0.7), usdHigh: Math.round(base * 1.3), note: 'API-price estimate for a full run with the default model; with a Claude Pro/Max login this is usage, not a bill' };
}

export function projectSummary(project: Project) {
  const stages = STAGES.map((s) => ({ stage: s, ...project.stageStatus(s) }));
  const tasks = listTasks(project);
  const phases = listPhases(project);
  const counts = itemCounts(project);
  const total = (t: string) => Object.values(counts[t] ?? {}).reduce((a, b) => a + b, 0);
  const pendingReview = Object.values(counts).reduce((a, c) => a + (c.pending ?? 0), 0);
  const current = stages.find((s) => s.status === 'running') ?? stages.find((s) => s.status === 'awaiting_review') ?? stages.find((s) => s.status === 'failed') ?? [...stages].reverse().find((s) => s.status === 'done');
  return {
    id: project.config.id,
    name: project.config.name,
    root: project.root,
    profile: getProfile(project),
    stages,
    currentStage: current?.stage,
    currentStatus: current?.status,
    phases: { total: phases.length, approved: phases.filter((p) => p.status === 'approved').length, analysed: phases.filter((p) => p.analysis_status === 'done').length },
    items: {
      features: total('feature'), journeys: total('journey'), rules: total('rule'), flows: total('flow'), entities: total('entity'),
      apis: total('api'), systemJourneys: total('system_journey'), pendingReview,
    },
    coverage: json<{ percent: number } | null>(project.meta('coverage'), null)?.percent ?? null,
    cost: {
      usd: Math.round(tasks.reduce((a, t) => a + t.cost_usd, 0) * 1000) / 1000,
      inputTokens: tasks.reduce((a, t) => a + t.input_tokens, 0),
      outputTokens: tasks.reduce((a, t) => a + t.output_tokens, 0),
    },
    estimate: estimateCost(project),
    tasks: { total: tasks.length, running: tasks.filter((t) => t.status === 'running').length, failed: tasks.filter((t) => t.status === 'failed').length },
  };
}
