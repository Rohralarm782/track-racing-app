import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useAdmin } from '../components/Layout';

interface Team { id: string; number: number; name: string; rider1?: string|null; rider2?: string|null; }
interface SprintResult { id: string; position: number; team: Team; }
interface Sprint { id: string; number: number; isFinale: boolean; results: SprintResult[]; }
interface LapEvent { id: string; delta: number; createdAt: string; team: Team; }
interface OmniumScore { id: string; points: number; team: Team; }
interface TeamStanding {
  teamId: string; teamNumber: number; teamName: string;
  rider1?: string|null; rider2?: string|null;
  total: number; sprintPoints: number; lapPoints: number; omniumPoints: number;
  wins: number; seconds: number; thirds: number; fourths: number;
  lapBalance: number; finalePosition?: number | null;
}
interface Race {
  id: string; name: string; type: string; status: string; finaleActive: boolean;
  format?: string|null;
  category: { id: string; name: string; format: string; teams: Team[]; event: { id: string; name: string } };
  sprints: Sprint[]; lapEvents: LapEvent[]; omniumScores: OmniumScore[];
  scoreboard: TeamStanding[]|null;
}

const SPRINT_PTS: Record<number, number> = { 1: 5, 2: 3, 3: 2, 4: 1 };

function sprintPts(sprint: Sprint, teamId: string): number|null {
  const r = sprint.results.find(r => r.team.id === teamId);
  if (!r) return null;
  return (SPRINT_PTS[r.position] ?? 0) * (sprint.isFinale ? 2 : 1);
}

type SlotEntry = { teamId: string; teamNumber: number; teamName: string }|null;

