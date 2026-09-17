// Zielpfad im Repo: frontend/src/components/pursuitAnalysis.ts  (NEUE Datei)
//
// Rechnen und Formatieren rund um einen gefahrenen Verfolgungslauf — ohne
// React, damit sich jede Zahl einzeln nachrechnen lässt. PursuitRunsCard.tsx
// und PursuitRunAnalysis.tsx benutzen ab 2.0.0 dieselben Funktionen; vorher
// lagen sie als lokale Helfer in der Karte und wären durch die neue Auswertung
// ein zweites Mal entstanden.
//
// Alle Zeiten sind Millisekunden, so wie sie im laps-JSON stehen.
//
// Begriffe (bewusst deutsch, wie trackside gesprochen wird):
//   halbe Runde  — 125 m auf einer 250-m-Bahn. Die erste halbe Runde enthält
//                  den Start und ist deshalb aus jedem Mittelwert "fliegend"
//                  herausgerechnet.
//   fliegend     — Mittelwert ohne die Startrunde bzw. ohne die erste halbe
//                  Runde. Nur dieser Wert ist zwischen Läufen vergleichbar.
//   Kilometer-Block — 1000 m am Stück: 4 Runden auf 250 m, 3 auf 333⅓ m,
//                  5 auf 200 m. Bleibt am Ende ein Rest, ist der Block
//                  unvollständig (`full: false`) und wird als solcher
//                  gekennzeichnet statt stillschweigend mitgezählt.

import type { PursuitRun, PursuitRunLap } from '../api/client';

/** Farben der Führung. Gleiche Reihenfolge wie im Führungsplan der
 *  Verfolgungsplanung — derselbe Fahrer bekommt dort und hier dieselbe Farbe,
 *  solange die Reihenfolge stimmt. */
export const LEAD_COLORS = ['#1d4ed8', '#16a34a', '#d97706', '#7c3aed', '#db2777', '#0891b2'];

export function leadColor(athleteIds: string[], id: string | null | undefined): string {
  if (!id) return 'var(--c-border)';
  const i = athleteIds.indexOf(id);
  return i < 0 ? '#9ca3af' : LEAD_COLORS[i % LEAD_COLORS.length];
}

/** m:ss,hh bzw. ss,hh — Hundertstel durchgängig, Trainingszeiten sind auf
 *  ganze Sekunden gerundet wertlos. */
export function fmtMs(ms: number): string {
  const neg = ms < 0;
  const cs = Math.round(Math.abs(ms) / 10);
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const h = cs % 100;
  const body = m > 0
    ? `${m}:${String(s).padStart(2, '0')},${String(h).padStart(2, '0')}`
    : `${s},${String(h).padStart(2, '0')}`;
  return `${neg ? '−' : ''}${body}`;
}

export function fmtDelta(ms: number): string {
  return `${ms > 0 ? '+' : ms < 0 ? '−' : '±'}${fmtMs(Math.abs(ms)).replace('−', '')}`;
}

export function fmtLaps(n: number): string {
  const r = Math.round(n * 2) / 2;
  const whole = Math.floor(r + 1e-9);
  const half = Math.abs(r - whole - 0.5) < 0.01;
  if (!half) return String(whole);
  return whole > 0 ? `${whole}½` : '½';
}

export function rolloutM(kb: number, rz: number, circMm: number): number {
  return (circMm / 1000) * (kb / rz);
}

/** Trittfrequenz in U/min für eine Teilstrecke. */
export function cadence(distM: number, ms: number, kb: number, rz: number, circMm: number): number | null {
  if (ms <= 0) return null;
  const roll = rolloutM(kb, rz, circMm);
  if (roll <= 0) return null;
  return (distM / (ms / 1000) / roll) * 60;
}

export function deltaColor(ms: number | null): string {
  if (ms === null) return 'var(--c-text)';
  if (ms > 200) return 'var(--c-success)';
  if (ms < -200) return 'var(--c-danger)';
  return 'var(--c-primary)';
}

