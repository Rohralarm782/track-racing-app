// Zielpfad im Repo: frontend/src/lib/qualification.ts  (NEUE DATEI)
//
// Rechnet für Punktefahren-Vorläufe aus, wie sicher ein Fahrer den Cut schafft.
//
// Zwei getrennte Aussagen, bewusst nicht vermischt:
//
//  1. "durch" / "raus" — rein kombinatorisch, hängt von keiner Annahme ab.
//     Wird nur gemeldet, wenn der Fall nachweisbar unmöglich ist. Lieber
//     einmal zu wenig "durch" als einmal falsch.
//
//  2. Die Stufe dazwischen — aus einer Simulation der Restwertungen.
//     Punktgleiche Fahrer sind darin ununterscheidbar und bekommen deshalb
//     zwingend denselben Wert (Mittelung je Punktestand, siehe unten).
//
// Kalibriert an elf realen Vorläufen (DM 2023–2026, U17/U19): dort punkteten
// im Mittel 10,5 verschiedene Fahrer pro Lauf, das Gleichverteilungsmodell
// erwartet 11,2. Ein angepasster Konzentrationsparameter (Gewicht 1 + 0,15·Punkte)
// trifft den Mittelwert exakt, verschiebt aber in keinem Szenario eine einzige
// angezeigte Stufe — die Streuung von Lauf zu Lauf ist ein Vielfaches davon
// (zwei Läufe derselben Veranstaltung mit 21 Startern: 11 bzw. 8 Punktesammler).
// Deshalb bleibt es beim einfachen Modell ohne getunte Konstante.

export interface QualiStanding {
  total: number;
  isDsq?: boolean;
}

export type QualiKind = 'safe' | 'out' | 'open';

export interface QualiLevel {
  /** 0 = muss vorfahren … 4 = durch; null bei "raus" */
  step: number | null;
  color: string;
  label: string;
  /** true, wenn die Aussage kombinatorisch bewiesen ist (nicht simuliert) */
  hard: boolean;
}

export interface QualiInput {
  /** Scoreboard-Reihenfolge, so wie sie angezeigt wird (DSQ inbegriffen) */
  rows: QualiStanding[];
  qualifyCount: number;
  /** aus der Ansetzung; ohne diese Zahl wird nicht gerechnet */
  plannedSprints: number | null;
  doneSprints: number;
  /** ob die Schlusswertung bereits gefahren ist */
  hasFinale: boolean;
  /** ob im Rennen ein Rundengewinn/-verlust erfasst wurde */
  hasLapEvents: boolean;
}

export interface QualiOutput {
  /** je Scoreboard-Zeile; null = keine Aussage (DSQ oder nicht gerechnet) */
  levels: (QualiLevel | null)[];
  /** Index der Zeile, NACH der die Cut-Linie gezeichnet wird; null = keine */
  cutAfterIndex: number | null;
  /** true, wenn Stufen berechnet wurden (sonst nur die Linie) */
  hasLevels: boolean;
}

const LEVELS: QualiLevel[] = [
  { step: 0, color: '#dc2626', label: 'muss vorfahren',   hard: false },
  { step: 1, color: '#ea580c', label: 'offen',            hard: false },
  { step: 2, color: '#eab308', label: 'wahrscheinlich',   hard: false },
  { step: 3, color: '#84cc16', label: 'so gut wie durch', hard: false },
  { step: 4, color: '#16a34a', label: 'durch',            hard: true  },
];
const OUT: QualiLevel = { step: null, color: '#9ca3af', label: 'raus', hard: true };

/** Punktwerte der verbleibenden Wertungen; Schlusswertung zählt doppelt. */
function remainingPool(plannedSprints: number, doneSprints: number, hasFinale: boolean): number[][] {
  const pool: number[][] = [];
  for (let i = doneSprints; i < plannedSprints; i++) {
    // Die letzte geplante Wertung ist die Schlusswertung — es sei denn, es
    // wurde bereits eine als Finale erfasst.
    const isFinale = !hasFinale && i + 1 === plannedSprints;
    const m = isFinale ? 2 : 1;
    pool.push([5 * m, 3 * m, 2 * m, 1 * m]);
  }
  return pool;
}
const maxGain   = (pool: number[][]) => pool.reduce((a, p) => a + p[0], 0);
const totalLeft = (pool: number[][]) => pool.reduce((a, p) => a + p[0] + p[1] + p[2] + p[3], 0);

/**
 * Kombinatorischer Status eines Fahrers.
 *
 * "durch" stützt sich auf zwei harte Schranken:
 *   (a) pro Wertung punkten höchstens vier Fahrer → maximal 4·r Überholer
 *   (b) das gesamte Restpunkte-Budget ist endlich
 * Beides sind notwendige Bedingungen dafür, dass genug Fahrer vorbeiziehen.
 * Scheitern sie, ist der Angriff unmöglich und der Platz sicher.
 */
export function hardStatus(rows: QualiStanding[], idx: number, Q: number, pool: number[][]): QualiKind {
  const me = rows[idx];
  const mg = maxGain(pool);

  // Rechnerisch raus: selbst mit voller Ausbeute bleiben zu viele vor mir.
  const uncatchable = rows.filter((x, i) => i < idx && x.total > me.total + mg).length;
  if (uncatchable >= Q) return 'out';

  const needPass = Q - idx;               // so viele von hinten müssen vorbei
  if (needPass <= 0) return 'open';       // stehe ohnehin außerhalb des Cuts

  const behind = rows.slice(idx + 1);
  // Punktgleiche kommen ohne einen einzigen Punkt vorbei — es entscheidet der Einlauf.
  const tied = behind.filter(x => x.total === me.total).length;
  const deficits = behind
    .filter(x => x.total < me.total && me.total - x.total <= mg)
    .map(x => me.total - x.total)
    .sort((a, b) => a - b);

  const maxScorers = 4 * pool.length;
  const budget = totalLeft(pool);
  let canPass = 0, spent = 0;
  for (const d of deficits.slice(0, maxScorers)) {
    if (spent + d <= budget) { spent += d; canPass++; } else break;
  }
  return tied + canPass < needPass ? 'safe' : 'open';
}

