import { NavLink, Route, Routes, useMatch } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type ProjectSummary } from './api';
import { ProjectsPage } from './pages/Projects';
import { OverviewPage } from './pages/Overview';
import { PhasesPage } from './pages/Phases';
import { SpecsPage } from './pages/Specs';
import { RelationsPage } from './pages/Relations';
import { CoveragePage } from './pages/Coverage';
import { ExportPage } from './pages/Export';

function Sidebar() {
  const match = useMatch('/p/:id/*');
  const id = match?.params.id;
  const { data } = useQuery({ queryKey: ['project', id], queryFn: () => api<ProjectSummary>(`/projects/${id}`), enabled: !!id, refetchInterval: 3000 });
  const link = (to: string, label: string, count?: number | string) => (
    <NavLink to={to} end className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
      <span>{label}</span>
      {count !== undefined && <span className="badge">{count}</span>}
    </NavLink>
  );
  return (
    <aside className="sidebar">
      <NavLink to="/" className="brand"><span className="brand-mark">{'</>'}</span>code2spec</NavLink>
      {link('/', 'Projects')}
      {id && data && (
        <>
          <div className="nav-section truncate" title={data.name}>{data.name}</div>
          {link(`/p/${id}`, 'Overview')}
          {link(`/p/${id}/phases`, 'Phases', data.phases.total)}
          {link(`/p/${id}/specs`, 'Features & journeys', data.items.journeys)}
          {link(`/p/${id}/relations`, 'Relations')}
          {link(`/p/${id}/coverage`, 'Coverage', data.coverage != null ? `${data.coverage}%` : undefined)}
          {link(`/p/${id}/export`, 'Export')}
        </>
      )}
    </aside>
  );
}

export function App() {
  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <Routes>
          <Route path="/" element={<ProjectsPage />} />
          <Route path="/p/:id" element={<OverviewPage />} />
          <Route path="/p/:id/phases" element={<PhasesPage />} />
          <Route path="/p/:id/specs" element={<SpecsPage />} />
          <Route path="/p/:id/specs/:itemId" element={<SpecsPage />} />
          <Route path="/p/:id/relations" element={<RelationsPage />} />
          <Route path="/p/:id/coverage" element={<CoveragePage />} />
          <Route path="/p/:id/export" element={<ExportPage />} />
        </Routes>
      </main>
    </div>
  );
}
