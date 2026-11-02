import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Phase } from '../api';
import { Badge, Progress, Stat } from '../components/ui';

interface Coverage {
  total: number; covered: number; percent: number;
  byKind: Record<string, { total: number; covered: number }>;
  byPhase: Record<string, { total: number; covered: number }>;
  files: { file: string; phaseId?: string; total: number; covered: number }[];
  uncovered: { kind: string; file: string; name: string; line?: number }[];
}

export function CoveragePage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const { data: c } = useQuery({ queryKey: ['coverage', id], queryFn: () => api<Coverage>(`/projects/${id}/coverage`), refetchInterval: 8000 });
  const { data: phases } = useQuery({ queryKey: ['phases', id], queryFn: () => api<Phase[]>(`/projects/${id}/phases`) });
  const gapfill = useMutation({ mutationFn: () => api(`/projects/${id}/stages/gapfill/run`, { body: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['project', id] }) });
  const [file, setFile] = useState<string | null>(null);
  if (!c) return <div className="muted">Loading…</div>;
  const pct = (v: { total: number; covered: number }) => (v.total ? Math.round((v.covered / v.total) * 100) : 0);
  const phaseName = (pid?: string) => phases?.find((p) => p.id === pid)?.name ?? 'Unassigned';

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Coverage</h1>
          <p>Share of code units (files, functions, handlers, routes, API calls, stores) referenced by spec evidence. Uncovered code = possibly undocumented behaviour.</p>
        </div>
        <button className="btn btn-primary" onClick={() => gapfill.mutate()} disabled={gapfill.isPending}>Run gap fill</button>
      </div>
      {gapfill.error && <div className="notice err" style={{ marginBottom: 12 }}>{String(gapfill.error.message)}</div>}
      <div className="stats" style={{ marginBottom: 16 }}>
        <Stat value={`${c.percent}%`} label={`${c.covered} / ${c.total} units`} />
        {Object.entries(c.byKind).map(([k, v]) => <Stat key={k} value={`${pct(v)}%`} label={`${k.replace('_', ' ')} · ${v.covered}/${v.total}`} />)}
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.4fr)', alignItems: 'start' }}>
        <div className="card card-pad stack">
          <h2>By phase</h2>
          {Object.entries(c.byPhase).map(([pid, v]) => (
            <div key={pid} className="stack" style={{ gap: 4 }}>
              <div className="spread small"><span>{phaseName(pid)}</span><span className="muted">{pct(v)}% · {v.covered}/{v.total}</span></div>
              <Progress value={pct(v)} />
            </div>
          ))}
        </div>
        <div className="card card-pad">
          <h2 style={{ marginBottom: 8 }}>Least covered files</h2>
          <table><thead><tr><th>File</th><th style={{ width: 160 }}>Coverage</th></tr></thead><tbody>
            {c.files.filter((f) => f.covered < f.total).slice(0, 60).map((f) => (
              <tr key={f.file} style={{ cursor: 'pointer' }} onClick={() => setFile(file === f.file ? null : f.file)}>
                <td><div className="mono small">{f.file}</div><div className="muted small">{phaseName(f.phaseId)}</div>
                  {file === f.file && (
                    <ul className="plain small" style={{ marginTop: 6 }}>
                      {c.uncovered.filter((u) => u.file === f.file).map((u, i) => <li key={i}><Badge>{u.kind}</Badge> {u.kind === 'file' ? 'whole file' : u.name} {u.line && <span className="muted">:{u.line}</span>}</li>)}
                    </ul>
                  )}
                </td>
                <td><div className="stack" style={{ gap: 3 }}><Progress value={pct(f)} /><span className="muted small">{f.covered}/{f.total}</span></div></td>
              </tr>
            ))}
          </tbody></table>
          {!c.files.some((f) => f.covered < f.total) && <div className="muted">Everything is covered.</div>}
        </div>
      </div>
    </>
  );
}
