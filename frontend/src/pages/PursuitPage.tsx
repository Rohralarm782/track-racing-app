import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAdmin } from '../components/Layout';

// ─── Typen ────────────────────────────────────────────────────────────────────

interface Plan {
  id: string; name: string; trackLength: number;
  totalLaps: number; anfahrtSec: number; lapTimeSec: number;
}

interface TEvent { ts: number; type: 'start' | 'lap' | 'half'; }

// ─── Konstanten ───────────────────────────────────────────────────────────────

const WHEEL     = 2.096; // m Radumfang Track
const TOLERANCE = 0.2;   // Sekunden – erst ab hier Farbwechsel
const DISPLAY_SEC = 8;   // Sekunden Athletenanzeige

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────

function fmtSec(s: number): string {
  if (isNaN(s) || s < 0) return '–';
  const m   = Math.floor(s / 60);
  const sec = s - m * 60;
  const ss  = sec.toFixed(2).padStart(5, '0');
  return m > 0 ? `${m}:${ss}` : `${sec.toFixed(2)}s`;
}

function parseSec(v: string): number {
  const m = v.trim().match(/^(\d+):(\d+\.?\d*)$/);
  return m ? parseInt(m[1]) * 60 + parseFloat(m[2]) : parseFloat(v);
}

// Farbe basierend auf Delta vs. Plan (mit Toleranz)
function diffStyle(diff: number | null): { border: string; text: string; label: string } {
  if (diff === null) return { border: 'var(--c-border)', text: 'var(--c-text-muted)', label: '–' };
  if (diff >  TOLERANCE) return { border: 'var(--c-success)', text: 'var(--c-success)', label: `▲ +${diff.toFixed(2)}s` };
  if (diff < -TOLERANCE) return { border: 'var(--c-danger)',  text: 'var(--c-danger)',  label: `▼ ${diff.toFixed(2)}s`  };
  return { border: 'var(--c-primary)', text: 'var(--c-primary)', label: `= ${diff >= 0 ? '+' : ''}${diff.toFixed(2)}s` };
}

type View = 'plans' | 'calc' | 'race' | 'display';

// ─── Hauptkomponente ──────────────────────────────────────────────────────────

