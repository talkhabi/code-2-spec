import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project } from '../src/project.js';
import { runAll, runStage, scan } from '../src/pipeline.js';
import { listItems, listPhases, getEvidence } from '../src/specs/store.js';
import { loadClusters } from '../src/graph/partition.js';
import { computeCoverage } from '../src/graph/coverage.js';
import { listTasks } from '../src/ai/runner.js';
import { MockRunner } from './mock-runner.js';

const FIXTURE = join(__dirname, '../../../fixtures/legacy-vue-app');
let dir: string;
let project: Project;

const journey = (title: string, variant: string, file: string, start: number, end: number) => ({
  title, variant, actor: 'Guest', goal: title, preconditions: [], steps: [{ actor: 'user', action: `does ${title}` }],
  outcomes: ['ok'], confidence: 0.9, evidence: [{ file, startLine: start, endLine: end }],
  scenarios: [{ name: title, given: ['a guest'], when: ['they act'], then: ['it works'] }],
  playwright: `await page.goto('/login');\nawait expect(page.getByRole('heading')).toBeVisible();`,
});

const runner = new MockRunner({
  partition: async (call) => {
    const clusters = JSON.parse(JSON.stringify(await call('project_overview', {})));
    expect(clusters.name).toBeTruthy();
    const ids = loadClusters(project).map((c) => c.id);
    // first attempt with a missing cluster must be rejected by validation
    const bad = await call('submit_phases', { phases: [{ name: 'Only one', description: 'x', clusters: [ids[0]] }] });
    expect(bad.ok).toBe(false);
    await call('submit_phases', { phases: ids.map((id) => ({ name: `Phase ${id}`, description: `cluster ${id}`, clusters: [id], entryPoints: [] })) });
  },
  analyze: async (call, ctx) => {
    const files: { path: string }[] = await call('list_files', { phase: ctx.phaseId });
    const page = files.find((f) => f.path.endsWith('.vue')) ?? files[0];
    await call('submit_feature', {
      feature: {
        title: `Feature of ${page.path.split('/').pop()}`, summary: 's', actors: ['Guest'], evidence: [{ file: page.path }],
        journeys: [journey('Sign in with email', 'happy', page.path, 1, 5), journey('Wrong password', 'error', page.path, 6, 9)],
        rules: [{ title: 'Rule', rule: 'Passwords need 8 chars', evidence: [{ file: page.path, startLine: 1 }] }],
        flows: [{ title: 'Flow', description: 'd', steps: [{ layer: 'ui', description: 'click' }, { layer: 'api-client', description: 'POST' }], evidence: [] }],
      },
    });
    const bad = await call('submit_feature', { feature: { title: 'x', summary: 's', evidence: [{ file: 'nope.ts' }], journeys: [journey('j', 'happy', 'nope.ts', 1, 2)] } });
    expect(bad.ok).toBe(false);
    await call('submit_domain', { entities: [{ name: 'User', description: 'account', fields: [{ name: 'email', type: 'string' }], evidence: [{ file: page.path }] }], apis: [] });
    await call('complete_task', { summary: 'done' });
  },
  gapfill: async (call, ctx, task) => {
    const units = [...task.prompt.matchAll(/^- \[(\w+)\] ([^\s:]+)/gm)].map((m) => m[2]);
    const files = [...new Set(units)];
    if (files.length) await call('submit_tech_notes', { notes: [{ title: 'Plumbing', note: 'n', evidence: files.map((file) => ({ file })) }] });
    await call('complete_task', { summary: 'gaps filled' });
  },
  synthesize: async (call) => {
    const journeys: any[] = await call('list_spec_items', { type: 'journey' });
    await call('submit_synthesis', {
      relations: [{ from: journeys[0].id, to: journeys[2].id, kind: 'continues_journey', note: 'n' }],
      systemJourneys: [{ title: 'E2E', summary: 's', actor: 'Guest', steps: [{ journeyId: journeys[0].id }, { journeyId: journeys[2].id }] }],
      glossary: [{ term: 'Cart', definition: 'basket' }],
      domainModel: [{ name: 'User', description: 'merged', fields: [], sources: [] }],
    });
    await call('complete_task', { summary: 'ok' });
  },
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'c2s-'));
  process.env.CODE2SPEC_HOME = join(dir, 'home');
  cpSync(FIXTURE, join(dir, 'app'), { recursive: true });
  project = Project.init(join(dir, 'app'));
  await scan(project);
});

