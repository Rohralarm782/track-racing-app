// Zielpfad im Repo: frontend/src/components/RenntimerView.tsx  (NEUE Datei)
//
// Der Renntimer, jetzt als eigenständige Komponente. Vorher gab es ihn zweimal:
// einmal eingebettet in VerfolgungsplanungView (mit Speichern) und einmal als
// eigene Ansicht in PursuitPage (ohne Speichern). Das war der Grund, warum auf
// der /pursuit-Seite gestoppte Läufe nie im Sportlerprofil landeten — dort lief
// die Fassung ohne Speicherpfad. Beide Aufrufer verwenden ab jetzt diese Datei.
//
// Bewusste Festlegungen:
//  - Tap-basiert: der Trainer tippt bei jeder Zieldurchfahrt, die Rundenzeit
//    wird rückwirkend aus den Zeitstempeln gerechnet. Kein durchlaufender
//    Countdown, der über Renndauer wegdriften könnte.
//  - performance.now() statt Date.now(): monoton, kein Sprung bei einer
//    Uhrzeitkorrektur mitten im Lauf. Die Wanduhrzeit des Starts wird beim
//    CSV-Export aus dem Offset zurückgerechnet.
//  - anfahrtSec/lapSec dürfen null sein ("Ohne Plan starten"). Dann gibt es
//    Rundenzeiten, aber keine Δ-Spalten — es gibt nichts zu vergleichen.
//  - Speichern ist immer ein bewusster Klick, nie automatisch. Ein Lauf, der
//    versehentlich gestoppt wurde, soll nicht ungefragt in einem Profil landen.
import { useMemo, useRef, useState } from 'react';
import type { PursuitRunLap } from '../api/client';
import { pursuitRunsApi } from '../api/client';
import FitText from './FitText';
import { readDisplaySettings, pursuitDisplayStyle } from './pursuitDisplay';
import { fmtTime, diffStyle, TOLERANCE, DISPLAY_SEC, type TEvent } from './pursuitFormat';

/** Alles, was der Renntimer braucht, um einen gefahrenen Lauf zu speichern.
 *  Wird aus Plan, Gang und Sportlerauswahl zusammengesetzt.
 *
 *  raceId ist null, wenn der Lauf an keinem Rennen hängt (freistehender Plan
 *  auf der /pursuit-Seite, Training). Das ist ausdrücklich erlaubt: im Schema
 *  ist PursuitRun.raceId optional, und für das Sportlerprofil zählt allein
 *  athleteIds. */
export interface RunSaveContext {
  raceId: string | null;
  label: string;
  eventName: string | null;
  athleteIds: string[];
  trackM: number;
  numRounds: number;
  planAnfahrtSec: number;
  planLapSec: number;
  planTotalSec: number;
  kb: number | null;
  rz: number | null;
  gears: Record<string, { kb: number; rz: number }> | null;
  onSaved?: () => void;
}

interface Props {
  /** Planzeit Runde 1 (stehender Start). null = ohne Plan gestartet. */
  anfahrtSec: number | null;
  /** Planzeit Runde 2ff. null = ohne Plan gestartet. */
  lapSec: number | null;
  numRounds: number;
  /** Kurzname für die Anzeige (Sportler/Team), nicht der gespeicherte Rennname. */
  planLabel: string;
  /** Fehlt der Kontext, zeigt der Timer keinen Speichern-Knopf. */
  save?: RunSaveContext | null;
  onBack?: () => void;
  /** Beschriftung des Zurück-Knopfs, je nach Aufrufer. */
  backLabel?: string;
}

