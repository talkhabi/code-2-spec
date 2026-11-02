import { Command } from 'commander';
import pc from 'picocolors';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { code2specHome, findProjectRoot, listRegistry, Project, type Stage } from './project.js';
import { runAll, runStage, scan } from './pipeline.js';
import { projectSummary } from './summary.js';
import fg from 'fast-glob';
import { listPhases, mergePhases, setPhaseStatus, getPhase, upsertPhase } from './specs/store.js';
import { startServer } from './server/server.js';
import { computeCoverage } from './graph/coverage.js';

const program = new Command();
program.name('code2spec').description('Turn a legacy codebase into specs, user journeys, Gherkin scenarios and Playwright tests for an AI rebuild.').version('0.2.0');

function open(path?: string) {
  const root = findProjectRoot(path ?? process.cwd());
  if (!root) {
    console.error(pc.red(`No code2spec project here. Run ${pc.bold('code2spec init <path>')} first.`));
    process.exit(1);
  }
  const project = Project.open(root);
  project.on((e) => {
    if (e.type === 'log' && (e.level !== 'debug' || process.env.CODE2SPEC_DEBUG)) {
      const color = e.level === 'error' ? pc.red : e.level === 'warn' ? pc.yellow : e.level === 'debug' ? pc.dim : pc.reset;
      console.log(`${pc.dim(`[${e.stage ?? '-'}]`)} ${color(e.message)}`);
    } else if (e.type === 'stage') console.log(pc.cyan(`▸ ${e.stage}: ${e.status}`));
  });
  return project;
}

function printStatus(project: Project) {
  const s = projectSummary(project);
  console.log(pc.bold(`\n${s.name}`), pc.dim(s.root));
  if (s.profile) console.log(`Stack: ${s.profile.frameworks.join(', ') || 'JS/TS'} · ${Object.entries(s.profile.languages).map(([k, v]) => `${v} .${k}`).join(', ')}`);
  for (const st of s.stages) {
    const icon = st.status === 'done' ? pc.green('✔') : st.status === 'running' ? pc.cyan('●') : st.status === 'failed' ? pc.red('✖') : st.status === 'awaiting_review' ? pc.yellow('◆') : pc.dim('○');
    console.log(` ${icon} ${st.stage.padEnd(11)} ${pc.dim(st.status)}${st.error ? pc.red(` ${st.error}`) : ''}`);
  }
  console.log(`Phases: ${s.phases.total} (${s.phases.approved} approved, ${s.phases.analysed} analysed)`);
  console.log(`Features: ${s.items.features} · Journeys: ${s.items.journeys} · Rules: ${s.items.rules} · Entities: ${s.items.entities} · APIs: ${s.items.apis} · Pending review: ${s.items.pendingReview}`);
  if (s.coverage != null) console.log(`Coverage: ${s.coverage}%`);
  console.log(`AI cost so far: $${s.cost.usd} (${s.cost.inputTokens} in / ${s.cost.outputTokens} out tokens)`);
  if (s.estimate.linesOfCode) console.log(pc.dim(`Full-run estimate: ~$${s.estimate.usdLow}–${s.estimate.usdHigh} at API prices for ${s.estimate.linesOfCode.toLocaleString('en-US')} lines (Claude Pro/Max: uses plan quota instead)`));
  console.log('');
}

const withAi = (cmd: Command) => cmd
  .option('-p, --path <path>', 'project path (default: cwd)')
  .option('-f, --force', 're-run even if already done')
  .option('-y, --yes', 'auto-approve review gates')
  .option('-m, --model <model>', 'Claude model to use');

const applyModel = (project: Project, model?: string) => {
  if (model) project.config.model = model;
};

program.command('init [path]').description('Register a project and run the deterministic scan (detect + index)')
  .option('-n, --name <name>', 'project name')
  .option('-x, --exclude <globs...>', 'extra glob patterns to exclude')
  .option('-c, --concurrency <n>', 'parallel AI agents', (v) => Number(v))
  .action(async (path = '.', o) => {
    const project = Project.init(path, { name: o.name, exclude: o.exclude, concurrency: o.concurrency });
    console.log(pc.green(`Initialised ${project.config.name} → ${project.dir}`));
    project.close();
    const p = open(path);
    await scan(p);
    printStatus(p);
    const gitignore = join(p.root, '.gitignore');
    if (existsSync(join(p.root, '.git')) && !(existsSync(gitignore) && /^\/?\.code2spec\/?$/m.test(readFileSync(gitignore, 'utf8')))) {
      console.log(pc.yellow(`Tip: add ".code2spec/" to ${gitignore} unless you want the generated specs in git.`));
    }
  });

