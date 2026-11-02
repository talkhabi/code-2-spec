---
name: code2spec-review
description: Help a human review code2spec output — walk through pending phases, features and journeys, surface low-confidence items, open questions, conflicts and duplicates, and record approve/reject decisions. Use when the user wants to review, approve, clean up or trim generated specs.
---

# Reviewing code2spec output

1. `project_status` → report counts of pending items per type and coverage.
2. `list_spec_items` (type=feature) per phase; for each feature list its journeys with variant and confidence (`get_spec_item` for detail).
3. Prioritise for the human:
   - journeys with confidence < 0.7 or with open questions,
   - relations of kind `conflicts` / `duplicates` (from `list_spec_items` + dashboard Relations page),
   - features the user may not need in the rebuild (dead code, legacy-only admin tools, feature flags).
4. Present them in small batches and ask the user what to keep. Record decisions with `set_review` (`approved` / `rejected`, with a comment explaining why).
   Rejecting a feature does not reject its children automatically — pass the journey ids too when the user wants the whole feature gone.
5. Do not edit item content yourself unless asked; content edits are best done in the dashboard (Edit tab), which marks items as human-owned so re-analysis keeps them.
6. When done, offer `export_pack`.