export default function RenntimerView({
  anfahrtSec, lapSec, numRounds, planLabel, save,
  onBack, backLabel = '← Zurück',
}: Props) {
  const [screen, setScreen]   = useState<'race' | 'display'>('race');
  const [events, setEvents]   = useState<TEvent[]>([]);
  const [autoAlt, setAutoAlt] = useState(false);
  const [nextIsHalf, setNextIsHalf] = useState(false);
  const [countdown, setCountdown]   = useState(0);
  const [finished, setFinished]     = useState(false);
  const [btnArmed, setBtnArmed]     = useState(false); // Finger liegt auf Button
  const [savingRun, setSavingRun]   = useState(false);
  const [savedRun, setSavedRun]     = useState(false);
  const [saveErr, setSaveErr]       = useState('');

  const hasPlan = anfahrtSec !== null && lapSec !== null;
  const planTotal = hasPlan ? anfahrtSec! + lapSec! * (numRounds - 1) : null;

  // ── Anzeige-Einstellungen (global) ───────────────────────────────────────
  // Zentral unter Einstellungen → Renntimer-Anzeige gesetzt, hier nur gelesen.
  const dcfg = readDisplaySettings();

  const eventsRef     = useRef<TEvent[]>([]);
  const autoAltRef    = useRef(false);
  const nextIsHalfRef = useRef(false);
  const dispTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cdInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  function syncEvs(evs: TEvent[]) { eventsRef.current = evs; setEvents(evs); }
  function setAuto(v: boolean)    { autoAltRef.current    = v; setAutoAlt(v); }
  function setNxtH(v: boolean)    { nextIsHalfRef.current = v; setNextIsHalf(v); }

  // ── Berechnete Werte ─────────────────────────────────────────────────────
  const lapEvs   = events.filter(e => e.type === 'lap');
  const startEvt = events.find(e => e.type === 'start');
  const lapCount = lapEvs.length;

  const lastLapT = lapCount > 0
    ? (lapEvs[lapCount - 1].ts - (lapCount > 1 ? lapEvs[lapCount - 2].ts : (startEvt?.ts ?? 0))) / 1000
    : null;
  const totalT = lapCount > 0 && startEvt
    ? (lapEvs[lapCount - 1].ts - startEvt.ts) / 1000 : null;

  const planLapT = hasPlan && lapCount > 0 ? (lapCount === 1 ? anfahrtSec! : lapSec!) : null;
  const planCumT = hasPlan && lapCount > 0 ? anfahrtSec! + lapSec! * (lapCount - 1) : null;
  const delta = planLapT !== null && lastLapT !== null ? planLapT - lastLapT : null;
  const style = diffStyle(delta);

  // ── Verlauf ──────────────────────────────────────────────────────────────
  const lapHistory = useMemo(() => {
    const start = events.find(e => e.type === 'start');
    const laps  = events.filter(e => e.type === 'lap');
    const halfs = events.filter(e => e.type === 'half');
    if (!start || laps.length === 0) return [];
    return [...laps].reverse().slice(0, 6).map((lap, ri) => {
      const i = laps.length - 1 - ri;
      const prevTs = i > 0 ? laps[i - 1].ts : start.ts;
      const lt = (lap.ts - prevTs) / 1000;
      const pLt = anfahrtSec !== null && lapSec !== null ? (i === 0 ? anfahrtSec : lapSec) : null;
      const diff = pLt !== null ? pLt - lt : null;
      const hBetween = halfs.filter(h => h.ts > prevTs && h.ts < lap.ts);
      const half = hBetween.length > 0
        ? { h1: (hBetween[0].ts - prevTs) / 1000, h2: (lap.ts - hBetween[0].ts) / 1000 }
        : null;
      return { lapNum: i + 1, lt, diff, half };
    });
  }, [events, anfahrtSec, lapSec]);

  // ── Aktionen ─────────────────────────────────────────────────────────────
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
    if (done >= numRounds) { setFinished(true); return; }
    // Zur Athletenanzeige wechseln
    clearTimeout(dispTimer.current!);
    clearInterval(cdInterval.current!);
    setScreen('display');
    setCountdown(DISPLAY_SEC);
    let rem = DISPLAY_SEC;
    cdInterval.current = setInterval(() => { rem--; setCountdown(rem); if (rem <= 0) clearInterval(cdInterval.current!); }, 1000);
    dispTimer.current = setTimeout(() => setScreen('race'), DISPLAY_SEC * 1000);
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
    if (finished) setFinished(false);
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
    setScreen('race');
    setSavedRun(false);
    setSaveErr('');
  }

  /** Getippte Zeitstempel in die gespeicherte Rundenliste übersetzen. halfMs
   *  ist die erste Hälfte ab Rundenbeginn; die zweite ergibt sich immer als
   *  lapMs − halfMs und wird deshalb nicht mitgeschrieben. */
  function buildLaps(): PursuitRunLap[] {
    const evs = eventsRef.current;
    const start = evs.find(e => e.type === 'start');
    if (!start) return [];
    const laps  = evs.filter(e => e.type === 'lap');
    const halfs = evs.filter(e => e.type === 'half');
    return laps.map((lap, i) => {
      const prevTs = i > 0 ? laps[i - 1].ts : start.ts;
      const h = halfs.find(x => x.ts > prevTs && x.ts < lap.ts);
      return {
        lapMs: Math.round(lap.ts - prevTs),
        halfMs: h ? Math.round(h.ts - prevTs) : null,
      };
    });
  }

  async function saveRun() {
    if (!save || savingRun) return;
    const laps = buildLaps();
    if (laps.length === 0) { setSaveErr('Noch keine Runde getippt.'); return; }
    setSavingRun(true); setSaveErr('');
    try {
      // Wanduhrzeit des Starts aus dem performance.now()-Offset rekonstruieren,
      // damit der Lauf im Profil unter der echten Startzeit steht und nicht
      // unter dem Zeitpunkt des Speicherns.
      const startEv = eventsRef.current.find(e => e.type === 'start')!;
      const ridenAt = new Date(Date.now() - (performance.now() - startEv.ts)).toISOString();

      await pursuitRunsApi.create({
        raceId: save.raceId,
        athleteIds: save.athleteIds,
        label: save.label,
        eventName: save.eventName,
        trackM: save.trackM,
        numRounds: save.numRounds,
        // Hängt der Lauf an einem Rennen, ist es ein Wettkampf; ein
        // freistehender Plan (/pursuit) ist Training. Trackside soll dafür
        // niemand einen Schalter suchen müssen — korrigierbar bleibt es über
        // „Bearbeiten“ im Sportlerprofil.
        runKind: save.raceId ? 'WETTKAMPF' : 'TRAINING',
        laps,
        totalMs: laps.reduce((a, l) => a + l.lapMs, 0),
        timeSource: 'TIMER',
        complete: laps.length >= save.numRounds,
        kb: save.kb,
        rz: save.rz,
        gears: save.gears && Object.keys(save.gears).length > 0 ? save.gears : null,
        planAnfahrtSec: save.planAnfahrtSec,
        planLapSec: save.planLapSec,
        planTotalSec: save.planTotalSec,
        ridenAt,
      });
      setSavedRun(true);
      save.onSaved?.();
    } catch (e: any) {
      setSaveErr(e?.message ?? 'Speichern fehlgeschlagen');
    } finally { setSavingRun(false); }
  }

  function doExport() {
    const start = eventsRef.current.find(e => e.type === 'start');
    if (!start) return;
    const laps  = eventsRef.current.filter(e => e.type === 'lap');
    const halfs = eventsRef.current.filter(e => e.type === 'half');
    // Wanduhrzeit des Starts aus dem performance.now()-Offset rekonstruieren
    const startedAt = new Date(Date.now() - (performance.now() - start.ts));
    const pad = (n: number) => String(n).padStart(2, '0');
    const dateStr = `${pad(startedAt.getDate())}.${pad(startedAt.getMonth() + 1)}.${startedAt.getFullYear()}`;
    const timeStr = `${pad(startedAt.getHours())}:${pad(startedAt.getMinutes())}:${pad(startedAt.getSeconds())}`;
    const fileDate = `${startedAt.getFullYear()}-${pad(startedAt.getMonth() + 1)}-${pad(startedAt.getDate())}`;
    const rows = [
      `Datum;${dateStr}`,
      `Startzeit;${timeStr}`,
      '',
      'Runde;Zeit (s);Halbrunde 1 (s);Halbrunde 2 (s);Kumuliert (s);Plan (s);Differenz (s)',
    ];
    laps.forEach((lap, i) => {
      const prevTs = i > 0 ? laps[i - 1].ts : start.ts;
      const lt  = ((lap.ts - prevTs) / 1000).toFixed(3);
      const cum = ((lap.ts - start.ts) / 1000).toFixed(3);
      const pLtNum = hasPlan ? (i === 0 ? anfahrtSec! : lapSec!) : null;
      const pLt = pLtNum !== null ? pLtNum.toFixed(3) : '';
      const df  = pLtNum !== null ? (pLtNum - parseFloat(lt)).toFixed(3) : '';
      const hEvs = halfs.filter(h => h.ts > prevTs && h.ts < lap.ts);
      const h1 = hEvs.length > 0 ? ((hEvs[0].ts - prevTs) / 1000).toFixed(3) : '';
      const h2 = hEvs.length > 0 ? ((lap.ts - hEvs[0].ts) / 1000).toFixed(3) : '';
      rows.push(`${i + 1};${lt};${h1};${h2};${cum};${pLt};${df}`);
    });
    const a = document.createElement('a');
    a.href = `data:text/csv;charset=utf-8,\uFEFF${encodeURIComponent(rows.join('\n'))}`;
    a.download = `verfolgung_${fileDate}_${planLabel.replace(/\s/g, '_')}.csv`;
    a.click();
  }

  // ── Athletenanzeige (Vollbild) ───────────────────────────────────────────
  if (screen === 'display') {
    const ds = pursuitDisplayStyle(delta, dcfg);
    const lapText   = lastLapT !== null ? `${lastLapT.toFixed(2)}s` : '–';
    const deltaText = delta !== null ? `${delta > 0 ? '+' : ''}${delta.toFixed(2)}s` : '–';
    const bigText   = dcfg.num === 'delta' ? deltaText : lapText;
    const subText   = dcfg.num === 'delta' ? lapText   : deltaText;

    return (
      <div style={{
        position: 'fixed', inset: 0, zIndex: 50,
        background: ds.containerBg,
        border: ds.containerBorder,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        textAlign: 'center',
        transition: 'background-color 0.25s, border-color 0.25s',
      }}>
        <div style={{ marginBottom: 8, fontSize: 14, color: ds.metaColor }}>
          {planLabel} · Runde {lapCount} / {numRounds}
        </div>
        <div style={{ width: '100%', padding: '0 2cm', boxSizing: 'border-box' }}>
          <FitText text={bigText} color={ds.bigColor} />
        </div>
        <div style={{ fontSize: 'clamp(16px, 3.5vw, 6vh)', fontWeight: 500, marginTop: 8, color: ds.subColor }}>
          {subText}
        </div>
        {countdown > 0 && (
          <div style={{ marginTop: 20, fontSize: 12, color: ds.metaColor }}>
            Zurück in {countdown}s
          </div>
        )}
        <button
          className="btn btn-ghost btn-sm"
          style={{ position: 'absolute', bottom: 24, color: ds.metaColor }}
          onClick={() => { clearTimeout(dispTimer.current!); clearInterval(cdInterval.current!); setScreen('race'); }}
        >
          ← Trainer
        </button>
      </div>
    );
  }

  // ── Renntimer (Trainer) ──────────────────────────────────────────────────
  const mainLabel = events.length === 0
    ? 'RUNDE ⏱ (Start)'
    : autoAlt ? (nextIsHalf ? '½ RUNDE →' : 'RUNDE ⏱') : 'RUNDE ⏱';

  const finDiff = planTotal !== null && totalT !== null ? planTotal - totalT : null;
  const finStyle = diffStyle(finDiff);

  return (
    <div>
      <div className="flex-between mb-4">
        <div>
          <h2 style={{ margin: 0, fontSize: 20 }}>{planLabel}</h2>
          <p className="text-sm text-muted" style={{ margin: '2px 0 0' }}>
            {numRounds} Runden
            {planTotal !== null ? ` · Plan ${fmtTime(planTotal)}` : ' · ohne Plan'}
          </p>
        </div>
      </div>

      {/* Ziel-Anzeige */}
      {finished && (
        <div className="card mb-4" style={{ textAlign: 'center', padding: 24 }}>
          <h3 style={{ marginBottom: 8 }}>Zielzeit</h3>
          <div style={{ fontSize: 52, fontWeight: 500, fontVariantNumeric: 'tabular-nums', marginBottom: 8 }}>
            {totalT !== null ? fmtTime(totalT) : '–'}
          </div>
          {finDiff !== null && (
            <div style={{ fontSize: 20, color: finStyle.text, marginBottom: 16 }}>
              {finStyle.label} vs Plan ({fmtTime(planTotal!)})
            </div>
          )}
          {saveErr && <div className="alert alert-error" style={{ marginBottom: 12 }}>{saveErr}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
            {save && (
              <button className="btn btn-primary" onClick={saveRun} disabled={savingRun || savedRun}>
                {savedRun ? '✓ Im Sportlerprofil gespeichert' : savingRun ? '…' : '💾 Lauf speichern'}
              </button>
            )}
            <button className="btn btn-secondary" onClick={doExport}>CSV exportieren</button>
            <button className="btn btn-ghost" onClick={resetTimer}>▶ Nochmal</button>
          </div>
          {save && !savedRun && (
            <p className="text-xs text-muted" style={{ marginTop: 10, marginBottom: 0 }}>
              Speichert Rundenzeiten, Halbrunden, Gang und den Plan im Profil der
              zugeordneten Sportler.
            </p>
          )}
          {/* Ohne Speicher-Kontext ist der Lauf nach „Nochmal" endgültig weg —
              das gehört genau hier hin, nicht in eine Fußnote. */}
          {!save && (
            <p className="text-xs" style={{ marginTop: 10, marginBottom: 0, color: 'var(--c-danger)' }}>
              Kein Sportler zugeordnet — dieser Lauf kann nicht gespeichert werden.
              Vor dem Verlassen CSV exportieren.
            </p>
          )}
        </div>
      )}

      {!finished && (
        <>
          {/* Zwischenstand */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div className="card" style={{ padding: '11px 14px' }}>
              <div className="text-xs text-muted">{planLabel}</div>
              <div style={{ fontSize: 20, fontWeight: 500, margin: '3px 0' }}>
                Runde {lapCount || '–'} / {numRounds}
              </div>
              <div className="text-sm text-muted">
                Gesamt: <span style={{ color: 'var(--c-text)', fontWeight: 500 }}>
                  {totalT !== null ? fmtTime(totalT) : '–'}
                </span>
              </div>
              {planCumT !== null && (
                <div className="text-sm text-muted">
                  Plan: <span style={{ fontWeight: 500 }}>{fmtTime(planCumT)}</span>
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
            onPointerUp={() => {
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
            <button className="btn btn-ghost btn-sm" onClick={resetTimer}>
              Reset
            </button>
          </div>

          {/* Abbruch speichern: ein abgebrochener Lauf ist als Trainingsdatum
              trotzdem wertvoll, wird aber als unvollständig markiert. */}
          {save && lapCount > 0 && (
            <div style={{ marginBottom: 14 }}>
              {saveErr && <div className="alert alert-error" style={{ marginBottom: 8 }}>{saveErr}</div>}
              <button className="btn btn-secondary btn-sm" style={{ width: '100%' }}
                onClick={saveRun} disabled={savingRun || savedRun}>
                {savedRun ? '✓ Gespeichert' : savingRun ? '…' : `💾 Abgebrochenen Lauf speichern (${lapCount} Rd.)`}
              </button>
            </div>
          )}

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

      {onBack && (
        <button className="btn btn-ghost btn-sm" style={{ marginTop: 16 }} onClick={onBack}>{backLabel}</button>
      )}
    </div>
  );
}