export default function PursuitPage() {
  const { isAdmin } = useAdmin();
  const [view, setView] = useState<View>('plans');

  // ── Pläne ──────────────────────────────────────────────────────────────────
  const [plans, setPlans]     = useState<Plan[]>([]);
  const [loadingP, setLoadingP] = useState(true);

  useEffect(() => {
    api.get<Plan[]>('/api/pursuit-plans').then(setPlans).finally(() => setLoadingP(false));
  }, []);

  async function deletePlan(id: string) {
    if (!confirm('Plan löschen?')) return;
    await api.delete(`/api/pursuit-plans/${id}`);
    setPlans(p => p.filter(x => x.id !== id));
  }

  // ── Rechner ────────────────────────────────────────────────────────────────
  const [trackLen,    setTrackLen]    = useState(250);
  const [laps,        setLaps]        = useState(12);
  const [calcMode,    setCalcMode]    = useState<'target' | 'laptime'>('target');
  const [anfahrtStr,  setAnfahrtStr]  = useState('23.5');
  const [targetStr,   setTargetStr]   = useState('3:45.0');
  const [lapStr,      setLapStr]      = useState('20.5');
  const [showSave,    setShowSave]    = useState(false);
  const [saveName,    setSaveName]    = useState('');
  const [saving,      setSaving]      = useState(false);

  const anfahrtSec = parseFloat(anfahrtStr) || 0;
  const calcLapSec = calcMode === 'target'
    ? (parseSec(targetStr) - anfahrtSec) / Math.max(laps - 1, 1)
    : parseSec(lapStr);
  const calcTotalSec = calcMode === 'target' ? parseSec(targetStr) : anfahrtSec + calcLapSec * (laps - 1);

  const planTable = useMemo(() => {
    const rows: { lap: number; time: number; cum: number }[] = [];
    let cum = 0;
    for (let i = 1; i <= laps; i++) {
      const t = i === 1 ? anfahrtSec : calcLapSec;
      cum += t;
      rows.push({ lap: i, time: t, cum });
    }
    return rows;
  }, [laps, anfahrtSec, calcLapSec]);

  async function savePlan() {
    if (!saveName || !isAdmin) return;
    setSaving(true);
    try {
      const p = await api.post<Plan>('/api/pursuit-plans', {
        name: saveName, trackLength: trackLen,
        totalLaps: laps, anfahrtSec, lapTimeSec: calcLapSec,
      });
      setPlans(prev => [p, ...prev]);
      setShowSave(false); setSaveName('');
    } finally { setSaving(false); }
  }

  // ── Timer – State ──────────────────────────────────────────────────────────
  const [activePlan,  setActivePlan]  = useState<Plan | null>(null);
  const [timerLaps,   setTimerLaps]   = useState(12);
  const [events,      setEvents]      = useState<TEvent[]>([]);
  const [autoAlt,     setAutoAlt]     = useState(false);
  const [nextIsHalf,  setNextIsHalf]  = useState(false);
  const [countdown,   setCountdown]   = useState(0);
  const [finished,    setFinished]    = useState(false);
  const [error,       setError]       = useState('');

  // Refs für stabile Callbacks (vermeidet stale closure Probleme)
  const eventsRef     = useRef<TEvent[]>([]);
  const autoAltRef    = useRef(false);
  const nextIsHalfRef = useRef(false);
  const timerLapsRef  = useRef(12);
  const activePlanRef = useRef<Plan | null>(null);
  const dispTimer     = useRef<ReturnType<typeof setTimeout>  | null>(null);
  const cdInterval    = useRef<ReturnType<typeof setInterval> | null>(null);

  function syncEvs(evs: TEvent[]) { eventsRef.current = evs; setEvents(evs); }
  function setAuto(v: boolean)     { autoAltRef.current    = v; setAutoAlt(v);    }
  function setNxtH(v: boolean)     { nextIsHalfRef.current = v; setNextIsHalf(v); }

  // ── Timer – Berechnete Werte ───────────────────────────────────────────────
  const lapEvs   = events.filter(e => e.type === 'lap');
  const startEvt = events.find(e => e.type === 'start');
  const lapCount = lapEvs.length;

  const lastLapT = lapCount > 0
    ? (lapEvs[lapCount - 1].ts - (lapCount > 1 ? lapEvs[lapCount - 2].ts : (startEvt?.ts ?? 0))) / 1000
    : null;
  const totalT = lapCount > 0 && startEvt
    ? (lapEvs[lapCount - 1].ts - startEvt.ts) / 1000 : null;

  const planLapT = activePlan && lapCount > 0
    ? (lapCount === 1 ? activePlan.anfahrtSec : activePlan.lapTimeSec) : null;
  const planCumT = activePlan && lapCount > 0
    ? activePlan.anfahrtSec + activePlan.lapTimeSec * (lapCount - 1) : null;
  const delta    = planLapT !== null && lastLapT !== null ? planLapT - lastLapT : null;
  const style    = diffStyle(delta);

  // ── Timer – Verlauf ────────────────────────────────────────────────────────
  const lapHistory = useMemo(() => {
    const start = events.find(e => e.type === 'start');
    const laps  = events.filter(e => e.type === 'lap');
    const halfs = events.filter(e => e.type === 'half');
    if (!start || laps.length === 0) return [];
    return [...laps].reverse().slice(0, 6).map((lap, ri) => {
      const i      = laps.length - 1 - ri;
      const prevTs = i > 0 ? laps[i - 1].ts : start.ts;
      const lt     = (lap.ts - prevTs) / 1000;
      const pLt    = activePlan ? (i === 0 ? activePlan.anfahrtSec : activePlan.lapTimeSec) : null;
      const diff   = pLt !== null ? pLt - lt : null;
      const hBetween = halfs.filter(h => h.ts > prevTs && h.ts < lap.ts);
      const half   = hBetween.length > 0
        ? { h1: (hBetween[0].ts - prevTs) / 1000, h2: (lap.ts - hBetween[0].ts) / 1000 }
        : null;
      return { lapNum: i + 1, lt, diff, half };
    });
  }, [events, activePlan]);

  // ── Timer – Aktionen ───────────────────────────────────────────────────────

  function mainTap() {
    if (finished) return;

    // Erster Tipp = Startschuss
    if (eventsRef.current.length === 0) {
      syncEvs([{ ts: performance.now(), type: 'start' }]);
      if (autoAltRef.current) setNxtH(true); // erste Auto-Aktion = Halbrunde
      return;
    }

    if (autoAltRef.current) {
      const wasHalf = nextIsHalfRef.current;
      setNxtH(!wasHalf); // ZUERST umschalten, dann Aktion
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

    // Automatisch zur Athletenanzeige wechseln
    clearTimeout(dispTimer.current!);
    clearInterval(cdInterval.current!);
    setView('display');
    setCountdown(DISPLAY_SEC);
    let rem = DISPLAY_SEC;
    cdInterval.current = setInterval(() => {
      rem--;
      setCountdown(rem);
      if (rem <= 0) clearInterval(cdInterval.current!);
    }, 1000);
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
    if (v) setNxtH(true); // erste Auto-Aktion = Halbrunde
  }

  function resetTimer() {
    clearTimeout(dispTimer.current!);
    clearInterval(cdInterval.current!);
    eventsRef.current = []; setEvents([]);
    autoAltRef.current = false; setAutoAlt(false);
    nextIsHalfRef.current = false; setNextIsHalf(false);
    setFinished(false); setError('');
  }

  function startWith(plan: Plan | null) {
    activePlanRef.current = plan;
    setActivePlan(plan);
    const n = plan?.totalLaps ?? laps;
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
    const p     = activePlanRef.current;
    const rows  = ['Runde;Zeit (s);Halbrunde 1 (s);Halbrunde 2 (s);Kumuliert (s);Plan (s);Differenz (s)'];
    laps.forEach((lap, i) => {
      const prevTs = i > 0 ? laps[i - 1].ts : start.ts;
      const lt  = ((lap.ts - prevTs) / 1000).toFixed(3);
      const cum = ((lap.ts - start.ts) / 1000).toFixed(3);
      const pLt = p ? (i === 0 ? p.anfahrtSec : p.lapTimeSec).toFixed(3) : '';
      const df  = p && pLt ? ((i === 0 ? p.anfahrtSec : p.lapTimeSec) - parseFloat(lt)).toFixed(3) : '';
      const hEvs = halfs.filter(h => h.ts > prevTs && h.ts < lap.ts);
      const h1 = hEvs.length > 0 ? ((hEvs[0].ts - prevTs) / 1000).toFixed(3) : '';
      const h2 = hEvs.length > 0 ? ((lap.ts - hEvs[0].ts) / 1000).toFixed(3) : '';
      rows.push(`${i + 1};${lt};${h1};${h2};${cum};${pLt};${df}`);
    });
    const csv = rows.join('\n');
    const a   = document.createElement('a');
    a.href     = `data:text/csv;charset=utf-8,\uFEFF${encodeURIComponent(csv)}`;
    a.download = `verfolgung_${(activePlanRef.current?.name ?? 'rennen').replace(/\s/g, '_')}.csv`;
    a.click();
  }

  // ════════════════════════════════════════════════════════════════════════════
  // RENDER – ATHLETENANZEIGE
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
          {activePlan?.name ?? 'Verfolgung'} · Runde {lapCount} / {timerLaps}
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
        <div style={{
          fontSize: 'clamp(24px, 8vw, 14vh)',
          fontWeight: 500, marginTop: 16, color: style.text,
        }}>
          {style.label}
        </div>
        {countdown > 0 && (
          <div className="text-xs text-muted" style={{ marginTop: 20 }}>
            Zurück in {countdown}s
          </div>
        )}
        <button className="btn btn-ghost btn-sm"
          style={{ position: 'absolute', bottom: 24 }}
          onClick={() => {
            clearTimeout(dispTimer.current!);
            clearInterval(cdInterval.current!);
            setView('race');
          }}>
          ← Trainer
        </button>
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════════════════════
  // RENDER – RENNTIMER (Trainer)
  // ════════════════════════════════════════════════════════════════════════════
  if (view === 'race') {
    const mainLabel = events.length === 0
      ? 'RUNDE ⏱ (Start)'
      : autoAlt ? (nextIsHalf ? '½ RUNDE →' : 'RUNDE ⏱') : 'RUNDE ⏱';

    const finDiff = activePlan && totalT !== null
      ? (activePlan.anfahrtSec + activePlan.lapTimeSec * (timerLaps - 1)) - totalT
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
          <span>›</span>{activePlan?.name ?? 'Ohne Plan'}
        </div>

        <div className="flex-between mb-4">
          <div>
            <h1>{activePlan?.name ?? 'Verfolgungsrennen'}</h1>
            <p className="text-sm text-muted" style={{ margin: '2px 0 0' }}>
              {timerLaps} Runden
              {activePlan && ` · Plan ${fmtSec(activePlan.anfahrtSec + activePlan.lapTimeSec * (timerLaps - 1))}`}
            </p>
          </div>
        </div>

        {error && <div className="alert alert-error mb-3">{error}</div>}

        {/* ── Ziel-Anzeige ── */}
        {finished && (
          <div className="card mb-4" style={{ textAlign: 'center', padding: 24 }}>
            <h2 style={{ marginBottom: 8 }}>Zielzeit</h2>
            <div style={{
              fontSize: 52, fontWeight: 500,
              fontVariantNumeric: 'tabular-nums', marginBottom: 8,
            }}>
              {totalT !== null ? fmtSec(totalT) : '–'}
            </div>
            {finDiff !== null && (
              <div style={{ fontSize: 20, color: finStyle.text, marginBottom: 16 }}>
                {finStyle.label} vs Plan ({fmtSec(activePlan!.anfahrtSec + activePlan!.lapTimeSec * (timerLaps - 1))})
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button className="btn btn-secondary" onClick={doExport}>CSV exportieren</button>
              <button className="btn btn-ghost" onClick={() => { resetTimer(); setView('plans'); }}>
                Beenden
              </button>
            </div>
          </div>
        )}

        {/* ── Zwischenstand-Karten ── */}
        {!finished && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <div className="card" style={{ padding: '11px 14px' }}>
                <div className="text-xs text-muted">{activePlan?.name ?? 'Sportler'}</div>
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
                  ? delta >  TOLERANCE ? '#dcfce7'
                  : delta < -TOLERANCE ? '#fee2e2' : '#dbeafe'
                  : undefined,
              }}>
                <div className="text-xs text-muted" style={{ marginBottom: 3 }}>letzte runde</div>
                <div style={{ fontSize: 36, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
                  {lastLapT !== null ? `${lastLapT.toFixed(2)}s` : '–'}
                </div>
                <div style={{ fontSize: 14, fontWeight: 500, color: style.text }}>{style.label}</div>
              </div>
            </div>

            {/* ── Haupt-Tipp-Knopf ── */}
            <button onClick={mainTap} style={{
              width: '100%', padding: '28px 16px', fontSize: 22, fontWeight: 500,
              borderRadius: 10, cursor: 'pointer', marginBottom: 8,
              background: '#dbeafe', border: '2px solid var(--c-primary)',
              color: 'var(--c-primary)', fontFamily: 'inherit',
            }}>
              {mainLabel}
            </button>

            {/* ── Nebensteuerung ── */}
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
              <button className="btn btn-secondary btn-sm"
                disabled={events.length <= 1} onClick={undoLast}>
                ↩ Undo
              </button>
              <button className="btn btn-ghost btn-sm"
                onClick={() => { resetTimer(); setView('plans'); }}>
                Beenden
              </button>
            </div>

            {/* ── Verlauf ── */}
            {lapHistory.length > 0 && (
              <div style={{ fontSize: 12 }}>
                {lapHistory.map(({ lapNum, lt, diff, half }) => {
                  const ds = diffStyle(diff);
                  return (
                    <div key={lapNum} style={{
                      display: 'flex', justifyContent: 'space-between',
                      padding: '4px 0', borderBottom: '1px solid var(--c-border)',
                    }}>
                      <span className="text-muted">Rd. {lapNum}</span>
                      <span style={{ fontWeight: 500 }}>
                        {lt.toFixed(2)}s
                        {half && (
                          <span className="text-muted" style={{ fontSize: 11, marginLeft: 6 }}>
                            ({half.h1.toFixed(2)} | {half.h2.toFixed(2)})
                          </span>
                        )}
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
  // RENDER – RECHNER (neuer Plan)
  // ════════════════════════════════════════════════════════════════════════════
  if (view === 'calc') {
    return (
      <div className="page container">
        <div className="breadcrumb">
          <Link to="/">Veranstaltungen</Link><span>›</span>
          <button className="btn btn-ghost btn-sm" style={{ padding: '0 4px', fontSize: 13 }}
            onClick={() => setView('plans')}>Verfolgung</button>
          <span>›</span>Neuer Plan
        </div>
        <div className="flex-between mb-4">
          <h1>Verfolgungsplan</h1>
          <button className="btn btn-ghost btn-sm" onClick={() => setView('plans')}>← Zurück</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>

          {/* Linke Spalte: Eingaben */}
          <div>
            <div className="card mb-3">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Bahnlänge</label>
                  <select className="form-select" value={trackLen}
                    onChange={e => setTrackLen(parseFloat(e.target.value))}>
                    <option value={250}>250m</option>
                    <option value={333.3}>333,3m</option>
                    <option value={200}>200m</option>
                  </select>
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Runden</label>
                  <select className="form-select" value={laps}
                    onChange={e => setLaps(parseInt(e.target.value))}>
                    <option value={8}>8</option>
                    <option value={12}>12</option>
                    <option value={16}>16</option>
                  </select>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
                <button
                  className={`btn btn-sm ${calcMode === 'target' ? 'btn-primary' : 'btn-secondary'}`}
                  style={{ flex: 1 }} onClick={() => setCalcMode('target')}>
                  Zielzeit → Rundenzeit
                </button>
                <button
                  className={`btn btn-sm ${calcMode === 'laptime' ? 'btn-primary' : 'btn-secondary'}`}
                  style={{ flex: 1 }} onClick={() => setCalcMode('laptime')}>
                  Rundenzeit → Zielzeit
                </button>
              </div>

              <div className="form-group">
                <label className="form-label">Anfahrtszeit Runde 1 (s)</label>
                <input className="form-input" value={anfahrtStr}
                  onChange={e => setAnfahrtStr(e.target.value)} placeholder="z.B. 23.5" />
              </div>

              {calcMode === 'target' ? (
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Zielzeit gesamt (M:SS oder s)</label>
                  <input className="form-input" value={targetStr}
                    onChange={e => setTargetStr(e.target.value)} placeholder="z.B. 3:45.0" />
                </div>
              ) : (
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Rundenzeit Rd. 2+ (s)</label>
                  <input className="form-input" value={lapStr}
                    onChange={e => setLapStr(e.target.value)} placeholder="z.B. 20.5" />
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              {isAdmin && (
                <button className="btn btn-primary" style={{ flex: 1 }}
                  onClick={() => setShowSave(true)} disabled={isNaN(calcLapSec) || calcLapSec <= 0}>
                  Plan speichern
                </button>
              )}
              <button className="btn btn-secondary" onClick={() => startWith(null)}>
                Ohne Plan starten
              </button>
            </div>
          </div>

          {/* Rechte Spalte: Ergebnis */}
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 14 }}>
              <div className="card" style={{ padding: 10 }}>
                <div className="text-xs text-muted" style={{ marginBottom: 3 }}>Rundenzeit Rd. 2+</div>
                <div style={{ fontSize: 20, fontWeight: 500 }}>
                  {isNaN(calcLapSec) ? '–' : `${calcLapSec.toFixed(2)}s`}
                </div>
              </div>
              <div className="card" style={{ padding: 10 }}>
                <div className="text-xs text-muted" style={{ marginBottom: 3 }}>Zielzeit / Distanz</div>
                <div style={{ fontSize: 20, fontWeight: 500 }}>
                  {isNaN(calcTotalSec) ? '–' : fmtSec(calcTotalSec)}
                  {' / '}{((trackLen * laps) / 1000).toFixed(1)}km
                </div>
              </div>
            </div>

            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 40 }}>Rd.</th>
                    <th>Zeit</th>
                    <th>Gesamt</th>
                  </tr>
                </thead>
                <tbody>
                  {planTable.map(row => (
                    <tr key={row.lap}>
                      <td className="text-muted">{row.lap}</td>
                      <td style={{ fontWeight: 500 }}>{row.time.toFixed(2)}s</td>
                      <td className="text-muted">{fmtSec(row.cum)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Speichern-Modal */}
        {showSave && (
          <div className="modal-overlay" onClick={() => setShowSave(false)}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <p className="modal-title">Plan speichern</p>
              <div className="form-group">
                <label className="form-label">Name des Sportlers</label>
                <input className="form-input" value={saveName} autoFocus
                  onChange={e => setSaveName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && savePlan()}
                  placeholder="z.B. Max Müller" />
              </div>
              <div className="flex-between">
                <button className="btn btn-ghost" onClick={() => setShowSave(false)}>Abbrechen</button>
                <button className="btn btn-primary" onClick={savePlan} disabled={!saveName || saving}>
                  {saving ? 'Speichert…' : 'Speichern'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════════════════════
  // RENDER – PLANLISTE (Standard)
  // ════════════════════════════════════════════════════════════════════════════
  return (
    <div className="page container">
      <div className="breadcrumb">
        <Link to="/">Veranstaltungen</Link><span>›</span>Verfolgung
      </div>
      <div className="flex-between mb-4">
        <h1>Verfolgungsplanung</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary btn-sm" onClick={() => startWith(null)}>
            Ohne Plan starten
          </button>
          {isAdmin && (
            <button className="btn btn-primary btn-sm" onClick={() => setView('calc')}>
              + Neuer Plan
            </button>
          )}
        </div>
      </div>

      {loadingP ? (
        <div className="loading"><span className="spinner" /> Lädt…</div>
      ) : plans.length === 0 ? (
        <div className="empty">
          <p>Noch keine Pläne gespeichert.</p>
          {isAdmin && (
            <button className="btn btn-primary" onClick={() => setView('calc')}>
              Ersten Plan erstellen
            </button>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {plans.map(plan => (
            <div key={plan.id} className="card"
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h3 style={{ marginBottom: 3 }}>{plan.name}</h3>
                <p className="text-sm text-muted" style={{ margin: 0 }}>
                  {plan.totalLaps} Runden · {plan.trackLength}m ·
                  Zielzeit {fmtSec(plan.anfahrtSec + plan.lapTimeSec * (plan.totalLaps - 1))} ·
                  Rd. 2+ {plan.lapTimeSec.toFixed(2)}s
                </p>
              </div>
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                <button className="btn btn-primary btn-sm" onClick={() => startWith(plan)}>
                  Timer starten
                </button>
                {isAdmin && (
                  <button className="btn btn-ghost btn-sm"
                    style={{ color: 'var(--c-danger)' }} onClick={() => deletePlan(plan.id)}>
                    Löschen
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
