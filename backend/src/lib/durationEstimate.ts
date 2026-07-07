import prisma from '../prisma';
import { inferCodeForEntry } from './scheduleImport';

// ─── Ausgangsformeln (Haukes Erfahrungswerte) ──────────────────────────────
// Diese Konstanten sind der fixe Kern der Schätzung. Kalibriert wird NICHT an
// den Konstanten selbst, sondern über einen einzigen multiplikativen
// Korrekturfaktor pro Kategorie (siehe DurationEstimate weiter unten) — bei
// Änderungswünschen an den Grundannahmen bitte direkt hier anpassen.

const MASS_START_SETUP_MIN = 5;      // Startaufstellung
const MASS_START_PER_ROUND_MIN = 20 / 60; // 20 Sek./Runde
const MASS_START_CLEAR_MIN = 3;      // bis alle Fahrer von der Bahn sind

const AF_SETUP_MIN = 3;              // Ausscheidungsfahren: eigene, kürzere Werte
const AF_PER_ROUND_MIN = 0.5;
const AF_CLEAR_MIN = 2;

// Verfolgung/Zeitfahren: pro Lauf = Startaufstellung + übliche Renndauer
// (kein Abräumen mehr extra, siehe Absprache). Renndauer hängt von der
// Distanz ab, die aus dem Disziplin-Klartext geparst wird.
const PURSUIT_SETUP_MIN = 1;
const DISTANCE_RACE_MIN: Array<[RegExp, number]> = [
  [/\b4000\s?m\b/i, 4.5],
  [/\b3000\s?m\b/i, 3.5],
  [/\b2000\s?m\b/i, 2.5],
  [/\b1000\s?m\b/i, 1.1],   // 1:06
  [/\b500\s?m\b/i, 0.583],  // 0:35
];
const DEFAULT_RACE_MIN = 3.0; // Fallback, falls keine bekannte Distanz im Text steht

const SPRINT_PER_HEAT_MIN = 2;
const TEAMSPRINT_PER_HEAT_MIN = 2; // Annahme: wie Sprint (von Hauke bestätigt)
const KEIRIN_PER_HEAT_MIN = 4;

const CEREMONY_MIN = 5;

// Grobe Rückfallgrößen, falls die Startliste keine Runden-/Laufzahl hergibt.
// Ohne Rückfall bricht die Schätzkette für JEDEN nachfolgenden Eintrag
// desselben Tages ab, sobald ein einziges Rennen dazwischen unbekannt ist —
// lieber eine grobe Schätzung zeigen, die sich über die Kalibrierung von
// selbst einpendelt, als gar keine (eine Kategorie kann sich zudem erst
// kalibrieren, wenn sie mindestens einmal eine Schätzung geliefert hat).
// Pro Disziplin unterschiedlich, da z.B. Punktefahren-Finals typischerweise
// deutlich mehr Runden haben als andere Massenstart-Formate.
const FALLBACK_ROUND_COUNT_BY_CODE: Record<string, number> = {
  PR: 50, // Punktefahren
  TR: 30, // Temporunden
};
const DEFAULT_FALLBACK_ROUND_COUNT = 30; // Madison, Scratch, Omnium, ...
const FALLBACK_HEAT_COUNT = 8;
// Verfolgung/Zeitfahren-Finals bestehen strukturell IMMER aus genau 2 Läufen
// (kleines Finale um Platz 3 + großes Finale um Platz 1) — unabhängig davon,
// ob/was die Startliste dazu hergibt. Deutlich zuverlässiger als der
// generische Lauf-Fallback oben, der für Qualifikationsrunden mit vielen
// Teilnehmern gedacht ist.
const PURSUIT_FINAL_HEAT_COUNT = 2;

function typicalRaceMinutes(disciplineLabel: string): number {
  for (const [re, min] of DISTANCE_RACE_MIN) {
    if (re.test(disciplineLabel)) return min;
  }
  return DEFAULT_RACE_MIN;
}

/**
 * Reine Formel-Schätzung (noch ohne Kalibrierung) für ein Rennen, gegeben die
 * Runden-/Laufzahl (ggf. schon mit Rückfallwert aufgefüllt, siehe
 * unitCountFor). Gibt nur bei INFO-Einträgen (Warm-up/Pausen) null zurück —
 * die sind bewusst nicht schätzbar.
 */
export function baseFormulaMinutes(
  entry: { disciplineLabel: string; massStart: boolean; type: string },
  unitCount: number,
): number | null {
  if (entry.type === 'CEREMONY') return CEREMONY_MIN;
  if (entry.type !== 'RACE') return null;

  const code = inferCodeForEntry(entry.disciplineLabel);

  if (code === 'AF') return AF_SETUP_MIN + AF_PER_ROUND_MIN * unitCount + AF_CLEAR_MIN;
  if (code === 'SP') return SPRINT_PER_HEAT_MIN * unitCount;
  if (code === 'TS') return TEAMSPRINT_PER_HEAT_MIN * unitCount;
  if (code === 'KE') return KEIRIN_PER_HEAT_MIN * unitCount;
  if (code === 'VF' || code === 'MV' || code === 'EV' || code === 'ZF') {
    const perHeat = PURSUIT_SETUP_MIN + typicalRaceMinutes(entry.disciplineLabel);
    return perHeat * unitCount;
  }
  // Massenstart-Sammelkategorie: Punktefahren, Madison, Scratch, Temporunden,
  // Omnium (grobe Annahme, im Detail noch nicht besprochen)
  return MASS_START_SETUP_MIN + MASS_START_PER_ROUND_MIN * unitCount + MASS_START_CLEAR_MIN;
}