program.command('doctor').description('Check that this machine can run code2spec').action(async () => {
  const ok = (m: string) => console.log(`${pc.green('✔')} ${m}`);
  const bad = (m: string) => { console.log(`${pc.red('✖')} ${m}`); process.exitCode = 1; };
  const warn = (m: string) => console.log(`${pc.yellow('!')} ${m}`);
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > 22 || (major === 22 && minor >= 5)) ok(`Node ${process.versions.node}`);
  else bad(`Node ${process.versions.node} is too old — code2spec needs Node 22.5+ (24 LTS recommended)`);
  try {
    await import('node:sqlite');
    ok('node:sqlite available');
  } catch {
    bad('node:sqlite is missing — upgrade Node');
  }
  const here = dirname(fileURLToPath(import.meta.url));
  if ([join(here, 'dashboard/index.html'), join(here, '../../dashboard/dist/index.html')].some((f) => existsSync(f))) ok('Dashboard build found');
  else warn('Dashboard build not found — run `pnpm build` in the code2spec repo (API still works)');
  const claude = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (claude.status === 0) ok(`Claude Code CLI ${claude.stdout.trim()}`);
  else warn('Claude Code CLI not found — needed for "Claude Code mode" and the easiest way to log in (npm i -g @anthropic-ai/claude-code)');
  if (process.env.ANTHROPIC_API_KEY) ok('ANTHROPIC_API_KEY is set (AI stages bill the API key)');
  else warn('ANTHROPIC_API_KEY not set — AI stages will use your Claude Code login (run `claude`, then /login and /status to check)');
  ok(`Data home: ${code2specHome()} (${listRegistry().length} registered projects)`);
});

program.command('scan').description('Re-run detection and indexing (no AI)').option('-p, --path <path>').action(async (o) => {
  const p = open(o.path);
  await scan(p);
  printStatus(p);
});

for (const [name, stage, desc] of [
  ['partition', 'partition', 'AI: split the project into phases (bounded contexts)'],
  ['analyze', 'analyze', 'AI: document features, journeys, flows, rules and tests for each approved phase'],
  ['gapfill', 'gapfill', 'AI: find code not covered by any spec item and document it'],
  ['synthesize', 'synthesize', 'AI: cross-phase relations, system journeys, glossary, domain model'],
] as const) {
  const cmd = withAi(program.command(name).description(desc));
  if (stage === 'analyze') cmd.option('--phase <ids...>', 'only these phases (id or slug)');
  cmd.action(async (o) => {
    const p = open(o.path);
    applyModel(p, o.model);
    await runStage(p, stage as Stage, { force: o.force, autoApprove: o.yes, phases: o.phase });
    printStatus(p);
  });
}

withAi(program.command('run').description('Run the full pipeline; stops at review gates unless --yes')).action(async (o) => {
  const p = open(o.path);
  applyModel(p, o.model);
  const result = await runAll(p, { force: o.force, autoApprove: o.yes });
  printStatus(p);
  if (result === 'awaiting_review') console.log(pc.yellow('Phases await review: open the dashboard (code2spec serve) or run `code2spec phases approve --all`, then `code2spec run` again.'));
});

program.command('verify').description('Run the generated Playwright suite against a running app')
  .requiredOption('-u, --base-url <url>', 'URL of the running app (legacy or rebuild)')
  .option('-p, --path <path>')
  .action(async (o) => {
    const p = open(o.path);
    const r = (await runStage(p, 'verify', { baseUrl: o.baseUrl })) as { passed: number; failed: number };
    console.log(`Passed ${r.passed}, failed ${r.failed}`);
  });

