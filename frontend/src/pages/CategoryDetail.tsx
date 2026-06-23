import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAdmin } from '../components/Layout';
import TeamBulkEntry, { type DetectedScore } from '../components/TeamBulkEntry';
import MadisonTeamBuilder from '../components/MadisonTeamBuilder';

const RACE_TYPE_OPTIONS = [
  { value: 'PUNKTEFAHREN',      label: 'Punktefahren / Madison' },
  { value: 'TEMPORUNDEN',       label: 'Temporunden' },
  { value: 'VERFOLGUNGSRENNEN', label: 'Verfolgungsrennen' },
] as const;

const STATUS_BADGE: Record<string, string> = { SETUP: 'badge-gray', ACTIVE: 'badge-yellow', FINISHED: 'badge-green' };
const STATUS_LABEL: Record<string, string> = { SETUP: 'Vorbereitung', ACTIVE: 'Läuft', FINISHED: 'Fertig' };

const STRATEGY_OPTIONS = [
  { value: 'import',  label: 'Importierte Punkte verwenden',  hint: 'Vorhandene Werte werden überschrieben' },
  { value: 'keep',    label: 'Vorhandene Punkte behalten',    hint: 'Nur fehlende Fahrer werden ergänzt' },
  { value: 'higher',  label: 'Jeweils die höhere Punktzahl',  hint: 'Sichere Standardoption' },
] as const;

type Strategy = 'import' | 'keep' | 'higher';

