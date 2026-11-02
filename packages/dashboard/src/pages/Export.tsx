import { useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, type ProjectSummary } from '../api';
import { Stat } from '../components/ui';

export function ExportPage() {
  const { id = '' } = useParams();
  const { data: p } = useQuery({ queryKey: ['project', id], queryFn: () => api<ProjectSummary>(`/projects/${id}`) });
  const exp = useMutation({ mutationFn: () => api<{ outDir: string }>(`/projects/${id}/export`, { body: {} }) });
  const last = p?.stages.find((s) => s.stage === 'export');
  if (!p) return <div className="muted">Loading…</div>;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Rebuild pack</h1>
          <p>Everything an AI agent needs to rebuild the product in a new stack — no legacy code required.</p>
        </div>
        <button className="btn btn-primary" onClick={() => exp.mutate()} disabled={exp.isPending}>Build rebuild pack</button>
      </div>
      {p.items.pendingReview > 0 && <div className="notice" style={{ marginBottom: 14 }}>{p.items.pendingReview} items are still pending review. They are included, marked as unreviewed.</div>}
      <div className="stats" style={{ marginBottom: 16 }}>
        <Stat value={p.phases.total} label="phases" />
        <Stat value={p.items.features} label="features" />
        <Stat value={p.items.journeys} label="journeys" />
        <Stat value={p.items.rules} label="rules" />
        <Stat value={p.items.apis} label="API contracts" />
        <Stat value={p.coverage != null ? `${p.coverage}%` : '–'} label="coverage" />
      </div>
      {(exp.data?.outDir || last?.info?.outDir) && (
        <div className="card card-pad stack">
          <h2>Output</h2>
          <code className="mono">{exp.data?.outDir ?? last?.info?.outDir}</code>
          <pre className="code small">{`AGENTS.md / CLAUDE.md   instructions for the rebuilding agent
README.md               summary
TRACEABILITY.md         legacy evidence → journey → scenarios
spec/                   phases, features, journeys, rules, flows, domain model, glossary
features/*.feature      Gherkin acceptance scenarios
e2e/*.spec.ts           Playwright tests (BASE_URL=… npx playwright test)
playwright.config.ts`}</pre>
        </div>
      )}
      {exp.error && <div className="notice err">{String(exp.error.message)}</div>}
    </>
  );
}
