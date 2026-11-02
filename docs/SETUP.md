# code2spec — setup and usage guide (zero to 100)

This guide takes you from a fresh machine to a reviewed specification and rebuild pack for your own legacy project.
It assumes no prior knowledge of code2spec. Expect ~15 minutes for setup; the AI run time depends on project size.

> Tested on macOS (Apple Silicon) with Node 24 and pnpm 12. Linux should work the same way. On Windows, use WSL2.

---

## 0. Before you start

You need:

| Requirement | Why |
|---|---|
| **Node.js 24 LTS** (22.5+ minimum) | code2spec uses the built-in `node:sqlite` module |
| **A Claude account (Pro / Max)** *or* **an Anthropic API key** | the AI stages run on Claude |

**Your code leaves your machine.** AI stages send the project's source code to Anthropic (the same as using Claude Code
on it). Check that your company allows this before scanning work code. Secret files (`.env*`, `.npmrc`, `*.pem`,
`*.key`, credentials files) are never read by the agents, but check your code for secrets that are written directly in it.

**Cost.** With a Claude Pro/Max login you pay nothing extra: runs use your plan's usage limits, and the dollar amount
code2spec shows is only an estimate at API prices. With an API key, that amount is billed to your Anthropic Console account.
Rough guide: about **$1.2 per 1,000 lines of code** analysed with the default model (Opus). See [step 6](#5-run-a-pilot-on-one-module-recommended).

---

## 1. Install Node.js 24

Check what you have:

```bash
node -v
```

If it prints `v22.5` or higher you are fine (v24 recommended). Otherwise install Node 24, for example with nvm:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
```

```bash
nvm install 24 && nvm alias default 24
```

(Homebrew `brew install node@24` or Volta `volta install node@24` work too.)

## 2. Install Claude Code and log in

code2spec's AI stages use the Claude Agent SDK, which reuses the Claude Code login.

```bash
npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code
```

> Keep `--allow-scripts=…`. Without it, recent npm versions skip the install script and `claude` fails with
> "claude native binary not installed".

Log in once:

```bash
claude
```

Inside Claude Code type `/login`, finish in the browser, then `/status` to confirm (it shows e.g. *Login method: Claude Pro account*),
then `/exit`.

**Alternative:** instead of logging in, export an API key (billed per token):

```bash
echo 'export ANTHROPIC_API_KEY=sk-ant-...' >> ~/.zshrc
```

## 3. Install code2spec

```bash
npm install -g code2spec
```

This installs the `code2spec` command (CLI + dashboard) and `code2spec-mcp` (for Claude Code mode).
To update later, run the same command again.

<details><summary>Alternative: install from source (to change code2spec itself)</summary>

Needs pnpm 10+ and git.

```bash
git clone https://github.com/talkhabi/code-2-spec.git && cd code-2-spec
```

```bash
./scripts/install.sh
```

The script installs dependencies, builds, and installs the commands globally with your own npm (works with nvm, Volta,
Homebrew). After `git pull`, run it again. Don't use `npm i -g ./packages/engine`: with Volta it creates a broken link.

</details>

Check the machine:

```bash
code2spec doctor
```

All lines should be ✔ (a ! for `ANTHROPIC_API_KEY` is fine when you logged in with Claude).

## 4. Scan your project (free, no AI)

```bash
code2spec init /absolute/path/to/your-project
```

This detects the stack and builds a code graph. It takes seconds, even on large projects. You get a summary like:

```
Indexed 1818 files, 3461 symbols, 4741 import edges, 43 routes, 181 HTTP calls, 51 stores
```

Things to know:

- It creates a `.code2spec/` folder inside your project (database, generated specs). Add `.code2spec/` to your
  project's `.gitignore` unless you want the specs committed.
- Supported today: **JavaScript, TypeScript, Vue** (and React/Express/Nest patterns in JS/TS). Other languages are skipped.
- `node_modules`, `dist`, `build`, `.git`, `coverage`, `.nuxt`, `.next`, `vendor` are excluded automatically. To exclude
  more (generated code, legacy folders you will not rebuild), re-run init with
  `code2spec init /path -x "src/generated/**" "legacy-admin/**"`, or edit `exclude` in `.code2spec/config.json` and run `code2spec scan -p /path`.
- Useful checks: `code2spec status -p /path` and `code2spec coverage -p /path`.

## 5. Run a pilot on one module (recommended)

Before spending a lot of usage on a big project, document one module and look at the quality and cost.

```bash
code2spec phases add "Authentication" -g "src/modules/Auth/**" -p /path/to/your-project
```

```bash
code2spec analyze --phase authentication -p /path/to/your-project
```

When it finishes, `code2spec status` shows the cost (e.g. `AI cost: $2.17`). Divide by the module's lines of code to
estimate the full project. With a Claude login, also run `/usage` inside `claude` to see how much of your usage window it took.

Pick a cheaper model for big projects:

```bash
code2spec analyze --phase authentication -m sonnet -p /path/to/your-project
```

## 6. Open the dashboard

```bash
code2spec serve
```

Open http://127.0.0.1:4600. Keep this terminal open; use a second terminal for CLI commands (both work on the same data).
Use `--port 4700` if 4600 is taken.

## 7. Run the full pipeline

From the dashboard press **Run pipeline**, or:

```bash
code2spec run -p /path/to/your-project
```

The pipeline:

| # | Stage | AI | What happens |
|---|---|---|---|
| 1 | Detect | – | languages, frameworks, libraries |
| 2 | Index | – | code graph: files, symbols, routes, API calls, stores |
| 3 | Partition | ✔ | the AI groups the code into **phases** (business areas) |
| – | **Your review** | | approve / rename / merge / split phases |
| 4 | Analyze | ✔ | one agent per phase writes features, journeys, rules, flows, Gherkin, Playwright |
| 5 | Gap fill | ✔ | documents code that no spec item references yet |
| 6 | Synthesize | ✔ | links journeys across phases, finds duplicates/conflicts, builds domain model + glossary |
| 7 | Export | – | writes the rebuild pack |

**It stops after Partition** so you can review the phases: dashboard → **Phases**. Approve the ones you want, reject the
ones you will not rebuild, merge or split as needed. Then run again:

```bash
code2spec run -p /path/to/your-project
```

Notes:
- Everything is **resumable**. If you hit your usage limit or stop it, run the same command later; finished work is kept.
- `--yes` skips the review gate (not recommended for real projects).
- `--force` redoes a stage. Items you approved or edited are kept.
- `-m sonnet` / `-m opus` picks the model; set `"model"` in `.code2spec/config.json` to make it permanent.
- `"concurrency"` in `.code2spec/config.json` is the number of phases analysed in parallel (default 3).

## 8. Review the results

Dashboard pages:

- **Features & journeys**: tree of phase → feature → journeys (happy / alternate / error / edge). Each item has details,
  Gherkin, Playwright, **Evidence** (click to see the exact legacy code lines), Edit (JSON) and History.
  **Approve all** on a feature approves its journeys too. Reject what the rebuild does not need.
- **Relations**: how journeys connect across phases; check **Needs attention** for duplicates and conflicts
  (these are often real bugs in the old code).
- **Coverage**: which code is not referenced by any spec item. Run **Gap fill** to fix it.
- Journeys with **Open questions** need a human decision.

Edited items are marked *edited* and are never overwritten by a re-run.

## 9. Export the rebuild pack

```bash
code2spec export -p /path/to/your-project
```

Output in `<your-project>/.code2spec/export/`:

```
AGENTS.md / CLAUDE.md   instructions for the AI that rebuilds the product
README.md               summary
spec/                   phases, features, journeys, rules, flows, domain model, glossary
features/*.feature      Gherkin acceptance scenarios
e2e/*.spec.ts           Playwright tests + playwright.config.ts
TRACEABILITY.md         legacy code → journey → scenarios
```

To rebuild, copy this folder into a new empty repository and start Claude Code there:
*"Read AGENTS.md and rebuild the product in <your stack>, phase by phase."*

To check the generated tests against a running app (the old one or the rebuild):

```bash
code2spec verify -u http://localhost:5173 -p /path/to/your-project
```

## 10. Optional: Claude Code mode

Instead of the CLI running agents, Claude Code itself can be the agent (handy for interactive work). Results go to the same
database and dashboard.

```bash
claude plugin marketplace add talkhabi/code-2-spec
```

```bash
claude plugin install code2spec@code2spec
```

Then in Claude Code: *"Use code2spec to turn /path/to/your-project into a spec."* It stops for your phase review.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Claude is not authenticated` / `Not logged in` | Run `claude`, then `/login`, or set `ANTHROPIC_API_KEY`. |
| `claude native binary not installed` | Reinstall with `npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code`. |
| `No such built-in module: node:sqlite` | Your Node is older than 22.5. Check `node -v` (the global `code2spec` uses your default Node).  |
| `code2spec: command not found` | Open a new terminal; check that npm's global bin is on your `PATH` (`npm prefix -g`). |
| `ERR_PNPM_IGNORED_BUILDS` (source install) | Run `pnpm approve-builds esbuild`, then `./scripts/install.sh` again. |
| Dashboard shows "build not found" | Reinstall: `npm install -g code2spec`. |
| Port 4600 in use | `code2spec serve --port 4700`. |
| Usage limit reached mid-run | Wait for the reset, then re-run the same command. It resumes. |
| A phase failed | Check the dashboard Overview log, then `code2spec analyze --phase <slug> -p …`. |
| Very few routes / HTTP calls found | Your project may use patterns the indexer does not know yet. Open an issue with a small example. |

## Updating

```bash
npm install -g code2spec
```

## Uninstalling

```bash
npm rm -g code2spec
```

Delete `~/.code2spec` (project registry) and the `.code2spec/` folders inside scanned projects.
