import { useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Evidence } from '../api';

export function Badge({ kind, children }: { kind?: string; children: React.ReactNode }) {
  return <span className={`badge ${kind ? `b-${kind}` : ''}`}>{children}</span>;
}

export function StatusDot({ status }: { status: string }) {
  return <span className={`dot ${status}`} title={status} />;
}

export function Stat({ value, label }: { value: React.ReactNode; label: string }) {
  return (
    <div className="card stat">
      <div className="v">{value}</div>
      <div className="l">{label}</div>
    </div>
  );
}

export function Progress({ value }: { value: number }) {
  return <div className="progress"><span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>;
}

let mermaidReady: Promise<typeof import('mermaid').default> | undefined;
function loadMermaid() {
  mermaidReady ??= import('mermaid').then((m) => {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    m.default.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'neutral', securityLevel: 'strict', fontFamily: 'inherit' });
    return m.default;
  });
  return mermaidReady;
}

export function Mermaid({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId().replace(/:/g, '');
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    loadMermaid()
      .then((m) => m.render(`m${id}`, code))
      .then(({ svg }) => { if (!cancelled && ref.current) ref.current.innerHTML = svg; })
      .catch((e) => !cancelled && setError(String(e.message ?? e)));
    return () => { cancelled = true; };
  }, [code, id]);
  if (error) return <pre className="code small">{code}</pre>;
  return <div className="mermaid-box" ref={ref} />;
}

export function CodePreview({ projectId, ev }: { projectId: string; ev: Evidence }) {
  const { data, error } = useQuery({
    queryKey: ['code', projectId, ev.file, ev.startLine, ev.endLine],
    queryFn: () => api<{ start: number; lines: string[] }>(`/projects/${projectId}/code?path=${encodeURIComponent(ev.file)}${ev.startLine ? `&start=${ev.startLine}&end=${ev.endLine ?? ev.startLine}` : '&end=60'}`),
  });
  if (error) return <div className="notice err small">{String((error as Error).message)}</div>;
  if (!data) return <div className="muted small">Loading…</div>;
  return (
    <div className="code"><div className="code-lines mono">
      {data.lines.map((l, i) => {
        const n = data.start + i;
        const hl = ev.startLine && n >= ev.startLine && n <= (ev.endLine ?? ev.startLine);
        return [<span key={`n${n}`} className={`ln ${hl ? 'hl' : ''}`}>{n}</span>, <span key={`c${n}`} className={hl ? 'hl' : ''}>{l || ' '}</span>];
      })}
    </div></div>
  );
}

export function EvidenceList({ projectId, evidence }: { projectId: string; evidence: Evidence[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!evidence.length) return <div className="muted small">No evidence recorded.</div>;
  return (
    <div className="stack">
      {evidence.map((e, i) => (
        <div key={i}>
          <button className="btn btn-sm" onClick={() => setOpen(open === i ? null : i)}>
            <span className="mono">{e.file}{e.startLine ? `:${e.startLine}${e.endLine && e.endLine !== e.startLine ? `-${e.endLine}` : ''}` : ''}</span>
            {e.symbol && <span className="muted">({e.symbol})</span>}
          </button>
          {e.note && <span className="muted small"> {e.note}</span>}
          {open === i && <div style={{ marginTop: 6 }}><CodePreview projectId={projectId} ev={e} /></div>}
        </div>
      ))}
    </div>
  );
}

export function timeAgo(ts?: string) {
  if (!ts) return '';
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}