export interface LeadShare { laps: number; ms: number; }

export function leadShares(run: PursuitRun): Record<string, LeadShare> {
  const acc: Record<string, LeadShare> = {};
  const bump = (id: string, laps: number, ms: number) => {
    if (!acc[id]) acc[id] = { laps: 0, ms: 0 };
    acc[id].laps += laps;
    acc[id].ms += ms;
  };
  run.laps.forEach(lap => {
    const a = lap.leadId ?? null;
    if (!a) return;
    const b = lap.leadId2 ?? null;
    if (!b) { bump(a, 1, lap.lapMs); return; }
    const first = lap.halfMs != null ? lap.halfMs : lap.lapMs / 2;
    bump(a, 0.5, first);
    bump(b, 0.5, lap.lapMs - first);
  });
  return acc;
}


// ── Auswertung ──────────────────────────────────────────────────────────────

/** Eine halbe Runde. `n` ist 1-basiert; n = 1 enthält den Start. */
export interface HalfLap { n: number; ms: number; leadId: string | null; }

/** Mittelwert mit und ohne Start. Bei nur einem Wert sind beide gleich. */
export interface Means { all: number; fly: number; }

export interface KmBlock {
  fromLap: number;
  toLap: number;
  ms: number;
  /** false = angebrochener Rest am Ende (abgebrochener Lauf, krumme Distanz). */
  full: boolean;
  label: string;
}

export interface RunAnalysis {
  laps: PursuitRunLap[];
  sumMs: number;
  lapMeans: Means;
  /** null, sobald auch nur EINER Runde die Halbrundenzeit fehlt — eine
   *  Auswertung aus halb gefüllten Daten wäre schlimmer als keine. */
  halves: HalfLap[] | null;
  halfMeans: Means | null;
  blocks: KmBlock[];
  lapsPerKm: number;
  showLead: boolean;
  shares: Record<string, LeadShare>;
}

export function means(values: number[]): Means {
  if (values.length === 0) return { all: 0, fly: 0 };
  const avg = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
  const all = avg(values);
  return { all, fly: values.length > 1 ? avg(values.slice(1)) : all };
}

/** Halbe Runden, oder null wenn die Daten dafür nicht reichen. Die zweite
 *  Hälfte ist immer lapMs − halfMs, so wie sie auch gespeichert wird. */
export function halfLaps(laps: PursuitRunLap[]): HalfLap[] | null {
  if (laps.length === 0) return null;
  const ok = laps.every(l => l.halfMs != null && l.halfMs > 0 && l.halfMs < l.lapMs);
  if (!ok) return null;
  const out: HalfLap[] = [];
  laps.forEach((l, i) => {
    const h1 = l.halfMs as number;
    out.push({ n: 2 * i + 1, ms: h1, leadId: l.leadId ?? null });
    out.push({ n: 2 * i + 2, ms: l.lapMs - h1, leadId: l.leadId2 ?? l.leadId ?? null });
  });
  return out;
}

/** Runden je Kilometer: 250 m → 4, 333⅓ m → 3, 200 m → 5. */
export function lapsPerKm(trackM: number): number {
  if (!trackM || trackM <= 0) return 0;
  return Math.max(1, Math.round(1000 / trackM));
}

export function kmBlocks(laps: PursuitRunLap[], trackM: number): KmBlock[] {
  const per = lapsPerKm(trackM);
  if (per === 0 || laps.length === 0) return [];
  const out: KmBlock[] = [];
  for (let i = 0; i < laps.length; i += per) {
    const part = laps.slice(i, i + per);
    const nr = out.length + 1;
    out.push({
      fromLap: i + 1,
      toLap: i + part.length,
      ms: part.reduce((a, l) => a + l.lapMs, 0),
      full: part.length === per,
      label: nr === 1 ? '1. km (mit Start)' : `${nr}. km`,
    });
  }
  return out;
}

