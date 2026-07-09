import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, athletesApi, athleteShortName, type Athlete, type FuehrungsplanData } from '../api/client';
import { useAdmin } from '../components/Layout';
import VerfolgungsplanungView, { PlanSaveData, fmtTime } from '../components/VerfolgungsplanungView';

// ── Typen ──────────────────────────────────────────────────────────────────────
interface SavedPlan {
  id: string; notes: string | null; trackM: number;
  numRounds: number; anfahrtSec: number; lapSec: number;
  totalSec: number; selectedKb: number | null; selectedRz: number | null;
  athleteMode: 'einzel' | 'mannschaft' | null;
  athleteIds: string[];
  fuehrungsplan: FuehrungsplanData | null;
  createdAt: string;
}

interface TEvent { ts: number; type: 'start' | 'lap' | 'half'; }

// ── Konstanten ─────────────────────────────────────────────────────────────────
const WHEEL       = 2.096;  // m Radumfang
const TOLERANCE   = 0.2;    // s Toleranz für Farbwechsel
const DISPLAY_SEC = 8;      // s Athletenanzeige

// ── Hilfsfunktionen ────────────────────────────────────────────────────────────
function fmtSec(s: number): string {
  if (isNaN(s) || s < 0) return '–';
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  const ss = sec.toFixed(2).padStart(5, '0');
  return m > 0 ? `${m}:${ss}` : `${sec.toFixed(2)}s`;
}

function parseSec(v: string): number {
  const m = v.trim().match(/^(\d+):(\d+\.?\d*)$/);
  return m ? parseInt(m[1]) * 60 + parseFloat(m[2]) : parseFloat(v);
}

function diffStyle(diff: number | null): { border: string; text: string; label: string } {
  if (diff === null) return { border: 'var(--c-border)', text: 'var(--c-text-muted)', label: '–' };
  if (diff >  TOLERANCE) return { border: 'var(--c-success)', text: 'var(--c-success)', label: `▲ +${diff.toFixed(2)}s` };
  if (diff < -TOLERANCE) return { border: 'var(--c-danger)',  text: 'var(--c-danger)',  label: `▼ ${diff.toFixed(2)}s`  };
  return { border: 'var(--c-primary)', text: 'var(--c-primary)', label: `= ${diff >= 0 ? '+' : ''}${diff.toFixed(2)}s` };
}

const planName = (p: SavedPlan | null) => p?.notes ?? 'Verfolgungsrennen';