export default function RaceDetail() {
  const { id }      = useParams<{ id: string }>();
  const { isAdmin } = useAdmin();
  const [race, setRace]       = useState<Race|null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  // Sprint entry
  const [entryOpen, setEntryOpen]       = useState(false);
  const [editingSprintId, setEditingId] = useState<string|null>(null);
  const [slots, setSlots]               = useState<SlotEntry[]>([null,null,null,null]);
  const [activeSlot, setActiveSlot]     = useState(0);
  const [isFinale, setIsFinale]         = useState(false);
  const [savingSprint, setSavingSprint] = useState(false);

  // Lap entry — Multi-Select
  const [lapDelta, setLapDelta]                   = useState<1|-1>(1);
  const [lapPickerOpen, setLapPickerOpen]         = useState(false);
  const [selectedLapIds, setSelectedLapIds]       = useState<Set<string>>(new Set());
  const [savingLap, setSavingLap]                 = useState(false);

  // Omnium
  const [omniumOpen, setOmniumOpen]     = useState(false);
  const [omniumValues, setOmniumValues] = useState<Record<string,string>>({});
  const [savingOmnium, setSavingOmnium] = useState(false);

  const fetchRace = useCallback(async () => {
    if (!id) return;
    try {
      const data = await api.get<Race>(`/api/races/${id}`);
      setRace(data);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [id]);

  useEffect(() => {
    fetchRace();
    const t = setInterval(fetchRace, 6000);
    return () => clearInterval(t);
  }, [fetchRace]);

  // ── Sprint ────────────────────────────────────────────────────────────────────
  function openNew() {
    setSlots([null,null,null,null]);
    setActiveSlot(0); setIsFinale(false); setEditingId(null); setEntryOpen(true);
  }

  function openEdit(sprint: Sprint) {
    const teams = race?.category.teams ?? [];
    const numSlots = sprint.isFinale ? teams.length : 4;
    const s: SlotEntry[] = Array(numSlots).fill(null);
    for (const r of sprint.results)
      if (r.position - 1 < numSlots)
        s[r.position-1] = { teamId: r.team.id, teamNumber: r.team.number, teamName: r.team.name };
    setSlots(s); setIsFinale(sprint.isFinale); setEditingId(sprint.id);
    const firstEmpty = s.findIndex(x => x === null);
    setActiveSlot(firstEmpty === -1 ? 0 : firstEmpty);
    setEntryOpen(true);
  }

  function handleFinaleToggle(checked: boolean) {
    const teams = race?.category.teams ?? [];
    setIsFinale(checked);
    if (checked) {
      const newSlots: SlotEntry[] = Array(teams.length).fill(null);
      slots.forEach((s, i) => { if (i < newSlots.length) newSlots[i] = s; });
      setSlots(newSlots);
      if (activeSlot >= teams.length) setActiveSlot(0);
    } else {
      setSlots([slots[0]??null, slots[1]??null, slots[2]??null, slots[3]??null]);
      if (activeSlot > 3) setActiveSlot(0);
    }
  }

  function selectTeam(team: Team) {
    const ns = [...slots];
    ns[activeSlot] = { teamId: team.id, teamNumber: team.number, teamName: team.name };
    setSlots(ns);
    const next = ns.findIndex((x, i) => i > activeSlot && x === null);
    if (next !== -1) setActiveSlot(next);
  }

  async function saveSprint() {
    const results = slots.flatMap((s,i) => s ? [{ teamId: s.teamId, position: i+1 }] : []);
    if (results.length === 0 || !id) return;
    setSavingSprint(true); setError('');
    try {
      const payload = { isFinale, results };
      if (editingSprintId) await api.put(`/api/sprints/${editingSprintId}`, payload);
      else await api.post(`/api/races/${id}/sprints`, payload);
      setEntryOpen(false); await fetchRace();
    } catch (e: any) { setError(e.message); }
    finally { setSavingSprint(false); }
  }

  async function deleteSprint(sid: string) {
    if (!confirm('Sprint löschen?')) return;
    await api.delete(`/api/sprints/${sid}`); await fetchRace();
  }

  // ── Laps — Multi-Select ───────────────────────────────────────────────────────
  function openLapPicker(delta: 1|-1) {
    setLapDelta(delta);
    setSelectedLapIds(new Set());
    setLapPickerOpen(true);
  }

  function toggleLapTeam(teamId: string) {
    setSelectedLapIds(prev => {
      const next = new Set(prev);
      if (next.has(teamId)) next.delete(teamId);
      else next.add(teamId);
      return next;
    });
  }

  async function saveSelectedLaps() {
    if (!id || selectedLapIds.size === 0) return;
    setSavingLap(true);
    try {
      await Promise.all(
        [...selectedLapIds].map(teamId =>
          api.post(`/api/races/${id}/laps`, { teamId, delta: lapDelta })
        )
      );
      setLapPickerOpen(false);
      setSelectedLapIds(new Set());
      await fetchRace();
    } catch (e: any) { setError(e.message); }
    finally { setSavingLap(false); }
  }

  async function deleteLap(lid: string) {
    await api.delete(`/api/laps/${lid}`); await fetchRace();
  }

  // ── Omnium ────────────────────────────────────────────────────────────────────
  function openOmnium() {
    if (!race) return;
    const init: Record<string,string> = {};
    for (const t of race.category.teams)
      init[t.id] = String(race.omniumScores.find(o => o.team.id === t.id)?.points ?? 0);
    setOmniumValues(init); setOmniumOpen(true);
  }

  async function saveOmnium() {
    if (!id) return; setSavingOmnium(true);
    try {
      await api.post(`/api/races/${id}/omnium`, {
        scores: Object.entries(omniumValues).map(([teamId,pts]) => ({ teamId, points: parseInt(pts)||0 })),
      });
      setOmniumOpen(false); await fetchRace();
    } catch (e: any) { setError(e.message); }
    finally { setSavingOmnium(false); }
  }

  // ── Render ────────────────────────────────────────────────────────────────────
  if (loading) return <div className="page container"><div className="loading"><span className="spinner" /> Lädt…</div></div>;
  if (!race) return <div className="page container"><div className="alert alert-error">{error||'Nicht gefunden'}</div></div>;

  const { category } = race;
  const teams = category.teams;
  const displayFormat = (race.format ?? category.format) as string;
  const nextNum = (race.sprints[race.sprints.length-1]?.number ?? 0) + 1;
  const usedIds = new Set(slots.filter(Boolean).map(s => s!.teamId));
  const hasOmnium = race.omniumScores.length > 0;
  const hasFinale = race.sprints.some(s => s.isFinale);
  const filledSlots = slots.filter(Boolean).length;
  const canSkip = slots.findIndex((s, i) => i > activeSlot && s === null) !== -1;

  return (
    <div className="page container">
      <div className="breadcrumb">
        <Link to="/">Veranstaltungen</Link><span>›</span>
        <Link to={`/events/${category.event.id}`}>{category.event.name}</Link><span>›</span>
        <Link to={`/categories/${category.id}`}>{category.name}</Link><span>›</span>
        {race.name}
      </div>

      <div className="flex-between mb-4">
        <div>
          <h1>{race.name}</h1>
          <p className="text-sm text-muted" style={{margin:'2px 0 0'}}>
            {category.name} · {race.sprints.length} Sprint{race.sprints.length!==1?'s':''}
          </p>
        </div>
        {isAdmin && (
          <div style={{display:'flex',gap:8}}>
            <button className="btn btn-secondary btn-sm" onClick={openOmnium}>Omnium-Vorpunkte</button>
            {!entryOpen && <button className="btn btn-primary" onClick={openNew}>+ Sprint {nextNum}</button>}
          </div>
        )}
      </div>

      {error && <div className="alert alert-error mb-3">{error}</div>}

      {/* ── Sprint entry / edit ── */}
      {isAdmin && entryOpen && (
        <div className="card mb-4" style={{borderColor:'#bfdbfe',background:'#f0f7ff'}}>
          <div className="flex-between" style={{marginBottom:12}}>
            <h3>{editingSprintId ? 'Sprint bearbeiten' : `Sprint ${nextNum}`}</h3>
            <label style={{display:'flex',alignItems:'center',gap:6,fontSize:13,cursor:'pointer'}}>
              <input type="checkbox" checked={isFinale} onChange={e=>handleFinaleToggle(e.target.checked)} />
              Finale (doppelte Punkte)
            </label>
          </div>

          <div style={{
            display:'grid',
            gridTemplateColumns: isFinale ? 'repeat(auto-fill, minmax(60px, 1fr))' : 'repeat(4, 1fr)',
            gap: isFinale ? 4 : 8, marginBottom:14,
            maxHeight: isFinale ? 180 : 'none', overflowY: isFinale ? 'auto' : 'visible',
          }}>
            {slots.map((slot,i) => (
              <div key={i} onClick={()=>setActiveSlot(i)} style={{
                border: activeSlot===i ? '2px solid var(--c-primary)' : '1px solid var(--c-border)',
                borderRadius: isFinale ? 6 : 8, padding: isFinale ? '4px 3px' : '8px 6px',
                cursor:'pointer', textAlign:'center',
                background: activeSlot===i ? '#dbeafe' : slot ? '#f0fff4' : 'white',
              }}>
                <div style={{fontSize:9,color:'var(--c-text-muted)',marginBottom:isFinale?1:3}}>{i+1}.</div>
                <div style={{fontWeight:600,fontSize:isFinale?13:15}}>{slot ? slot.teamNumber : '—'}</div>
                {!isFinale && (
                  <div style={{fontSize:11,color:'var(--c-text-muted)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                    {slot ? slot.teamName : ''}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div style={{marginBottom:12}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
              <span className="text-xs text-muted">{activeSlot+1}. Platz wählen:</span>
              {canSkip && (
                <button type="button" className="btn btn-ghost btn-sm" style={{fontSize:11,padding:'3px 8px'}}
                  onClick={()=>{const next=slots.findIndex((s,i)=>i>activeSlot&&s===null);if(next!==-1)setActiveSlot(next);}}>
                  Überspringen →
                </button>
              )}
            </div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(72px,1fr))',gap:6}}>
              {teams.map(team => {
                const used = usedIds.has(team.id) && slots[activeSlot]?.teamId !== team.id;
                const selected = slots[activeSlot]?.teamId === team.id;
                return (
                  <button key={team.id} type="button" onClick={()=>!used&&selectTeam(team)}
                    style={{padding:'8px 4px',borderRadius:7,cursor:used?'not-allowed':'pointer',textAlign:'center',
                      border:selected?'2px solid var(--c-primary)':'1px solid var(--c-border)',
                      background:used?'#f3f4f6':selected?'#dbeafe':'var(--c-white)',opacity:used?0.4:1}}>
                    <div style={{fontWeight:700,fontSize:16}}>{team.number}</div>
                    <div style={{fontSize:10,color:'var(--c-text-muted)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{team.name}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex-between">
            <div style={{display:'flex',alignItems:'center',gap:12}}>
              <button className="btn btn-ghost" onClick={()=>setEntryOpen(false)}>Abbrechen</button>
              {isFinale && filledSlots > 0 && filledSlots < teams.length && (
                <span className="text-xs text-muted">{filledSlots}/{teams.length} Teams eingetragen</span>
              )}
              {!isFinale && filledSlots > 0 && filledSlots < 4 && (
                <span className="text-xs text-muted">{4-filledSlots} Platz/Plätze leer — später bearbeiten</span>
              )}
            </div>
            <button className="btn btn-primary" onClick={saveSprint} disabled={filledSlots===0||savingSprint}>
              {savingSprint ? 'Speichert…' : editingSprintId ? 'Änderungen speichern' : 'Sprint speichern ✓'}
            </button>
          </div>
        </div>
      )}

      {/* ── Lap tracker ── */}
      {isAdmin && !entryOpen && (
        <div className="card mb-4">
          <h3 style={{marginBottom:10}}>Rundenwertung</h3>
          <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
            <button className="btn btn-secondary" onClick={()=>openLapPicker(1)}
              style={{borderColor:'var(--c-success)',color:'var(--c-success)'}}>
              + Runde gewonnen
            </button>
            <button className="btn btn-secondary" onClick={()=>openLapPicker(-1)}
              style={{borderColor:'var(--c-danger)',color:'var(--c-danger)'}}>
              − Runde verloren
            </button>
          </div>
          {race.lapEvents.length > 0 && (
            <div style={{marginTop:12}}>
              <div className="text-xs text-muted" style={{marginBottom:4}}>Letzte Ereignisse</div>
              {[...race.lapEvents].reverse().slice(0,5).map(lap => (
                <div key={lap.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'4px 0',borderBottom:'1px solid var(--c-border)',fontSize:13}}>
                  <span>
                    <span style={{color:lap.delta>0?'var(--c-success)':'var(--c-danger)',fontWeight:600}}>{lap.delta>0?'+1':'-1'}</span>
                    {' · '}{lap.team.number} {lap.team.name}
                  </span>
                  <button className="btn btn-ghost btn-sm" style={{fontSize:11}} onClick={()=>deleteLap(lap.id)}>
                    Rückgängig
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Lap picker modal — Multi-Select ── */}
      {lapPickerOpen && (
        <div className="modal-overlay" onClick={()=>setLapPickerOpen(false)}>
          <div className="modal" style={{maxWidth:520}} onClick={e=>e.stopPropagation()}>
            <p className="modal-title">
              {lapDelta>0?'+ Runde gewonnen':'− Runde verloren'} — Teams wählen
            </p>
            <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(84px,1fr))',gap:8,marginBottom:16}}>
              {teams.map(team => {
                const sel = selectedLapIds.has(team.id);
                return (
                  <button key={team.id} type="button"
                    onClick={()=>toggleLapTeam(team.id)}
                    style={{
                      padding:'10px 6px', borderRadius:8, textAlign:'center', cursor:'pointer',
                      border: sel ? '2px solid var(--c-primary)' : '1px solid var(--c-border)',
                      background: sel ? '#dbeafe' : 'var(--c-white)',
                      transition:'all 0.1s',
                    }}>
                    <div style={{fontWeight:700,fontSize:20,color:sel?'var(--c-primary)':'var(--c-text)'}}>{team.number}</div>
                    <div style={{fontSize:11,color:'var(--c-text-muted)',marginTop:2}}>{team.name}</div>
                    {sel && <div style={{fontSize:10,color:'var(--c-primary)',marginTop:2,fontWeight:600}}>✓</div>}
                  </button>
                );
              })}
            </div>
            <div className="flex-between">
              <button className="btn btn-ghost" onClick={()=>setLapPickerOpen(false)}>Abbrechen</button>
              <button className="btn btn-primary" onClick={saveSelectedLaps}
                disabled={selectedLapIds.size===0||savingLap}>
                {savingLap
                  ? 'Speichert…'
                  : selectedLapIds.size===0
                    ? 'Team auswählen'
                    : `Bestätigen (${selectedLapIds.size} Team${selectedLapIds.size>1?'s':''})`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Omnium modal ── */}
      {omniumOpen && (
        <div className="modal-overlay" onClick={()=>setOmniumOpen(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <p className="modal-title">Omnium-Vorpunkte</p>
            <div style={{maxHeight:320,overflowY:'auto'}}>
              {teams.map(team => (
                <div key={team.id} style={{display:'flex',alignItems:'center',gap:12,marginBottom:8}}>
                  <span style={{flex:1,fontSize:13}}><strong>{team.number}</strong> {team.name}</span>
                  <input type="number" className="form-input" style={{width:80}}
                    value={omniumValues[team.id]??'0'}
                    onChange={e=>setOmniumValues(p=>({...p,[team.id]:e.target.value}))} />
                </div>
              ))}
            </div>
            <div className="flex-between mt-4">
              <button className="btn btn-ghost" onClick={()=>setOmniumOpen(false)}>Abbrechen</button>
              <button className="btn btn-primary" onClick={saveOmnium} disabled={savingOmnium}>
                {savingOmnium?'Speichert…':'Speichern'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Scoreboard ── */}
      {race.scoreboard && race.scoreboard.length > 0 && (
        <div className="mb-4">
          <div className="section-header" style={{marginBottom:8}}>
            <h2 style={{margin:0}}>Zwischenstand</h2>
            <span className="text-xs text-muted">aktualisiert alle 6s</span>
          </div>
          <div className="table-wrap" style={{overflowX:'auto'}}>
            <table className="table" style={{minWidth:220+race.sprints.length*48+(hasOmnium?48:0)+(hasFinale?36:0)}}>
              <thead>
                <tr>
                  <th style={{width:28}}>#</th>
                  <th style={{width:40}}>Nr.</th>
                  <th style={{minWidth:100}}>Name</th>
                  {race.sprints.map(s=>(
                    <th key={s.id} style={{textAlign:'center',width:48,fontSize:11}}>
                      {s.isFinale?<span>S{s.number}<span style={{color:'var(--c-warning)'}}>★</span></span>:`S${s.number}`}
                    </th>
                  ))}
                  {hasFinale && <th style={{textAlign:'center',width:36,fontSize:11}} title="Finale-Platzierung">F.</th>}
                  <th style={{textAlign:'center',width:52}}>R.</th>
                  {hasOmnium && <th style={{textAlign:'center',width:48}}>Omn.</th>}
                  <th style={{textAlign:'right',width:52}}>Ges.</th>
                </tr>
              </thead>
              <tbody>
                {race.scoreboard.map((s,idx)=>(
                  <tr key={s.teamId}>
                    <td style={{color:'var(--c-text-muted)',fontSize:12}}>{idx+1}</td>
                    <td className="num" style={{fontWeight:600}}>{s.teamNumber}</td>
                    <td>
                      <div style={{fontWeight:500}}>{s.teamName}</div>
                      {displayFormat==='TEAM_PAIRS'&&(s.rider1||s.rider2)&&(
                        <div style={{fontSize:11,color:'var(--c-text-muted)'}}>{[s.rider1,s.rider2].filter(Boolean).join(' / ')}</div>
                      )}
                    </td>
                    {race.sprints.map(sprint=>{
                      const pts=sprintPts(sprint,s.teamId);
                      return (
                        <td key={sprint.id} style={{textAlign:'center'}}>
                          {pts!==null?<span style={{fontWeight:pts>=5?700:pts>=3?600:400,color:pts>=5?'var(--c-success)':pts>=3?'var(--c-primary)':'var(--c-text)',fontSize:pts>=5?15:13}}>{pts}</span>:''}
                        </td>
                      );
                    })}
                    {hasFinale&&<td style={{textAlign:'center',fontSize:12,color:'var(--c-text-muted)'}}>{s.finalePosition??''}</td>}
                    <td style={{textAlign:'center',color:s.lapBalance>0?'var(--c-success)':s.lapBalance<0?'var(--c-danger)':'',fontWeight:s.lapBalance!==0?600:400}}>
                      {s.lapBalance!==0?(s.lapBalance>0?`+${s.lapBalance*20}`:`${s.lapBalance*20}`):''}
                    </td>
                    {hasOmnium&&<td style={{textAlign:'center'}}>{s.omniumPoints||''}</td>}
                    <td style={{textAlign:'right',fontWeight:700,fontSize:15}}>{s.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Sprint-Verlauf ── */}
      {race.sprints.length > 0 && (
        <div>
          <h2 style={{marginBottom:10}}>Sprint-Verlauf</h2>
          <div style={{display:'flex',flexDirection:'column',gap:8}}>
            {[...race.sprints].reverse().map(sprint=>(
              <div key={sprint.id} className="card" style={{padding:'10px 14px'}}>
                <div className="flex-between">
                  <div style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
                    <span style={{fontWeight:600,fontSize:13,minWidth:64}}>
                      Sprint {sprint.number}
                      {sprint.isFinale&&<span className="badge badge-yellow" style={{marginLeft:6,fontSize:10}}>Finale ★</span>}
                    </span>
                    <span style={{fontSize:12,color:'var(--c-text-muted)'}}>
                      {sprint.results.length===0?<em>leer</em>:sprint.results.map(r=>`${r.position}. ${r.team.number} ${r.team.name}`).join(' · ')}
                    </span>
                  </div>
                  {isAdmin&&(
                    <div style={{display:'flex',gap:6,flexShrink:0}}>
                      <button className="btn btn-secondary btn-sm" style={{fontSize:11}} onClick={()=>openEdit(sprint)}>Bearbeiten</button>
                      {sprint.id===race.sprints[race.sprints.length-1]?.id&&(
                        <button className="btn btn-ghost btn-sm" style={{fontSize:11,color:'var(--c-danger)'}} onClick={()=>deleteSprint(sprint.id)}>Löschen</button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