afterAll(() => {
  project?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('pipeline (mock AI)', () => {
  it('stops at the phase review gate', async () => {
    const result = await runAll(project, { runner });
    expect(result).toBe('awaiting_review');
    expect(project.stageStatus('partition').status).toBe('awaiting_review');
    const phases = listPhases(project);
    expect(phases.length).toBe(loadClusters(project).length);
    expect(phases.every((p) => p.status === 'pending')).toBe(true);
    expect(new Set(phases.flatMap((p) => p.files)).size).toBe(phases.reduce((a, p) => a + p.files.length, 0));
  });

  it('runs the remaining stages after approval', async () => {
    const result = await runAll(project, { runner, autoApprove: true });
    expect(result).toBe('done');
    const phases = listPhases(project);
    expect(phases.every((p) => p.analysis_status === 'done')).toBe(true);
    const journeys = listItems(project, { type: 'journey' });
    expect(journeys.length).toBe(phases.length * 2);
    expect(getEvidence(project, journeys[0].id)[0].startLine).toBe(1);
    expect(computeCoverage(project).byKind.file.covered).toBe(computeCoverage(project).byKind.file.total);
    expect(listItems(project, { type: 'system_journey' })).toHaveLength(1);
    expect(listTasks(project).every((t) => t.status === 'done')).toBe(true);
  });

  it('renders specs and the rebuild pack', () => {
    const out = project.path('export');
    for (const f of ['AGENTS.md', 'CLAUDE.md', 'README.md', 'TRACEABILITY.md', 'playwright.config.ts', 'spec/README.md', 'spec/system/journey-map.md']) {
      expect(existsSync(join(out, f)), f).toBe(true);
    }
    const features = readdirSync(join(out, 'features'));
    expect(features.length).toBe(listPhases(project).length);
    const gherkin = readFileSync(join(out, 'features', features[0]), 'utf8');
    expect(gherkin).toMatch(/Feature: .*\n/);
    expect(gherkin).toContain('@happy');
    expect(gherkin).toContain('    Given a guest');
    const spec = readFileSync(join(out, 'e2e', readdirSync(join(out, 'e2e'))[0]), 'utf8');
    expect(spec).toContain("await page.goto('/login');");
  });

  it('is resumable: re-running analysis without --force does nothing', async () => {
    const before = runner.calls.length;
    await runStage(project, 'analyze', { runner });
    expect(runner.calls.length).toBe(before);
  });

  it('refuses to read secret files and searches i18n json', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    writeFileSync(join(dir, 'app', '.env'), 'API_KEY=supersecret');
    mkdirSync(join(dir, 'app', 'src', 'locales'), { recursive: true });
    writeFileSync(join(dir, 'app', 'src', 'locales', 'en.json'), '{ "login": { "failed": "Invalid email or password" } }');
    const { graphTools, invokeTool } = await import('../src/ai/tools.js');
    const ctx = { project, taskId: 't', stage: 'test', submitted: new Map() };
    const read = graphTools.find((t) => t.name === 'read_file')!;
    const search = graphTools.find((t) => t.name === 'search_code')!;
    expect(await invokeTool(read, { path: '.env' }, ctx)).toContain('cannot be read');
    expect(await invokeTool(read, { path: './src/../.env' }, ctx)).toContain('cannot be read');
    expect(await invokeTool(search, { pattern: 'supersecret' }, ctx)).toBe('No matches');
    expect(await invokeTool(search, { pattern: 'Invalid email', i18nOnly: true }, ctx)).toContain('src/locales/en.json:1');
  });

  it('registers a project scanned under another data home when it is opened', async () => {
    const before = process.env.CODE2SPEC_HOME;
    process.env.CODE2SPEC_HOME = join(dir, 'other-home');
    try {
      const { listRegistry } = await import('../src/project.js');
      expect(listRegistry()).toHaveLength(0);
      const opened = Project.open(join(dir, 'app'));
      expect(listRegistry().map((e) => e.id)).toEqual([project.config.id]);
      expect(Project.openById(project.config.id).root).toBe(project.root);
      opened.close();
      expect(() => Project.openById('nope')).toThrow(/Unknown project/);
    } finally {
      process.env.CODE2SPEC_HOME = before;
    }
  });

  it('retries and fails a task when the agent never submits', async () => {
    const lazy = new MockRunner({ analyze: async () => {} });
    const phase = listPhases(project)[0];
    await runStage(project, 'analyze', { runner: lazy, phases: [phase.slug] });
    expect(listTasks(project, 'analyze').find((t) => t.target === phase.id)).toMatchObject({ status: 'failed', attempts: 3 });
    expect(project.stageStatus('analyze').status).toBe('failed');
  });
});