/** Alles, was die Auswertung braucht, in einem Durchgang. null bei einem Lauf
 *  ohne Rundenzeiten — dann gibt es schlicht nichts auszuwerten. */
export function analyseRun(run: PursuitRun): RunAnalysis | null {
  const laps = run.laps ?? [];
  if (laps.length === 0) return null;
  const halves = halfLaps(laps);
  return {
    laps,
    sumMs: laps.reduce((a, l) => a + l.lapMs, 0),
    lapMeans: means(laps.map(l => l.lapMs)),
    halves,
    halfMeans: halves ? means(halves.map(h => h.ms)) : null,
    blocks: kmBlocks(laps, run.trackM),
    lapsPerKm: lapsPerKm(run.trackM),
    showLead: run.athleteIds.length > 1 && laps.some(l => !!l.leadId),
    shares: leadShares(run),
  };
}

/** Größter Wechselverlust je fliegender Runde, der noch als plausibel gilt
 *  (Sekunden). Selbst ein Plan aus lauter ½-Runden-Führungen kommt auf rund
 *  0,2 s je Runde; alles darüber stammt aus einem nachträglich geänderten Lauf. */
const PLAN_WECHSEL_JE_RUNDE_MAX_SEC = 0.25;

/** Plan-Rundenzeit für den Vergleich mit dem gefahrenen Lauf, in Sekunden —
 *  brutto, also einschließlich der Wechselverluste.
 *
 *  Seit 2.0.0 ist `planLapSec` ein Netto-Wert (Tempo zwischen den Ablösungen);
 *  die 0,10 s je Führungswechsel stecken nur in `planTotalSec`. Wer mit
 *  `planLapSec` kumuliert, endet um die Summe der Wechselverluste vor der
 *  gespeicherten Zielzeit, und eine Mannschaft genau nach Plan läge scheinbar
 *  zurück. Deshalb wird die Rundenzeit aus der Zielzeit abgeleitet.
 *
 *  Für Läufe vor 2.0.0 und für die Einerverfolgung ändert sich nichts: dort
 *  gilt planTotalSec = Anfahrt + (Runden − 1) · planLapSec.
 *
 *  Wo die Wechsel lagen, weiß der Lauf nicht. Der Verlust wird gleichmäßig
 *  verteilt: das Ziel stimmt, dazwischen liegt die Planlinie um wenige
 *  Hundertstel neben der stufigen Wirklichkeit.
 *
 *  Passt die abgeleitete Zeit nicht zu `planLapSec` (kleiner als netto oder mehr
 *  als PLAN_WECHSEL_JE_RUNDE_MAX_SEC darüber — etwa weil die Rundenzahl
 *  nachträglich geändert wurde), gilt `planLapSec` wie bisher. */
export function planLapBruttoSec(run: PursuitRun): number | null {
  if (run.planAnfahrtSec == null || run.planLapSec == null) return null;
  if (run.planTotalSec != null && run.numRounds > 1) {
    const brutto = (run.planTotalSec - run.planAnfahrtSec) / (run.numRounds - 1);
    if (
      Number.isFinite(brutto)
      && brutto >= run.planLapSec - 0.001
      && brutto <= run.planLapSec + PLAN_WECHSEL_JE_RUNDE_MAX_SEC
    ) {
      return brutto;
    }
  }
  return run.planLapSec;
}

/** Plan-Kumulierte nach Runde i (1-basiert), in ms. Rundenzeit brutto, siehe
 *  planLapBruttoSec(). */
export function planCum(run: PursuitRun, i: number): number | null {
  const lapSec = planLapBruttoSec(run);
  if (run.planAnfahrtSec == null || lapSec == null) return null;
  return Math.round((run.planAnfahrtSec + lapSec * (i - 1)) * 1000);
}
