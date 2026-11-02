import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Phase } from '../api';
import { Badge } from '../components/ui';

export function PhasesPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const { data: phases } = useQuery({ queryKey: ['phases', id], queryFn: () => api<Phase[]>(`/projects/${id}/phases`), refetchInterval: 3000 });
  const [selected, setSelected] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string; description: string } | null>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['phases', id] }); qc.invalidateQueries({ queryKey: ['project', id] }); };

  const patch = useMutation({ mutationFn: ({ phaseId, body }: { phaseId: string; body: object }) => api(`/projects/${id}/phases/${phaseId}`, { method: 'PATCH', body }), onSuccess: refresh });
  const approveAll = useMutation({ mutationFn: () => api(`/projects/${id}/phases/approve-all`, { body: { status: 'approved' } }), onSuccess: refresh });
  const merge = useMutation({
    mutationFn: () => api(`/projects/${id}/phases/merge`, { body: { ids: selected, name: prompt('Name of the merged phase?') ?? undefined } }),
    onSuccess: () => { setSelected([]); refresh(); },
  });
  const analyze = useMutation({ mutationFn: (phaseIds?: string[]) => api(`/projects/${id}/stages/analyze/run`, { body: { phases: phaseIds } }), onSuccess: refresh });
  const split = useMutation({
    mutationFn: ({ phaseId, files, name }: { phaseId: string; files: string[]; name: string }) => api(`/projects/${id}/phases/${phaseId}/split`, { body: { name, files } }),
    onSuccess: refresh,
  });
  const [splitFiles, setSplitFiles] = useState<string[]>([]);

  if (!phases) return <div className="muted">Loading…</div>;
  const pending = phases.filter((p) => p.status === 'pending').length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Phases</h1>
          <p>Bounded contexts proposed by the AI from the code graph. Approve, rename, merge or split before analysis.</p>
        </div>
        <div className="row">
          {selected.length >= 2 && <button className="btn" onClick={() => merge.mutate()}>Merge {selected.length}</button>}
          <button className="btn" disabled={!pending} onClick={() => approveAll.mutate()}>Approve all pending ({pending})</button>
          <button className="btn btn-primary" disabled={!phases.some((p) => p.status === 'approved' && p.analysis_status !== 'done')} onClick={() => analyze.mutate(undefined)}>Analyze approved</button>
        </div>
      </div>
      {analyze.error && <div className="notice err" style={{ marginBottom: 12 }}>{String(analyze.error.message)}</div>}
      {!phases.length && <div className="card empty"><h2>No phases yet</h2><p>Run the <b>Partition</b> stage from the overview.</p></div>}
      <div className="stack">
        {phases.map((ph, idx) => (
          <div key={ph.id} className="card card-pad stack">
            <div className="spread">
              <div className="row" style={{ minWidth: 0 }}>
                <input type="checkbox" checked={selected.includes(ph.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, ph.id] : selected.filter((x) => x !== ph.id))} />
                <span className="muted mono small">{String(idx + 1).padStart(2, '0')}</span>
                {editing?.id === ph.id ? (
                  <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                ) : <h2>{ph.name}</h2>}
                <Badge kind={ph.status}>{ph.status}</Badge>
                {ph.analysis_status !== 'pending' && <Badge kind={ph.analysis_status}>analysis {ph.analysis_status}</Badge>}
              </div>
              <div className="row">
                {editing?.id === ph.id ? (
                  <>
                    <button className="btn btn-sm btn-primary" onClick={() => { patch.mutate({ phaseId: ph.id, body: { name: editing.name, description: editing.description } }); setEditing(null); }}>Save</button>
                    <button className="btn btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                  </>
                ) : <button className="btn btn-sm" onClick={() => setEditing({ id: ph.id, name: ph.name, description: ph.description ?? '' })}>Edit</button>}
                {ph.status !== 'approved' && <button className="btn btn-sm btn-green" onClick={() => patch.mutate({ phaseId: ph.id, body: { status: 'approved' } })}>Approve</button>}
                {ph.status !== 'rejected' && <button className="btn btn-sm btn-red" onClick={() => patch.mutate({ phaseId: ph.id, body: { status: 'rejected' } })}>Reject</button>}
                {ph.status === 'approved' && <button className="btn btn-sm" onClick={() => analyze.mutate([ph.id])}>{ph.analysis_status === 'done' ? 'Re-analyze' : 'Analyze'}</button>}
              </div>
            </div>
            {editing?.id === ph.id ? (
              <textarea style={{ minHeight: 70, fontFamily: 'inherit' }} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            ) : <div>{ph.description}</div>}
            <div className="row small muted">
              <span>{ph.files.length} files</span>·<span>{ph.counts.features} features</span>·<span>{ph.counts.journeys} journeys</span>
              {ph.counts.pending > 0 && <>·<span>{ph.counts.pending} items to review</span></>}
              {ph.counts.features > 0 && <>·<Link to={`/p/${id}/specs?phase=${ph.id}`}>Browse specs →</Link></>}
            </div>
            {ph.entry_points.length > 0 && <div className="row small">{ph.entry_points.map((e) => <code key={e} className="badge">{e}</code>)}</div>}
            <div>
              <button className="btn btn-sm" onClick={() => { setExpanded(expanded === ph.id ? null : ph.id); setSplitFiles([]); }}>{expanded === ph.id ? 'Hide files' : 'Show files'}</button>
            </div>
            {expanded === ph.id && (
              <div className="stack">
                <div className="code" style={{ maxHeight: 300 }}>
                  {ph.files.map((f) => (
                    <label key={f} className="row mono small" style={{ gap: 6 }}>
                      <input type="checkbox" checked={splitFiles.includes(f)} onChange={(e) => setSplitFiles(e.target.checked ? [...splitFiles, f] : splitFiles.filter((x) => x !== f))} />{f}
                    </label>
                  ))}
                </div>
                {splitFiles.length > 0 && (
                  <div><button className="btn btn-sm" onClick={() => { const name = prompt('Name of the new phase?'); if (name) split.mutate({ phaseId: ph.id, files: splitFiles, name }); }}>Split {splitFiles.length} file(s) into a new phase</button></div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
