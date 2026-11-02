---
description: Turn the current project into specs, journeys, Gherkin and Playwright tests (resumable; stops for your phase review)
argument-hint: "[optional: phase name/slug to analyse only that phase]"
---

Follow the `code2spec` skill for the project open in Claude Code. Extra instructions: "$ARGUMENTS".

- Start with `project_status`. If the project is not scanned yet, call `init_project` first and show the estimate; ask the user to confirm before any AI stage on a project above 20,000 lines.
- Continue from the current stage: the pipeline is resumable; never redo finished work unless asked.
- Stop after partition and ask the user to review phases (offer `/code2spec:dashboard`). Never call `approve_phases` without their confirmation.
- Analyse phases with one subagent per phase when there are more than two (each subagent calls `next_task` stage=analyze itself).
- After analyze: gap fill, then synthesize, then `export_pack`. Finish with a short report: features, journeys, coverage, conflicts/duplicates and open questions worth a human look.
