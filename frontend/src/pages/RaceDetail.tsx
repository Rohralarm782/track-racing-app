import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useAdmin } from '../components/Layout';
import VerfolgungsplanungView, { PlanSaveData } from '../components/VerfolgungsplanungView';
import MadisonTeamBuilder from '../components/MadisonTeamBuilder';

interface Team { id: string; number: number; name: string; club?: string|null; rider1?: string|null; rider2?: string|null; isFavorite?: boolean; }
interface SprintResult { id: string; position: number; team: Team; }
interface Sprint { id: string; number: number; isFinale: boolean; results: SprintResult[]; }
interface LapEvent { id: string; delta: number; createdAt: string; team: Team; }
interface OmniumScore { id: string; points: number; team: Team; }
interface RaceFlag { id: string; teamId: string; type: 'DSQ'|'WARNING'; }
interface TeamStanding {
  teamId: string; teamNumber: number; teamName: string;
  club?: string|null; rider1?: string|null; rider2?: string|null;
  isFavorite?: boolean; isDsq?: boolean; isWarned?: boolean;
  total: number; sprintPoints: number; lapPoints: number; omniumPoints: number;
  wins: number; seconds: number; thirds: number; fourths: number;
  lapBalance: number; finalePosition?: number|null;
}
interface Race {
  id: string; name: string; type: string; status: string; finaleActive: boolean;
  format?: string|null;
  category: { id: string | null; name: string; format: string; teams: Team[]; event: { id: string; name: string } };
  sprints: Sprint[]; lapEvents: LapEvent[]; omniumScores: OmniumScore[];
  flags: RaceFlag[]; scoreboard: TeamStanding[]|null;
}