export default function CategoryDetail() {
  const { id }                        = useParams<{ id: string }>();
  const navigate                      = useNavigate();
  const [category, setCategory]       = useState<Category | null>(null);
  const [loading, setLoading]         = useState(true);
  const [showImport, setShowImport]           = useState(false);
  const [showMadisonBuilder, setShowMadisonBuilder] = useState(false);  // ← NEU
  const [showNewRace, setShowNewRace] = useState(false);
  const [raceName, setRaceName]       = useState('');
  const [raceType, setRaceType]       = useState<string>('PUNKTEFAHREN');
  const [raceFormat, setRaceFormat]   = useState<string>('INDIVIDUAL');
  const [savingRace, setSavingRace]   = useState(false);
  const [raceError, setRaceError]     = useState('');
  const { isAdmin }                   = useAdmin();

  // ── Score-Import nach Startlisten-Upload ───────────────────────────────────
  const [pendingScores, setPendingScores]     = useState<DetectedScore[]>([]);
  const [showScoreImport, setShowScoreImport] = useState(false);
  const [scoreRaceId, setScoreRaceId]         = useState('');
  const [scoreStrategy, setScoreStrategy]     = useState<Strategy>('import');
  const [savingScores, setSavingScores]       = useState(false);
  const [scoreError, setScoreError]           = useState('');

  // ── Inline-Bearbeitung einzelner Fahrer ───────────────────────────────────
  interface EditValues { number: number; name: string; club: string; rider1: string; rider2: string; }
  const [editingTeamId, setEditingTeamId] = useState<string | null>(null);
  const [editValues, setEditValues]       = useState<EditValues>({ number: 0, name: '', club: '', rider1: '', rider2: '' });
  const [savingEdit, setSavingEdit]       = useState(false);
  const [editError, setEditError]         = useState('');

  function startEdit(team: Team) {
    setEditingTeamId(team.id);
    setEditValues({
      number: team.number,
      name:   team.name,
      club:   team.club   ?? '',
      rider1: team.rider1 ?? '',
      rider2: team.rider2 ?? '',
    });
    setEditError('');
  }

  function cancelEdit() { setEditingTeamId(null); setEditError(''); }

  async function saveEdit(teamId: string) {
    setSavingEdit(true); setEditError('');
    try {
      await api.patch(`/api/teams/${teamId}`, {
        number: editValues.number,
        name:   editValues.name,
        club:   editValues.club   || null,
        rider1: editValues.rider1 || null,
        rider2: editValues.rider2 || null,
      });
      setEditingTeamId(null);
      load();
    } catch (e: any) {
      setEditError(e.message ?? 'Fehler beim Speichern');
    } finally {
      setSavingEdit(false);
    }
  }

  async function deleteTeam(teamId: string, teamName: string) {
    if (!confirm(`"${teamName}" wirklich aus der Startliste entfernen?`)) return;
    try {
      await api.delete(`/api/teams/${teamId}`);
      load();
    } catch (e: any) {
      alert(e.message ?? 'Fehler beim Löschen');
    }
  }

  function load() {
    if (!id) return;
    setLoading(true);
    api.get<Category>(`/api/categories/${id}`).then(setCategory).finally(() => setLoading(false));
  }
  useEffect(load, [id]);

  function handleImportSuccess(teams: Team[], scores?: DetectedScore[]) {
    setShowImport(false);
    setCategory(prev => prev ? { ...prev, teams } : prev);

    const races = category?.races ?? [];
    if (scores && scores.length > 0 && races.length > 0) {
      setPendingScores(scores);
      setScoreRaceId(races[0].id);
      setScoreStrategy('import');
      setScoreError('');
      setShowScoreImport(true);
    } else if (scores && scores.length > 0) {
      console.info('Omnium-Punkte erkannt, aber noch kein Rennen vorhanden. Punkte werden nicht gespeichert.');
    }
  }

  async function saveDetectedScores() {
    if (!scoreRaceId || pendingScores.length === 0) return;
    setSavingScores(true); setScoreError('');
    try {
      const teams = category?.teams ?? [];
      const teamMap = new Map(teams.map(t => [t.number, t.id]));
      const scores = pendingScores
        .filter(s => teamMap.has(s.number))
        .map(s => ({ teamId: teamMap.get(s.number)!, points: s.points }));

      if (scores.length === 0) throw new Error('Keine Fahrer konnten zugeordnet werden.');

      await api.post(`/api/races/${scoreRaceId}/omnium`, { scores, strategy: scoreStrategy });
      setShowScoreImport(false);
      setPendingScores([]);
    } catch (e: any) {
      setScoreError(e.message ?? 'Fehler beim Speichern');
    } finally {
      setSavingScores(false);
    }
  }

  function dismissScoreImport() {
    setShowScoreImport(false);
    setPendingScores([]);
  }

  async function toggleFavorite(teamId: string) {
    await api.patch(`/api/teams/${teamId}/favorite`, {});
    load();
  }

  async function createRace() {
    if (!raceName || !id) return;
    setSavingRace(true); setRaceError('');
    try {
      const race = await api.post<{ id: string }>('/api/races', {
        categoryId: id, type: raceType, name: raceName, format: raceFormat,
        order: (category?.races?.length ?? 0),
      });
      navigate(`/races/${race.id}`);
    } catch (e: any) { setRaceError(e.message ?? 'Fehler'); setSavingRace(false); }
  }

  async function deleteRace(raceId: string, raceName: string) {
    if (!confirm(`Rennen "${raceName}" wirklich löschen? Alle Sprints und Ergebnisse werden ebenfalls gelöscht.`)) return;
    try {
      await api.delete(`/api/races/${raceId}`);
      load();
    } catch (e: any) { alert(e.message ?? 'Fehler beim Löschen'); }
  }

  if (loading) return <div className="page container"><div className="loading"><span className="spinner" /> Lädt…</div></div>;
  if (!category) return <div className="page container"><div className="alert alert-error">Kategorie nicht gefunden.</div></div>;

  const teams       = category.teams ?? [];
  const races       = category.races ?? [];
  const isTeamPairs = category.format === 'TEAM_PAIRS';
  const anyPanelOpen = showImport || showMadisonBuilder;

  return (
    <div className="page container">

      {/* ── Score-Import-Dialog ──────────────────────────────────────────── */}
      {showScoreImport && (
        <div className="modal-overlay" onClick={dismissScoreImport}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <p className="modal-title">Omnium-Punkte importieren</p>
            <p className="text-sm text-muted" style={{ marginBottom: 18 }}>
              {pendingScores.length} Fahrer mit Punkten erkannt. In welches Rennen sollen sie eingetragen werden?
            </p>

            {races.length > 1 && (
              <div className="form-group">
                <label className="form-label">Rennen</label>
                <select className="form-select" value={scoreRaceId} onChange={e => setScoreRaceId(e.target.value)}>
                  {races.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </div>
            )}
            {races.length === 1 && (
              <div className="alert alert-info" style={{ marginBottom: 14 }}>
                Rennen: <strong>{races[0].name}</strong>
              </div>
            )}

            <div className="form-group" style={{ marginBottom: 20 }}>
              <label className="form-label">Bei vorhandenen Punkten</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {STRATEGY_OPTIONS.map(opt => (
                  <label key={opt.value} onClick={() => setScoreStrategy(opt.value)}
                    style={{
                      display: 'flex', gap: 12, alignItems: 'flex-start', cursor: 'pointer',
                      border: scoreStrategy === opt.value ? '2px solid var(--c-primary)' : '1px solid var(--c-border)',
                      borderRadius: 7, padding: scoreStrategy === opt.value ? '10px 13px' : '11px 14px',
                      background: scoreStrategy === opt.value ? '#eff6ff' : 'var(--c-white)',
                      transition: 'all .15s',
                    }}
                  >
                    <input type="radio" name="scoreStrategy" value={opt.value}
                      checked={scoreStrategy === opt.value} onChange={() => setScoreStrategy(opt.value)}
                      style={{ marginTop: 3, flexShrink: 0 }} />
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 1 }}>{opt.label}</div>
                      <div style={{ fontSize: 12, color: 'var(--c-text-muted)' }}>{opt.hint}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {scoreError && <div className="alert alert-error">{scoreError}</div>}
            <div className="flex-between">
              <button className="btn btn-ghost" onClick={dismissScoreImport}>Überspringen</button>
              <button className="btn btn-primary" onClick={saveDetectedScores} disabled={savingScores}>
                {savingScores ? 'Speichert…' : `${pendingScores.length} Punkte importieren`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Breadcrumb & Header ──────────────────────────────────────────── */}
      <div className="breadcrumb">
        <Link to="/">Veranstaltungen</Link><span>›</span>
        {category.event && <><Link to={`/events/${category.event.id}`}>{category.event.name}</Link><span>›</span></>}
        {category.name}
      </div>

      <div className="flex-between mb-4">
        <div>
          <h1>{category.name}</h1>
          <p className="text-sm text-muted" style={{ margin: '2px 0 0' }}>
            {isTeamPairs ? 'Madison / Mannschaft' : 'Einzelrennen'} · {teams.length} Teilnehmer
          </p>
        </div>
        {/* ── Header-Buttons ── */}
        {isAdmin && !anyPanelOpen && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary btn-sm" onClick={() => setShowMadisonBuilder(true)}>
              🔀 Teams aufbauen
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => setShowImport(true)}>
              {teams.length === 0 ? '+ Startliste' : 'Startliste bearbeiten'}
            </button>
          </div>
        )}
      </div>

      {/* ── Madison-Team-Builder ─────────────────────────────────────────── */}
      {showMadisonBuilder && (
        <div className="card mb-4">
          <div className="flex-between mb-3">
            <h2 style={{ margin: 0 }}>🔀 Madison-Teams aufbauen</h2>
            <button className="btn btn-ghost btn-sm" onClick={() => setShowMadisonBuilder(false)}>✕ Schließen</button>
          </div>
          <MadisonTeamBuilder
            categoryId={category.id}
            categoryName={category.name}
            categoryFormat={category.format}
            eventId={category.event?.id ?? ''}
            existingTeams={teams}
            onSuccess={(_, targetCategoryId) => {
              setShowMadisonBuilder(false);
              if (targetCategoryId !== category.id) navigate(`/categories/${targetCategoryId}`);
              else load();
            }}
            onCancel={() => setShowMadisonBuilder(false)}
          />
        </div>
      )}

      {/* ── Startliste bearbeiten (TeamBulkEntry) ────────────────────────── */}
      {showImport && (
        <div className="card mb-4">
          <div className="flex-between mb-3">
            <h2 style={{ margin: 0 }}>Startliste bearbeiten</h2>
            <button className="btn btn-ghost btn-sm" onClick={() => { setShowImport(false); cancelEdit(); }}>
              ✕ Schließen
            </button>
          </div>

          {teams.length > 0 && (
            <>
              {editError && <div className="alert alert-error mb-3">{editError}</div>}
              <div className="table-wrap" style={{ marginBottom: 20 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ width: 60 }}>Nr.</th>
                      <th>{isTeamPairs ? 'Team' : 'Fahrer'}</th>
                      {(isTeamPairs || teams.some(t => t.club)) && <th>Verein</th>}
                      {isTeamPairs && <th>Fahrer</th>}
                      <th style={{ width: 80 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {teams.map(team => editingTeamId === team.id ? (
                      <tr key={team.id} style={{ background: '#f0f7ff' }}>
                        <td>
                          <input type="number" className="form-input" style={{ width: 56, padding: '4px 6px', fontSize: 13 }}
                            value={editValues.number}
                            onChange={e => setEditValues(v => ({ ...v, number: parseInt(e.target.value) || 0 }))} />
                        </td>
                        <td>
                          <input type="text" className="form-input" style={{ padding: '4px 8px', fontSize: 13 }}
                            value={editValues.name}
                            onChange={e => setEditValues(v => ({ ...v, name: e.target.value }))}
                            onKeyDown={e => { if (e.key === 'Enter') saveEdit(team.id); if (e.key === 'Escape') cancelEdit(); }}
                            autoFocus />
                        </td>
                        {(isTeamPairs || teams.some(t => t.club)) && (
                          <td>
                            <input type="text" className="form-input" style={{ padding: '4px 8px', fontSize: 13 }}
                              value={editValues.club} placeholder="Verein"
                              onChange={e => setEditValues(v => ({ ...v, club: e.target.value }))} />
                          </td>
                        )}
                        {isTeamPairs && (
                          <td>
                            <div style={{ display: 'flex', gap: 4 }}>
                              <input type="text" className="form-input" style={{ padding: '4px 8px', fontSize: 12 }}
                                value={editValues.rider1} placeholder="Fahrer 1"
                                onChange={e => setEditValues(v => ({ ...v, rider1: e.target.value }))} />
                              <input type="text" className="form-input" style={{ padding: '4px 8px', fontSize: 12 }}
                                value={editValues.rider2} placeholder="Fahrer 2"
                                onChange={e => setEditValues(v => ({ ...v, rider2: e.target.value }))} />
                            </div>
                          </td>
                        )}
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <button className="btn btn-primary btn-sm" style={{ marginRight: 4 }}
                            onClick={() => saveEdit(team.id)} disabled={savingEdit || !editValues.name} title="Speichern">
                            {savingEdit ? '…' : '✓'}
                          </button>
                          <button className="btn btn-ghost btn-sm" onClick={cancelEdit} title="Abbrechen">✗</button>
                        </td>
                      </tr>
                    ) : (
                      <tr key={team.id}>
                        <td className="num" style={{ fontWeight: 600 }}>{team.number}</td>
                        <td>{team.name}</td>
                        {(isTeamPairs || teams.some(t => t.club)) && (
                          <td className="text-muted text-sm">{team.club ?? ''}</td>
                        )}
                        {isTeamPairs && (
                          <td className="text-muted text-sm">
                            {team.rider1 && team.rider2 ? `${team.rider1} / ${team.rider2}` : team.rider1 ?? '—'}
                          </td>
                        )}
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <button className="btn btn-ghost btn-sm" style={{ marginRight: 4 }}
                            onClick={() => startEdit(team)} title="Bearbeiten">✏</button>
                          <button className="btn btn-ghost btn-sm" style={{ color: 'var(--c-danger)' }}
                            onClick={() => deleteTeam(team.id, team.name)} title="Löschen">🗑</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ borderTop: '1px solid var(--c-border)', paddingTop: 16, marginBottom: 12 }}>
                <h3 style={{ margin: '0 0 12px', color: 'var(--c-text-muted)', fontSize: 13, fontWeight: 500 }}>
                  Oder neue Startliste importieren
                </h3>
              </div>
            </>
          )}

          <TeamBulkEntry
            categoryId={category.id}
            format={category.format}
            existingTeams={teams}
            onSuccess={handleImportSuccess}
            onCancel={() => setShowImport(false)}
          />
        </div>
      )}

      {/* ── Rennen & Startliste (Hauptinhalt) ────────────────────────────── */}
      {!anyPanelOpen && (
        <>
          <div className="section-header" style={{ marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>Rennen</h2>
            {isAdmin && teams.length > 0 && (
              <button className="btn btn-primary btn-sm" onClick={() => setShowNewRace(!showNewRace)}>
                {showNewRace ? 'X' : '+ Rennen anlegen'}
              </button>
            )}
          </div>

          {showNewRace && (
            <div className="card mb-3" style={{ borderColor: '#bfdbfe', background: '#f0f7ff' }}>
              {raceError && <div className="alert alert-error">{raceError}</div>}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Name</label>
                  <input className="form-input" type="text" value={raceName}
                    onChange={e => setRaceName(e.target.value)} placeholder="z.B. Punktefahren 1"
                    onKeyDown={e => e.key === 'Enter' && createRace()} autoFocus />
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Typ</label>
                  <select className="form-select" value={raceType} onChange={e => setRaceType(e.target.value)}>
                    {RACE_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Format</label>
                  <select className="form-select" value={raceFormat} onChange={e => setRaceFormat(e.target.value)}>
                    <option value="INDIVIDUAL">Einzeldisziplin</option>
                    <option value="TEAM_PAIRS">Madison</option>
                  </select>
                </div>
              </div>
              <div className="flex-between mt-3">
                <button className="btn btn-ghost btn-sm" onClick={() => { setShowNewRace(false); setRaceError(''); }}>Abbrechen</button>
                <button className="btn btn-primary" onClick={createRace} disabled={savingRace || !raceName}>
                  {savingRace ? 'Erstelle…' : 'Rennen anlegen'}
                </button>
              </div>
            </div>
          )}

          {races.length === 0 ? (
            <div className="empty"><p>Noch keine Rennen angelegt.</p></div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 24 }}>
              {races.map(race => (
                <div key={race.id} className="card" style={{ display: 'block' }}>
                  <div className="flex-between">
                    <Link to={`/races/${race.id}`} className="flex-center gap-2" style={{ textDecoration: 'none', flex: 1 }}>
                      <h3>{race.name}</h3>
                      <span className={`badge ${STATUS_BADGE[race.status]}`} style={{ fontSize: 11 }}>
                        {STATUS_LABEL[race.status]}
                      </span>
                    </Link>
                    <div className="flex-center gap-2">
                      <span className="badge badge-gray" style={{ fontSize: 11 }}>
                        {race.type === 'PUNKTEFAHREN' ? 'Punktefahren' : race.type === 'TEMPORUNDEN' ? 'Temporunden' : 'Verfolgung'}
                      </span>
                      {isAdmin && (
                        <button className="btn btn-ghost btn-sm" style={{ color: 'var(--c-danger)', fontSize: 11 }}
                          onClick={() => deleteRace(race.id, race.name)}>
                          Löschen
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {teams.length > 0 && (
            <>
              <h2 style={{ marginBottom: 8 }}>
                {isTeamPairs ? 'Teams' : 'Startliste'}
                <span className="text-muted text-sm" style={{ fontWeight: 400, marginLeft: 8 }}>({teams.length})</span>
              </h2>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ width: 32 }}></th>
                      <th style={{ width: 56 }}>Nr.</th>
                      <th>{isTeamPairs ? 'Team' : 'Fahrer'}</th>
                      {teams.some(t => t.club) && <th>Verein</th>}
                      {isTeamPairs && <th>Fahrer</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {teams.map(team => (
                      <tr key={team.id} style={{ background: team.isFavorite ? '#fffbeb' : '' }}>
                        <td style={{ textAlign: 'center' }}>
                          {isAdmin ? (
                            <button type="button" onClick={() => toggleFavorite(team.id)}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}>
                              {team.isFavorite ? '⭐' : '☆'}
                            </button>
                          ) : team.isFavorite ? '⭐' : ''}
                        </td>
                        <td className="num" style={{ fontWeight: 600 }}>{team.number}</td>
                        <td>{team.name}</td>
                        {teams.some(t => t.club) && <td className="text-muted text-sm">{team.club ?? ''}</td>}
                        {isTeamPairs && (
                          <td className="text-muted">
                            {team.rider1 && team.rider2 ? `${team.rider1} / ${team.rider2}` : team.rider1 ?? '—'}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
