// Zielpfad im Repo: frontend/src/components/PursuitRunAnalysis.tsx  (NEUE Datei)
//
// Die Auswertung eines gefahrenen Laufes — halbe Runden, ganze Runden,
// Führungsbilanz, Vergleich mit dem Plan. Ersetzt ab 2.0.0 die drei getrennten
// Blöcke CourseChart / LeadSummary / LapTable, die vorher in
// PursuitRunsCard.tsx lagen und dieselben Zahlen dreifach angefasst haben.
//
// Bewusste Festlegungen:
//  - Tabellen zeigen die Startrunde (grau hinterlegt), Diagramme nicht. Der
//    Startwert ist zwei bis fünf Sekunden langsamer als alles andere und würde
//    die Skala so stauchen, dass die eigentlichen Unterschiede verschwinden.
//    Er steht stattdessen als eigene Kennzahl und in der Bildunterschrift.
//  - Mittelwerte gibt es doppelt: fliegend (groß, zwischen Läufen
//    vergleichbar) und mit Start (klein, entspricht der Gesamtzeit).
//  - Die Δ-Spalte bezieht sich auf den FLIEGENDEN Mittelwert, also auf die
//    gestrichelte Linie im Diagramm daneben. Schneller als der Schnitt ist
//    grün — dieselbe Leserichtung wie bei der Abweichung zum Plan.
//  - Die Tabelle der halben Runden ist zugeklappt. Bei 24 Zeilen schiebt sie
//    sonst alles Weitere aus dem Bild; im Rennen zählt erst das Diagramm.
//  - Fehlt an auch nur EINER Runde die Halbrundenzeit, entfallen Diagramm und
//    Tabelle der halben Runden ganz. Eine Auswertung aus halb gefüllten Daten
//    wäre irreführender als keine.
//  - Führung, Δ zum Plan und Trittfrequenz erscheinen nur, wenn der Lauf sie
//    hergibt (Mannschaft mit eingetragener Führung / Plan aus dem Renntimer /
//    hinterlegter Gang). Keine Spalten voller Striche.

import { useMemo, useState } from 'react';
import type { PursuitRun } from '../api/client';
import {
  analyseRun,
  cadence,
  deltaColor,
  fmtDelta,
  fmtLaps,
  fmtMs,
  leadColor,
  planCum,
  planLapBruttoSec,
  type HalfLap,
  type KmBlock,
  type RunAnalysis,
} from './pursuitAnalysis';

interface Props {
  run: PursuitRun;
  /** Sportler-ID → Anzeigename, für die Führungsspalten. */
  nameById: Record<string, string>;
}

const MUTED = 'var(--c-text-muted, #888)';

/** Δ gegen den Schnitt: negativ = schneller. deltaColor liest positiv als gut,
 *  deshalb das umgekehrte Vorzeichen. */
function meanColor(ms: number): string {
  return deltaColor(-ms);
}

// ── Kennzahlen ──────────────────────────────────────────────────────────────

function Stat({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div style={{
      background: 'var(--c-bg)', border: '1px solid var(--c-border)',
      borderRadius: 8, padding: '6px 9px',
    }}>
      <div className="text-xs text-muted" style={{ textTransform: 'uppercase', letterSpacing: '.04em' }}>{k}</div>
      <div style={{ fontSize: 17, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{v}</div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
    </div>
  );
}

function Kennzahlen({ run, a }: { run: PursuitRun; a: RunAnalysis }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
      <Stat k="Rundensumme" v={fmtMs(a.sumMs)} sub={`${a.laps.length} Runden · ${run.trackM} m`} />
      <Stat k="Ø Runde" v={fmtMs(Math.round(a.lapMeans.fly))} sub={`${fmtMs(Math.round(a.lapMeans.all))} mit Start`} />
      {a.halfMeans && a.halves && (
        <Stat k="Ø halbe Runde" v={fmtMs(Math.round(a.halfMeans.fly))} sub={`${fmtMs(Math.round(a.halfMeans.all))} mit Start`} />
      )}
      <Stat k="Start" v={fmtMs(a.laps[0].lapMs)} sub={a.halves ? `erste halbe Runde ${fmtMs(a.halves[0].ms)}` : 'Startrunde'} />
    </div>
  );
}

function Legende({ run, nameById }: Props) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, margin: '0 0 8px' }} className="text-xs">
      {run.athleteIds.map(id => (
        <span key={id}>
          <span style={{
            display: 'inline-block', width: 9, height: 9, borderRadius: '50%',
            background: leadColor(run.athleteIds, id), marginRight: 5,
          }} />
          {nameById[id] ?? 'unbekannt'}
        </span>
      ))}
    </div>
  );
}