const DEFAULT_CIRC_MM = 2100;
function rollout(kb: number, rz: number) { return (kb / rz) * (DEFAULT_CIRC_MM / 1000); }
function cadenceFromPlan(p: SavedPlan) {
  if (!p.selectedKb || !p.selectedRz) return null;
  return (p.trackM / p.lapSec / rollout(p.selectedKb, p.selectedRz)) * 60;
}
function formatDate(iso: string) {
  return new Date(iso).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// ── Führungsplan-Vorschau (read-only, für die Plan-Karte) ───────────────────
const FUEHRUNG_COLORS = ['#1d4ed8', '#16a34a', '#d97706', '#7c3aed', '#db2777', '#0891b2'];
function fmtLaps(n: number): string {
  const rounded = Math.round(n * 4) / 4;
  const whole = Math.floor(rounded + 1e-9);
  const frac = rounded - whole;
  let fracStr = '';
  if (Math.abs(frac - 0.25) < 0.01) fracStr = '¼';
  else if (Math.abs(frac - 0.5) < 0.01) fracStr = '½';
  else if (Math.abs(frac - 0.75) < 0.01) fracStr = '¾';
  if (!fracStr) return `${whole}`;
  return whole > 0 ? `${whole}${fracStr}` : fracStr;
}

type View = 'plans' | 'race' | 'display';

// ── Hauptkomponente ────────────────────────────────────────────────────────────
export default function PursuitPage() {
  const { isAdmin } = useAdmin();
  const [view, setView] = useState<View>('plans');

  // ── Pläne ──────────────────────────────────────────────────────────────────
  const [plans, setPlans]       = useState<SavedPlan[]>([]);
  const [loadingP, setLoadingP] = useState(true);
  const [error, setError]       = useState('');
  // Aktuell zum Bearbeiten geöffneter Plan (null = Rechner erstellt einen neuen).
  // key={editingPlan?.id ?? 'new'} weiter unten sorgt dafür, dass der Rechner
  // beim Wechsel zwischen "neu" und "bearbeiten" komplett neu mountet und damit
  // seine Vorbefüllung (initialPlan) frisch übernimmt.
  const [editingPlan, setEditingPlan] = useState<SavedPlan | null>(null);
  const [expandedPlanIds, setExpandedPlanIds] = useState<Set<string>>(new Set());
  function togglePlanExpanded(id: string) {
    setExpandedPlanIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  useEffect(() => {
    api.get<SavedPlan[]>('/api/pursuit-plans')
      .then(setPlans)
      .catch(() => {})
      .finally(() => setLoadingP(false));
  }, []);

  async function handleSave(data: PlanSaveData) {
    setError('');
    try {
      if (editingPlan) {
        const p = await api.patch<SavedPlan>(`/api/pursuit-plans/${editingPlan.id}`, data);
        setPlans(prev => prev.map(x => x.id === p.id ? p : x));
        setEditingPlan(null);
      } else {
        const p = await api.post<SavedPlan>('/api/pursuit-plans', data);
        setPlans(prev => [p, ...prev]);
      }
    } catch (e: any) { setError(e.message); }
  }

  async function deletePlan(id: string) {
    if (!confirm('Plan löschen?')) return;
    await api.delete(`/api/pursuit-plans/${id}`);
    setPlans(p => p.filter(x => x.id !== id));
    if (editingPlan?.id === id) cancelEdit();
  }

  function startEdit(plan: SavedPlan) {
    setEditingPlan(plan);
    setPursuitMode(plan.athleteMode ?? 'einzel');
    setSelectedAthletes(allAthletes.filter(a => plan.athleteIds.includes(a.id)));
    document.getElementById('rechner-anchor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function cancelEdit() {
    setEditingPlan(null);
    setPursuitMode('einzel');
    setSelectedAthletes([]);
  }

  // ── Sportlerauswahl (Einzel/Mannschaft) ───────────────────────────────────
  // Rein lokal — die eigenständige /pursuit-Seite hängt an keinem Rennen, es
  // gibt also nichts, woran die Auswahl im Backend hängen könnte. Dient nur
  // der Gang-Vorauswahl aus dem Sportlerprofil (wie im Renndetail) und wird
  // beim Speichern als Teil von PlanSaveData mitgesichert.
  const [allAthletes, setAllAthletes] = useState<Athlete[]>([]);
  useEffect(() => { athletesApi.list().then(setAllAthletes).catch(() => {}); }, []);
  const [pursuitMode, setPursuitMode]         = useState<'einzel' | 'mannschaft'>('einzel');
  const [selectedAthletes, setSelectedAthletes] = useState<Athlete[]>([]);
  function switchPursuitMode(m: 'einzel' | 'mannschaft') {
    setPursuitMode(m);
    setSelectedAthletes([]);
  }
  function handleAthletesChange(ids: string[]) {
    setSelectedAthletes(allAthletes.filter(a => ids.includes(a.id)));
  }

  // ── Timer – State ──────────────────────────────────────────────────────────
  const [activePlan, setActivePlan]   = useState<SavedPlan | null>(null);
  const [timerLaps, setTimerLaps]     = useState(12);
  const [events, setEvents]           = useState<TEvent[]>([]);
  const [autoAlt, setAutoAlt]         = useState(false);
  const [nextIsHalf, setNextIsHalf]   = useState(false);
  const [countdown, setCountdown]     = useState(0);
  const [finished, setFinished]       = useState(false);
  const [btnArmed, setBtnArmed]       = useState(false); // Finger liegt auf Button

  // Refs für stabile Callbacks
  const eventsRef     = useRef<TEvent[]>([]);
  const autoAltRef    = useRef(false);
  const nextIsHalfRef = useRef(false);
  const timerLapsRef  = useRef(12);
  const activePlanRef = useRef<SavedPlan | null>(null);
  const dispTimer     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cdInterval    = useRef<ReturnType<typeof setInterval> | null>(null);

  function syncEvs(evs: TEvent[]) { eventsRef.current = evs; setEvents(evs); }
  function setAuto(v: boolean)    { autoAltRef.current    = v; setAutoAlt(v); }
  function setNxtH(v: boolean)    { nextIsHalfRef.current = v; setNextIsHalf(v); }

  // ── Timer – Berechnete Werte ───────────────────────────────────────────────
  const lapEvs   = events.filter(e => e.type === 'lap');
  const startEvt = events.find(e => e.type === 'start');
  const lapCount = lapEvs.length;

  const lastLapT = lapCount > 0
    ? (lapEvs[lapCount-1].ts - (lapCount > 1 ? lapEvs[lapCount-2].ts : (startEvt?.ts ?? 0))) / 1000
    : null;
  const totalT = lapCount > 0 && startEvt
    ? (lapEvs[lapCount-1].ts - startEvt.ts) / 1000 : null;

  const planLapT = activePlan && lapCount > 0
    ? (lapCount === 1 ? activePlan.anfahrtSec : activePlan.lapSec) : null;
  const planCumT = activePlan && lapCount > 0
    ? activePlan.anfahrtSec + activePlan.lapSec * (lapCount - 1) : null;
  const delta = planLapT !== null && lastLapT !== null ? planLapT - lastLapT : null;
  const style = diffStyle(delta);

  // ── Timer – Verlauf ────────────────────────────────────────────────────────
  const lapHistory = useMemo(() => {
    const start = events.find(e => e.type === 'start');
    const laps  = events.filter(e => e.type === 'lap');
    const halfs = events.filter(e => e.type === 'half');
    if (!start || laps.length === 0) return [];
    return [...laps].reverse().slice(0, 6).map((lap, ri) => {
      const i = laps.length - 1 - ri;
      const prevTs = i > 0 ? laps[i-1].ts : start.ts;
      const lt = (lap.ts - prevTs) / 1000;
      const pLt = activePlan ? (i === 0 ? activePlan.anfahrtSec : activePlan.lapSec) : null;
      const diff = pLt !== null ? pLt - lt : null;
      const hBetween = halfs.filter(h => h.ts > prevTs && h.ts < lap.ts);
      const half = hBetween.length > 0
        ? { h1: (hBetween[0].ts - prevTs) / 1000, h2: (lap.ts - hBetween[0].ts) / 1000 }
        : null;
      return { lapNum: i + 1, lt, diff, half };
    });
  }, [events, activePlan]);

  // ── Timer – Aktionen ───────────────────────────────────────────────────────
  function mainTap() {
    if (finished) return;
    if (eventsRef.current.length === 0) {
      syncEvs([{ ts: performance.now(), type: 'start' }]);
      if (autoAltRef.current) setNxtH(true);
      return;
    }
    if (autoAltRef.current) {
      const wasHalf = nextIsHalfRef.current;
      setNxtH(!wasHalf);
      wasHalf ? recHalf() : recLap();
    } else {
      recLap();
    }
  }

  function recLap() {
    const ev: TEvent = { ts: performance.now(), type: 'lap' };
    const newEvs = [...eventsRef.current, ev];
    eventsRef.current = newEvs;
    const done = newEvs.filter(e => e.type === 'lap').length;
    setEvents(newEvs);
    if (done >= timerLapsRef.current) { setFinished(true); return; }
    // Zur Athletenanzeige wechseln
    clearTimeout(dispTimer.current!);
    clearInterval(cdInterval.current!);
    setView('display');
    setCountdown(DISPLAY_SEC);
    let rem = DISPLAY_SEC;
    cdInterval.current = setInterval(() => { rem--; setCountdown(rem); if (rem <= 0) clearInterval(cdInterval.current!); }, 1000);
    dispTimer.current = setTimeout(() => setView('race'), DISPLAY_SEC * 1000);
  }

  function recHalf() {
    const newEvs = [...eventsRef.current, { ts: performance.now(), type: 'half' as const }];
    eventsRef.current = newEvs;
    setEvents(newEvs);
  }

  function manualHalf() {
    if (eventsRef.current.length === 0 || finished) return;
    recHalf();
  }

  function undoLast() {
    if (eventsRef.current.length <= 1) return;
    const last = eventsRef.current[eventsRef.current.length - 1];
    const newEvs = eventsRef.current.slice(0, -1);
    if (autoAltRef.current && (last.type === 'lap' || last.type === 'half'))
      setNxtH(!nextIsHalfRef.current);
    syncEvs(newEvs);
  }

  function togAuto() {
    const v = !autoAltRef.current;
    setAuto(v);
    if (v) setNxtH(true);
  }

  function resetTimer() {
    clearTimeout(dispTimer.current!);
    clearInterval(cdInterval.current!);
    eventsRef.current = []; setEvents([]);
    autoAltRef.current = false; setAutoAlt(false);
    nextIsHalfRef.current = false; setNextIsHalf(false);
    setFinished(false);
  }

  function startWith(plan: SavedPlan | null) {
    activePlanRef.current = plan;
    setActivePlan(plan);
    const n = plan?.numRounds ?? timerLaps;
    timerLapsRef.current = n;
    setTimerLaps(n);
    resetTimer();
    setView('race');
  }

  function doExport() {
    const start = eventsRef.current.find(e => e.type === 'start');
    if (!start) return;
    const laps  = eventsRef.current.filter(e => e.type === 'lap');
    const halfs = eventsRef.current.filter(e => e.type === 'half');
    const p = activePlanRef.current;
    const rows = ['Runde;Zeit (s);Halbrunde 1 (s);Halbrunde 2 (s);Kumuliert (s);Plan (s);Differenz (s)'];
    laps.forEach((lap, i) => {
      const prevTs = i > 0 ? laps[i-1].ts : start.ts;
      const lt  = ((lap.ts - prevTs) / 1000).toFixed(3);
      const cum = ((lap.ts - start.ts) / 1000).toFixed(3);
      const pLt = p ? (i === 0 ? p.anfahrtSec : p.lapSec).toFixed(3) : '';
      const df  = p && pLt ? ((i === 0 ? p.anfahrtSec : p.lapSec) - parseFloat(lt)).toFixed(3) : '';
      const hEvs = halfs.filter(h => h.ts > prevTs && h.ts < lap.ts);
      const h1 = hEvs.length > 0 ? ((hEvs[0].ts - prevTs) / 1000).toFixed(3) : '';
      const h2 = hEvs.length > 0 ? ((lap.ts - hEvs[0].ts) / 1000).toFixed(3) : '';
      rows.push(`${i+1};${lt};${h1};${h2};${cum};${pLt};${df}`);
    });
    const a = document.createElement('a');
    a.href = `data:text/csv;charset=utf-8,\uFEFF${encodeURIComponent(rows.join('\n'))}`;
    a.download = `verfolgung_${(planName(activePlanRef.current)).replace(/\s/g, '_')}.csv`;
    a.click();
  }

  // ════════════════════════════════════════════════════════════════════════════
  // VIEW: ATHLETENANZEIGE
  // ════════════════════════════════════════════════════════════════════════════
  if (view === 'display') {
    return (
      <div style={{
        position: 'fixed', inset: 0, zIndex: 50,
        background: 'var(--c-white)',
        border: `16px solid ${style.border}`,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        textAlign: 'center',
        transition: 'border-color 0.25s',
      }}>
        <div className="text-sm text-muted" style={{ marginBottom: 8 }}>
          {planName(activePlan)} · Runde {lapCount} / {timerLaps}
        </div>
        <div style={{
          fontSize: 'clamp(80px, 22vw, 40vh)',
          fontWeight: 500, lineHeight: 1,
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: '-0.02em',
          color: 'var(--c-text)',
        }}>
          {lastLapT !== null ? `${lastLapT.toFixed(2)}s` : '–'}
        </div>
        <div style={{ fontSize: 'clamp(24px, 8vw, 14vh)', fontWeight: 500, marginTop: 16, color: style.text }}>
          {style.label}
        </div>
        {countdown > 0 && (
          <div className="text-xs text-muted" style={{ marginTop: 20 }}>
            Zurück in {countdown}s
          </div>
        )}
        <button
          className="btn btn-ghost btn-sm"
          style={{ position: 'absolute', bottom: 24 }}
          onClick={() => { clearTimeout(dispTimer.current!); clearInterval(cdInterval.current!); setView('race'); }}
        >
          ← Trainer
        </button>
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════════════════════
  // VIEW: RENNTIMER (Trainer)
  // ════════════════════════════════════════════════════════════════════════════
  if (view === 'race') {
    const mainLabel = events.length === 0
      ? 'RUNDE ⏱ (Start)'
      : autoAlt ? (nextIsHalf ? '½ RUNDE →' : 'RUNDE ⏱') : 'RUNDE ⏱';

    const finDiff = activePlan && totalT !== null
      ? (activePlan.anfahrtSec + activePlan.lapSec * (timerLaps - 1)) - totalT
      : null;
    const finStyle = diffStyle(finDiff);

    return (
      <div className="page container">
        <div className="breadcrumb">
          <Link to="/">Veranstaltungen</Link><span>›</span>
          <button className="btn btn-ghost btn-sm" style={{ padding: '0 4px', fontSize: 13 }}
            onClick={() => { resetTimer(); setView('plans'); }}>
            Verfolgung
          </button>
          <span>›</span>{planName(activePlan)}
        </div>

        <div className="flex-between mb-4">
          <div>
            <h1>{planName(activePlan)}</h1>
            <p className="text-sm text-muted" style={{ margin: '2px 0 0' }}>
              {timerLaps} Runden
              {activePlan && ` · Plan ${fmtSec(activePlan.anfahrtSec + activePlan.lapSec * (timerLaps - 1))}`}
            </p>
          </div>
        </div>

        {/* Ziel-Anzeige */}
        {finished && (
          <div className="card mb-4" style={{ textAlign: 'center', padding: 24 }}>
            <h2 style={{ marginBottom: 8 }}>Zielzeit</h2>
            <div style={{ fontSize: 52, fontWeight: 500, fontVariantNumeric: 'tabular-nums', marginBottom: 8 }}>
              {totalT !== null ? fmtSec(totalT) : '–'}
            </div>
            {finDiff !== null && (
              <div style={{ fontSize: 20, color: finStyle.text, marginBottom: 16 }}>
                {finStyle.label} vs Plan ({fmtSec(activePlan!.anfahrtSec + activePlan!.lapSec * (timerLaps - 1))})
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button className="btn btn-secondary" onClick={doExport}>CSV exportieren</button>
              <button className="btn btn-ghost" onClick={() => { resetTimer(); setView('plans'); }}>Beenden</button>
            </div>
          </div>
        )}

        {!finished && (
          <>
            {/* Zwischenstand */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <div className="card" style={{ padding: '11px 14px' }}>
                <div className="text-xs text-muted">{planName(activePlan)}</div>
                <div style={{ fontSize: 20, fontWeight: 500, margin: '3px 0' }}>
                  Runde {lapCount || '–'} / {timerLaps}
                </div>
                <div className="text-sm text-muted">
                  Gesamt: <span style={{ color: 'var(--c-text)', fontWeight: 500 }}>
                    {totalT !== null ? fmtSec(totalT) : '–'}
                  </span>
                </div>
                {planCumT && (
                  <div className="text-sm text-muted">
                    Plan: <span style={{ fontWeight: 500 }}>{fmtSec(planCumT)}</span>
                    {totalT !== null && (
                      <span style={{ marginLeft: 6, color: diffStyle(planCumT - totalT).text, fontWeight: 500 }}>
                        {diffStyle(planCumT - totalT).label}
                      </span>
                    )}
                  </div>
                )}
              </div>

              <div className="card" style={{
                padding: '11px 14px', textAlign: 'center',
                background: delta !== null
                  ? delta > TOLERANCE ? '#dcfce7' : delta < -TOLERANCE ? '#fee2e2' : '#dbeafe'
                  : undefined,
              }}>
                <div className="text-xs text-muted" style={{ marginBottom: 3 }}>letzte runde</div>
                <div style={{ fontSize: 36, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
                  {lastLapT !== null ? `${lastLapT.toFixed(2)}s` : '–'}
                </div>
                <div style={{ fontSize: 14, fontWeight: 500, color: style.text }}>{style.label}</div>
              </div>
            </div>

            {/* Haupt-Tipp-Knopf — löst beim Loslassen aus (onPointerUp) */}
            <button
              onPointerDown={e => {
                e.preventDefault();
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                setBtnArmed(true);
              }}
              onPointerUp={e => {
                if (!btnArmed) return;
                setBtnArmed(false);
                mainTap();
              }}
              onPointerCancel={() => setBtnArmed(false)}
              onContextMenu={e => e.preventDefault()}
              style={{
                width: '100%',
                height: 'clamp(100px, 22vh, 160px)',
                fontSize: 'clamp(20px, 4vw, 26px)',
                fontWeight: 500,
                borderRadius: 12,
                cursor: 'pointer',
                marginBottom: 8,
                border: `3px solid var(--c-primary)`,
                color: btnArmed ? 'white' : 'var(--c-primary)',
                background: btnArmed ? 'var(--c-primary)' : '#dbeafe',
                fontFamily: 'inherit',
                transition: 'background 0.08s, color 0.08s',
                userSelect: 'none',
                WebkitUserSelect: 'none',
                touchAction: 'none',
              }}
            >
              {btnArmed ? '↑ Loslassen zum Auslösen' : mainLabel}
            </button>

            {/* Nebensteuerung */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 6, marginBottom: 14 }}>
              <button className="btn btn-secondary btn-sm" onClick={manualHalf}
                style={{ opacity: autoAlt ? 0.35 : 1, pointerEvents: autoAlt ? 'none' : 'auto' }}>
                ½ Runde
              </button>
              <button className="btn btn-secondary btn-sm" onClick={togAuto}
                style={{
                  background: autoAlt ? '#dcfce7' : undefined,
                  borderColor: autoAlt ? 'var(--c-success)' : undefined,
                  color: autoAlt ? 'var(--c-success)' : undefined,
                }}>
                Auto: {autoAlt ? 'EIN' : 'AUS'}
              </button>
              <button className="btn btn-secondary btn-sm" disabled={events.length <= 1} onClick={undoLast}>
                ↩ Undo
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => { resetTimer(); setView('plans'); }}>
                Beenden
              </button>
            </div>

            {/* Verlauf */}
            {lapHistory.length > 0 && (
              <div style={{ fontSize: 12 }}>
                {lapHistory.map(({ lapNum, lt, diff, half }) => {
                  const ds = diffStyle(diff);
                  return (
                    <div key={lapNum} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--c-border)' }}>
                      <span className="text-muted">Rd. {lapNum}</span>
                      <span style={{ fontWeight: 500 }}>
                        {lt.toFixed(2)}s
                        {half && <span className="text-muted" style={{ fontSize: 11, marginLeft: 6 }}>({half.h1.toFixed(2)} | {half.h2.toFixed(2)})</span>}
                      </span>
                      <span style={{ color: ds.text }}>{diff !== null ? ds.label : ''}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════════════════════
  // VIEW: PLANLISTE + RECHNER
  // ════════════════════════════════════════════════════════════════════════════
  return (
    <div className="page container">
      <div className="breadcrumb">
        <Link to="/">Veranstaltungen</Link><span>›</span>Verfolgung
      </div>
      <div className="flex-between mb-4">
        <h1>Verfolgungsplanung</h1>
        <button className="btn btn-secondary btn-sm" onClick={() => startWith(null)}>
          Ohne Plan starten
        </button>
      </div>

      {error && <div className="alert alert-error mb-3">{error}</div>}

      {/* Gespeicherte Pläne */}
      {loadingP ? (
        <div className="loading"><span className="spinner" /> Lädt…</div>
      ) : plans.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 24 }}>
          {plans.map(plan => {
            const hasGear = plan.selectedKb !== null && plan.selectedRz !== null;
            const ro  = hasGear ? rollout(plan.selectedKb!, plan.selectedRz!) : null;
            const cad = hasGear ? cadenceFromPlan(plan) : null;
            const planAthletes = plan.athleteIds
              .map(id => allAthletes.find(a => a.id === id))
              .filter((a): a is Athlete => !!a);
            const fp = plan.fuehrungsplan;
            const isExpanded = expandedPlanIds.has(plan.id);
            const riderColorFor = (athleteId: string) => {
              const i = fp?.riderOrder.indexOf(athleteId) ?? -1;
              return FUEHRUNG_COLORS[(i < 0 ? 0 : i) % FUEHRUNG_COLORS.length];
            };
            return (
              <div key={plan.id} className="card" style={{ padding: '12px 14px', borderColor: editingPlan?.id === plan.id ? 'var(--c-primary)' : undefined }}>
                <div style={{ fontWeight: 600, fontSize: 14.5 }}>{planName(plan)}</div>
                <div className="text-sm text-muted" style={{ marginTop: 2 }}>
                  {plan.numRounds} Runden · {Math.round(plan.numRounds * plan.trackM)}m ·
                  {' '}{fmtTime(plan.totalSec)} · Rd. 2+ {plan.lapSec.toFixed(2)}s
                </div>

                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 9 }}>
                  <button className="btn btn-secondary btn-sm" onClick={() => togglePlanExpanded(plan.id)}>
                    👁 {isExpanded ? 'Ausblenden' : 'Anzeigen'}
                  </button>
                  <button className="btn btn-primary btn-sm" onClick={() => startWith(plan)}>
                    ⏱ Timer
                  </button>
                  {isAdmin && (
                    <>
                      <button className="btn btn-secondary btn-sm" onClick={() => startEdit(plan)}>
                        ✏️ Bearbeiten
                      </button>
                      <button className="btn btn-ghost btn-sm" style={{ color: 'var(--c-danger)' }} onClick={() => deletePlan(plan.id)}>
                        🗑
                      </button>
                    </>
                  )}
                </div>

                {hasGear && (
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 12, background: 'var(--c-primary)', borderRadius: 6, padding: '5px 12px', marginTop: 8 }}>
                    <span style={{ fontWeight: 800, fontSize: 18, color: 'white', letterSpacing: '-0.5px' }}>{plan.selectedKb} / {plan.selectedRz}</span>
                    <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.85)', borderLeft: '1px solid rgba(255,255,255,0.3)', paddingLeft: 10 }}>
                      Rollout {ro!.toFixed(2)} m · {cad!.toFixed(0)} rpm
                    </span>
                  </div>
                )}

                {isExpanded && (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed var(--c-border)' }}>
                    {planAthletes.length > 0 && (
                      <div className="text-xs text-muted">
                        {plan.athleteMode === 'mannschaft' ? 'Team: ' : 'Sportler: '}
                        {planAthletes.map(a => athleteShortName(a)).join(', ')}
                      </div>
                    )}
                    <div className="text-xs text-muted" style={{ marginTop: 3 }}>{formatDate(plan.createdAt)}</div>

                    {fp && fp.segments.length > 0 && (
                      <>
                        <div style={{ display: 'flex', height: 28, borderRadius: 6, overflow: 'hidden', boxShadow: 'inset 0 0 0 1px var(--c-border)', marginTop: 10, marginBottom: 8 }}>
                          {fp.segments.map((seg, i) => (
                            <div key={i} style={{
                              flex: seg.laps, display: 'flex', alignItems: 'center', justifyContent: 'center',
                              background: riderColorFor(seg.athleteId), color: 'white', fontWeight: 600, fontSize: 10,
                              fontVariantNumeric: 'tabular-nums',
                            }}>
                              {fmtLaps(seg.laps)}
                            </div>
                          ))}
                        </div>
                        <div>
                          {(() => {
                            let cum = 0;
                            return fp.segments.map((seg, i) => {
                              const rider = planAthletes.find(a => a.id === seg.athleteId);
                              const start = cum; cum += seg.laps;
                              return (
                                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: i < fp.segments.length - 1 ? '1px solid var(--c-border)' : 'none' }}>
                                  <div style={{ width: 17, height: 17, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, color: 'white', flexShrink: 0, background: riderColorFor(seg.athleteId) }}>{i + 1}</div>
                                  <span style={{ fontSize: 12.5, fontWeight: 500, flex: 1 }}>{rider ? athleteShortName(rider) : '–'}</span>
                                  <span style={{ fontSize: 10.5, color: 'var(--c-text-muted)' }}>Rd. {fmtLaps(start)}–{fmtLaps(cum)}</span>
                                  <span style={{ fontSize: 12.5, fontWeight: 600, minWidth: 30, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtLaps(seg.laps)}</span>
                                </div>
                              );
                            });
                          })()}
                        </div>

                        <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px dashed var(--c-border)' }}>
                          {planAthletes.filter(a => fp.riderModes[a.id] !== 'back').map(a => {
                            const lapSum = fp.segments.filter(s => s.athleteId === a.id).reduce((s, x) => s + x.laps, 0);
                            const segCount = fp.segments.filter(s => s.athleteId === a.id).length;
                            const gear = fp.riderGears?.[a.id] ?? null;
                            return (
                              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '4px 0', fontSize: 12.5 }}>
                                <span style={{ width: 9, height: 9, borderRadius: '50%', flexShrink: 0, background: riderColorFor(a.id) }} />
                                <span style={{ flex: 1 }}>{athleteShortName(a)}</span>
                                <span style={{ color: 'var(--c-text-muted)', fontSize: 11.5 }}>{fmtLaps(lapSum)} Rd. · {segCount}× vorne</span>
                                <span style={{
                                  fontSize: 11, fontWeight: gear ? 700 : 500, borderRadius: 5, padding: '2px 7px', marginLeft: 8, whiteSpace: 'nowrap',
                                  background: gear ? 'var(--c-primary)' : '#f3f4f6', color: gear ? 'white' : 'var(--c-text-muted)',
                                }}>
                                  {gear ? `${gear.kb}/${gear.rz}` : 'kein Gang'}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : !loadingP && (
        <div className="alert alert-info mb-4" style={{ fontSize: 13 }}>
          Noch kein Plan gespeichert – Rechner unten verwenden und Plan speichern.
        </div>
      )}

      {/* Trennlinie */}
      <div id="rechner-anchor" style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: editingPlan ? 12 : 20, scrollMarginTop: 70 }}>
        <div style={{ flex: 1, height: 1, background: 'var(--c-border)' }} />
        <span style={{ fontSize: 12, color: 'var(--c-text-muted)', whiteSpace: 'nowrap' }}>
          {editingPlan ? 'Plan bearbeiten' : isAdmin ? 'Neuen Plan erstellen' : 'Rechner (lokal, ohne Speichern)'}
        </span>
        <div style={{ flex: 1, height: 1, background: 'var(--c-border)' }} />
      </div>

      {editingPlan && (
        <div className="alert alert-info" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <span>Du bearbeitest <strong>{planName(editingPlan)}</strong> — „Änderungen speichern" überschreibt diesen Plan.</span>
          <button className="btn btn-ghost btn-sm" onClick={cancelEdit}>Abbrechen</button>
        </div>
      )}

      {/* Einzel/Mannschaft-Umschalter */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button
          className={`btn btn-sm ${pursuitMode === 'einzel' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => switchPursuitMode('einzel')}
        >
          Einzelverfolgung
        </button>
        <button
          className={`btn btn-sm ${pursuitMode === 'mannschaft' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => switchPursuitMode('mannschaft')}
        >
          Mannschaftsverfolgung
        </button>
      </div>

      {/* Rechner */}
      <VerfolgungsplanungView
        key={editingPlan?.id ?? 'new'}
        isAdmin={isAdmin}
        onSave={isAdmin ? handleSave : undefined}
        initialPlan={editingPlan}
        athleteMode={pursuitMode}
        allAthletes={allAthletes}
        selectedAthletes={selectedAthletes}
        onAthletesChange={handleAthletesChange}
        fuehrungsplan={editingPlan?.fuehrungsplan}
      />
    </div>
  );
}