/** Reproduzierbarer PRNG — sonst springen die Stufen bei jedem Auto-Refresh. */
function mulberry32(seed: number) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Simuliert die Restwertungen und liefert je Fahrer die Chance auf einen
 * Qualifikationsplatz. Annahme bewusst neutral: jeder Fahrer punktet gleich
 * wahrscheinlich, der Einlauf der Schlusswertung ist zufällig.
 */
export function qualiChances(rows: QualiStanding[], Q: number, pool: number[][], runs = 3000): number[] {
  const N = rows.length;
  const base = rows.map(r => r.total);
  const rnd = mulberry32(0x5EED);
  const hits = new Array(N).fill(0);
  const tot = new Array<number>(N);
  const fin = new Array<number>(N);
  const ord = Array.from({ length: N }, (_, i) => i);

  const finaleIdx = pool.findIndex(p => p[0] === 10);

  for (let run = 0; run < runs; run++) {
    for (let i = 0; i < N; i++) { tot[i] = base[i]; fin[i] = 99; }
    for (let s = 0; s < pool.length; s++) {
      const perm = Array.from({ length: N }, (_, i) => i);
      for (let i = N - 1; i > 0; i--) {
        const j = (rnd() * (i + 1)) | 0;
        const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
      }
      for (let k = 0; k < 4 && k < N; k++) tot[perm[k]] += pool[s][k];
      // Die Schlusswertung liefert zugleich den Einlauf, der Gleichstände löst.
      if (s === finaleIdx) for (let p = 0; p < N; p++) fin[perm[p]] = p + 1;
    }
    ord.sort((a, b) => tot[b] - tot[a] || fin[a] - fin[b]);
    for (let k = 0; k < Q && k < N; k++) hits[ord[k]]++;
  }

  // Punktgleiche Fahrer sind im Modell austauschbar. Der Mittelwert je
  // Punktestand ist damit der exakte Wert — und verhindert, dass identische
  // Fahrer durch Simulationsrauschen verschiedene Stufen bekommen.
  const byTotal = new Map<number, number[]>();
  rows.forEach((r, i) => {
    const list = byTotal.get(r.total);
    if (list) list.push(i); else byTotal.set(r.total, [i]);
  });
  const out = new Array<number>(N);
  for (const idxs of byTotal.values()) {
    const avg = idxs.reduce((a, i) => a + hits[i], 0) / idxs.length / runs;
    for (const i of idxs) out[i] = avg;
  }
  return out;
}

function bandOf(p: number): QualiLevel {
  if (p >= 0.85) return LEVELS[3];
  if (p >= 0.65) return LEVELS[2];
  if (p >= 0.40) return LEVELS[1];
  return LEVELS[0];
}

export function computeQualification(input: QualiInput): QualiOutput {
  const { rows, qualifyCount: Q, plannedSprints, doneSprints, hasFinale, hasLapEvents } = input;
  const levels: (QualiLevel | null)[] = rows.map(() => null);

  // DSQ-Fahrer nehmen keinen Qualifikationsplatz ein und können auch keinen
  // mehr erreichen — sie fliegen komplett aus der Rechnung.
  const live: number[] = [];
  rows.forEach((r, i) => { if (!r.isDsq) live.push(i); });
  const liveRows = live.map(i => rows[i]);

  const cutAfterIndex = Q > 0 && Q <= live.length ? live[Q - 1] : null;

  // Ohne bekannte Wertungszahl wird nur der Strich gezogen, nicht gerechnet.
  if (plannedSprints == null || Q <= 0 || Q >= liveRows.length) {
    return { levels, cutAfterIndex, hasLevels: false };
  }

  const pool = remainingPool(plannedSprints, doneSprints, hasFinale);

  // Rennen durch: die Plätze stehen fest.
  if (pool.length === 0) {
    live.forEach((rowIdx, k) => { levels[rowIdx] = k < Q ? LEVELS[4] : OUT; });
    return { levels, cutAfterIndex, hasLevels: true };
  }

  const chances = qualiChances(liveRows, Q, pool);
  live.forEach((rowIdx, k) => {
    const status = hardStatus(liveRows, k, Q, pool);
    // Sobald ein Rundengewinn im Spiel ist, sind +20 Punkte jederzeit möglich
    // und die harten Aussagen können kippen — dann nur noch die Stufen.
    if (!hasLapEvents && status === 'safe') { levels[rowIdx] = LEVELS[4]; return; }
    if (!hasLapEvents && status === 'out')  { levels[rowIdx] = OUT;       return; }
    levels[rowIdx] = bandOf(chances[k]);
  });

  return { levels, cutAfterIndex, hasLevels: true };
}

/** Vorbelegung des Quali-Hakens aus dem Rennnamen. Immer korrigierbar. */
export function looksLikeQualifying(name: string): boolean {
  return /vorlauf|vorl\.|qualifikation|quali\b|heat/i.test(name);
}