function Abschnitt({ titel }: { titel: string }) {
  return (
    <h4 className="text-xs text-muted" style={{
      textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 600,
      margin: '16px 0 6px', paddingTop: 10, borderTop: '1px solid var(--c-border)',
    }}>{titel}</h4>
  );
}

// ── Diagramm: halbe Runden ──────────────────────────────────────────────────
// Ein Balken je 125 m, eingefärbt nach führendem Fahrer. Die gepunktete Linie
// steht VOR dem Balken, ab dem jemand Neues vorn ist.

function HalfChart({ run, halves, mean }: { run: PursuitRun; halves: HalfLap[]; mean: number }) {
  const vis = halves.slice(1);
  if (vis.length < 2) return null;

  const W = Math.max(560, vis.length * 26), H = 210, PL = 40, PR = 10, PT = 18, PB = 26;
  const vals = vis.map(h => h.ms);
  const lo = Math.floor((Math.min(...vals) - 200) / 100) * 100;
  const hi = Math.ceil((Math.max(...vals) + 300) / 100) * 100;
  const bw = (W - PL - PR) / vis.length;
  const y = (v: number) => PT + (1 - (v - lo) / (hi - lo)) * (H - PT - PB);

  return (
    <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ display: 'block' }}>
        <line x1={PL} y1={y(mean)} x2={W - PR} y2={y(mean)} stroke={MUTED} strokeWidth="1" strokeDasharray="5 4" />
        <text x={W - PR} y={y(mean) - 4} textAnchor="end" fontSize="9" fill={MUTED}>Ø {fmtMs(Math.round(mean))}</text>
        {[lo, hi].map(v => (
          <text key={v} x={PL - 5} y={y(v) + 3} textAnchor="end" fontSize="8" fill={MUTED}>{fmtMs(v)}</text>
        ))}
        {vis.map((h, i) => {
          const x = PL + i * bw;
          const prev = i === 0 ? halves[0].leadId : vis[i - 1].leadId;
          const wechsel = !!h.leadId && !!prev && h.leadId !== prev;
          return (
            <g key={h.n}>
              {wechsel && (
                <line x1={x} y1={PT - 6} x2={x} y2={H - PB} stroke="var(--c-border)" strokeWidth="1" strokeDasharray="2 3" />
              )}
              <rect x={x + 1} y={y(h.ms)} width={Math.max(1, bw - 2)} height={H - PB - y(h.ms)}
                fill={h.leadId ? leadColor(run.athleteIds, h.leadId) : 'var(--c-primary)'} rx="1" />
              <text x={x + bw / 2} y={y(h.ms) - 4} textAnchor="middle" fontSize="8" fill="var(--c-text)">{fmtMs(h.ms)}</text>
              <text x={x + bw / 2} y={H - 8} textAnchor="middle" fontSize="8" fill={MUTED}>{h.n}</text>
            </g>
          );
        })}
        <line x1={PL} y1={H - PB} x2={W - PR} y2={H - PB} stroke="var(--c-border)" />
      </svg>
    </div>
  );
}

// ── Diagramm: ganze Runden ──────────────────────────────────────────────────
// Rundenzeiten als Linie, dahinter die Kilometer-Blöcke mit ihren Teilzeiten.

