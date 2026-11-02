import type { Project } from '../project.js';
import { getProfile } from '../stages/detect.js';
import { loadClusters } from '../graph/partition.js';
import { getPhase, listItems, listPhases } from '../specs/store.js';
import type { CoverageUnit } from '../graph/coverage.js';

export const BASE_SYSTEM = `You are a senior software archaeologist working inside "code2spec".
Your job is to reverse-engineer a legacy codebase into an implementation-neutral specification that another AI agent
will use to rebuild the product from scratch, possibly in a different language or framework.

Principles:
- Describe BEHAVIOUR, not implementation. Write what users see and what the system guarantees; never prescribe frameworks.
- Be exhaustive about behaviour: every user-visible path, validation, error message, limit, redirect, permission check and side effect matters.
  The rebuild must be behaviourally equivalent. Quote exact UI texts, limits and formats from the code.
- One capability can have many journeys. Example: "Authentication" may have: sign in with email, sign in with Google,
  sign in requiring 2FA, sign up, forgot/reset password, sign out, session expiry. Each journey has variants: happy, alternate, error, edge.
- Every spec item MUST carry evidence: project-relative file path + line range of the code that implements it.
- Never invent behaviour. If something is unclear (dead code, feature flags, server behaviour you cannot see), say so in openQuestions and lower confidence.
- Gherkin scenarios must be black-box and implementation-neutral (no CSS selectors, no function names).
- Playwright tests: TypeScript test bodies using \`page\`, relative URLs, and accessible selectors (getByRole, getByLabel, getByPlaceholder, getByText). Mock or stub nothing; they run against a live app.
- UI texts are often i18n keys (t('…'), $t('…')). Resolve them with search_code (i18nOnly) and quote the English text, not the key.
- Use the code2spec tools to explore (outline before reading whole files) and to submit results. Submissions are validated; if a submit returns problems, fix them and resubmit.
- Output must be in English.`;

export interface TaskPrompt {
  system: string;
  prompt: string;
  tools: string[]; // submit tool names allowed for this task (graph tools are always available)
  required: string[]; // submit tools that must have been called for the task to count as done
}

function profileLine(project: Project) {
  const p = getProfile(project);
  if (!p) return 'Stack: unknown';
  return `Stack: frameworks=[${p.frameworks.join(', ')}] router=[${p.router.join(', ')}] state=[${p.state.join(', ')}] http=[${p.http.join(', ')}] server=[${p.server.join(', ')}] files=${JSON.stringify(p.languages)}`;
}

export function partitionPrompt(project: Project): TaskPrompt {
  const clusters = loadClusters(project);
  const db = project.db;
  const lines = clusters.map((c) => {
    const ids = c.files.map((f) => (db.prepare('SELECT id FROM files WHERE path = ?').get(f) as { id: number }).id);
    const inList = ids.join(',');
    const routes = (db.prepare(`SELECT method, path FROM routes WHERE file_id IN (${inList}) OR target_file_id IN (${inList}) LIMIT 15`).all() as any[]).map((r) => `${r.method ?? 'PAGE'} ${r.path}`);
    const calls = (db.prepare(`SELECT DISTINCT url FROM http_calls WHERE file_id IN (${inList}) LIMIT 10`).all() as any[]).map((r) => r.url);
    const files = c.files.length > 25 ? [...c.files.slice(0, 25), `… +${c.files.length - 25} more`] : c.files;
    return `### Cluster ${c.id} — "${c.label}" (${c.files.length} files)\nfiles: ${files.join(', ')}${routes.length ? `\nroutes: ${routes.join('; ')}` : ''}${calls.length ? `\nhttp: ${calls.join('; ')}` : ''}`;
  });
  return {
    system: BASE_SYSTEM,
    tools: ['submit_phases', 'complete_task'],
    required: ['submit_phases'],
    prompt: `Project "${project.config.name}". ${profileLine(project)}

Static analysis clustered the code graph into ${clusters.length} candidate clusters (Louvain community detection on imports, routes and component usage):

${lines.join('\n\n')}

TASK: Group these clusters into PHASES. A phase is a business-level bounded context that can be analysed and specified independently
(e.g. "Authentication & Accounts", "Product Catalog", "Cart & Checkout", "Admin – Users", "Shared infrastructure").
- Prefer 3–15 phases depending on size; each phase should be analysable by one agent (roughly < 80 files).
- Clusters are only hints: if a cluster mixes concerns, move individual files with extraFiles.
- Put cross-cutting plumbing (http client, app bootstrap, layout, generic UI kit, utils) in a "Shared infrastructure" phase.
- Order phases so foundational ones (auth, shared) come first.
- List entry points (routes / pages / endpoints) for each phase.
You may inspect files with the tools. Then call submit_phases, then complete_task.`,
  };
}

