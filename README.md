# code2spec

Turn a large legacy codebase into an **implementation-neutral specification** — phases, features, user journeys
(happy / alternate / error / edge), business rules, technical flows, Gherkin scenarios and Playwright tests — so an AI
agent can rebuild the product from scratch, in a modern stack or a different language.

AI does the work **stage by stage**; a human reviews between stages and decides what to keep.

```
legacy code ──► detect ─► index ─► partition ─► [review] ─► analyze ─► gap fill ─► synthesize ─► [review] ─► export
                (no AI)  (code graph)   (AI)       phases      (AI, per phase)  (AI)      (AI, cross-phase)        rebuild pack
```

## Why it works

Letting an LLM read the whole repo doesn't scale and silently misses things. code2spec does it in three layers:

1. **Deterministic code graph first** — every file is parsed (ts-morph, Vue SFC compiler) into SQLite: symbols, imports,
   client routes, server endpoints, HTTP calls, stores, template handlers. No AI, cheap and complete.
2. **AI on top of the graph** — the graph is split into phases (Louvain community detection + AI naming/regrouping).
   One agent per phase explores through graph tools (`file_outline`, `list_routes`, `read_file`, …) and submits structured,
   zod-validated results. Context stays small; phases run in parallel.
3. **Coverage-checked** — every spec item carries evidence (file + line range). Coverage = share of code units
   (files, functions, handlers, routes, HTTP calls, stores) referenced by evidence. The gap-fill stage hands uncovered
   code back to the AI, so behaviour does not get lost.

## Output

```
<project>/.code2spec/
  index.db                      SQLite: code graph, spec items, evidence, reviews, tasks, logs
  specs/                        live Markdown view, re-rendered after every change
    README.md
    phases/<phase>/README.md    entities, API contracts, tech notes
    phases/<phase>/<feature>.md journeys, rules, flows (Mermaid), screens, evidence
    phases/<phase>/<feature>.feature
    phases/<phase>/e2e/<feature>.spec.ts
    system/                     journey map + relations, domain model, glossary, coverage
  export/                       rebuild pack (code2spec export)
    AGENTS.md, CLAUDE.md        instructions for the rebuilding agent
    spec/, features/*.feature, e2e/*.spec.ts, playwright.config.ts
    TRACEABILITY.md             legacy evidence → journey → scenarios
```

Example: an "Authentication" feature typically ends up with journeys such as *sign in with email*, *wrong credentials*,
*two-step verification*, *sign in with Google*, *sign out* and *session expiry* — each with steps, outcomes, exact error
messages, Gherkin scenarios and code evidence.

## Quick start

**New machine? Follow the full guide: [docs/SETUP.md](docs/SETUP.md)** (Node, pnpm, Claude login, first scan,
pilot, full run, review, export, troubleshooting).

Short version (Node 22.5+, pnpm 10+, logged in with `claude` or `ANTHROPIC_API_KEY` set):

```bash
git clone <REPO_URL> code2spec && cd code2spec
```

```bash
pnpm run bootstrap
```

```bash
code2spec doctor
```

```bash
code2spec init /path/to/legacy-app
```

```bash
code2spec serve
```

## Use it from the CLI + dashboard

```bash
code2spec init /path/to/legacy-app
```

```bash
code2spec serve
```

Open http://127.0.0.1:4600 and press **Run pipeline**, or drive it from the terminal:

```bash
code2spec run -p /path/to/legacy-app
```

The run stops after partitioning so you can review the phases (dashboard **Phases** page, or
`code2spec phases list` / `code2spec phases approve --all`). Run `code2spec run` again to continue.
Every stage is resumable; `--force` redoes a stage (human-approved or edited items are kept), `--yes` skips review gates.

| Command | What it does |
|---|---|
| `code2spec init [path]` | register project, detect stack, build code graph |
| `code2spec scan` | re-run detection + indexing |
| `code2spec doctor` | check Node, sqlite, dashboard build, Claude CLI / login |
| `code2spec partition` | AI proposes phases |
| `code2spec phases list / approve / reject / merge` | review phases from the terminal |
| `code2spec phases add <name> -g <globs>` | define a phase by hand, e.g. to pilot one module |
| `code2spec analyze [--phase <slug>]` | AI documents approved phases (parallel, `concurrency` in config) |
| `code2spec gapfill` | AI documents uncovered code |
| `code2spec synthesize` | AI links journeys across phases, builds domain model + glossary |
| `code2spec verify -u <url>` | run generated Playwright tests against a running app |
| `code2spec export` | write the rebuild pack |
| `code2spec status` / `coverage --uncovered` | progress, cost, coverage |

