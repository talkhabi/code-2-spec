import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Item, type ItemDetail, type Phase } from '../api';
import { Badge, EvidenceList, Mermaid, StatusDot } from '../components/ui';

const VARIANTS = ['happy', 'alternate', 'error', 'edge'];
const TYPE_LABEL: Record<string, string> = {
  feature: 'Feature', journey: 'Journey', flow: 'Flow', rule: 'Rule', screen: 'Screen', entity: 'Entity', api: 'API', tech_note: 'Tech note',
  glossary: 'Term', system_journey: 'System journey',
};

export function SpecsPage() {
  const { id = '', itemId } = useParams();
  const [search] = useSearchParams();
  const phaseFilter = search.get('phase');
  const nav = useNavigate();
  const { data: phases } = useQuery({ queryKey: ['phases', id], queryFn: () => api<Phase[]>(`/projects/${id}/phases`) });
  const { data: items } = useQuery({ queryKey: ['items', id], queryFn: () => api<Item[]>(`/projects/${id}/items`), refetchInterval: 5000 });
  const [filter, setFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [openFeatures, setOpenFeatures] = useState<Record<string, boolean>>({});

  const tree = useMemo(() => {
    if (!items || !phases) return [];
    const q = filter.toLowerCase();
    const match = (i: Item) => (!q || i.title.toLowerCase().includes(q) || (i.summary ?? '').toLowerCase().includes(q)) && (!statusFilter || i.status === statusFilter);
    const groups = phases.filter((p) => !phaseFilter || p.id === phaseFilter).map((p) => {
      const features = items.filter((i) => i.phase_id === p.id && i.type === 'feature').map((f) => {
        const journeys = items.filter((j) => j.parent_id === f.id && j.type === 'journey').sort((a, b) => VARIANTS.indexOf(a.data.variant) - VARIANTS.indexOf(b.data.variant));
        return { feature: f, journeys: journeys.filter(match), visible: match(f) || journeys.some(match) };
      }).filter((x) => x.visible);
      const other = items.filter((i) => i.phase_id === p.id && ['entity', 'api', 'tech_note'].includes(i.type)).filter(match);
      return { phase: p, features, other };
    });
    const system = items.filter((i) => i.phase_id === null).filter(match);
    return { groups, system };
  }, [items, phases, filter, statusFilter, phaseFilter]) as { groups: { phase: Phase; features: { feature: Item; journeys: Item[] }[]; other: Item[] }[]; system: Item[] } | [];

  const go = (i: Item) => nav(`/p/${id}/specs/${i.id}${phaseFilter ? `?phase=${phaseFilter}` : ''}`);
  const selectedParent = items?.find((i) => i.id === itemId)?.parent_id;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Features & journeys</h1>
          <p>Everything the AI extracted. Review each item: approve, reject or edit.</p>
        </div>
        <div className="row">
          <input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All statuses</option><option value="pending">Pending</option><option value="approved">Approved</option>
            <option value="edited">Edited</option><option value="rejected">Rejected</option>
          </select>
          {phaseFilter && <Link className="btn" to={`/p/${id}/specs`}>All phases</Link>}
        </div>
      </div>
      {items && !items.length && <div className="card empty"><h2>Nothing documented yet</h2><p>Approve phases and run the <b>Analyze</b> stage.</p></div>}
      {!Array.isArray(tree) && items?.length ? (
        <div className="split">
          <div className="card tree">
            {tree.groups.map(({ phase, features, other }) => (
              <div key={phase.id}>
                <div className="tree-phase">{phase.name}</div>
                {features.map(({ feature, journeys }) => {
                  const open = openFeatures[feature.id] ?? (feature.id === itemId || feature.id === selectedParent || !!filter);
                  return (
                    <div key={feature.id}>
                      <div className={`tree-item ${feature.id === itemId ? 'active' : ''}`} onClick={() => { go(feature); setOpenFeatures({ ...openFeatures, [feature.id]: true }); }}>
                        <span className="muted small" onClick={(e) => { e.stopPropagation(); setOpenFeatures({ ...openFeatures, [feature.id]: !open }); }}>{open ? '▾' : '▸'}</span>
                        <StatusDot status={feature.status} />
                        <span className="truncate" style={{ flex: 1, fontWeight: 600 }}>{feature.title}</span>
                        <span className="badge">{journeys.length}</span>
                      </div>
                      {open && journeys.map((j) => (
                        <div key={j.id} className={`tree-item child ${j.id === itemId ? 'active' : ''}`} onClick={() => go(j)}>
                          <StatusDot status={j.status} />
                          <span className="truncate" style={{ flex: 1 }}>{j.title}</span>
                          <Badge kind={j.data.variant}>{j.data.variant}</Badge>
                        </div>
                      ))}
                    </div>
                  );
                })}
                {other.length > 0 && other.map((o) => (
                  <div key={o.id} className={`tree-item ${o.id === itemId ? 'active' : ''}`} onClick={() => go(o)}>
                    <StatusDot status={o.status} /><span className="muted small">{TYPE_LABEL[o.type]}</span><span className="truncate">{o.title}</span>
                  </div>
                ))}
              </div>
            ))}
            {tree.system.length > 0 && (
              <div>
                <div className="tree-phase">System (cross-phase)</div>
                {tree.system.map((o) => (
                  <div key={o.id} className={`tree-item ${o.id === itemId ? 'active' : ''}`} onClick={() => go(o)}>
                    <StatusDot status={o.status} /><span className="muted small">{TYPE_LABEL[o.type]}</span><span className="truncate">{o.title}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div>{itemId ? <ItemView projectId={id} itemId={itemId} onOpen={go} /> : <div className="card empty">Select a feature or journey.</div>}</div>
        </div>
      ) : null}
    </>
  );
}

function ReviewBar({ projectId, item, cascade }: { projectId: string; item: ItemDetail; cascade?: boolean }) {
  const qc = useQueryClient();
  const review = useMutation({
    mutationFn: (status: string) => api(`/projects/${projectId}/review`, { body: { ids: [item.id], status, cascade, comment: undefined } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['item', projectId] }); qc.invalidateQueries({ queryKey: ['items', projectId] }); qc.invalidateQueries({ queryKey: ['project', projectId] }); },
  });
  return (
    <div className="row">
      <Badge kind={item.status}>{item.status}</Badge>
      <button className="btn btn-sm btn-green" onClick={() => review.mutate('approved')}>Approve{cascade ? ' all' : ''}</button>
      <button className="btn btn-sm btn-red" onClick={() => review.mutate('rejected')}>Reject{cascade ? ' all' : ''}</button>
      {item.status !== 'pending' && <button className="btn btn-sm" onClick={() => review.mutate('pending')}>Reset</button>}
    </div>
  );
}

function ItemView({ projectId, itemId, onOpen }: { projectId: string; itemId: string; onOpen: (i: Item) => void }) {
  const { data: item } = useQuery({ queryKey: ['item', projectId, itemId], queryFn: () => api<ItemDetail>(`/projects/${projectId}/items/${itemId}`) });
  const [tab, setTab] = useState('details');
  if (!item) return <div className="muted">Loading…</div>;
  const isFeature = item.type === 'feature';
  const tabs = ['details', ...(item.gherkin ? ['gherkin'] : []), ...(item.playwright || item.data.playwright ? ['playwright'] : []), 'evidence', ...(item.relations.length ? ['relations'] : []), 'edit', 'history'];

  return (
    <div className="card card-pad">
      <div className="spread" style={{ alignItems: 'flex-start' }}>
        <div className="stack" style={{ gap: 4, minWidth: 0 }}>
          <div className="row small muted">
            <span>{TYPE_LABEL[item.type] ?? item.type}</span>
            {item.parent && <>· <a onClick={() => onOpen(item.parent!)} style={{ cursor: 'pointer' }}>{item.parent.title}</a></>}
            {item.confidence != null && <>· confidence {Math.round(item.confidence * 100)}%</>}
            · <span className="mono">{item.id}</span>
          </div>
          <h2 className="row">{item.title} {item.data.variant && <Badge kind={item.data.variant}>{item.data.variant}</Badge>}</h2>
        </div>
        <ReviewBar projectId={projectId} item={item} cascade={isFeature} />
      </div>
      <div className="tabs">
        {tabs.map((t) => <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}
      </div>
      {tab === 'details' && (isFeature ? <FeatureDetails item={item} onOpen={onOpen} /> : item.type === 'journey' ? <JourneyDetails item={item} /> : <GenericDetails item={item} />)}
      {tab === 'gherkin' && <pre className="code">{item.gherkin}</pre>}
      {tab === 'playwright' && <pre className="code">{item.playwright ?? item.data.playwright}</pre>}
      {tab === 'evidence' && <EvidenceList projectId={projectId} evidence={item.evidence} />}
      {tab === 'relations' && (
        <table><thead><tr><th>From</th><th>Relation</th><th>To</th><th>Note</th></tr></thead><tbody>
          {item.relations.map((r) => <tr key={r.id}><td>{r.from_title}</td><td><Badge>{r.kind}</Badge></td><td>{r.to_title}</td><td className="muted">{r.note}</td></tr>)}
        </tbody></table>
      )}
      {tab === 'edit' && <EditItem projectId={projectId} item={item} />}
      {tab === 'history' && (
        item.reviews.length ? <table><tbody>{item.reviews.map((r, i) => <tr key={i}><td><Badge kind={r.status}>{r.status}</Badge></td><td>{r.author}</td><td className="muted">{new Date(r.ts).toLocaleString()}</td><td>{r.comment}</td></tr>)}</tbody></table>
          : <div className="muted">No reviews yet.</div>
      )}
    </div>
  );
}

function FeatureDetails({ item, onOpen }: { item: ItemDetail; onOpen: (i: Item) => void }) {
  const by = (t: string) => item.children.filter((c) => c.type === t && c.status !== 'rejected');
  const journeys = by('journey').sort((a, b) => VARIANTS.indexOf(a.data.variant) - VARIANTS.indexOf(b.data.variant));
  return (
    <div>
      <p>{item.summary}</p>
      {item.data.actors?.length > 0 && <div className="small muted">Actors: {item.data.actors.join(', ')}</div>}
      <div className="section-title">Journeys ({journeys.length})</div>
      {journeys.map((j) => (
        <div key={j.id} className="journey-row" onClick={() => onOpen(j)}>
          <div className="row"><StatusDot status={j.status} /><span>{j.title}</span></div>
          <span className="muted small">{j.data.actor}</span>
          <Badge kind={j.data.variant}>{j.data.variant}</Badge>
        </div>
      ))}
      {by('rule').length > 0 && <>
        <div className="section-title">Business rules</div>
        <ul className="plain">{by('rule').map((r) => <li key={r.id}><b>{r.title}</b> — {r.summary}</li>)}</ul>
      </>}
      {by('flow').map((f) => (
        <div key={f.id}>
          <div className="section-title">Flow · {f.title}</div>
          <p className="small">{f.summary}</p>
          <Mermaid code={flowChart(f)} />
        </div>
      ))}
      {by('screen').length > 0 && <>
        <div className="section-title">Screens</div>
        {by('screen').map((s) => (
          <div key={s.id} style={{ marginBottom: 8 }}>
            <b>{s.title}</b> {s.data.route && <code className="badge">{s.data.route}</code>}
            <div className="small">{s.summary}</div>
            {s.data.states?.length > 0 && <div className="small muted">States: {s.data.states.join(' · ')}</div>}
          </div>
        ))}
      </>}
    </div>
  );
}

function flowChart(f: Item) {
  const esc = (s: string) => s.replace(/["`]/g, "'").replace(/[<>{}[\]|]/g, ' ').slice(0, 70);
  const steps: { layer: string; description: string }[] = f.data.steps ?? [];
  return ['flowchart TD', ...steps.map((s, i) => `  s${i}["${esc(`${s.layer}: ${s.description}`)}"]${i ? `\n  s${i - 1} --> s${i}` : ''}`)].join('\n');
}

function JourneyDetails({ item }: { item: ItemDetail }) {
  const d = item.data;
  return (
    <div>
      <div className="row small muted">Actor: <b>{d.actor}</b>{d.trigger && <> · Trigger: {d.trigger}</>}</div>
      <p><b>Goal:</b> {d.goal}</p>
      {d.preconditions?.length > 0 && <><div className="section-title">Preconditions</div><ul className="plain">{d.preconditions.map((p: string, i: number) => <li key={i}>{p}</li>)}</ul></>}
      <div className="section-title">Steps</div>
      <ol className="steps">
        {(d.steps ?? []).map((s: any, i: number) => (
          <li key={i}><Badge kind={s.actor === 'user' ? 'alternate' : undefined}>{s.actor}</Badge> {s.action}{s.expected && <span className="muted"> → {s.expected}</span>}</li>
        ))}
      </ol>
      {d.outcomes?.length > 0 && <><div className="section-title">Outcomes</div><ul className="plain">{d.outcomes.map((o: string, i: number) => <li key={i}>{o}</li>)}</ul></>}
      {d.postconditions?.length > 0 && <><div className="section-title">Postconditions</div><ul className="plain">{d.postconditions.map((o: string, i: number) => <li key={i}>{o}</li>)}</ul></>}
      {d.openQuestions?.length > 0 && <div className="notice" style={{ marginTop: 12 }}><b>Open questions</b><ul className="plain">{d.openQuestions.map((o: string, i: number) => <li key={i}>{o}</li>)}</ul></div>}
      <div className="section-title">Scenarios ({(d.scenarios ?? []).length})</div>
      <ul className="plain">{(d.scenarios ?? []).map((s: any, i: number) => <li key={i}>{s.name}</li>)}</ul>
    </div>
  );
}

function GenericDetails({ item }: { item: ItemDetail }) {
  const d = item.data;
  return (
    <div className="stack">
      {item.summary && <p style={{ margin: 0 }}>{item.summary}</p>}
      {item.type === 'entity' && d.fields?.length > 0 && (
        <table><thead><tr><th>Field</th><th>Type</th><th>Notes</th></tr></thead>
          <tbody>{d.fields.map((f: any) => <tr key={f.name}><td className="mono">{f.name}</td><td className="mono">{f.type}</td><td>{f.notes}</td></tr>)}</tbody></table>
      )}
      {item.type === 'api' && <>
        {d.request && <><div className="section-title">Request</div><pre className="code">{d.request}</pre></>}
        {d.response && <><div className="section-title">Response</div><pre className="code">{d.response}</pre></>}
        {d.errors?.length > 0 && <ul className="plain">{d.errors.map((e: any, i: number) => <li key={i}><code>{e.status}</code> {e.meaning}</li>)}</ul>}
      </>}
      {item.type === 'system_journey' && (
        <ol className="steps">{(d.steps ?? []).map((s: any, i: number) => <li key={i}><span className="mono small">{s.journeyId}</span> {s.note}</li>)}</ol>
      )}
      {!['entity', 'api', 'system_journey'].includes(item.type) && Object.keys(d).length > 0 && <pre className="code">{JSON.stringify(d, null, 2)}</pre>}
    </div>
  );
}

function EditItem({ projectId, item }: { projectId: string; item: ItemDetail }) {
  const qc = useQueryClient();
  const [text, setText] = useState(() => JSON.stringify({ title: item.title, summary: item.summary, data: item.data }, null, 2));
  const [comment, setComment] = useState('');
  const [err, setErr] = useState('');
  const save = useMutation({
    mutationFn: (body: object) => api(`/projects/${projectId}/items/${item.id}`, { method: 'PATCH', body }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['item', projectId] }); qc.invalidateQueries({ queryKey: ['items', projectId] }); },
  });
  return (
    <div className="stack">
      <div className="muted small">Edit the item as JSON. Saving marks it as <b>edited</b> (human-owned; re-analysis keeps it) and re-renders the spec files.</div>
      <textarea style={{ minHeight: 360 }} value={text} onChange={(e) => setText(e.target.value)} />
      <input placeholder="Review comment (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
      {err && <div className="notice err">{err}</div>}
      {save.isSuccess && <div className="small" style={{ color: 'var(--green)' }}>Saved.</div>}
      <div>
        <button className="btn btn-primary" onClick={() => {
          try { setErr(''); save.mutate({ ...JSON.parse(text), comment }); } catch (e) { setErr(`Invalid JSON: ${(e as Error).message}`); }
        }}>Save changes</button>
      </div>
    </div>
  );
}
