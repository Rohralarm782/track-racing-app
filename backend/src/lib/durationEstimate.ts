import prisma from '../prisma';
import { inferCodeForEntry } from './scheduleImport';

// ─── Ausgangsformeln (Haukes Erfahrungswerte) ──────────────────────────────
// Diese Konstanten sind der fixe Kern der Schätzung. Kalibriert wird NICHT an
// den Konstanten selbst, sondern über einen einzigen multiplikativen
// Korrekturfaktor pro Kategorie (siehe DurationEstimate weiter unten) — bei
// Änderungswünschen an den Grundannahmen bitte direkt hier anpassen.

const MASS_START_SETUP_MIN = 5;      // Startaufstellung
const MASS_START_PER_ROUND_MIN = 0.5;
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

const CEREMONY_MIN = 3;

function typicalRaceMinutes(disciplineLabel: string): number {
  for (const [re, min] of DISTANCE_RACE_MIN) {
    if (re.test(disciplineLabel)) return min;
  }
  return DEFAULT_RACE_MIN;
}

/**
 * Reine Formel-Schätzung (noch ohne Kalibrierung) für ein Rennen, gegeben die
 * aus der verknüpften Startliste bekannte Runden-/Laufzahl. Gibt null zurück,
 * wenn die nötige Zahl (noch) nicht bekannt ist, oder es sich um kein
 * schätzbares Rennen handelt (INFO-Einträge wie Warm-up/Pausen) — dann lieber
 * gar keine Schätzung anzeigen als eine offensichtlich falsche.
 */
export function baseFormulaMinutes(
  entry: { disciplineLabel: string; massStart: boolean; type: string },
  unitCount: number | null,
): number | null {
  if (entry.type === 'CEREMONY') return CEREMONY_MIN;
  if (entry.type !== 'RACE') return null;

  const code = inferCodeForEntry(entry.disciplineLabel);

  if (code === 'AF') {
    if (unitCount == null) return null;
    return AF_SETUP_MIN + AF_PER_ROUND_MIN * unitCount + AF_CLEAR_MIN;
  }
  if (code === 'SP') {
    return unitCount == null ? null : SPRINT_PER_HEAT_MIN * unitCount;
  }
  if (code === 'TS') {
    return unitCount == null ? null : TEAMSPRINT_PER_HEAT_MIN * unitCount;
  }
  if (code === 'KE') {
    return unitCount == null ? null : KEIRIN_PER_HEAT_MIN * unitCount;
  }
  if (code === 'VF' || code === 'MV' || code === 'EV' || code === 'ZF') {
    if (unitCount == null) return null;
    const perHeat = PURSUIT_SETUP_MIN + typicalRaceMinutes(entry.disciplineLabel);
    return perHeat * unitCount;
  }
  // Massenstart-Sammelkategorie: Punktefahren, Madison, Scratch, Temporunden,
  // Omnium (grobe Annahme, im Detail noch nicht besprochen)
  if (unitCount == null) return null;
  return MASS_START_SETUP_MIN + MASS_START_PER_ROUND_MIN * unitCount + MASS_START_CLEAR_MIN;
}

function unitCountFor(
  entry: { massStart: boolean },
  linkedDoc: { roundCount: number | null; heatCount: number | null } | null | undefined,
): number | null {
  if (!linkedDoc) return null;
  return entry.massStart ? linkedDoc.roundCount : linkedDoc.heatCount;
}

/**
 * Kalibrierte Schätzung: Formel-Basiswert × Korrekturfaktor der Kategorie
 * (1.0, solange noch keine Beobachtungen vorliegen).
 */
export async function estimateMinutes(
  entry: { ak: string; disciplineLabel: string; massStart: boolean; type: string },
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
