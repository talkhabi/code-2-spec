import { z } from 'zod';

export const EvidenceSchema = z.object({
  file: z.string().describe('Project-relative file path'),
  startLine: z.number().int().optional(),
  endLine: z.number().int().optional(),
  symbol: z.string().optional().describe('Function / component / handler name'),
  note: z.string().optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

const evidenceList = z.array(EvidenceSchema).describe('Where in the legacy code this behaviour is implemented. Be precise (file + line range).');

export const ScenarioSchema = z.object({
  name: z.string(),
  tags: z.array(z.string()).optional().describe('e.g. ["@smoke", "@negative"]'),
  given: z.array(z.string()).min(1),
  when: z.array(z.string()).min(1),
  then: z.array(z.string()).min(1),
  examples: z
    .object({ headers: z.array(z.string()), rows: z.array(z.array(z.string())) })
    .optional()
    .describe('Scenario Outline examples table; use <placeholders> in steps'),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export const JourneySchema = z.object({
  title: z.string().describe('User-facing name, e.g. "Sign in with email and password"'),
  variant: z.enum(['happy', 'alternate', 'error', 'edge']),
  actor: z.string().describe('e.g. "Guest", "Registered user", "Admin", "System"'),
  goal: z.string(),
  trigger: z.string().optional(),
  preconditions: z.array(z.string()).default([]),
  steps: z
    .array(z.object({ actor: z.enum(['user', 'system']), action: z.string(), expected: z.string().optional() }))
    .min(1),
  outcomes: z.array(z.string()).default([]).describe('Observable end results (UI messages, navigation, data changes)'),
  postconditions: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).describe('How sure you are this journey exists exactly as described'),
  openQuestions: z.array(z.string()).optional().describe('Ambiguities a human reviewer should resolve'),
  evidence: evidenceList,
  scenarios: z.array(ScenarioSchema).min(1).describe('Gherkin scenarios that verify this journey (black-box, implementation-neutral)'),
  playwright: z
    .string()
    .optional()
    .describe('Optional Playwright test body (TypeScript, using `page`) for this journey. Use role/label/text selectors, relative URLs.'),
});
export type Journey = z.infer<typeof JourneySchema>;

export const FlowSchema = z.object({
  title: z.string(),
  description: z.string(),
  steps: z
    .array(
      z.object({
        layer: z.enum(['ui', 'state', 'api-client', 'server', 'storage', 'external', 'navigation']),
        description: z.string(),
        ref: z.string().optional().describe('file:line or symbol reference'),
      }),
    )
    .min(1),
  evidence: evidenceList,
});

export const RuleSchema = z.object({
  title: z.string(),
  rule: z.string().describe('Precise, testable statement, including exact limits, formats and messages'),
  rationale: z.string().optional(),
  evidence: evidenceList,
});

export const ScreenSchema = z.object({
  title: z.string(),
  route: z.string().optional(),
  purpose: z.string(),
  elements: z.array(z.string()).default([]).describe('Inputs, buttons, links, lists (with labels)'),
  states: z.array(z.string()).default([]).describe('Loading, empty, error, disabled, success, etc.'),
  evidence: evidenceList,
});

export const FeatureSchema = z.object({
  title: z.string().describe('Business capability, e.g. "Authentication"'),
  summary: z.string(),
  actors: z.array(z.string()).default([]),
  journeys: z.array(JourneySchema).min(1),
  flows: z.array(FlowSchema).default([]),
  rules: z.array(RuleSchema).default([]),
  screens: z.array(ScreenSchema).default([]),
  evidence: evidenceList,
});
export type Feature = z.infer<typeof FeatureSchema>;

export const EntitySchema = z.object({
  name: z.string(),
  description: z.string(),
  fields: z.array(z.object({ name: z.string(), type: z.string(), notes: z.string().optional() })).default([]),
  lifecycle: z.array(z.string()).optional().describe('States / status transitions'),
  evidence: evidenceList,
});

export const ApiContractSchema = z.object({
  method: z.string(),
  path: z.string(),
  description: z.string(),
  auth: z.string().optional(),
  request: z.string().optional().describe('Request shape (JSON-like)'),
  response: z.string().optional().describe('Success response shape'),
  errors: z.array(z.object({ status: z.string(), meaning: z.string() })).default([]),
  evidence: evidenceList,
});

export const TechNoteSchema = z.object({
  title: z.string(),
  note: z.string().describe('Cross-cutting/technical behaviour the rebuild must preserve (auth tokens, caching, i18n, error handling, config)'),
  evidence: evidenceList,
});

export const PhaseInputSchema = z.object({
  name: z.string().describe('Bounded-context name, e.g. "Authentication & Accounts"'),
  description: z.string(),
  clusters: z.array(z.number().int()).describe('Cluster ids that belong to this phase'),
  extraFiles: z.array(z.string()).optional().describe('Files to move into this phase from other clusters'),
  entryPoints: z.array(z.string()).default([]).describe('Routes, pages or endpoints where users enter this area'),
});

export const RelationSchema = z.object({
  from: z.string().describe('Item id'),
  to: z.string().describe('Item id'),
  kind: z.enum(['depends_on', 'continues_journey', 'shares_entity', 'triggers', 'duplicates', 'conflicts']),
  note: z.string(),
});

export const SystemJourneySchema = z.object({
  title: z.string(),
  summary: z.string(),
  actor: z.string(),
  steps: z.array(z.object({ journeyId: z.string(), note: z.string().optional() })).min(2),
});