// Nur für Punktefahren/Omnium-Anzeige in der Tabelle
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

  // ── Sprint-Eingabe (Punktefahren / TEMPORUNDEN-Schlusswertung) ────────────
  const [entryOpen, setEntryOpen]       = useState(false);
  const [editingSprintId, setEditingId] = useState<string|null>(null);
  const [slots, setSlots]               = useState<SlotEntry[]>([null,null,null,null]);
  const [activeSlot, setActiveSlot]     = useState(0);
  const [isFinale, setIsFinale]         = useState(false);
  const [savingSprint, setSavingSprint] = useState(false);
  // BIB-Tastatur-Modus (session-only, kein localStorage)
  const [bibMode, setBibMode]   = useState(false);
  const [bibInput, setBibInput] = useState('');
  const bibRef = useRef<HTMLInputElement>(null);

  // ── Rundenwertung (Rundengewinn/-verlust) ─────────────────────────────────
  const [lapDelta, setLapDelta]             = useState<1|-1>(1);
  const [lapPickerOpen, setLapPickerOpen]   = useState(false);
  const [selectedLapIds, setSelectedLapIds] = useState<Set<string>>(new Set());
  const [savingLap, setSavingLap]           = useState(false);

  // ── Omnium-Vorpunkte ──────────────────────────────────────────────────────
  const [omniumOpen, setOmniumOpen]     = useState(false);
  const [omniumValues, setOmniumValues] = useState<Record<string,string>>({});
  const [savingOmnium, setSavingOmnium] = useState(false);
  const omniumPdfRef = useRef<HTMLInputElement>(null);

  // ── TEMPORUNDEN-spezifisch ────────────────────────────────────────────────
  const [savingTempoRound, setSavingTempoRound] = useState(false);
  const [savedFeedback, setSavedFeedback]       = useState<string|null>(null);
  const [editingRoundId, setEditingRoundId]     = useState<string|null>(null);
  const [editRoundWinnerId, setEditRoundWinnerId] = useState<string|null>(null);
  const [savingRoundEdit, setSavingRoundEdit]   = useState(false);

  // ── Madison-Teambuilder ───────────────────────────────────────────────────
  const [showTeamBuilder, setShowTeamBuilder] = useState(false);

  // ── Datenabruf ────────────────────────────────────────────────────────────
  const fetchRace = useCallback(async () => {
    if (!id) return;
    try { const d = await api.get<Race>(`/api/races/${id}`); setRace(d); }
    catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [id]);

  useEffect(() => { fetchRace(); const t = setInterval(fetchRace, 6000); return () => clearInterval(t); }, [fetchRace]);

  // ── Punktefahren-Sprint-Eingabe ───────────────────────────────────────────
  function openNew() { setSlots([null,null,null,null]); setActiveSlot(0); setIsFinale(false); setEditingId(null); setBibInput(''); setEntryOpen(true); }

  function openEdit(sprint: Sprint) {
    const teams = race?.category.teams ?? [];
    const numSlots = sprint.isFinale ? teams.length : 4;
    const s: SlotEntry[] = Array(numSlots).fill(null);
    for (const r of sprint.results) if (r.position-1 < numSlots) s[r.position-1] = { teamId: r.team.id, teamNumber: r.team.number, teamName: r.team.name };
    setSlots(s); setIsFinale(sprint.isFinale); setEditingId(sprint.id); setBibInput('');
    const fe = s.findIndex(x => x === null); setActiveSlot(fe === -1 ? 0 : fe); setEntryOpen(true);
  }

  function handleFinaleToggle(checked: boolean) {
    const teams = race?.category.teams ?? []; setIsFinale(checked);
    if (checked) { const ns: SlotEntry[] = Array(teams.length).fill(null); slots.forEach((s,i) => { if(i<ns.length) ns[i]=s; }); setSlots(ns); if(activeSlot>=teams.length) setActiveSlot(0); }
    else { setSlots([slots[0]??null,slots[1]??null,slots[2]??null,slots[3]??null]); if(activeSlot>3) setActiveSlot(0); }
  }

  function selectTeam(team: Team) {
    const ns=[...slots]; ns[activeSlot]={teamId:team.id,teamNumber:team.number,teamName:team.name}; setSlots(ns);
    const next=ns.findIndex((x,i)=>i>activeSlot&&x===null); if(next!==-1) setActiveSlot(next);
  }

  function confirmBib() {
    const num = parseInt(bibInput);
    const team = race?.category.teams.find(t => t.number === num);
    if (team) { selectTeam(team); setBibInput(''); setTimeout(() => bibRef.current?.focus(), 50); }
  }

  async function saveSprint() {
    const results = slots.flatMap((s,i) => s ? [{teamId:s.teamId,position:i+1}] : []);
    if (results.length===0||!id) return; setSavingSprint(true); setError('');
    try { const payload={isFinale,results}; if(editingSprintId) await api.put(`/api/sprints/${editingSprintId}`,payload); else await api.post(`/api/races/${id}/sprints`,payload); setEntryOpen(false); await fetchRace(); }
    catch(e:any){setError(e.message);} finally{setSavingSprint(false);}
  }

  async function deleteSprint(sid: string) { if(!confirm('Eintrag löschen?')) return; await api.delete(`/api/sprints/${sid}`); await fetchRace(); }

  // ── Rundenwertung ─────────────────────────────────────────────────────────
  function openLapPicker(delta: 1|-1) { setLapDelta(delta); setSelectedLapIds(new Set()); setLapPickerOpen(true); }
  function toggleLapTeam(id: string) { setSelectedLapIds(p => { const n=new Set(p); n.has(id)?n.delete(id):n.add(id); return n; }); }

  async function saveSelectedLaps() {
    if(!id||selectedLapIds.size===0) return; setSavingLap(true);
    try { await Promise.all([...selectedLapIds].map(teamId => api.post(`/api/races/${id}/laps`,{teamId,delta:lapDelta}))); setLapPickerOpen(false); setSelectedLapIds(new Set()); await fetchRace(); }
    catch(e:any){setError(e.message);} finally{setSavingLap(false);}
  }

  async function deleteLap(lid: string) { await api.delete(`/api/laps/${lid}`); await fetchRace(); }

  // ── Flags (DSQ / WARNING) ─────────────────────────────────────────────────
  async function toggleFlag(teamId: string, type: 'DSQ'|'WARNING') {
    if (!id) return;
    const existing = race?.flags.find(f => f.teamId===teamId && f.type===type);
    if (existing) await api.delete(`/api/race-flags/${existing.id}`);
    else await api.post(`/api/races/${id}/flags`, { teamId, type });
    await fetchRace();
  }

  // ── Omnium-Vorpunkte ──────────────────────────────────────────────────────
  function openOmnium() {
    if (!race) return;
    const init: Record<string,string> = {};
    for (const t of race.category.teams) init[t.id] = String(race.omniumScores.find(o=>o.team.id===t.id)?.points??0);
    setOmniumValues(init); setOmniumOpen(true);
  }

  async function saveOmnium() {
    if(!id) return; setSavingOmnium(true);
    try { await api.post(`/api/races/${id}/omnium`,{scores:Object.entries(omniumValues).map(([teamId,pts])=>({teamId,points:parseInt(pts)||0}))}); setOmniumOpen(false); await fetchRace(); }
    catch(e:any){setError(e.message);} finally{setSavingOmnium(false);}
  }

  async function handleOmniumPdf(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if(!file||!id) return;
    try {
      const base64 = await new Promise<string>((res,rej)=>{const r=new FileReader();r.onload=()=>res((r.result as string).split(',')[1]);r.onerror=()=>rej(new Error('Fehler'));r.readAsDataURL(file);});
      const result = await api.post<{imported:number,total:number}>(`/api/races/${id}/omnium-pdf`,{pdfBase64:base64});
      await fetchRace(); alert(`${result.imported} von ${result.total} Einträgen importiert`);
    } catch(e:any){setError(e.message);}
    finally{if(omniumPdfRef.current) omniumPdfRef.current.value='';}
  }

  // ── TEMPORUNDEN-spezifische Funktionen ────────────────────────────────────
  async function saveTempoRound(winnerId: string|null, winnerName?: string) {
    if (!id || !race) return;
    setSavingTempoRound(true);
    const regularSprints = race.sprints.filter(s => !s.isFinale);
    const nextNum = regularSprints.length > 0
      ? Math.max(...regularSprints.map(s => s.number)) + 1
      : 1;
    try {
      await api.post(`/api/races/${id}/tempo-round`, {
        number: nextNum,
        results: winnerId ? [{ teamId: winnerId, position: 1 }] : [],
      });
      await fetchRace();
      const fb = winnerId ? `✓ Runde ${nextNum}: ${winnerName}` : `✓ Runde ${nextNum}: übersprungen`;
      setSavedFeedback(fb);
      setTimeout(() => setSavedFeedback(null), 2000);
    } catch(e: any) { setError(e.message); }
    finally { setSavingTempoRound(false); }
  }

  function openTempoSchlusswertung() {
    const t = race?.category.teams ?? [];
    setSlots(Array(t.length).fill(null));
    setIsFinale(true); setEditingId(null); setActiveSlot(0); setBibInput('');
    setEntryOpen(true);
  }

  async function saveRoundEdit() {
    if (!editingRoundId) return;
    setSavingRoundEdit(true);
    try {
      await api.put(`/api/sprints/${editingRoundId}`, {
        isFinale: false,
        results: editRoundWinnerId ? [{ teamId: editRoundWinnerId, position: 1 }] : [],
      });
      setEditingRoundId(null);
      setEditRoundWinnerId(null);
      await fetchRace();
    } catch(e: any) { setError(e.message); }
    finally { setSavingRoundEdit(false); }
  }

  // ── Ladezustände ─────────────────────────────────────────────────────────
  if (loading) return <div className="page container"><div className="loading"><span className="spinner"/>Lädt…</div></div>;
  if (!race)   return <div className="page container"><div className="alert alert-error">{error||'Nicht gefunden'}</div></div>;

  const {category}=race, teams=category.teams;
  const displayFormat=(race.format??category.format) as string;
  const nextNum=(race.sprints[race.sprints.length-1]?.number??0)+1;
  const usedIds=new Set(slots.filter(Boolean).map(s=>s!.teamId));
  const hasOmnium=race.omniumScores.length>0;
  const hasFinale=race.sprints.some(s=>s.isFinale);
  const filledSlots=slots.filter(Boolean).length;
  const canSkip=slots.findIndex((s,i)=>i>activeSlot&&s===null)!==-1;

  // ── VERFOLGUNGSRENNEN ─────────────────────────────────────────────────────
  async function handleSavePlan(data: PlanSaveData) {
    await api.post('/api/pursuit-plans', data);
  }

  if (race.type === 'VERFOLGUNGSRENNEN') {
    return (
      <div className="page container">
        <div className="breadcrumb">
          <Link to="/">Veranstaltungen</Link><span>›</span>
          <Link to={`/events/${category.event.id}`}>{category.event.name}</Link><span>›</span>
          {category.id ? <><Link to={`/categories/${category.id}`}>{category.name}</Link><span>›</span></> : <><span>{category.name}</span><span>›</span></>}
          {race.name}
        </div>
        <div className="flex-between mb-4">
          <div>
            <h1>{race.name}</h1>
            <p className="text-sm text-muted" style={{margin:'2px 0 0'}}>
              {category.name} · {teams.length} Teams · Verfolgung
            </p>
          </div>
        </div>
        {error && <div className="alert alert-error mb-3">{error}</div>}
        <VerfolgungsplanungView
          teams={teams}
          isAdmin={isAdmin}
          onSave={isAdmin ? handleSavePlan : undefined}
        />
      </div>
    );
  }

  // ── TEMPORUNDEN ───────────────────────────────────────────────────────────
  if (race.type === 'TEMPORUNDEN') {
    const regularRounds = [...race.sprints.filter(s => !s.isFinale)].sort((a,b) => a.number - b.number);
    const schlusswertung = race.sprints.find(s => s.isFinale);
    const nextTempoNum = regularRounds.length > 0
      ? Math.max(...regularRounds.map(s => s.number)) + 1
      : 1;
    const isLocked = race.status === 'FINISHED';

    return (
      <div className="page container">
        {/* Breadcrumb */}
        <div className="breadcrumb">
          <Link to="/">Veranstaltungen</Link><span>›</span>
          <Link to={`/events/${category.event.id}`}>{category.event.name}</Link><span>›</span>
          {category.id ? <><Link to={`/categories/${category.id}`}>{category.name}</Link><span>›</span></> : <><span>{category.name}</span><span>›</span></>}
          {race.name}
        </div>

        {/* Header */}
        <div className="flex-between mb-4">
          <div>
            <h1>{race.name}</h1>
            <p className="text-sm text-muted" style={{margin:'2px 0 0'}}>
              {category.name} · {regularRounds.length} Runden{schlusswertung ? ' + Schlusswertung' : ''}
            </p>
          </div>
          {isAdmin && !isLocked && !entryOpen && !schlusswertung && (
            <button className="btn btn-secondary" onClick={openTempoSchlusswertung} style={{borderColor:'#f59e0b',color:'#b45309'}}>
              Schlusswertung ★
            </button>
          )}
        </div>

        {error && <div className="alert alert-error mb-3">{error}</div>}

        {/* ── Runden-Eingabepanel — immer offen, Klick = sofort speichern ── */}
        {isAdmin && !isLocked && !entryOpen && (
          <div className="card mb-4" style={{borderColor:'#bfdbfe',background:'#f0f7ff'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
              <h3 style={{margin:0}}>Runde {nextTempoNum} — Sieger anklicken</h3>
              {savedFeedback && (
                <span style={{fontSize:12,color:'var(--c-success)',fontWeight:600,background:'#f0fff4',padding:'3px 10px',borderRadius:12,border:'1px solid var(--c-success)'}}>
                  {savedFeedback}
                </span>
              )}
            </div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(84px,1fr))',gap:8,marginBottom:12}}>
              {teams.map(team => (
                <button key={team.id} type="button"
                  disabled={savingTempoRound}
                  onClick={() => saveTempoRound(team.id, String(team.number))}
                  style={{padding:'10px 6px',borderRadius:8,cursor:savingTempoRound?'wait':'pointer',textAlign:'center',
                    border:'1px solid var(--c-border)',background:'var(--c-white)',
                    opacity:savingTempoRound?0.6:1}}>
                  <div style={{fontWeight:700,fontSize:20}}>{team.number}</div>
                  <div style={{fontSize:11,color:'var(--c-text-muted)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{team.name}</div>
                </button>
              ))}
            </div>
            <button className="btn btn-ghost btn-sm" style={{fontSize:12,color:'var(--c-text-muted)'}}
              onClick={() => saveTempoRound(null)} disabled={savingTempoRound}>
              Überspringen (kein Sieger) →
            </button>
          </div>
        )}

        {/* ── Schlusswertung-Eingabepanel (nutzt bestehendes Slot-System) ── */}
        {isAdmin && entryOpen && (
          <div className="card mb-4" style={{borderColor:'#fde68a',background:'#fffbeb'}}>
            <h3 style={{marginBottom:12}}>Schlusswertung — Platzierungen erfassen</h3>
            {/* Slot-Anzeige */}
            <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(60px,1fr))',gap:4,marginBottom:14,maxHeight:180,overflowY:'auto'}}>
              {slots.map((slot,i)=>(
                <div key={i} onClick={()=>setActiveSlot(i)} style={{border:activeSlot===i?'2px solid var(--c-primary)':'1px solid var(--c-border)',borderRadius:6,padding:'4px 3px',cursor:'pointer',textAlign:'center',background:activeSlot===i?'#dbeafe':slot?'#f0fff4':'white'}}>
                  <div style={{fontSize:9,color:'var(--c-text-muted)',marginBottom:1}}>{i+1}.</div>
                  <div style={{fontWeight:600,fontSize:13}}>{slot?slot.teamNumber:'—'}</div>
                </div>
              ))}
            </div>
            {/* Team-Auswahl */}
            <div style={{marginBottom:12}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                <span className="text-xs text-muted">{activeSlot+1}. Platz wählen:</span>
                {canSkip&&<button type="button" className="btn btn-ghost btn-sm" style={{fontSize:11,padding:'3px 8px'}} onClick={()=>{const n=slots.findIndex((s,i)=>i>activeSlot&&s===null);if(n!==-1)setActiveSlot(n);}}>Überspringen →</button>}
              </div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(72px,1fr))',gap:6}}>
                {teams.map(team=>{
                  const used=usedIds.has(team.id)&&slots[activeSlot]?.teamId!==team.id;
                  const sel=slots[activeSlot]?.teamId===team.id;
                  return(<button key={team.id} type="button" onClick={()=>!used&&selectTeam(team)} style={{padding:'8px 4px',borderRadius:7,cursor:used?'not-allowed':'pointer',textAlign:'center',border:sel?'2px solid var(--c-primary)':'1px solid var(--c-border)',background:used?'#f3f4f6':sel?'#dbeafe':'var(--c-white)',opacity:used?0.4:1}}>
                    <div style={{fontWeight:700,fontSize:16}}>{team.number}</div>
                    <div style={{fontSize:10,color:'var(--c-text-muted)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{team.name}</div>
                  </button>);
                })}
              </div>
            </div>
            <div className="flex-between">
              <div style={{display:'flex',alignItems:'center',gap:12}}>
                <button className="btn btn-ghost" onClick={()=>setEntryOpen(false)}>Abbrechen</button>
                {filledSlots>0&&filledSlots<teams.length&&<span className="text-xs text-muted">{filledSlots}/{teams.length} Teams</span>}
              </div>
              <button className="btn btn-primary" onClick={saveSprint} disabled={filledSlots===0||savingSprint}>
                {savingSprint?'Speichert…':'Schlusswertung speichern ✓'}
              </button>
            </div>
          </div>
        )}

        {/* ── Rundenwertung (Rundengewinn/-verlust) ── */}
        {isAdmin && !entryOpen && (
          <div className="card mb-4">
            <h3 style={{marginBottom:10}}>Rundenwertung</h3>
            <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
              <button className="btn btn-secondary" onClick={()=>openLapPicker(1)} style={{borderColor:'var(--c-success)',color:'var(--c-success)'}}>+ Runde gewonnen</button>
              <button className="btn btn-secondary" onClick={()=>openLapPicker(-1)} style={{borderColor:'var(--c-danger)',color:'var(--c-danger)'}}>− Runde verloren</button>
            </div>
            {race.lapEvents.length>0&&(
              <div style={{marginTop:12}}>
                <div className="text-xs text-muted" style={{marginBottom:4}}>Letzte Ereignisse</div>
                {[...race.lapEvents].reverse().slice(0,5).map(lap=>(
                  <div key={lap.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'4px 0',borderBottom:'1px solid var(--c-border)',fontSize:13}}>
                    <span><span style={{color:lap.delta>0?'var(--c-success)':'var(--c-danger)',fontWeight:600}}>{lap.delta>0?'+1':'-1'}</span>{' · '}{lap.team.number} {lap.team.name}</span>
                    {isAdmin&&<button className="btn btn-ghost btn-sm" style={{fontSize:11}} onClick={()=>deleteLap(lap.id)}>Rückgängig</button>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Scoreboard ── */}
        {race.scoreboard&&race.scoreboard.length>0&&(
          <div className="mb-4">
            <div className="section-header" style={{marginBottom:8}}>
              <h2 style={{margin:0}}>Zwischenstand</h2>
              <span className="text-xs text-muted">aktualisiert alle 6s</span>
            </div>
            <div className="table-wrap" style={{overflowX:'auto'}}>
              <table className="table" style={{minWidth:320}}>
                <thead>
                  <tr>
                    <th style={{width:28}}>#</th>
                    <th style={{width:40}}>Nr.</th>
                    <th style={{minWidth:100}}>Name</th>
                    <th style={{textAlign:'center',width:64,fontSize:11}}>Rundensiege</th>
                    {schlusswertung&&<th style={{textAlign:'center',width:40,fontSize:11}} title="Schlusswertungsplatz">S.W.</th>}
                    <th style={{textAlign:'center',width:52}}>R.</th>
                    <th style={{textAlign:'right',width:52}}>Ges.</th>
                    {isAdmin&&<th style={{width:60}}></th>}
                  </tr>
                </thead>
                <tbody>
                  {race.scoreboard.map((s,idx)=>{
                    const rowStyle: React.CSSProperties = s.isDsq?{opacity:0.5,textDecoration:'line-through'}:s.isFavorite?{background:'#fffbeb'}:{};
                    return(
                      <tr key={s.teamId} style={rowStyle}>
                        <td style={{color:'var(--c-text-muted)',fontSize:12}}>{s.isDsq?'':idx+1}</td>
                        <td className="num" style={{fontWeight:600}}>{s.teamNumber}</td>
                        <td>
                          <div style={{display:'flex',alignItems:'center',gap:4}}>
                            {s.isFavorite&&<span>⭐</span>}
                            {s.isWarned&&<span title="Verwarnung" style={{color:'var(--c-warning)'}}>⚠</span>}
                            {s.isDsq&&<span title="Disqualifiziert" style={{color:'var(--c-danger)'}}>⛔</span>}
                            <span style={{fontWeight:500}}>{s.teamName}</span>
                          </div>
                          {s.club&&<div style={{fontSize:11,color:'var(--c-text-muted)'}}>{s.club}</div>}
                        </td>
                        <td style={{textAlign:'center',fontWeight:600,color:s.wins>0?'var(--c-success)':''}}>{s.wins||''}</td>
                        {schlusswertung&&<td style={{textAlign:'center',fontSize:12,color:'var(--c-text-muted)'}}>{s.finalePosition??''}</td>}
                        <td style={{textAlign:'center',color:s.lapBalance>0?'var(--c-success)':s.lapBalance<0?'var(--c-danger)':'',fontWeight:s.lapBalance!==0?600:400}}>
                          {s.lapBalance!==0?(s.lapBalance>0?`+${s.lapBalance*20}`:`${s.lapBalance*20}`):''}
                        </td>
                        <td style={{textAlign:'right',fontWeight:700,fontSize:15,color:s.isDsq?'var(--c-danger)':''}}>{s.isDsq?'DSQ':s.total}</td>
                        {isAdmin&&(
                          <td style={{textAlign:'center'}}>
                            <div style={{display:'flex',gap:2,justifyContent:'center'}}>
                              <button type="button" title={s.isWarned?'Verwarnung aufheben':'Verwarnung'} onClick={()=>toggleFlag(s.teamId,'WARNING')} style={{background:'none',border:'none',cursor:'pointer',fontSize:14,opacity:s.isWarned?1:0.3}}>⚠</button>
                              <button type="button" title={s.isDsq?'DSQ aufheben':'DSQ'} onClick={()=>toggleFlag(s.teamId,'DSQ')} style={{background:'none',border:'none',cursor:'pointer',fontSize:14,opacity:s.isDsq?1:0.3}}>⛔</button>
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Rundenprotokoll ── */}
        {(regularRounds.length>0||schlusswertung)&&(
          <div className="card mb-4">
            <h3 style={{marginBottom:8}}>Rundenprotokoll</h3>
            <div style={{maxHeight:320,overflowY:'auto'}}>
              {regularRounds.map(round=>{
                const winner=round.results.find(r=>r.position===1);
                const isEditing=editingRoundId===round.id;
                return(
                  <div key={round.id} style={{borderBottom:'1px solid var(--c-border)'}}>
                    {/* ── Anzeigezeile ── */}
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'6px 0',fontSize:13}}>
                      <div>
                        <span style={{color:'var(--c-text-muted)',minWidth:56,display:'inline-block',fontSize:12}}>Rd. {round.number}</span>
                        {winner
                          ? <span><span style={{fontWeight:600}}>{winner.team.number}</span> {winner.team.name} <span style={{color:'var(--c-success)',fontSize:11}}>+1 Pkt</span></span>
                          : <span style={{color:'var(--c-text-muted)',fontStyle:'italic'}}>übersprungen</span>
                        }
                      </div>
                      {isAdmin&&!isEditing&&(
                        <div style={{display:'flex',gap:4}}>
                          <button className="btn btn-ghost btn-sm" style={{fontSize:11}} title="Bearbeiten"
                            onClick={()=>{setEditingRoundId(round.id);setEditRoundWinnerId(winner?.team.id??null);}}>
                            ✏
                          </button>
                          <button className="btn btn-ghost btn-sm" style={{fontSize:11,color:'var(--c-text-muted)'}}
                            onClick={()=>deleteSprint(round.id)}>×</button>
                        </div>
                      )}
                    </div>
                    {/* ── Inline-Edit ── */}
                    {isAdmin&&isEditing&&(
                      <div style={{paddingBottom:10,paddingTop:4}}>
                        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(72px,1fr))',gap:6,marginBottom:8}}>
                          {teams.map(team=>{
                            const sel=editRoundWinnerId===team.id;
                            return(
                              <button key={team.id} type="button"
                                onClick={()=>setEditRoundWinnerId(sel?null:team.id)}
                                style={{padding:'7px 4px',borderRadius:7,cursor:'pointer',textAlign:'center',
                                  border:sel?'2px solid var(--c-primary)':'1px solid var(--c-border)',
                                  background:sel?'#dbeafe':'var(--c-white)'}}>
                                <div style={{fontWeight:700,fontSize:15,color:sel?'var(--c-primary)':''}}>{team.number}</div>
                                <div style={{fontSize:10,color:'var(--c-text-muted)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{team.name}</div>
                              </button>
                            );
                          })}
                        </div>
                        <div style={{display:'flex',gap:6,alignItems:'center'}}>
                          <button className="btn btn-ghost btn-sm" onClick={()=>{setEditingRoundId(null);setEditRoundWinnerId(null);}}>Abbrechen</button>
                          <button className="btn btn-ghost btn-sm" style={{fontSize:11,color:'var(--c-text-muted)'}}
                            onClick={()=>setEditRoundWinnerId(null)}>
                            Kein Sieger
                          </button>
                          <button className="btn btn-primary btn-sm" onClick={saveRoundEdit} disabled={savingRoundEdit}>
                            {savingRoundEdit?'…':'Speichern ✓'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              {schlusswertung&&(
                <div style={{paddingTop:8,marginTop:4,borderTop:'2px solid #fde68a'}}>
                  <div style={{fontWeight:600,fontSize:12,color:'#b45309',marginBottom:4}}>Schlusswertung ★</div>
                  <div style={{fontSize:13}}>
                    {[...schlusswertung.results].sort((a,b)=>a.position-b.position).map(r=>(
                      <span key={r.team.id} style={{marginRight:10}}>{r.position}. <span style={{fontWeight:600}}>{r.team.number}</span> {r.team.name}</span>
                    ))}
                  </div>
                  {isAdmin&&<button className="btn btn-ghost btn-sm" style={{fontSize:11,marginTop:6,color:'var(--c-danger)'}} onClick={()=>deleteSprint(schlusswertung.id)}>Schlusswertung löschen</button>}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Rundenwertung Modal ── */}
        {lapPickerOpen&&(
          <div className="modal-overlay" onClick={()=>setLapPickerOpen(false)}>
            <div className="modal" style={{maxWidth:520}} onClick={e=>e.stopPropagation()}>
              <p className="modal-title">{lapDelta>0?'+ Runde gewonnen':'− Runde verloren'} — Teams wählen</p>
              <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(84px,1fr))',gap:8,marginBottom:16}}>
                {teams.map(team=>{const sel=selectedLapIds.has(team.id);return(
                  <button key={team.id} type="button" onClick={()=>toggleLapTeam(team.id)} style={{padding:'10px 6px',borderRadius:8,textAlign:'center',cursor:'pointer',border:sel?'2px solid var(--c-primary)':'1px solid var(--c-border)',background:sel?'#dbeafe':'var(--c-white)'}}>
                    <div style={{fontWeight:700,fontSize:20,color:sel?'var(--c-primary)':'var(--c-text)'}}>{team.number}</div>
                    <div style={{fontSize:11,color:'var(--c-text-muted)',marginTop:2}}>{team.name}</div>
                    {sel&&<div style={{fontSize:10,color:'var(--c-primary)',fontWeight:600}}>✓</div>}
                  </button>
                );})}
              </div>
              <div className="flex-between">
                <button className="btn btn-ghost" onClick={()=>setLapPickerOpen(false)}>Abbrechen</button>
                <button className="btn btn-primary" onClick={saveSelectedLaps} disabled={selectedLapIds.size===0||savingLap}>
                  {savingLap?'Speichert…':selectedLapIds.size===0?'Team auswählen':`Bestätigen (${selectedLapIds.size})`}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── PUNKTEFAHREN / MADISON / OMNIUM ───────────────────────────────────────
  return (
    <div className="page container">
      <div className="breadcrumb">
        <Link to="/">Veranstaltungen</Link><span>›</span>
        <Link to={`/events/${category.event.id}`}>{category.event.name}</Link><span>›</span>
        {category.id ? <><Link to={`/categories/${category.id}`}>{category.name}</Link><span>›</span></> : <><span>{category.name}</span><span>›</span></>}
        {race.name}
      </div>

      <div className="flex-between mb-4">
        <div>
          <h1>{race.name}</h1>
          <p className="text-sm text-muted" style={{margin:'2px 0 0'}}>{category.name} · {race.sprints.length} Sprints</p>
        </div>
        {isAdmin && (
          <div style={{display:'flex',gap:8}}>
            {displayFormat==='TEAM_PAIRS' && !showTeamBuilder && (
              <button className="btn btn-secondary btn-sm" onClick={()=>setShowTeamBuilder(true)}>
                🔀 Teams aufbauen
              </button>
            )}
            <button className="btn btn-secondary btn-sm" onClick={openOmnium}>Omnium-Vorpunkte</button>
            {!entryOpen && !showTeamBuilder && <button className="btn btn-primary" onClick={openNew}>+ Sprint {nextNum}</button>}
          </div>
        )}
      </div>

      {error && <div className="alert alert-error mb-3">{error}</div>}

      {/* ── Madison-Teambuilder ── */}
      {/* Nur für Rennen mit echter Kategorie — bei neuen, direkt am Event
          hängenden Rennen kommt die Startliste bereits fertig aus der
          Ansetzung, kein manuelles Team-Pairing nötig. */}
      {isAdmin && showTeamBuilder && category.id && (
        <div className="card mb-4">
          <div className="flex-between mb-3">
            <h2 style={{margin:0}}>🔀 Madison-Teams aufbauen</h2>
            <button className="btn btn-ghost btn-sm" onClick={()=>setShowTeamBuilder(false)}>✕ Schließen</button>
          </div>
          <MadisonTeamBuilder
            categoryId={category.id}
            categoryName={category.name}
            categoryFormat={category.format as 'INDIVIDUAL' | 'TEAM_PAIRS'}
            eventId={category.event.id}
            existingTeams={teams}
            onSuccess={(_teams, _targetId)=>{ setShowTeamBuilder(false); fetchRace(); }}
            onCancel={()=>setShowTeamBuilder(false)}
          />
        </div>
      )}

      {/* ── Sprint-Eingabepanel ── */}
      {isAdmin && entryOpen && (
        <div className="card mb-4" style={{borderColor:'#bfdbfe',background:'#f0f7ff'}}>
          <div className="flex-between" style={{marginBottom:12}}>
            <h3>{editingSprintId?'Sprint bearbeiten':`Sprint ${nextNum}`}</h3>
            <div style={{display:'flex',gap:10,alignItems:'center'}}>
              <label style={{display:'flex',alignItems:'center',gap:5,fontSize:12,cursor:'pointer',color:'var(--c-text-muted)'}}>
                <input type="checkbox" checked={bibMode} onChange={e=>{setBibMode(e.target.checked);setBibInput('');setTimeout(()=>bibRef.current?.focus(),50);}}/>
                BIB-Eingabe
              </label>
              <label style={{display:'flex',alignItems:'center',gap:6,fontSize:13,cursor:'pointer'}}>
                <input type="checkbox" checked={isFinale} onChange={e=>handleFinaleToggle(e.target.checked)}/>
                Finale (doppelte Punkte)
              </label>
            </div>
          </div>
          {/* Slot-Anzeige */}
          <div style={{display:'grid',gridTemplateColumns:isFinale?'repeat(auto-fill,minmax(60px,1fr))':'repeat(4,1fr)',gap:isFinale?4:8,marginBottom:14,maxHeight:isFinale?180:'none',overflowY:isFinale?'auto':'visible'}}>
            {slots.map((slot,i)=>(
              <div key={i} onClick={()=>setActiveSlot(i)} style={{border:activeSlot===i?'2px solid var(--c-primary)':'1px solid var(--c-border)',borderRadius:isFinale?6:8,padding:isFinale?'4px 3px':'8px 6px',cursor:'pointer',textAlign:'center',background:activeSlot===i?'#dbeafe':slot?'#f0fff4':'white'}}>
                <div style={{fontSize:9,color:'var(--c-text-muted)',marginBottom:isFinale?1:3}}>{i+1}.</div>
                <div style={{fontWeight:600,fontSize:isFinale?13:15}}>{slot?slot.teamNumber:'—'}</div>
                {!isFinale&&<div style={{fontSize:11,color:'var(--c-text-muted)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{slot?slot.teamName:''}</div>}
              </div>
            ))}
          </div>
          {/* BIB-Eingabe oder Button-Raster */}
          <div style={{marginBottom:12}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
              <span className="text-xs text-muted">{activeSlot+1}. Platz wählen:</span>
              {canSkip&&<button type="button" className="btn btn-ghost btn-sm" style={{fontSize:11,padding:'3px 8px'}} onClick={()=>{const n=slots.findIndex((s,i)=>i>activeSlot&&s===null);if(n!==-1)setActiveSlot(n);}}>Überspringen →</button>}
            </div>
            {bibMode ? (
              <div style={{display:'flex',gap:8,alignItems:'center'}}>
                <input
                  ref={bibRef}
                  type="number"
                  className="form-input"
                  style={{width:100,fontSize:22,fontWeight:700,textAlign:'center',padding:'8px 12px'}}
                  value={bibInput}
                  onChange={e=>setBibInput(e.target.value)}
                  onKeyDown={e=>{ if(e.key==='Enter') confirmBib(); }}
                  placeholder="Nr."
                  autoFocus
                />
                <button className="btn btn-primary" onClick={confirmBib} disabled={!bibInput}>
                  Bestätigen →
                </button>
                {bibInput&&!teams.find(t=>t.number===parseInt(bibInput))&&(
                  <span style={{fontSize:12,color:'var(--c-danger)'}}>Nicht gefunden</span>
                )}
              </div>
            ) : (
              <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(72px,1fr))',gap:6}}>
                {teams.map(team=>{
                  const used=usedIds.has(team.id)&&slots[activeSlot]?.teamId!==team.id;
                  const sel=slots[activeSlot]?.teamId===team.id;
                  return(<button key={team.id} type="button" onClick={()=>!used&&selectTeam(team)} style={{padding:'8px 4px',borderRadius:7,cursor:used?'not-allowed':'pointer',textAlign:'center',border:sel?'2px solid var(--c-primary)':'1px solid var(--c-border)',background:used?'#f3f4f6':sel?'#dbeafe':'var(--c-white)',opacity:used?0.4:1}}>
                    <div style={{fontWeight:700,fontSize:16}}>{team.number}</div>
                    <div style={{fontSize:10,color:'var(--c-text-muted)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{team.name}</div>
                  </button>);
                })}
              </div>
            )}
          </div>
          <div className="flex-between">
            <div style={{display:'flex',alignItems:'center',gap:12}}>
              <button className="btn btn-ghost" onClick={()=>setEntryOpen(false)}>Abbrechen</button>
              {isFinale&&filledSlots>0&&filledSlots<teams.length&&<span className="text-xs text-muted">{filledSlots}/{teams.length} Teams</span>}
            </div>
            <button className="btn btn-primary" onClick={saveSprint} disabled={filledSlots===0||savingSprint}>
              {savingSprint?'Speichert…':editingSprintId?'Änderungen speichern':'Sprint speichern ✓'}
            </button>
          </div>
        </div>
      )}

      {/* ── Rundenwertung ── */}
      {isAdmin&&!entryOpen&&(
        <div className="card mb-4">
          <h3 style={{marginBottom:10}}>Rundenwertung</h3>
          <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
            <button className="btn btn-secondary" onClick={()=>openLapPicker(1)} style={{borderColor:'var(--c-success)',color:'var(--c-success)'}}>+ Runde gewonnen</button>
            <button className="btn btn-secondary" onClick={()=>openLapPicker(-1)} style={{borderColor:'var(--c-danger)',color:'var(--c-danger)'}}>− Runde verloren</button>
          </div>
          {race.lapEvents.length>0&&(
            <div style={{marginTop:12}}>
              <div className="text-xs text-muted" style={{marginBottom:4}}>Letzte Ereignisse</div>
              {[...race.lapEvents].reverse().slice(0,5).map(lap=>(
                <div key={lap.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'4px 0',borderBottom:'1px solid var(--c-border)',fontSize:13}}>
                  <span><span style={{color:lap.delta>0?'var(--c-success)':'var(--c-danger)',fontWeight:600}}>{lap.delta>0?'+1':'-1'}</span>{' · '}{lap.team.number} {lap.team.name}</span>
                  <button className="btn btn-ghost btn-sm" style={{fontSize:11}} onClick={()=>deleteLap(lap.id)}>Rückgängig</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Lap-Picker Modal ── */}
      {lapPickerOpen&&(
        <div className="modal-overlay" onClick={()=>setLapPickerOpen(false)}>
          <div className="modal" style={{maxWidth:520}} onClick={e=>e.stopPropagation()}>
            <p className="modal-title">{lapDelta>0?'+ Runde gewonnen':'− Runde verloren'} — Teams wählen</p>
            <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(84px,1fr))',gap:8,marginBottom:16}}>
              {teams.map(team=>{const sel=selectedLapIds.has(team.id);return(
                <button key={team.id} type="button" onClick={()=>toggleLapTeam(team.id)} style={{padding:'10px 6px',borderRadius:8,textAlign:'center',cursor:'pointer',border:sel?'2px solid var(--c-primary)':'1px solid var(--c-border)',background:sel?'#dbeafe':'var(--c-white)'}}>
                  <div style={{fontWeight:700,fontSize:20,color:sel?'var(--c-primary)':'var(--c-text)'}}>{team.number}</div>
                  <div style={{fontSize:11,color:'var(--c-text-muted)',marginTop:2}}>{team.name}</div>
                  {sel&&<div style={{fontSize:10,color:'var(--c-primary)',fontWeight:600}}>✓</div>}
                </button>
              );})}
            </div>
            <div className="flex-between">
              <button className="btn btn-ghost" onClick={()=>setLapPickerOpen(false)}>Abbrechen</button>
              <button className="btn btn-primary" onClick={saveSelectedLaps} disabled={selectedLapIds.size===0||savingLap}>
                {savingLap?'Speichert…':selectedLapIds.size===0?'Team auswählen':`Bestätigen (${selectedLapIds.size})`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Omnium-Modal ── */}
      {omniumOpen&&(
        <div className="modal-overlay" onClick={()=>setOmniumOpen(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div className="flex-between" style={{marginBottom:16}}>
              <p className="modal-title" style={{margin:0}}>Omnium-Vorpunkte</p>
              <label style={{cursor:'pointer'}}>
                <input ref={omniumPdfRef} type="file" accept=".pdf" style={{display:'none'}} onChange={handleOmniumPdf}/>
                <span className="btn btn-secondary btn-sm" style={{pointerEvents:'none'}}>📄 PDF importieren</span>
              </label>
            </div>
            <div style={{maxHeight:320,overflowY:'auto'}}>
              {teams.map(team=>(
                <div key={team.id} style={{display:'flex',alignItems:'center',gap:12,marginBottom:8}}>
                  <span style={{flex:1,fontSize:13}}><strong>{team.number}</strong> {team.name}</span>
                  <input type="number" className="form-input" style={{width:80}} value={omniumValues[team.id]??'0'} onChange={e=>setOmniumValues(p=>({...p,[team.id]:e.target.value}))}/>
                </div>
              ))}
            </div>
            <div className="flex-between mt-4">
              <button className="btn btn-ghost" onClick={()=>setOmniumOpen(false)}>Abbrechen</button>
              <button className="btn btn-primary" onClick={saveOmnium} disabled={savingOmnium}>{savingOmnium?'Speichert…':'Speichern'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Scoreboard ── */}
      {race.scoreboard&&race.scoreboard.length>0&&(
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
                  {race.sprints.map(s=><th key={s.id} style={{textAlign:'center',width:48,fontSize:11}}>{s.isFinale?<span>S{s.number}<span style={{color:'var(--c-warning)'}}>★</span></span>:`S${s.number}`}</th>)}
                  {hasFinale&&<th style={{textAlign:'center',width:36,fontSize:11}}>F.</th>}
                  <th style={{textAlign:'center',width:52}}>R.</th>
                  {hasOmnium&&<th style={{textAlign:'center',width:48}}>Omn.</th>}
                  <th style={{textAlign:'right',width:52}}>Ges.</th>
                  {isAdmin&&<th style={{width:60}}></th>}
                </tr>
              </thead>
              <tbody>
                {race.scoreboard.map((s,idx)=>{
                  const rowStyle: React.CSSProperties = s.isDsq?{opacity:0.5,textDecoration:'line-through'}:s.isFavorite?{background:'#fffbeb'}:{};
                  return(
                    <tr key={s.teamId} style={rowStyle}>
                      <td style={{color:'var(--c-text-muted)',fontSize:12}}>{s.isDsq?'':idx+1}</td>
                      <td className="num" style={{fontWeight:600}}>{s.teamNumber}</td>
                      <td>
                        <div style={{display:'flex',alignItems:'center',gap:4}}>
                          {s.isFavorite&&<span>⭐</span>}
                          {s.isWarned&&<span title="Verwarnung" style={{color:'var(--c-warning)'}}>⚠</span>}
                          {s.isDsq&&<span title="Disqualifiziert" style={{color:'var(--c-danger)'}}>⛔</span>}
                          <span style={{fontWeight:500}}>{s.teamName}</span>
                        </div>
                        {s.club&&<div style={{fontSize:11,color:'var(--c-text-muted)'}}>{s.club}</div>}
                        {displayFormat==='TEAM_PAIRS'&&(s.rider1||s.rider2)&&<div style={{fontSize:11,color:'var(--c-text-muted)'}}>{[s.rider1,s.rider2].filter(Boolean).join(' / ')}</div>}
                      </td>
                      {race.sprints.map(sprint=>{const pts=sprintPts(sprint,s.teamId);return(<td key={sprint.id} style={{textAlign:'center'}}>{pts!==null?<span style={{fontWeight:pts>=5?700:pts>=3?600:400,color:pts>=5?'var(--c-success)':pts>=3?'var(--c-primary)':'var(--c-text)',fontSize:pts>=5?15:13}}>{pts}</span>:''}</td>);})}
                      {hasFinale&&<td style={{textAlign:'center',fontSize:12,color:'var(--c-text-muted)'}}>{s.finalePosition??''}</td>}
                      <td style={{textAlign:'center',color:s.lapBalance>0?'var(--c-success)':s.lapBalance<0?'var(--c-danger)':'',fontWeight:s.lapBalance!==0?600:400}}>{s.lapBalance!==0?(s.lapBalance>0?`+${s.lapBalance*20}`:`${s.lapBalance*20}`):''}</td>
                      {hasOmnium&&<td style={{textAlign:'center'}}>{s.omniumPoints||''}</td>}
                      <td style={{textAlign:'right',fontWeight:700,fontSize:15,color:s.isDsq?'var(--c-danger)':''}}>{s.isDsq?'DSQ':s.total}</td>
                      {isAdmin&&(
                        <td style={{textAlign:'center'}}>
                          <div style={{display:'flex',gap:2,justifyContent:'center'}}>
                            <button type="button" title={s.isWarned?'Verwarnung aufheben':'Verwarnung'} onClick={()=>toggleFlag(s.teamId,'WARNING')} style={{background:'none',border:'none',cursor:'pointer',fontSize:14,opacity:s.isWarned?1:0.3}}>⚠</button>
                            <button type="button" title={s.isDsq?'DSQ aufheben':'DSQ'} onClick={()=>toggleFlag(s.teamId,'DSQ')} style={{background:'none',border:'none',cursor:'pointer',fontSize:14,opacity:s.isDsq?1:0.3}}>⛔</button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Sprint-Liste (Bearbeiten/Löschen) ── */}
      {race.sprints.length>0&&isAdmin&&(
        <div className="card">
          <h3 style={{marginBottom:8}}>Sprints</h3>
          {race.sprints.map(sprint=>(
            <div key={sprint.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'5px 0',borderBottom:'1px solid var(--c-border)',fontSize:13}}>
              <span>
                <span style={{color:'var(--c-text-muted)',marginRight:8}}>S{sprint.number}{sprint.isFinale?'★':''}</span>
                {sprint.results.map(r=>`${r.position}. ${r.team.number} ${r.team.name}`).join(' · ')}
              </span>
              <div style={{display:'flex',gap:4}}>
                <button className="btn btn-ghost btn-sm" style={{fontSize:11}} onClick={()=>openEdit(sprint)}>✏</button>
                <button className="btn btn-ghost btn-sm" style={{fontSize:11,color:'var(--c-danger)'}} onClick={()=>deleteSprint(sprint.id)}>×</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