function unitCountFor(
  entry: { disciplineLabel: string; massStart: boolean; phase: string | null },
  linkedDoc: { roundCount: number | null; heatCount: number | null } | null | undefined,
): number {
  const known = linkedDoc ? (entry.massStart ? linkedDoc.roundCount : linkedDoc.heatCount) : null;
  if (known != null) return known;
  if (!entry.massStart) {
    const code = inferCodeForEntry(entry.disciplineLabel);
    const isPursuit = code === 'VF' || code === 'MV' || code === 'EV' || code === 'ZF';
    if (isPursuit && entry.phase && /finale/i.test(entry.phase)) return PURSUIT_FINAL_HEAT_COUNT;
    return FALLBACK_HEAT_COUNT;
  }
  const code = inferCodeForEntry(entry.disciplineLabel);
  return (code ? FALLBACK_ROUND_COUNT_BY_CODE[code] : undefined) ?? DEFAULT_FALLBACK_ROUND_COUNT;
}

/**
 * Kalibrierte Schätzung: Formel-Basiswert × Korrekturfaktor der Kategorie
 * (1.0, solange noch keine Beobachtungen vorliegen).
 */
export async function estimateMinutes(
  entry: { ak: string; disciplineLabel: string; massStart: boolean; type: string; phase: string | null },
  linkedDoc: { roundCount: number | null; heatCount: number | null } | null | undefined,
): Promise<number | null> {
  const unitCount = unitCountFor(entry, linkedDoc);
  const base = baseFormulaMinutes(entry, unitCount);
  if (base == null) return null;

  const cal = await prisma.durationEstimate.findUnique({
    where: { ak_disciplineLabel_massStart: { ak: entry.ak, disciplineLabel: entry.disciplineLabel, massStart: entry.massStart } },
  });
  return base * (cal?.correctionFactor ?? 1.0);
}

const MIN_PLAUSIBLE_RATIO = 0.3;
const MAX_PLAUSIBLE_RATIO = 3.0;
const BASE_LEARNING_RATE = 0.2;

async function nudgeCategory(ak: string, disciplineLabel: string, massStart: boolean, errorRatio: number): Promise<void> {
  const existing = await prisma.durationEstimate.findUnique({
    where: { ak_disciplineLabel_massStart: { ak, disciplineLabel, massStart } },
  });
  const currentFactor = existing?.correctionFactor ?? 1.0;
  const sampleCount = existing?.sampleCount ?? 0;

  // Lernrate sinkt mit steigender Beobachtungszahl — frühe Meldungen dürfen
  // stark korrigieren, spätere nur noch fein nachjustieren, damit sich der
  // Wert stabilisiert statt bei jeder Meldung neu zu überschwingen.
  const alpha = Math.max(0.03, BASE_LEARNING_RATE / (1 + sampleCount * 0.15));
  const newFactor = currentFactor * (1 + alpha * (errorRatio - 1));

  await prisma.durationEstimate.upsert({
    where: { ak_disciplineLabel_massStart: { ak, disciplineLabel, massStart } },
    create: { ak, disciplineLabel, massStart, correctionFactor: newFactor, sampleCount: 1 },
    update: { correctionFactor: newFactor, sampleCount: { increment: 1 } },
  });
}

/**
 * Wird nach JEDER neuen "Aktueller Stand"-Meldung aufgerufen (siehe PUT
 * /events/:id/status in schedule.ts). Vergleicht die real vergangene Zeit
 * seit der letzten Meldung mit der Summe der aktuellen Schätzungen für die
 * dazwischen liegenden Zeitplan-Einträge und verschiebt deren Kategorien
 * anteilig in Richtung der beobachteten Realität.
 */
export async function recalibrateFromStatusUpdate(
  eventId: string,
  newLogId: string,
  newScheduleEntryId: string,
  at: Date,
): Promise<void> {
  const previous = await prisma.statusUpdateLog.findFirst({
    where: { eventId, id: { not: newLogId } },
    orderBy: { createdAt: 'desc' },
  });
  if (!previous) return; // erste Meldung der Veranstaltung — keine Vergleichsbasis

  const [prevEntry, newEntry] = await Promise.all([
    prisma.scheduleEntry.findUnique({ where: { id: previous.scheduleEntryId } }),
    prisma.scheduleEntry.findUnique({ where: { id: newScheduleEntryId } }),
  ]);
  if (!prevEntry || !newEntry || newEntry.order <= prevEntry.order) return;

  const realElapsedMin = (at.getTime() - previous.createdAt.getTime()) / 60000;
  if (realElapsedMin <= 0 || realElapsedMin > 240) return; // unplausibel (z.B. Tagesende/lange Pause) — nicht lernen

  const between = await prisma.scheduleEntry.findMany({
    where: { eventId, type: 'RACE', order: { gte: prevEntry.order, lt: newEntry.order } },
    include: { linkedDocument: { select: { roundCount: true, heatCount: true } } },
  });
  if (between.length === 0) return;

  let predictedTotal = 0;
  const withEstimate: Array<{ ak: string; disciplineLabel: string; massStart: boolean }> = [];
  for (const e of between) {
    const est = await estimateMinutes(e, e.linkedDocument);
    if (est != null) {
      predictedTotal += est;
      withEstimate.push({ ak: e.ak, disciplineLabel: e.disciplineLabel, massStart: e.massStart });
    }
  }
  if (predictedTotal <= 0 || withEstimate.length === 0) return;

  const errorRatio = realElapsedMin / predictedTotal;
  if (errorRatio < MIN_PLAUSIBLE_RATIO || errorRatio > MAX_PLAUSIBLE_RATIO) return; // Ausreißer ignorieren (z.B. lange Pause mit reingerechnet)

  for (const cat of withEstimate) {
    await nudgeCategory(cat.ak, cat.disciplineLabel, cat.massStart, errorRatio);
  }
}
