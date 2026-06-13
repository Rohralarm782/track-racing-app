import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type Category, type Team } from '../api/client';
import { useAdmin } from '../components/Layout';
import TeamBulkEntry from '../components/TeamBulkEntry';

const RACE_TYPE_OPTIONS = [
  { value: 'PUNKTEFAHREN',      label: 'Punktefahren / Madison' },
  { value: 'TEMPORUNDEN',       label: 'Temporunden' },
  { value: 'VERFOLGUNGSRENNEN', label: 'Verfolgungsrennen' },
] as const;

const STATUS_BADGE: Record<string,string> = { SETUP:'badge-gray', ACTIVE:'badge-yellow', FINISHED:'badge-green' };
const STATUS_LABEL: Record<string,string> = { SETUP:'Vorbereitung', ACTIVE:'Laeuft', FINISHED:'Fertig' };

export default function CategoryDetail() {
  const { id }                       = useParams<{ id: string }>();
  const navigate                     = useNavigate();
  const [category, setCategory]      = useState<Category|null>(null);
  const [loading, setLoading]        = useState(true);
  const [showImport, setShowImport]  = useState(false);
  const [showNewRace, setShowNewRace] = useState(false);
  const [raceName, setRaceName]      = useState('');
  const [raceType, setRaceType]      = useState<string>('PUNKTEFAHREN');
  const [raceFormat, setRaceFormat]  = useState<string>('INDIVIDUAL');
  const [savingRace, setSavingRace]  = useState(false);
  const [raceError, setRaceError]    = useState('');
  const { isAdmin }                  = useAdmin();

  function load() {
    if (!id) return;
    setLoading(true);
    api.get<Category>(`/api/categories/${id}`).then(setCategory).finally(()=>setLoading(false));
  }

  useEffect(load, [id]);

  function handleImportSuccess(teams: Team[]) {
    setShowImport(false);
    setCategory(prev => prev ? {...prev, teams} : prev);
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

  if (loading) return <div className="page container"><div className="loading"><span className="spinner" /> Laedt...</div></div>;
  if (!category) return <div className="page container"><div className="alert alert-error">Kategorie nicht gefunden.</div></div>;

  const teams = category.teams ?? [];
  const races = category.races ?? [];
  const isTeamPairs = category.format === 'TEAM_PAIRS';

  return (
    <div className="page container">
      <div className="breadcrumb">
        <Link to="/">Veranstaltungen</Link><span>›</span>
        {category.event && (<><Link to={`/events/${category.event.id}`}>{category.event.name}</Link><span>›</span></>)}
        {category.name}
      </div>

      <div className="flex-between mb-4">
        <div>
          <h1>{category.name}</h1>
          <p className="text-sm text-muted" style={{margin:'2px 0 0'}}>
            {isTeamPairs ? 'Madison / Mannschaft' : 'Einzelrennen'}
            {' - '}{teams.length} {isTeamPairs ? 'Teams' : 'Teilnehmer'}
          </p>
        </div>
        {isAdmin && !showImport && (
          <button className="btn btn-secondary btn-sm" onClick={()=>setShowImport(true)}>
            {teams.length === 0 ? '+ Startliste' : 'Startliste bearbeiten'}
          </button>
        )}
      </div>

      {showImport && (
        <div className="card mb-4">
          <div className="flex-between mb-3"><h2 style={{margin:0}}>Startliste einpflegen</h2></div>
          <TeamBulkEntry categoryId={category.id} format={category.format} existingTeams={teams}
            onSuccess={handleImportSuccess} onCancel={()=>setShowImport(false)} />
        </div>
      )}

      {!showImport && (
        <>
          <div className="section-header" style={{marginBottom:10}}>
            <h2 style={{margin:0}}>Rennen</h2>
            {isAdmin && teams.length > 0 && (
              <button className="btn btn-primary btn-sm" onClick={()=>setShowNewRace(!showNewRace)}>
                {showNewRace ? 'X' : '+ Rennen anlegen'}
              </button>
            )}
          </div>

          {showNewRace && (
            <div className="card mb-3" style={{borderColor:'#bfdbfe',background:'#f0f7ff'}}>
              {raceError && <div className="alert alert-error">{raceError}</div>}
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:12}}>
                <div className="form-group" style={{margin:0}}>
                  <label className="form-label">Name</label>
                  <input className="form-input" type="text" value={raceName}
                    onChange={e=>setRaceName(e.target.value)}
                    placeholder="z.B. Punktefahren 1"
                    onKeyDown={e=>e.key==='Enter'&&createRace()} autoFocus />
                </div>
                <div className="form-group" style={{margin:0}}>
                  <label className="form-label">Typ</label>
                  <select className="form-select" value={raceType} onChange={e=>setRaceType(e.target.value)}>
                    {RACE_TYPE_OPTIONS.map(o=>(
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group" style={{margin:0}}>
                  <label className="form-label">Format</label>
                  <select className="form-select" value={raceFormat} onChange={e=>setRaceFormat(e.target.value)}>
                    <option value="INDIVIDUAL">Einzeldisziplin</option>
                    <option value="TEAM_PAIRS">Madison</option>
                  </select>
                </div>
              </div>
              <div className="flex-between mt-3">
                <button className="btn btn-ghost btn-sm" onClick={()=>{setShowNewRace(false);setRaceError('');}}>Abbrechen</button>
                <button className="btn btn-primary" onClick={createRace} disabled={savingRace||!raceName}>
                  {savingRace ? 'Erstelle...' : 'Rennen anlegen'}
                </button>
              </div>
            </div>
          )}

          {races.length===0 ? (
            <div className="empty">
              <p>Noch keine Rennen angelegt.</p>
              {isAdmin && teams.length===0 && <p className="text-sm">Zuerst die Startliste einpflegen.</p>}
            </div>
          ) : (
            <div style={{display:'flex',flexDirection:'column',gap:8,marginBottom:24}}>
              {races.map(race=>(
                <Link key={race.id} to={`/races/${race.id}`} className="card card-link" style={{display:'block'}}>
                  <div className="flex-between">
                    <div className="flex-center gap-2">
                      <h3>{race.name}</h3>
                      <span className={`badge ${STATUS_BADGE[race.status]}`} style={{fontSize:11}}>
                        {STATUS_LABEL[race.status]}
                      </span>
                    </div>
                    <span className="badge badge-gray" style={{fontSize:11}}>
                      {race.type==='PUNKTEFAHREN'?'Punktefahren':race.type==='TEMPORUNDEN'?'Temporunden':'Verfolgung'}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}

          {teams.length > 0 && (
            <>
              <h2 style={{marginBottom:8}}>
                {isTeamPairs?'Teams':'Startliste'}
                <span className="text-muted text-sm" style={{fontWeight:400,marginLeft:8}}>({teams.length})</span>
              </h2>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{width:56}}>Nr.</th>
                      <th>{isTeamPairs?'Team':'Fahrer'}</th>
                      {isTeamPairs && <th>Fahrer</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {teams.map(team=>(
                      <tr key={team.id}>
                        <td className="num" style={{fontWeight:600}}>{team.number}</td>
                        <td>{team.name}</td>
                        {isTeamPairs && (
                          <td className="text-muted">
                            {team.rider1&&team.rider2?`${team.rider1} / ${team.rider2}`:team.rider1??'-'}
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
