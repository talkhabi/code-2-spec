import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, STAGE_LABELS, type ProjectSummary } from '../api';
import { Badge } from '../components/ui';

export function ProjectsPage() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const { data, isLoading, error } = useQuery({ queryKey: ['projects'], queryFn: () => api<ProjectSummary[]>('/projects'), refetchInterval: 4000 });
  const [path, setPath] = useState('');
  const add = useMutation({
    mutationFn: () => api<ProjectSummary>('/projects', { body: { root: path } }),
    onSuccess: (p) => { qc.invalidateQueries({ queryKey: ['projects'] }); nav(`/p/${p.id}`); },
  });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <p>Legacy codebases being turned into specs, journeys and tests.</p>
        </div>
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (path) add.mutate(); }}>
          <input style={{ width: 340 }} placeholder="/absolute/path/to/legacy/project" value={path} onChange={(e) => setPath(e.target.value)} />
          <button className="btn btn-primary" disabled={!path || add.isPending}>Add & scan</button>
        </form>
      </div>
      {add.error && <div className="notice err" style={{ marginBottom: 12 }}>{String(add.error.message)}</div>}
      {error && <div className="notice err">{String((error as Error).message)}</div>}
      {isLoading && <div className="muted">Loading…</div>}
      {data && !data.length && (
        <div className="card empty">
          <h2>No projects yet</h2>
          <p>Add a project path above, or run <code>code2spec init &lt;path&gt;</code> in a terminal.</p>
        </div>
      )}
      <div className="grid grid-cards">
        {data?.map((p) => (
          <Link key={p.id} to={`/p/${p.id}`} className="card card-pad stack" style={{ color: 'inherit', textDecoration: 'none' }}>
            <div className="spread">
              <h2 className="truncate">{p.name}</h2>
              {p.job ? <Badge kind="running">running {typeof p.job === 'string' ? p.job : p.job.stage}</Badge>
                : p.currentStatus ? <Badge kind={p.currentStatus}>{STAGE_LABELS[p.currentStage ?? ''] ?? p.currentStage}: {p.currentStatus.replace('_', ' ')}</Badge> : null}
            </div>
            <div className="muted small mono truncate" title={p.root}>{p.root}</div>
            {p.error ? <div className="notice err small">{p.error}</div> : (
              <>
                <div className="stage-strip" title={p.stages.map((s) => `${s.stage}: ${s.status}`).join('\n')}>
                  {p.stages.map((s) => <span key={s.stage} className={s.status} />)}
                </div>
                <div className="row small muted">
                  <span>{p.profile?.frameworks.join(', ') || 'JS/TS'}</span>·
                  <span>{p.phases.total} phases</span>·
                  <span>{p.items.features} features</span>·
                  <span>{p.items.journeys} journeys</span>
                  {p.coverage != null && <>·<span>{p.coverage}% coverage</span></>}
                </div>
                <div className="row small">
                  {p.items.pendingReview > 0 && <Badge kind="pending">{p.items.pendingReview} to review</Badge>}
                  {p.tasks.failed > 0 && <Badge kind="failed">{p.tasks.failed} failed tasks</Badge>}
                  <span className="muted">${p.cost.usd.toFixed(2)}</span>
                </div>
              </>
            )}
          </Link>
        ))}
      </div>
    </>
  );
}
