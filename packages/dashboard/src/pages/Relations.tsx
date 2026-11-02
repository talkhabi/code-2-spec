import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ReactFlow, Background, Controls, MarkerType, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api, type Item, type Phase, type Relation } from '../api';
import { Badge, Mermaid } from '../components/ui';

const KIND_COLOR: Record<string, string> = {
  depends_on: '#6366f1', continues_journey: '#16a34a', shares_entity: '#0891b2', triggers: '#a855f7', duplicates: '#d97706', conflicts: '#dc2626',
};

export function RelationsPage() {
  const { id = '' } = useParams();
  const { data: relations } = useQuery({ queryKey: ['relations', id], queryFn: () => api<Relation[]>(`/projects/${id}/relations`) });
  const { data: phases } = useQuery({ queryKey: ['phases', id], queryFn: () => api<Phase[]>(`/projects/${id}/phases`) });
  const { data: items } = useQuery({ queryKey: ['items', id], queryFn: () => api<Item[]>(`/projects/${id}/items`) });

  const { nodes, edges } = useMemo(() => {
    if (!relations || !phases) return { nodes: [] as Node[], edges: [] as Edge[] };
    const ids = [...new Set(relations.flatMap((r) => [r.from_id, r.to_id]))];
    const meta = new Map<string, { title: string; phase: string | null; type: string }>();
    for (const r of relations) {
      meta.set(r.from_id, { title: r.from_title, phase: r.from_phase, type: r.from_type });
      meta.set(r.to_id, { title: r.to_title, phase: r.to_phase, type: r.to_type });
    }
    const columns = [...phases.map((p) => p.id), null];
    const rowInCol = new Map<string | null, number>();
    const nodes: Node[] = ids.map((nid) => {
      const m = meta.get(nid)!;
      const col = Math.max(0, columns.indexOf(m.phase));
      const row = rowInCol.get(m.phase) ?? 0;
      rowInCol.set(m.phase, row + 1);
      return {
        id: nid, position: { x: col * 280, y: row * 90 + (col % 2) * 30 },
        data: { label: `${m.title}` }, style: { width: 220, fontSize: 12, borderRadius: 8, background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)' },
      };
    });
    const edges: Edge[] = relations.map((r) => ({
      id: String(r.id), source: r.from_id, target: r.to_id, label: r.kind.replace('_', ' '),
      style: { stroke: KIND_COLOR[r.kind] ?? '#888' }, labelStyle: { fontSize: 10, fill: 'var(--text)' }, labelBgStyle: { fill: 'var(--surface-2)' }, markerEnd: { type: MarkerType.ArrowClosed, color: KIND_COLOR[r.kind] },
      animated: r.kind === 'conflicts',
    }));
    return { nodes, edges };
  }, [relations, phases]);

  const systemJourneys = items?.filter((i) => i.type === 'system_journey') ?? [];
  const byId = new Map(items?.map((i) => [i.id, i]) ?? []);
  const issues = relations?.filter((r) => r.kind === 'conflicts' || r.kind === 'duplicates') ?? [];
  const phaseName = (pid: string | null) => phases?.find((p) => p.id === pid)?.name ?? 'System';

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Relations</h1>
          <p>How journeys connect across phases: dependencies, hand-offs, shared entities, duplicates and conflicts.</p>
        </div>
      </div>
      {!relations?.length && <div className="card empty"><h2>No relations yet</h2><p>Run the <b>Synthesize</b> stage after analysis.</p></div>}
      {relations && relations.length > 0 && (
        <>
          <div className="card" style={{ height: 460, marginBottom: 16 }}>
            <ReactFlow nodes={nodes} edges={edges} fitView colorMode="system" proOptions={{ hideAttribution: true }}>
              <Background /><Controls />
            </ReactFlow>
          </div>
          <div className="row" style={{ marginBottom: 16 }}>
            {Object.entries(KIND_COLOR).map(([k, c]) => <span key={k} className="row small"><span className="dot" style={{ background: c }} />{k.replace('_', ' ')}</span>)}
          </div>
        </>
      )}
      {issues.length > 0 && (
        <div className="card card-pad" style={{ marginBottom: 16 }}>
          <h2 style={{ marginBottom: 8 }}>Needs attention ({issues.length})</h2>
          <table><tbody>{issues.map((r) => (
            <tr key={r.id}><td><Badge kind={r.kind === 'conflicts' ? 'error' : 'edge'}>{r.kind}</Badge></td>
              <td><Link to={`/p/${id}/specs/${r.from_id}`}>{r.from_title}</Link></td><td><Link to={`/p/${id}/specs/${r.to_id}`}>{r.to_title}</Link></td><td className="muted">{r.note}</td></tr>
          ))}</tbody></table>
        </div>
      )}
      {systemJourneys.length > 0 && (
        <>
          <h2 style={{ margin: '8px 0 10px' }}>System journeys</h2>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))' }}>
            {systemJourneys.map((sj) => (
              <div key={sj.id} className="card card-pad stack">
                <div className="spread"><h3>{sj.title}</h3><Badge>{sj.data.actor}</Badge></div>
                <div className="muted small">{sj.summary}</div>
                <Mermaid code={['flowchart LR', ...(sj.data.steps ?? []).map((s: any, i: number) => `  j${i}["${(byId.get(s.journeyId)?.title ?? s.journeyId).replace(/["[\]{}<>|]/g, ' ')}"]${i ? `\n  j${i - 1} --> j${i}` : ''}`)].join('\n')} />
              </div>
            ))}
          </div>
        </>
      )}
      {relations && relations.length > 0 && (
        <div className="card card-pad" style={{ marginTop: 16 }}>
          <h2 style={{ marginBottom: 8 }}>All relations</h2>
          <table><thead><tr><th>From</th><th>Relation</th><th>To</th><th>Note</th></tr></thead><tbody>
            {relations.map((r) => (
              <tr key={r.id}>
                <td><Link to={`/p/${id}/specs/${r.from_id}`}>{r.from_title}</Link><div className="muted small">{phaseName(r.from_phase)}</div></td>
                <td><Badge>{r.kind}</Badge></td>
                <td><Link to={`/p/${id}/specs/${r.to_id}`}>{r.to_title}</Link><div className="muted small">{phaseName(r.to_phase)}</div></td>
                <td className="muted small">{r.note}</td>
              </tr>
            ))}
          </tbody></table>
        </div>
      )}
    </>
  );
}
