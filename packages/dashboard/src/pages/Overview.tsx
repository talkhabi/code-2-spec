import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, STAGE_HELP, STAGE_LABELS, type ProjectSummary } from '../api';
import { Badge, Stat } from '../components/ui';

const AI_STAGES = new Set(['partition', 'analyze', 'gapfill', 'synthesize']);

export function OverviewPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const { data: p } = useQuery({ queryKey: ['project', id], queryFn: () => api<ProjectSummary & { config: any }>(`/projects/${id}`), refetchInterval: 2000 });
  const [baseUrl, setBaseUrl] = useState('http://localhost:5173');
  const [showDebug, setShowDebug] = useState(false);
  const run = useMutation({
    mutationFn: ({ stage, body }: { stage: string; body?: object }) => api(`/projects/${id}/stages/${stage}/run`, { body: body ?? {} }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['project', id] }),
  });
  const cancel = useMutation({ mutationFn: () => api(`/projects/${id}/cancel`, { body: {} }) });
  if (!p) return <div className="muted">Loading…</div>;
  const busy = !!p.job;
  const awaiting = p.stages.find((s) => s.status === 'awaiting_review');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{p.name}</h1>
          <p className="mono small">{p.root}</p>
        </div>
        <div className="row">
          {busy && <Badge kind="running">running {typeof p.job === 'object' && p.job ? p.job.stage : String(p.job)}</Badge>}
          {busy && <button className="btn btn-red" onClick={() => cancel.mutate()}>Cancel</button>}
          <button className="btn" disabled={busy} onClick={() => run.mutate({ stage: 'scan' })}>Re-scan</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => run.mutate({ stage: 'all' })}>Run pipeline</button>
        </div>
      </div>
      {run.error && <div className="notice err" style={{ marginBottom: 12 }}>{String(run.error.message)}</div>}
      {awaiting && (
        <div className="notice" style={{ marginBottom: 14 }}>
          <b>{STAGE_LABELS[awaiting.stage]}</b> is waiting for your review. <Link to={`/p/${id}/phases`}>Review phases →</Link>
        </div>
      )}

      <div className="stats" style={{ marginBottom: 18 }}>
        <Stat value={p.phases.total} label={`phases (${p.phases.approved} approved)`} />
        <Stat value={p.items.features} label="features" />
        <Stat value={p.items.journeys} label="journeys" />
        <Stat value={p.items.rules} label="business rules" />
        <Stat value={p.items.entities} label="entities" />
        <Stat value={p.coverage != null ? `${p.coverage}%` : '–'} label="code coverage" />
        <Stat value={p.items.pendingReview} label="pending review" />
        <Stat value={`$${p.cost.usd.toFixed(2)}`} label={`${Math.round((p.cost.inputTokens + p.cost.outputTokens) / 1000)}k tokens`} />
        {p.estimate?.linesOfCode > 0 && <Stat value={`~$${p.estimate.usdLow}–${p.estimate.usdHigh}`} label={`full-run estimate · ${p.estimate.linesOfCode.toLocaleString('en-US')} lines`} />}
      </div>

      <h2 style={{ marginBottom: 10 }}>Pipeline</h2>
      <div className="pipeline" style={{ marginBottom: 18 }}>
        {p.stages.map((s, i) => (
          <div key={s.stage} className="card stage-card">
            <div className="spread">
              <span className="n">{String(i + 1).padStart(2, '0')} {AI_STAGES.has(s.stage) ? '· AI' : ''}</span>
              <Badge kind={s.status}>{s.status.replace('_', ' ')}</Badge>
            </div>
            <h3>{STAGE_LABELS[s.stage]}</h3>
            <div className="muted small">{STAGE_HELP[s.stage]}</div>
            {s.error && <div className="small" style={{ color: 'var(--red)' }}>{s.error}</div>}
            <StageInfo info={s.info} />
            <div className="row" style={{ marginTop: 'auto' }}>
              {s.stage === 'verify' ? (
                <>
                  <input className="small" style={{ flex: 1, minWidth: 0 }} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
                  <button className="btn btn-sm" disabled={busy} onClick={() => run.mutate({ stage: 'verify', body: { baseUrl } })}>Run</button>
                </>
              ) : (
                <>
                  <button className="btn btn-sm" disabled={busy} onClick={() => run.mutate({ stage: s.stage })}>{s.status === 'pending' ? 'Run' : 'Resume'}</button>
                  {s.status !== 'pending' && AI_STAGES.has(s.stage) && (
                    <button className="btn btn-sm" disabled={busy} title="Discard pending AI output and redo" onClick={() => confirm(`Re-run ${s.stage} from scratch? Unreviewed AI output for this stage is replaced.`) && run.mutate({ stage: s.stage, body: { force: true } })}>Redo</button>
                  )}
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', alignItems: 'start' }}>
        <div>
          <div className="spread" style={{ marginBottom: 8 }}>
            <h2>Activity</h2>
            <label className="row small muted"><input type="checkbox" checked={showDebug} onChange={(e) => setShowDebug(e.target.checked)} /> agent tool calls</label>
          </div>
          <Logs projectId={id} debug={showDebug} />
        </div>
        <div className="card card-pad stack">
          <h2>Detected stack</h2>
          {p.profile ? (
            <table className="small"><tbody>
              <tr><th>Frameworks</th><td>{p.profile.frameworks.join(', ') || '–'}</td></tr>
              <tr><th>Router</th><td>{p.profile.router.join(', ') || '–'}</td></tr>
              <tr><th>State</th><td>{p.profile.state.join(', ') || '–'}</td></tr>
              <tr><th>HTTP</th><td>{p.profile.http.join(', ') || '–'}</td></tr>
              <tr><th>Server</th><td>{p.profile.server.join(', ') || '–'}</td></tr>
              <tr><th>Files</th><td>{Object.entries(p.profile.languages).map(([k, v]) => `${v} .${k}`).join(', ')}</td></tr>
            </tbody></table>
          ) : <div className="muted">Not scanned yet.</div>}
          <div className="muted small">Model: {p.config?.model ?? 'default'} · {p.config?.concurrency} parallel agents</div>
        </div>
      </div>
    </>
  );
}

function StageInfo({ info }: { info: Record<string, any> }) {
  const entries = Object.entries(info ?? {}).filter(([k, v]) => typeof v !== 'object' && k !== 'outDir');
  if (!entries.length) return null;
  return <div className="muted small">{entries.map(([k, v]) => `${k}: ${v}`).join(' · ')}</div>;
}

function Logs({ projectId, debug }: { projectId: string; debug: boolean }) {
  const { data } = useQuery({
    queryKey: ['logs', projectId, debug],
    queryFn: () => api<{ id: number; ts: string; stage: string; level: string; message: string }[]>(`/projects/${projectId}/logs?limit=400${debug ? '&level=debug' : ''}`),
    refetchInterval: 2000,
  });
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }); }, [data?.length]);
  return (
    <div className="logs" ref={ref}>
      {!data?.length && <div className="muted">No activity yet.</div>}
      {data?.map((l) => (
        <div key={l.id} className={`l-${l.level}`}>
          <span className="muted">{new Date(l.ts).toLocaleTimeString()} </span>
          <span className="muted">[{l.stage ?? '-'}]</span> {l.message}
        </div>
      ))}
    </div>
  );
}