export function analyzePrompt(project: Project, phaseId: string): TaskPrompt {
  const phase = getPhase(project, phaseId)!;
  const others = listPhases(project).filter((p) => p.id !== phaseId).map((p) => `- ${p.name}: ${p.description ?? ''}`).join('\n');
  return {
    system: BASE_SYSTEM,
    tools: ['submit_feature', 'submit_domain', 'submit_tech_notes', 'complete_task'],
    required: ['submit_feature', 'complete_task'],
    prompt: `Project "${project.config.name}". ${profileLine(project)}

You are analysing PHASE "${phase.name}" (id ${phase.id}).
Description: ${phase.description ?? '-'}
Entry points: ${phase.entry_points.join(', ') || '-'}
Files in this phase (${phase.files.length}):
${phase.files.map((f) => `- ${f}`).join('\n')}

Other phases (do not document their internals, but note when a journey continues into them):
${others || '-'}

TASK — document everything this phase does:
1. Explore: use list_routes / list_http_calls / list_stores / file_outline, then read the relevant files fully. Follow calls into shared code when needed to understand behaviour.
2. Identify FEATURES (business capabilities). For each feature, find ALL journeys — every distinct path a user (or system) can take,
   including alternate paths (remember me, social login, redirect-after-login), error paths (invalid input, server errors, locked account, expired token)
   and edge cases (empty states, limits, permissions, double submit, back navigation).
3. For each journey: actor, goal, preconditions, numbered steps, observable outcomes, Gherkin scenarios (cover each validation/error message)
   and, when it is a UI journey, a Playwright test body.
4. Capture technical FLOWS (UI → state → api-client → server → storage) for the main journeys, BUSINESS RULES (exact limits, formats, messages, permissions)
   and SCREENS (elements and states).
5. Call submit_feature once per feature. Then submit_domain with entities (data shapes, statuses) and API contracts used/defined in this phase.
6. Use submit_tech_notes for cross-cutting behaviour that is not a user journey (token storage, interceptors, guards, caching).
7. Call complete_task with a summary and reviewer notes (open questions, suspected dead code).`,
  };
}

export function gapfillPrompt(project: Project, phaseId: string | undefined, uncovered: CoverageUnit[]): TaskPrompt {
  const phase = phaseId ? getPhase(project, phaseId) : undefined;
  const existing = listItems(project, { phaseId: phaseId ?? undefined }).filter((i) => ['feature', 'journey', 'tech_note'].includes(i.type));
  const list = uncovered.slice(0, 150).map((u) => `- [${u.kind}] ${u.file}${u.line ? `:${u.line}${u.endLine && u.endLine !== u.line ? `-${u.endLine}` : ''}` : ''} ${u.kind === 'file' ? '' : u.name}`);
  return {
    system: BASE_SYSTEM,
    tools: ['submit_feature', 'attach_evidence', 'submit_tech_notes', 'submit_domain', 'complete_task'],
    required: ['complete_task'],
    prompt: `Project "${project.config.name}". GAP-FILL for ${phase ? `phase "${phase.name}" (id ${phase.id})` : 'files not assigned to any phase'}.

These code units are not referenced by any spec item yet (${uncovered.length} total${uncovered.length > 150 ? ', first 150 shown' : ''}):
${list.join('\n')}

Already documented in this scope:
${existing.map((i) => `- ${i.id} [${i.type}] ${i.title}`).join('\n') || '-'}

TASK: Read the uncovered code and for each unit decide:
- It implements behaviour of an existing item → attach_evidence to that item (journey/feature/tech_note id).
- It implements behaviour that is missing from the spec → submit_feature (new feature, or a new feature containing the missing journeys).
- It is technical plumbing that the rebuild still needs to know about → submit_tech_notes.
- It is dead/unused code → mention it in complete_task reviewerNotes (do not document it as behaviour).
Finish with complete_task.`,
  };
}

export function synthesizePrompt(project: Project): TaskPrompt {
  const phases = listPhases(project).filter((p) => p.status !== 'rejected');
  const sections = phases.map((p) => {
    const items = listItems(project, { phaseId: p.id }).filter((i) => i.status !== 'rejected');
    const features = items.filter((i) => i.type === 'feature').map((f) => {
      const journeys = items.filter((i) => i.parent_id === f.id && i.type === 'journey')
        .map((j) => `    - ${j.id} [${j.data.variant}] ${j.title} — actor: ${j.data.actor}; outcomes: ${(j.data.outcomes ?? []).join('; ').slice(0, 200)}`);
      return `  * ${f.id} FEATURE ${f.title}: ${f.summary ?? ''}\n${journeys.join('\n')}`;
    });
    const entities = items.filter((i) => i.type === 'entity').map((e) => `  * ${e.id} ENTITY ${e.title}: ${(e.data.fields ?? []).map((x: any) => x.name).join(', ')}`);
    const apis = items.filter((i) => i.type === 'api').map((a) => `  * ${a.id} API ${a.title}`);
    return `## Phase ${p.name} (${p.id})\n${[...features, ...entities, ...apis].join('\n')}`;
  });
  return {
    system: BASE_SYSTEM,
    tools: ['submit_synthesis', 'complete_task'],
    required: ['submit_synthesis'],
    prompt: `Project "${project.config.name}". All phases have been analysed independently. Catalog:

${sections.join('\n\n')}

TASK — cross-phase synthesis:
1. RELATIONS between items across (and within) phases: depends_on (journey requires another, e.g. checkout requires sign-in),
   continues_journey (one journey hands off to another), shares_entity, triggers (side effects), duplicates (same behaviour documented twice),
   conflicts (contradicting rules — explain in note).
2. SYSTEM JOURNEYS: end-to-end user journeys that span several phases (e.g. "First purchase as a new customer": register → browse → add to cart → checkout),
   as ordered lists of existing journey ids.
3. GLOSSARY of domain terms.
4. DOMAIN MODEL: unify entity items from all phases into one model (merge duplicates; list source entity ids in sources).
Use get_spec_item / read_file if you need detail. Then call submit_synthesis and complete_task.`,
  };
}