function LapChart({ a, mean }: { a: RunAnalysis; mean: number }) {
  const vis = a.laps.slice(1);
  if (vis.length < 2) return null;

  const W = Math.max(520, vis.length * 42), H = 200, PL = 42, PR = 12, PT = 18, PB = 34;
  const vals = vis.map(l => l.lapMs);
  const lo = Math.floor((Math.min(...vals) - 300) / 100) * 100;
  const hi = Math.ceil((Math.max(...vals) + 400) / 100) * 100;
  const step = (W - PL - PR) / vis.length;
  const x = (i: number) => PL + step * (i + 0.5);
  const y = (v: number) => PT + (1 - (v - lo) / (hi - lo)) * (H - PT - PB);
  const d = vis.map((l, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(l.lapMs).toFixed(1)}`).join(' ');

  return (
    <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ display: 'block' }}>
        {a.blocks.map((b: KmBlock, bi) => {
          const i0 = Math.max(0, b.fromLap - 2), i1 = b.toLap - 2;
          if (i1 < 0) return null;
          const xa = PL + step * i0, xb = PL + step * (i1 + 1);
          return (
            <g key={b.fromLap}>
              <rect x={xa} y={PT - 8} width={xb - xa} height={H - PB - PT + 8}
                fill={bi % 2 ? 'var(--c-bg)' : 'transparent'} />
              <text x={(xa + xb) / 2} y={H - PB + 14} textAnchor="middle" fontSize="9" fill={MUTED}>
                {b.label} {fmtMs(b.ms)}{b.full ? '' : ' *'}
              </text>
            </g>
          );
        })}
        <line x1={PL} y1={y(mean)} x2={W - PR} y2={y(mean)} stroke={MUTED} strokeWidth="1" strokeDasharray="5 4" />
        <text x={W - PR} y={y(mean) - 4} textAnchor="end" fontSize="9" fill={MUTED}>Ø {fmtMs(Math.round(mean))}</text>
        {[lo, hi].map(v => (
          <text key={v} x={PL - 5} y={y(v) + 3} textAnchor="end" fontSize="8" fill={MUTED}>{fmtMs(v)}</text>
        ))}
        <path d={d} fill="none" stroke="var(--c-primary)" strokeWidth="2" strokeLinejoin="round" />
        {vis.map((l, i) => (
          <g key={i}>
            <circle cx={x(i)} cy={y(l.lapMs)} r="3" fill="var(--c-primary)" />
            <text x={x(i)} y={y(l.lapMs) - 8} textAnchor="middle" fontSize="8" fill="var(--c-text)">{fmtMs(l.lapMs)}</text>
            <text x={x(i)} y={H - PB + 2} textAnchor="middle" fontSize="8" fill={MUTED}>{i + 2}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

// ── Tabellen ────────────────────────────────────────────────────────────────

function HalfTable({ run, nameById, a }: Props & { a: RunAnalysis }) {
  const halves = a.halves!;
  const mean = a.halfMeans!.fly;
  const kb = run.kb, rz = run.rz;
  let cum = 0;

  return (
    <div className="table-wrap" style={{ marginBottom: 10 }}>
      <table className="table" style={{ fontSize: 13 }}>
        <thead>
          <tr>
            <th>½ Rd</th>
            <th style={{ textAlign: 'right' }}>Zeit</th>
            {a.showLead && <th>Führung</th>}
            <th style={{ textAlign: 'right' }}>Kum.</th>
            <th style={{ textAlign: 'right' }}>Δ Ø</th>
            {kb && rz ? <th style={{ textAlign: 'right' }}>TF</th> : null}
          </tr>
        </thead>
        <tbody>
          {halves.map((h, idx) => {
            cum += h.ms;
            const dlt = h.ms - mean;
            const tf = kb && rz ? cadence(run.trackM / 2, h.ms, kb, rz, run.circMm) : null;
            return (
              <tr key={h.n} style={idx === 0 ? { background: 'var(--c-bg)' } : undefined}>
                <td>{h.n}{idx === 0 && <span className="text-xs text-muted"> Start</span>}</td>
                <td style={{ textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmtMs(h.ms)}</td>
                {a.showLead && (
                  <td>
                    {h.leadId ? (
                      <>
                        <span style={{
                          display: 'inline-block', width: 9, height: 9, borderRadius: '50%',
                          background: leadColor(run.athleteIds, h.leadId), marginRight: 5,
                        }} />
                        {nameById[h.leadId] ?? 'unbekannt'}
                      </>
                    ) : <span className="text-muted">—</span>}
                  </td>
                )}
                <td className="text-muted" style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtMs(cum)}</td>
                <td style={{ textAlign: 'right', color: meanColor(dlt), fontVariantNumeric: 'tabular-nums' }}>
                  {fmtDelta(Math.round(dlt))}
                </td>
                {kb && rz ? (
                  <td className="text-muted" style={{ textAlign: 'right' }}>{tf ? tf.toFixed(0) : '—'}</td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LapTable({ run, nameById, a }: Props & { a: RunAnalysis }) {
  const hasPlan = run.planAnfahrtSec != null && run.planLapSec != null;
  const kb = run.kb, rz = run.rz;
  const mean = a.lapMeans.fly;
  let cum = 0;

  return (
    <div className="table-wrap" style={{ marginBottom: 10 }}>
      <table className="table" style={{ fontSize: 13 }}>
        <thead>
          <tr>
            <th>Rd</th>
            <th style={{ textAlign: 'right' }}>Zeit</th>
            {a.showLead && <th>Führung</th>}
            <th style={{ textAlign: 'right' }}>Kum.</th>
            <th style={{ textAlign: 'right' }}>Δ Ø</th>
            {hasPlan && <th style={{ textAlign: 'right' }}>Δ Plan</th>}
            {kb && rz ? <th style={{ textAlign: 'right' }}>TF</th> : null}
          </tr>
        </thead>
        <tbody>
          {a.laps.map((lap, idx) => {
            const i = idx + 1;
            cum += lap.lapMs;
            const pc = planCum(run, i);
            const vsPlan = pc !== null ? pc - cum : null;
            const dlt = lap.lapMs - mean;
            const tf = kb && rz ? cadence(run.trackM, lap.lapMs, kb, rz, run.circMm) : null;
            const h1 = lap.halfMs ?? null;
            const h2 = h1 !== null ? lap.lapMs - h1 : null;
            return (
              <tr key={i} style={idx === 0 ? { background: 'var(--c-bg)' } : undefined}>
                <td style={{ verticalAlign: 'top' }}>
                  {i}{idx === 0 && <span className="text-xs text-muted"> Start</span>}
                </td>
                <td style={{ textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                  {fmtMs(lap.lapMs)}
                  {h1 !== null && h2 !== null && (
                    <div className="text-xs text-muted" style={{ fontWeight: 400 }}>
                      ½ {fmtMs(h1)} | {fmtMs(h2)}
                      {kb && rz && (
                        <> · {cadence(run.trackM / 2, h1, kb, rz, run.circMm)?.toFixed(0)}/
                          {cadence(run.trackM / 2, h2, kb, rz, run.circMm)?.toFixed(0)}</>
                      )}
                    </div>
                  )}
                </td>
                {a.showLead && (
                  <td style={{ verticalAlign: 'top' }}>
                    {lap.leadId ? (
                      <>
                        <span style={{
                          display: 'inline-block', width: 9, height: 9, borderRadius: '50%',
                          background: leadColor(run.athleteIds, lap.leadId), marginRight: 5,
                        }} />
                        {nameById[lap.leadId] ?? 'unbekannt'}
                        {lap.leadId2 && (
                          <>
                            <span className="text-muted"> › </span>
                            <span style={{
                              display: 'inline-block', width: 9, height: 9, borderRadius: '50%',
                              background: leadColor(run.athleteIds, lap.leadId2), marginRight: 5,
                            }} />
                            {nameById[lap.leadId2] ?? 'unbekannt'}
                          </>
                        )}
                      </>
                    ) : <span className="text-muted">—</span>}
                  </td>
                )}
                <td className="text-muted" style={{ textAlign: 'right', verticalAlign: 'top', fontVariantNumeric: 'tabular-nums' }}>
                  {fmtMs(cum)}
                </td>
                <td style={{ textAlign: 'right', verticalAlign: 'top', color: meanColor(dlt), fontVariantNumeric: 'tabular-nums' }}>
                  {fmtDelta(Math.round(dlt))}
                </td>
                {hasPlan && (
                  <td style={{ textAlign: 'right', verticalAlign: 'top', color: deltaColor(vsPlan), fontVariantNumeric: 'tabular-nums' }}>
                    {vsPlan !== null ? fmtDelta(vsPlan) : '—'}
                  </td>
                )}
                {kb && rz ? (
                  <td className="text-muted" style={{ textAlign: 'right', verticalAlign: 'top' }}>
                    {tf ? tf.toFixed(0) : '—'}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Führungsbilanz ──────────────────────────────────────────────────────────
// Der Balken zeigt den Verlauf über die Runden, die Tabelle darunter die
// Bilanz je Fahrer. Eine Runde mit Ablösung zur Mitte zählt für beide je eine
// halbe Runde; die Zeit wird über die Halbrundenzeit aufgeteilt, wenn es sie
// gibt, sonst hälftig.

function LeadSummary({ run, nameById, a }: Props & { a: RunAnalysis }) {
  const shares = a.shares;
  const segs: { id: string | null; w: number }[] = [];
  run.laps.forEach(lap => {
    if (!lap.leadId) { segs.push({ id: null, w: 1 }); return; }
    if (!lap.leadId2) { segs.push({ id: lap.leadId, w: 1 }); return; }
    segs.push({ id: lap.leadId, w: 0.5 });
    segs.push({ id: lap.leadId2, w: 0.5 });
  });
  const total = segs.reduce((x, y) => x + y.w, 0) || 1;

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', height: 16, borderRadius: 4, overflow: 'hidden', border: '1px solid var(--c-border)' }}>
        {segs.map((x, i) => (
          <div key={i} style={{
            width: `${(x.w / total * 100).toFixed(3)}%`,
            background: x.id ? leadColor(run.athleteIds, x.id) : 'var(--c-bg)',
          }} />
        ))}
      </div>
      <div className="flex-between text-xs text-muted" style={{ marginTop: 2 }}>
        <span>Start</span><span>Ziel</span>
      </div>
      <table className="table" style={{ fontSize: 13, marginTop: 6 }}>
        <thead>
          <tr>
            <th>Führung</th>
            <th style={{ textAlign: 'right' }}>Runden</th>
            <th style={{ textAlign: 'right' }}>Zeit vorn</th>
            <th style={{ textAlign: 'right' }}>Anteil</th>
          </tr>
        </thead>
        <tbody>
          {run.athleteIds.filter(id => shares[id]).map(id => (
            <tr key={id}>
              <td>
                <span style={{
                  display: 'inline-block', width: 9, height: 9, borderRadius: '50%',
                  background: leadColor(run.athleteIds, id), marginRight: 6,
                }} />
                {nameById[id] ?? 'unbekannt'}
              </td>
              <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtLaps(shares[id].laps)}</td>
              <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtMs(Math.round(shares[id].ms))}</td>
              <td className="text-muted" style={{ textAlign: 'right' }}>
                {run.laps.length > 0 ? `${Math.round(shares[id].laps / run.laps.length * 100)} %` : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Gegen den Plan ──────────────────────────────────────────────────────────
// Kumulierte Abweichung gegen den Plan über die Runden. Positiv = vor dem Plan.
// Halbrunden erscheinen als Zwischenpunkte, wenn sie getippt wurden.

function CourseChart({ run }: { run: PursuitRun }) {
  const pts = useMemo(() => {
    const planLapSec = planLapBruttoSec(run);
    if (run.planAnfahrtSec == null || planLapSec == null) return [];
    const out: { x: number; y: number; half: boolean }[] = [];
    let actCum = 0;
    let plCum = 0;
    run.laps.forEach((lap, idx) => {
      const i = idx + 1;
      const planLap = (i === 1 ? run.planAnfahrtSec! : planLapSec) * 1000;
      if (lap.halfMs != null) {
        out.push({
          x: i - 0.5,
          y: (plCum + planLap / 2) - (actCum + lap.halfMs),
          half: true,
        });
      }
      actCum += lap.lapMs;
      plCum += planLap;
      out.push({ x: i, y: plCum - actCum, half: false });
    });
    return out;
  }, [run]);

  if (pts.length < 2) return null;

  const W = 320, H = 120, PL = 30, PR = 8, PT = 10, PB = 18;
  const maxX = run.numRounds;
  const maxAbs = Math.max(500, ...pts.map(p => Math.abs(p.y)));
  const sx = (x: number) => PL + (x / maxX) * (W - PL - PR);
  const sy = (y: number) => PT + (1 - (y + maxAbs) / (2 * maxAbs)) * (H - PT - PB);

  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];

  return (
    <div style={{ marginBottom: 10 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={130} style={{ display: 'block' }}>
        {/* Nulllinie = Plan */}
        <line x1={PL} y1={sy(0)} x2={W - PR} y2={sy(0)} stroke="var(--c-border)" strokeWidth="1" strokeDasharray="3 3" />
        <text x={PL - 4} y={sy(0) + 3} textAnchor="end" fontSize="8" fill={MUTED}>Plan</text>
        <text x={PL - 4} y={sy(maxAbs) + 7} textAnchor="end" fontSize="8" fill={MUTED}>
          +{(maxAbs / 1000).toFixed(1)}s
        </text>
        <text x={PL - 4} y={sy(-maxAbs)} textAnchor="end" fontSize="8" fill={MUTED}>
          −{(maxAbs / 1000).toFixed(1)}s
        </text>
        <path d={d} fill="none" stroke={deltaColor(last.y)} strokeWidth="2" strokeLinejoin="round" />
        {pts.map((p, i) => (
          <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r={p.half ? 1.6 : 2.8}
            fill={p.half ? 'white' : deltaColor(last.y)}
            stroke={deltaColor(last.y)} strokeWidth={p.half ? 1.2 : 0} />
        ))}
        <text x={PL} y={H - 5} fontSize="8" fill={MUTED}>Rd 1</text>
        <text x={W - PR} y={H - 5} textAnchor="end" fontSize="8" fill={MUTED}>
          Rd {run.numRounds}
        </text>
      </svg>
      <p className="text-xs text-muted" style={{ margin: 0 }}>
        Kumulierte Abweichung gegen den Plan · offene Punkte = halbe Runden
      </p>
    </div>
  );
}

// ── Auswertung ──────────────────────────────────────────────────────────────

export default function PursuitRunAnalysis({ run, nameById }: Props) {
  const a = useMemo(() => analyseRun(run), [run]);
  const [halfTable, setHalfTable] = useState(false);

  if (!a) {
    return (
      <p className="text-sm text-muted" style={{ margin: '0 0 10px' }}>
        Keine Rundenzeiten hinterlegt — über „Bearbeiten“ jederzeit nachtragbar.
      </p>
    );
  }

  const hasPlan = run.planAnfahrtSec != null && run.planLapSec != null;
  const rest = a.blocks.some(b => !b.full);

  return (
    <div>
      <Kennzahlen run={run} a={a} />
      {a.showLead && <Legende run={run} nameById={nameById} />}

      {a.halves ? (
        <>
          <Abschnitt titel="Halbe Runden" />
          <HalfChart run={run} halves={a.halves} mean={a.halfMeans!.fly} />
          <p className="text-xs text-muted" style={{ margin: '2px 0 8px' }}>
            {a.showLead && <>Farbe = führender Fahrer, gepunktet = Führungswechsel · </>}
            erste halbe Runde (Start, {fmtMs(a.halves[0].ms)}) nicht dargestellt · Δ gegen den
            fliegenden Schnitt
          </p>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setHalfTable(v => !v)}
            style={{ marginBottom: 8 }}>
            {halfTable ? '▾ Tabelle ausblenden' : `▸ Tabelle (${a.halves.length} halbe Runden)`}
          </button>
          {halfTable && <HalfTable run={run} nameById={nameById} a={a} />}
        </>
      ) : (
        <>
          <Abschnitt titel="Halbe Runden" />
          <p className="text-xs text-muted" style={{ margin: '0 0 8px' }}>
            Für diesen Lauf sind keine halben Runden erfasst — Diagramm und Tabelle entfallen.
          </p>
        </>
      )}

      <Abschnitt titel="Ganze Runden" />
      <LapChart a={a} mean={a.lapMeans.fly} />
      <p className="text-xs text-muted" style={{ margin: '2px 0 8px' }}>
        Startrunde ({fmtMs(a.laps[0].lapMs)}) nicht dargestellt
        {a.lapsPerKm > 0 && <> · Kilometer-Blöcke = {a.lapsPerKm} Runden bei {run.trackM} m</>}
        {rest && <> · * unvollständiger Block</>}
      </p>
      <LapTable run={run} nameById={nameById} a={a} />

      {a.showLead && (
        <>
          <Abschnitt titel="Führungsbilanz" />
          <LeadSummary run={run} nameById={nameById} a={a} />
        </>
      )}

      {hasPlan && (
        <>
          <Abschnitt titel="Gegen den Plan" />
          <CourseChart run={run} />
        </>
      )}
    </div>
  );
}
