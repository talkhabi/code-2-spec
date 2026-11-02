---
description: Scan the current project into a code graph (no AI, free) and estimate the cost of a full run
argument-hint: "[path to project — defaults to the open project]"
---

Use the code2spec MCP tools.

1. Call `init_project` with `path` = "$ARGUMENTS" if given, otherwise without a path (the project open in Claude Code).
2. Report briefly:
   - detected stack (frameworks, router, state, http libraries)
   - files, lines of code, pages/routes, HTTP calls, stores
   - the full-run estimate from the result (`estimate.usdLow`–`estimate.usdHigh`): explain it is the API-price equivalent; with a Claude Pro/Max login it uses plan quota instead of money
   - stages already done, if the project was scanned before
3. If the project has a `.gitignore` that does not ignore `.code2spec/`, suggest adding it.
4. Suggest next steps: `/code2spec:run` for the whole project, or a pilot on one module first (ask which folder), and `/code2spec:dashboard` to watch progress.
