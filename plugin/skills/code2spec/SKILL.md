---
name: code2spec
description: Reverse-engineer a legacy codebase into an implementation-neutral specification (phases, features, user journeys with happy/alternate/error/edge variants, business rules, flows, Gherkin scenarios, Playwright tests) so it can be rebuilt by AI in a new stack. Use when the user wants to document, spec out, migrate, rewrite, modernise or "convert to spec" an existing/legacy project.
---

# code2spec — legacy code → spec, journeys and tests

You drive the code2spec pipeline through its MCP tools (server `code2spec`). You are the analysing agent: the tools give you a
code graph and validate/store what you submit. Results show up live in the dashboard (`code2spec serve`, http://127.0.0.1:4600).

If the `code2spec` MCP tools are missing, tell the user to install the CLI first: `npm i -g <repo>/packages/engine` (provides `code2spec` and `code2spec-mcp`).

## Pipeline

1. **Scan (no AI)** — `init_project` with the absolute project path. Report the detected stack and counts (files, routes, HTTP calls, stores).
2. **Partition** — `next_task` stage=`partition`. Follow the returned instructions exactly; inspect clusters with the graph tools, then `submit_phases` and `complete_task` (always pass `task_id`).
3. **Human gate** — show the proposed phases (name, description, file count, entry points) and ask the user to approve, rename, merge or split
   (they can also use the dashboard Phases page). Only call `approve_phases` after the user confirms. Never skip this gate unless the user said so.
4. **Analyze** — repeat `next_task` stage=`analyze` until it returns `done`. One task = one phase.
   - For more than 2 phases, launch one subagent per phase in parallel; give each this instruction: *"Use the code2spec MCP tools. Call next_task with project=<id> stage=analyze, follow the task instructions completely, submit with task_id, finish with complete_task. Report the features and journeys you documented."* Each `next_task` call hands out a different phase.
   - Quality bar per phase: every distinct user path is a journey (e.g. sign in with email / with Google / with 2FA / wrong password / locked out / session expired / sign out), each with Gherkin scenarios that quote exact UI messages and limits, and evidence with file + line range.
5. **Gap fill** — repeat `next_task` stage=`gapfill` until done. Attach evidence for code that belongs to existing items, add missing journeys, record plumbing as tech notes, and report dead code in reviewer notes.
6. **Synthesize** — `next_task` stage=`synthesize`: relations across phases (depends_on, continues_journey, shares_entity, triggers, duplicates, conflicts), cross-phase system journeys, glossary, unified domain model.
7. **Review** — summarise counts, coverage (`get_coverage`), conflicts/duplicates and open questions; point the user to the dashboard for item-by-item review (or use the `code2spec-review` skill).
8. **Export** — `export_pack` writes `.code2spec/export/` (AGENTS.md, spec/, features/*.feature, e2e/*.spec.ts, TRACEABILITY.md).

## Rules
- Describe behaviour, not implementation. Never invent behaviour; put doubts in `openQuestions` and lower `confidence`.
- Use `file_outline` before `read_file`; read files fully when they contain behaviour.
- If a submit returns `ok: false`, fix the listed problems and resubmit — do not skip.
- The pipeline is resumable: `project_status` shows where it stopped.
- Everything you write is in English.
