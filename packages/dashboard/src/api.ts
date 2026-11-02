export async function api<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init?.method ?? (init?.body ? 'POST' : 'GET'),
    headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data as T;
}

export interface StageInfo { stage: string; status: string; info: Record<string, any>; error?: string }

export interface ProjectSummary {
  id: string;
  name: string;
  root: string;
  error?: string;
  profile?: { frameworks: string[]; languages: Record<string, number>; router: string[]; state: string[]; http: string[]; server: string[] };
  stages: StageInfo[];
  currentStage?: string;
  currentStatus?: string;
  phases: { total: number; approved: number; analysed: number };
  items: { features: number; journeys: number; rules: number; flows: number; entities: number; apis: number; systemJourneys: number; pendingReview: number };
  coverage: number | null;
  cost: { usd: number; inputTokens: number; outputTokens: number };
  tasks: { total: number; running: number; failed: number };
  job: null | string | { stage: string; startedAt: string };
}

export interface Phase {
  id: string; slug: string; name: string; description: string | null; files: string[]; entry_points: string[];
  status: 'pending' | 'approved' | 'rejected'; analysis_status: string; counts: { features: number; journeys: number; pending: number };
}

export interface Evidence { file: string; startLine?: number; endLine?: number; symbol?: string; note?: string }

export interface Item {
  id: string; phase_id: string | null; parent_id: string | null; type: string; slug: string; title: string; summary: string | null;
  data: Record<string, any>; status: 'pending' | 'approved' | 'rejected' | 'edited'; confidence: number | null; origin: string;
}

export interface ItemDetail extends Item {
  evidence: Evidence[]; children: Item[]; reviews: { status: string; comment: string | null; author: string; ts: string }[];
  relations: Relation[]; parent: Item | null; gherkin?: string; playwright?: string;
}

export interface Relation {
  id: number; from_id: string; to_id: string; kind: string; note: string | null; status: string;
  from_title: string; from_type: string; from_phase: string | null; to_title: string; to_type: string; to_phase: string | null;
}

export const STAGE_LABELS: Record<string, string> = {
  detect: 'Detect', index: 'Index', partition: 'Partition', analyze: 'Analyze', gapfill: 'Gap fill', synthesize: 'Synthesize', verify: 'Verify', export: 'Export',
};

export const STAGE_HELP: Record<string, string> = {
  detect: 'Languages, frameworks and libraries',
  index: 'Code graph: files, symbols, routes, API calls, stores',
  partition: 'AI groups the code into phases (bounded contexts)',
  analyze: 'AI documents features, journeys, rules and tests per phase',
  gapfill: 'AI documents code no spec item references yet',
  synthesize: 'AI links journeys across phases, builds domain model',
  verify: 'Run generated Playwright tests against a live app',
  export: 'Rebuild pack for the AI that rewrites the product',
};
