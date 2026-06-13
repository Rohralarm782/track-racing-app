import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type Category, type Team } from '../api/client';
import { useAdmin } from '../components/Layout';
import TeamBulkEntry from '../components/TeamBulkEntry';

export default function CategoryDetail() {
  const { id }                    = useParams<{ id: string }>();
  const [category, setCategory]   = useState<Category | null>(null);
  const [loading, setLoading]     = useState(true);
  const [showImport, setShowImport] = useState(false);
  const { isAdmin }               = useAdmin();

  function load() {
    if (!id) return;
    setLoading(true);
    api.get<Category>(`/api/categories/${id}`).then(setCategory).finally(() => setLoading(false));
  }

  useEffect(load, [id]);

  function handleImportSuccess(teams: Team[]) {
    setShowImport(false);
    setCategory(prev => prev ? { ...prev, teams } : prev);
  }

  if (loading) return (
    <div className="page container"><div className="loading"><span className="spinner" /> Lädt…</div></div>
  );
  if (!category) return (
    <div className="page container"><div className="alert alert-error">Kategorie nicht gefunden.</div></div>
  );

  const teams = category.teams ?? [];
  const isTeamPairs = category.format === 'TEAM_PAIRS';

  return (
    <div className="page container">
      {/* Breadcrumb */}
      <div className="breadcrumb">
        <Link to="/">Veranstaltungen</Link>
        <span>›</span>
        {category.event && <><Link to={`/events/${category.event.id}`}>{category.event.name}</Link><span>›</span></>}
        {category.name}
      </div>

      <div className="flex-between mb-4">
        <div>
          <h1>{category.name}</h1>
          <p className="text-sm text-muted" style={{ margin: '2px 0 0' }}>
            {isTeamPairs ? 'Madison / Mannschaft' : 'Einzelrennen'}
            {' · '}{teams.length} {isTeamPairs ? 'Teams' : 'Teilnehmer'}
          </p>
        </div>
        {isAdmin && !showImport && (
          <button className="btn btn-primary" onClick={() => setShowImport(true)}>
            {teams.length === 0 ? '+ Startliste einpflegen' : '✎ Startliste bearbeiten'}
          </button>
        )}
      </div>

      {/* ── Bulk import form ── */}
      {showImport && (
        <div className="card mb-4">
          <div className="flex-between mb-3">
            <h2 style={{ margin: 0 }}>Startliste einpflegen</h2>
          </div>
          <TeamBulkEntry
            categoryId={category.id}
            format={category.format}
            existingTeams={teams}
            onSuccess={handleImportSuccess}
            onCancel={() => setShowImport(false)}
          />
        </div>
      )}

      {/* ── Team list ── */}
      {!showImport && (
        teams.length === 0 ? (
          <div className="empty">
            <p>Noch keine Startliste eingetragen.</p>
            {isAdmin && (
              <button className="btn btn-primary" onClick={() => setShowImport(true)}>
                Startliste einpflegen
              </button>
            )}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 56 }}>Nr.</th>
                  <th>{isTeamPairs ? 'Team' : 'Fahrer'}</th>
                  {isTeamPairs && <th>Fahrer</th>}
                </tr>
              </thead>
              <tbody>
                {teams.map(team => (
                  <tr key={team.id}>
                    <td className="num" style={{ fontWeight: 600 }}>{team.number}</td>
                    <td>{team.name}</td>
                    {isTeamPairs && (
                      <td className="text-muted">
                        {team.rider1 && team.rider2
                          ? `${team.rider1} / ${team.rider2}`
                          : team.rider1 ?? '—'}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* ── Races section — placeholder for Phase 2 ── */}
      {!showImport && teams.length > 0 && (
        <div className="mt-4">
          <div className="section-header">
            <h2 style={{ margin: 0 }}>Rennen</h2>
            {isAdmin && (
              <button className="btn btn-secondary btn-sm" disabled title="Folgt in Phase 2">
                + Rennen (kommt)
              </button>
            )}
          </div>
          <div className="card" style={{ borderStyle: 'dashed', color: 'var(--c-text-muted)' }}>
            <p className="text-sm" style={{ margin: 0 }}>
              Rennen anlegen und Ergebnisse eintragen — folgt in Phase 2.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