Options: `-m, --model <id>` picks the Claude model; per-project settings live in `.code2spec/config.json`
(`include`, `exclude`, `concurrency`, `model`).

### Dashboard

- **Projects** — every scanned project, stage progress, coverage, cost, items awaiting review
- **Overview** — pipeline stepper with run / resume / redo per stage, live activity log (optionally agent tool calls), detected stack
- **Phases** — approve, reject, rename, merge, split (by file), analyse a single phase
- **Features & journeys** — tree phase → feature → journeys with variant badges; details, Gherkin, Playwright, evidence with
  highlighted legacy code, JSON edit, review history; approve/reject (cascading for features)
- **Relations** — cross-phase graph, conflicts & duplicates, system journeys
- **Coverage** — by kind and phase, least-covered files, uncovered units, run gap fill
- **Export** — build the rebuild pack

## Use it inside Claude Code (no API key needed)

Claude Code itself becomes the analysing agent through the MCP server; results land in the same database and dashboard.

```bash
claude plugin marketplace add /path/to/code2spec
```

```bash
claude plugin install code2spec@code2spec
```

Then ask Claude Code, e.g. *"Use code2spec to turn /path/to/legacy-app into a spec"*. The `code2spec` skill walks the
pipeline (`init_project` → `next_task` → submit tools → `complete_task`), stops for your phase review and fans phase
analysis out to subagents. The `code2spec-review` skill helps you go through pending items.

## Status

**Version 0.1 — working end to end, early stage.**

What works:
- Full pipeline (detect → index → partition → review → analyze → gap fill → synthesize → export → verify), resumable,
  with human review gates and a dashboard.
- Two runtimes sharing one database: CLI/dashboard (Claude Agent SDK) and Claude Code mode (MCP server + plugin skills).
- JS / TS / Vue indexing: vue-router, file-based routing (Nuxt/Next), Express/Koa/Fastify, NestJS, axios/fetch
  (including URLs kept in constants), pinia/vuex/redux, Vue templates and JSX.
- Safety: agents get no built-in file tools; code2spec's tools refuse `.env*`, `.npmrc`, keys and credential files.
- UI texts behind i18n keys are resolved from English translation JSON files.

Validated runs with real AI (Claude Opus, default settings):

| Codebase | Size | Result | Cost at API prices |
|---|---|---|---|
| `fixtures/legacy-vue-app` (Vue + Express shop) | 26 files, ~780 LOC | 3 phases, 13 features, 72 journeys, 100% coverage, real bugs flagged as conflicts | $3.55 |
| Production Vue 3 + TS app, one module (pilot) | 41 files, ~1.8k LOC | 4 features, 23 journeys, 16 rules, 11 API contracts, 82% coverage before gap fill | $2.17 |

Known limitations:
- Languages other than JS/TS/Vue are not indexed yet.
- Files shared by several phases (e.g. one server file with all routes) belong to one phase; gap fill attaches the rest.
- Editing generated Markdown files by hand is not synced back; edit items in the dashboard instead.
- Very large modules are split by the partition step; costs for UI-heavy code can vary ±30% from pilot estimates.
- Tested on macOS; Linux expected to work; Windows via WSL2.

Roadmap ideas: more language adapters (PHP, Python, Java/Kotlin, C#), Markdown → DB sync, cost estimate before each
AI stage, per-phase model selection, splitting oversized phases automatically, PR-friendly diffs between runs.

## Architecture

```
packages/engine       TypeScript, single package
  src/adapters/       LanguageAdapter interface; ts-js (ts-morph), vue (@vue/compiler-sfc)
  src/stages/         detect, index, AI stages, export/verify
  src/graph/          Louvain partitioning, coverage
  src/ai/             zod schemas, tools (graph + submit), prompts, task runner, Claude Agent SDK runner
  src/specs/          spec item store (SQLite)
  src/render/         Markdown / Gherkin / Playwright renderers
  src/server/         Fastify REST API + static dashboard
  src/cli.ts, mcp.ts  entry points
packages/dashboard    Vite + React + TanStack Query, Mermaid, React Flow
plugin/               Claude Code plugin (MCP config + skills)
fixtures/             small legacy Vue + Express shop used in tests
```

**Adding a language** (PHP, Python, Java…): implement `LanguageAdapter` (`analyze(path, text)` → symbols, imports,
routes, HTTP calls, stores) and register it in `src/adapters/index.ts`. Everything downstream is language-agnostic.

## Development

```bash
pnpm test
```

```bash
pnpm typecheck
```

```bash
pnpm dev:dashboard
```

Tests run the full pipeline on `fixtures/legacy-vue-app` with a scripted mock agent (`test/mock-runner.ts`), covering
validation errors, review gates, resumability and retries.