program.command('export').description('Write the rebuild pack (.code2spec/export)').option('-p, --path <path>').action(async (o) => {
  const p = open(o.path);
  const out = await runStage(p, 'export');
  console.log(pc.green(`Rebuild pack: ${out}`));
});

program.command('status').description('Show pipeline status').option('-p, --path <path>').action((o) => printStatus(open(o.path)));

program.command('coverage').description('Show spec coverage of the code').option('-p, --path <path>').option('--uncovered', 'list uncovered units').action((o) => {
  const c = computeCoverage(open(o.path));
  console.log(`Coverage ${c.percent}% (${c.covered}/${c.total})`);
  for (const [k, v] of Object.entries(c.byKind)) console.log(`  ${k.padEnd(10)} ${v.covered}/${v.total}`);
  if (o.uncovered) c.uncovered.forEach((u) => console.log(pc.dim(`  [${u.kind}] ${u.file}${u.line ? `:${u.line}` : ''} ${u.kind === 'file' ? '' : u.name}`)));
});

const phases = program.command('phases').description('Review phases');
phases.command('list').option('-p, --path <path>').action((o) => {
  for (const ph of listPhases(open(o.path))) console.log(`${ph.status.padEnd(9)} ${ph.analysis_status.padEnd(8)} ${pc.bold(ph.name)} ${pc.dim(`${ph.slug} · ${ph.files.length} files`)}`);
});
phases.command('approve [ids...]').option('--all').option('-p, --path <path>').action((ids: string[], o) => {
  const p = open(o.path);
  const targets = o.all ? listPhases(p).filter((x) => x.status === 'pending') : ids.map((id) => getPhase(p, id)).filter((x) => !!x);
  targets.forEach((ph) => setPhaseStatus(p, ph!.id, 'approved'));
  if (!listPhases(p).some((x) => x.status === 'pending') && p.stageStatus('partition').status === 'awaiting_review') p.setStage('partition', 'done');
  console.log(`Approved ${targets.length} phase(s)`);
});
phases.command('add <name>').description('Create an approved phase by hand from file globs (e.g. to pilot one module)')
  .requiredOption('-g, --files <globs...>', 'globs relative to the project root, e.g. "src/modules/Auth/**"')
  .option('-d, --description <text>').option('-p, --path <path>')
  .action(async (name: string, o) => {
    const p = open(o.path);
    const indexed = new Set((p.db.prepare('SELECT path FROM files').all() as { path: string }[]).map((r) => r.path));
    const files = (await fg(o.files, { cwd: p.root, ignore: p.config.exclude })).filter((f) => indexed.has(f)).sort();
    if (!files.length) throw new Error('No indexed files match those globs');
    const id = upsertPhase(p, { name, description: o.description ?? `Manually defined: ${o.files.join(', ')}`, files, entry_points: [], order_idx: listPhases(p).length, status: 'approved' });
    console.log(`Created phase ${pc.bold(name)} (${getPhase(p, id)!.slug}) with ${files.length} files`);
  });
phases.command('reject <ids...>').option('-p, --path <path>').action((ids: string[], o) => {
  const p = open(o.path);
  ids.forEach((id) => { const ph = getPhase(p, id); if (ph) setPhaseStatus(p, ph.id, 'rejected'); });
});
phases.command('merge <ids...>').option('-n, --name <name>').option('-p, --path <path>').action((ids: string[], o) => {
  const p = open(o.path);
  console.log(`Merged into ${mergePhases(p, ids.map((id) => getPhase(p, id)?.id ?? id), o.name)}`);
});

program.command('list').description('List registered projects').action(() => {
  for (const e of listRegistry()) console.log(`${pc.bold(e.name)} ${pc.dim(e.root)}`);
});

program.command('serve').description('Start the dashboard + API').option('--port <port>', 'port', (v) => Number(v), 4600).option('--host <host>', 'host', '127.0.0.1')
  .action(async (o) => {
    const { url, dashboard } = await startServer({ port: o.port, host: o.host });
    console.log(pc.green(`code2spec dashboard: ${url}`) + (dashboard ? '' : pc.yellow(' (API only — dashboard not built)')));
  });

program.parseAsync().catch((err) => {
  console.error(pc.red(err.message));
  process.exit(1);
});
