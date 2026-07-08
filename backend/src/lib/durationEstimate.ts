import prisma from '../prisma';
import { inferCodeForEntry } from './scheduleImport';
import { getSettings, parseDistanceTable, type DistanceRaceMinutes } from './settings';
import type { AppSettings } from '@prisma/client';

function typicalRaceMinutes(disciplineLabel: string, distances: DistanceRaceMinutes): number {
  for (const [key, min] of Object.entries(distances)) {
    if (key === 'default') continue;
    if (new RegExp(`\\b${key}\\b`, 'i').test(disciplineLabel)) return min;
  }
  return distances.default;
}

/**
 * Reine Formel-Schätzung (noch ohne Kalibrierung) für ein Rennen, gegeben die
 * Runden-/Laufzahl (ggf. schon mit Rückfallwert aufgefüllt, siehe
 * unitCountFor) und die aktuellen Einstellungen (siehe settings.ts). Gibt nur
 * bei INFO-Einträgen (Warm-up/Pausen) null zurück — die sind bewusst nicht
 * schätzbar.
 */
export function baseFormulaMinutes(
  entry: { disciplineLabel: string; massStart: boolean; type: string },
  unitCount: number,
  settings: AppSettings,
): number | null {
  if (entry.type === 'CEREMONY') return 5;
  if (entry.type !== 'RACE') return null;

  const code = inferCodeForEntry(entry.disciplineLabel);

  if (code === 'AF') return settings.afSetupMin + settings.afPerRoundMin * unitCount + settings.afClearMin;
  if (code === 'SP') return settings.sprintPerHeatMin * unitCount;
  if (code === 'TS') return settings.teamsprintPerHeatMin * unitCount;
  if (code === 'KE') return settings.keirinPerHeatMin * unitCount;
  if (code === 'VF' || code === 'MV' || code === 'EV' || code === 'ZF') {
    const distances = parseDistanceTable(settings.distanceRaceMinutes);
    const perHeat = settings.pursuitSetupMin + typicalRaceMinutes(entry.disciplineLabel, distances);
    return perHeat * unitCount;
  }
  // Massenstart-Sammelkategorie: Punktefahren, Madison, Scratch, Temporunden,
  // Omnium (grobe Annahme, im Detail noch nicht besprochen)
  return settings.massStartSetupMin + settings.massStartPerRoundMin * unitCount + settings.massStartClearMin;
}

function unitCountFor(
  entry: { disciplineLabel: string; massStart: boolean; phase: string | null; manualUnitCount?: number | null },
  linkedDoc: { roundCount: number | null; heatCount: number | null } | null | undefined,
  settings: AppSettings,
): number {
  // Manuelle Eingabe (siehe ScheduleEntry.manualUnitCount) hat immer Vorrang —
  // sowohl vor der aus der Startliste extrahierten Zahl als auch vor jeder
  // Rückfallgröße.
  if (entry.manualUnitCount != null) return entry.manualUnitCount;

  const known = linkedDoc ? (entry.massStart ? linkedDoc.roundCount : linkedDoc.heatCount) : null;
  if (known != null) return known;
  if (!entry.massStart) {
    const code = inferCodeForEntry(entry.disciplineLabel);
    const isPursuit = code === 'VF' || code === 'MV' || code === 'EV' || code === 'ZF';
    if (isPursuit && entry.phase && /finale/i.test(entry.phase)) return settings.pursuitFinalHeatCount;
    return settings.fallbackHeatCount;
  }
  const code = inferCodeForEntry(entry.disciplineLabel);
  if (code === 'PR') return settings.fallbackRoundCountPr;
  if (code === 'TR') return settings.fallbackRoundCountTr;
  return settings.fallbackRoundCountDefault;
}

/**
 * Ob für diesen Eintrag eine ECHTE Runden-/Laufzahl bekannt ist (Startliste
 * oder manuelle Eingabe) oder nur eine Rückfallgröße verwendet wurde — damit
 * das Frontend anzeigen kann, wo eine manuelle Korrektur sinnvoll wäre.
 */
export function usedFallback(
  entry: { massStart: boolean; manualUnitCount?: number | null },
  linkedDoc: { roundCount: number | null; heatCount: number | null } | null | undefined,
): boolean {
  if (entry.manualUnitCount != null) return false;
  const known = linkedDoc ? (entry.massStart ? linkedDoc.roundCount : linkedDoc.heatCount) : null;
  return known == null;
}

/**
 * Kalibrierte Schätzung: Formel-Basiswert × Korrekturfaktor der Kategorie
 * (1.0, solange noch keine Beobachtungen vorliegen). settings muss vom
 * Aufrufer einmalig geladen und durchgereicht werden (statt hier pro Eintrag
 * neu abzufragen), damit z.B. withEstimates() in schedule.ts bei vielen
 * Einträgen nicht unnötig oft dieselbe Zeile lädt.
 */
export async function estimateMinutes(
  entry: { ak: string; disciplineLabel: string; massStart: boolean; type: string; phase: string | null; manualUnitCount?: number | null },
  linkedDoc: { roundCount: number | null; heatCount: number | null } | null | undefined,
  settings: AppSettings,
): Promise<number | null> {
  const unitCount = unitCountFor(entry, linkedDoc, settings);
  const base = baseFormulaMinutes(entry, unitCount, settings);
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

  const settings = await getSettings();

  let predictedTotal = 0;
  const withEstimate: Array<{ ak: string; disciplineLabel: string; massStart: boolean }> = [];
  for (const e of between) {
    const est = await estimateMinutes(e, e.linkedDocument, settings);
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
